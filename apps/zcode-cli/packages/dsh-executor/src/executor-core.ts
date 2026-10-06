/**
 * Executor internals: process ownership, session registry wiring and protocol callbacks.
 *
 * Split out of `adapter.ts` so the public adapter stays a thin, readable mapping of the frozen
 * interface onto the protocol. Nothing here is exported from the package barrel; the adapter is the
 * only entry point.
 */

import { AcpClient } from './acp-client.js';
import { buildChildArgs, buildChildEnv, type ResolvedDshExecutorConfig } from './config.js';
import {
  ExecutorExited,
  ExecutorHandshakeFailed,
  isDshExecutorError,
  ProtocolViolation,
  RpcMethodNotFound,
  SessionNotFound,
} from './errors.js';
import { isRecord } from './jsonrpc.js';
import { MODEL_CONFIG_ID, REASONING_EFFORT_CONFIG_ID, resolveModelValue } from './models.js';
import { buildPermissionResponse, readPermissionRequest } from './permissions.js';
import { createRedactor, secretValuesFromEnv, type Redactor } from './redact.js';
import { SessionRegistry, type SessionState } from './session-state.js';
import { ACP_PROTOCOL_VERSION, type AcpExitInfo, type DshConfigOption, type DshEvent, type DshExecutorState, type DshExitReport } from './types.js';

const MAX_RECORDED_VIOLATIONS = 50;

export class ExecutorCore {
  readonly config: ResolvedDshExecutorConfig;
  readonly redact: Redactor;
  readonly registry: SessionRegistry;
  /** sessionId -> cwd, learned from every create/attach/list; `session/resume` needs it. */
  readonly cwdIndex = new Map<string, string>();
  readonly violations: ProtocolViolation[] = [];
  client: AcpClient | undefined;
  state: DshExecutorState = 'idle';
  exitReport: DshExitReport | undefined;
  agentInfo: unknown;
  agentCapabilities: unknown;
  disposing = false;

  constructor(config: ResolvedDshExecutorConfig) {
    this.config = config;
    this.redact = createRedactor([...config.secrets, ...secretValuesFromEnv(config.env)]);
    this.registry = new SessionRegistry({ submitToolName: config.submitToolName });
  }

  log(line: string): void {
    this.config.logSink?.(line);
  }

  // -------------------------------------------------------------- process life

  /** Spawn `binary --profile <profile>` and complete the ACP handshake. */
  async start(): Promise<void> {
    if (this.state === 'ready' && this.client?.isRunning === true) return;
    if (this.state === 'disposed') throw new ExecutorExited({ message: 'adapter was disposed' });
    this.state = 'starting';
    const childEnv = buildChildEnv(this.config);
    const client = new AcpClient({
      binary: this.config.binary,
      args: buildChildArgs(this.config),
      env: childEnv,
      cwd: this.config.childCwd,
      requestTimeoutMs: this.config.requestTimeoutMs,
      maxLineChars: this.config.maxLineChars,
      stderrBufferLines: this.config.stderrBufferLines,
      logSink: this.config.logSink,
      secrets: [...this.config.secrets, ...secretValuesFromEnv(childEnv)],
      onNotification: (method, params) => {
        this.handleNotification(method, params);
      },
      onServerRequest: (method, params) => this.handleServerRequest(method, params),
      onProtocolViolation: (violation) => {
        this.recordViolation(violation);
      },
      onExit: (info) => {
        this.handleExit(info);
      },
      onDiagnostic: (line) => {
        this.log(line);
      },
      disposeGraceMs: this.config.disposeGraceMs,
    });
    await client.start();
    try {
      const result = await client.request<unknown>(
        'initialize',
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: this.config.clientName, version: this.config.clientVersion },
        },
        { timeoutMs: this.config.requestTimeoutMs },
      );
      const protocolVersion = isRecord(result) ? result['protocolVersion'] : undefined;
      if (protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new ExecutorHandshakeFailed({
          message: `unsupported ACP protocol version: ${JSON.stringify(protocolVersion ?? null)}`,
          detail: { protocolVersion: protocolVersion ?? null },
        });
      }
      this.agentInfo = isRecord(result) ? result['agentInfo'] : undefined;
      this.agentCapabilities = isRecord(result) ? result['agentCapabilities'] : undefined;
    } catch (error) {
      await client.dispose();
      this.state = 'failed';
      if (error instanceof ExecutorHandshakeFailed) throw error;
      throw new ExecutorHandshakeFailed({
        message: `initialize failed: ${
          error instanceof Error ? this.redact(error.message) : this.redact(String(error))
        }`,
        cause: error,
        detail: isDshExecutorError(error) ? { ...error.detail } : {},
      });
    }
    this.client = client;
    this.state = 'ready';
  }

  async dispose(): Promise<void> {
    if (this.state === 'disposed') return;
    this.disposing = true;
    const client = this.client;
    if (client !== undefined) {
      const open = this.registry.list().filter((state) => state.status !== 'closed');
      await Promise.allSettled(
        open.map((state) =>
          client.request(
            'session/close',
            { sessionId: state.sessionId },
            { timeoutMs: Math.min(this.config.requestTimeoutMs, 5_000), sessionId: state.sessionId },
          ),
        ),
      );
      await client.dispose();
    }
    this.registry.closeAll();
    this.client = undefined;
    this.state = 'disposed';
  }

  // -------------------------------------------------------------- requirements

  requireClient(): AcpClient {
    const client = this.client;
    if (client === undefined || !client.isRunning) {
      throw new ExecutorExited({
        message:
          this.state === 'disposed'
            ? 'adapter was disposed'
            : 'executor is not running (call start() first)',
        exitInfo: this.exitReport ?? client?.exitInfo,
        stderrExcerpt: client?.stderrExcerpt ?? '',
      });
    }
    return client;
  }

  requireLiveSession(sessionId: string): SessionState {
    const state = this.registry.require(sessionId);
    if (state.status === 'closed') {
      throw new SessionNotFound({
        sessionId,
        method: 'session/state',
        message: `session ${sessionId} is closed`,
      });
    }
    if (state.stale) {
      throw new SessionNotFound({
        sessionId,
        method: 'session/state',
        message: `session ${sessionId} belongs to an executor that exited; resume it on a new adapter`,
      });
    }
    return state;
  }

  // ------------------------------------------------------------------ config

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    const client = this.requireClient();
    const state = this.requireLiveSession(sessionId);
    const result = await client.request<unknown>(
      'session/set_config_option',
      { sessionId, configId, value },
      { timeoutMs: this.config.requestTimeoutMs, sessionId },
    );
    const configOptions = readConfigOptions(result);
    if (configOptions !== undefined) state.configOptions = configOptions;
    // The catalogue changes between calls (probe 8.5), so the event carries the fresh state.
    this.emit(state, {
      kind: 'config',
      payload: { type: 'config_option', configId, value, configOptions: state.configOptions ?? [] },
    });
  }

  async applyModelSelection(
    sessionId: string,
    selection: { model?: string; reasoningEffort?: string },
  ): Promise<void> {
    const state = this.requireLiveSession(sessionId);
    if (selection.model !== undefined && selection.model !== '') {
      const value = resolveModelValue(selection.model, state.configOptions);
      await this.setConfigOption(sessionId, MODEL_CONFIG_ID, value);
    }
    if (selection.reasoningEffort !== undefined && selection.reasoningEffort !== '') {
      await this.setConfigOption(sessionId, REASONING_EFFORT_CONFIG_ID, selection.reasoningEffort);
    }
  }

  // ------------------------------------------------------------- protocol in

  handleNotification(method: string, params: unknown): void {
    if (method !== 'session/update') {
      this.log(`unhandled notification from executor: ${method}`);
      return;
    }
    const sessionId = isRecord(params) ? params['sessionId'] : undefined;
    if (typeof sessionId !== 'string') {
      this.recordViolation(
        new ProtocolViolation({
          message: 'session/update without sessionId',
          method,
          evidence: this.redact(JSON.stringify(params ?? null).slice(0, 200)),
          fatal: false,
        }),
      );
      return;
    }
    this.registry.update(sessionId, isRecord(params) ? params['update'] : undefined);
  }

  handleServerRequest(method: string, params: unknown): unknown {
    if (method === 'session/request_permission') return this.answerPermission(params);
    throw new RpcMethodNotFound(method);
  }

  /** Probe 8.14: never expected, always answered from policy, recorded as an event when possible. */
  answerPermission(params: unknown): unknown {
    const request = readPermissionRequest(params);
    const policy = this.config.permissionPolicy;
    const response = buildPermissionResponse(request.options, policy);
    if (request.sessionId !== undefined) {
      const state = this.registry.get(request.sessionId);
      if (state !== undefined) {
        this.emit(state, {
          kind: 'other',
          payload: {
            type: 'permission_request',
            policy,
            answer: response,
            toolCallId: request.toolCallId ?? null,
          },
        });
      }
    }
    this.log(`session/request_permission answered by policy ${policy}: ${JSON.stringify(response)}`);
    return response;
  }

  handleExit(info: AcpExitInfo): void {
    const fatal = this.client?.fatalViolation;
    this.exitReport = {
      ...info,
      reason: this.disposing ? 'disposed' : fatal !== undefined ? 'protocol-violation' : 'exit',
      stderrExcerpt: this.client?.stderrExcerpt ?? '',
    };
    this.registry.markStale();
    if (!this.disposing && this.state !== 'disposed') this.state = 'failed';
  }

  recordViolation(violation: ProtocolViolation): void {
    if (this.violations.length >= MAX_RECORDED_VIOLATIONS) this.violations.shift();
    this.violations.push(violation);
    this.log(`protocol violation: ${violation.message}`);
  }

  emit(state: SessionState, event: Omit<DshEvent, 'sessionId' | 'at'>): void {
    state.events.publish({ ...event, sessionId: state.sessionId, at: Date.now() });
  }
}

export function readConfigOptions(value: unknown): readonly DshConfigOption[] | undefined {
  if (!isRecord(value)) return undefined;
  const options = value['configOptions'];
  if (!Array.isArray(options)) return undefined;
  return options.filter(isRecord) as unknown as DshConfigOption[];
}
