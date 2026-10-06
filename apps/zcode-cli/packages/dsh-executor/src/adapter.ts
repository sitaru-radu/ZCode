/**
 * `DeepSeekHarnessAdapter` (spec 40-dsh-executor.md §3), implemented over `AcpClient`.
 *
 * Lifecycle mapping (spec §4, all names confirmed by the probe):
 *   start -> spawn + `initialize`                  cancel        -> `session/cancel` (notification!)
 *   createSession -> `session/new`                 listSessions  -> `session/list`
 *   runTask/sendMessage -> `session/prompt`        resumeSession -> `session/resume`
 *   streamEvents -> `session/update`               setModel      -> `session/set_config_option`
 *   destroySession -> `session/close`              dispose       -> close all, then kill the child
 *
 * Deliberate behaviours worth knowing before reading the code:
 *  - `session/cancel` is a notification (no id) and the in-flight prompt resolves with
 *    `stopReason: "cancelled"` (probe 8.6); `cancel` is therefore idempotent and never throws.
 *  - a `PromptTimeout` auto-issues that cancel, otherwise the session would stay busy forever.
 *  - `runTask` with an already-aborted signal settles as cancelled without touching the wire.
 *  - a worker's `tool_call_update{status:"completed"}` is never treated as proof of a side effect
 *    (probe 8.1): the caller asserts on the host filesystem.
 */

import path from 'node:path';

import { type DshExecutorConfig, resolveConfig } from './config.js';
import {
  ExecutorRequestFailed,
  isSessionNotFound,
  PromptTimeout,
  ProtocolViolation,
  RequestTimeout,
  SessionCreateFailed,
  SessionNotFound,
} from './errors.js';
import { ExecutorCore, readConfigOptions } from './executor-core.js';
import { isRecord } from './jsonrpc.js';
import { toAcpMcpServers } from './mcp/servers.js';
import { describeError } from './redact.js';
import type { SessionState } from './session-state.js';
import {
  type AcpMcpServer,
  type DshConfigOption,
  type DshEvent,
  type DshExecutorState,
  type DshExitReport,
  type DshMcpServer,
  type DshSessionSpec,
  type DshSessionStatus,
  type DshSessionSummary,
  type DshStreamStats,
  type DshSubmission,
  type DshTurnResult,
} from './types.js';

/** The frozen adapter surface (spec §3). Do not add members here; extend `DshExecutorAdapter`. */
export interface DeepSeekHarnessAdapter {
  start(): Promise<void>;
  createSession(spec: DshSessionSpec): Promise<{ sessionId: string; configOptions?: unknown }>;
  runTask(
    sessionId: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<{ stopReason: string; finalText: string }>;
  sendMessage(
    sessionId: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<{ stopReason: string; finalText: string }>;
  streamEvents(sessionId: string): AsyncIterable<DshEvent>;
  cancel(sessionId: string): Promise<void>;
  listSessions(): Promise<DshSessionSummary[]>;
  resumeSession(sessionId: string): Promise<void>;
  setModel(sessionId: string, model: string, reasoningEffort?: string): Promise<void>;
  getStatus(sessionId: string): DshSessionStatus;
  destroySession(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * `resumeSession` needs the session's cwd and MCP servers: `session/resume` matches cwd by realpath
 * (probe 8.10) and takes `mcpServers` so the submit bridge can be re-attached. Both may come from
 * configuration or from a previous `listSessions()`; they are optional so the call stays compatible
 * with the frozen one-argument signature.
 */
export interface DshResumeOptions {
  readonly cwd?: string;
  readonly mcpServers?: readonly DshMcpServer[];
}

export class DshExecutorAdapter implements DeepSeekHarnessAdapter {
  readonly #core: ExecutorCore;

  constructor(config: DshExecutorConfig = {}) {
    this.#core = new ExecutorCore(resolveConfig(config));
  }

  // ---------------------------------------------------------------- lifecycle

  start(): Promise<void> {
    return this.#core.start();
  }

  dispose(): Promise<void> {
    return this.#core.dispose();
  }

  // ------------------------------------------------------------------ sessions

  async createSession(spec: DshSessionSpec): Promise<{ sessionId: string; configOptions?: unknown }> {
    const core = this.#core;
    const client = core.requireClient();
    const cwd = spec.cwd;
    if (typeof cwd !== 'string' || cwd === '' || !path.isAbsolute(cwd)) {
      throw new SessionCreateFailed({
        cwd: typeof cwd === 'string' ? cwd : String(cwd),
        message: `session cwd must be an absolute path (got ${JSON.stringify(cwd ?? null)})`,
      });
    }
    let mcpServers: AcpMcpServer[];
    try {
      mcpServers = toAcpMcpServers(spec.mcpServers ?? []);
    } catch (error) {
      throw new SessionCreateFailed({
        cwd,
        message: `invalid mcpServers: ${describeError(error, core.redact)}`,
        cause: error,
      });
    }
    const result = await client.request<unknown>(
      'session/new',
      { cwd, mcpServers },
      { timeoutMs: core.config.requestTimeoutMs, cwd },
    );
    const sessionId = isRecord(result) ? result['sessionId'] : undefined;
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new ProtocolViolation({
        message: 'session/new returned no sessionId',
        method: 'session/new',
        evidence: core.redact(JSON.stringify(result ?? null).slice(0, 400)),
        stderrExcerpt: client.stderrExcerpt,
      });
    }
    const state = core.registry.register(sessionId, cwd, readConfigOptions(result));
    core.cwdIndex.set(sessionId, cwd);
    if (spec.env !== undefined && Object.keys(spec.env).length > 0) {
      // ACP has one child process per connection and no per-session env; saying so beats ignoring it.
      core.emit(state, {
        kind: 'other',
        payload: { type: 'unsupported-session-env', keys: Object.keys(spec.env) },
      });
      core.log(
        `session ${sessionId}: spec.env is not supported by ACP; use DshExecutorConfig.env or permissionMode`,
      );
    }
    if (spec.model !== undefined || spec.reasoningEffort !== undefined) {
      await core.applyModelSelection(sessionId, {
        model: spec.model,
        reasoningEffort: spec.reasoningEffort,
      });
    }
    return { sessionId, configOptions: state.configOptions };
  }

  async listSessions(): Promise<DshSessionSummary[]> {
    const core = this.#core;
    const result = await core.requireClient().request<unknown>('session/list', {}, {
      timeoutMs: core.config.requestTimeoutMs,
    });
    const rows = isRecord(result) && Array.isArray(result['sessions']) ? result['sessions'] : [];
    const summaries: DshSessionSummary[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const sessionId = row['sessionId'];
      if (typeof sessionId !== 'string') continue;
      const cwd = typeof row['cwd'] === 'string' ? row['cwd'] : undefined;
      if (cwd !== undefined) core.cwdIndex.set(sessionId, cwd);
      summaries.push(cwd === undefined ? { sessionId } : { sessionId, cwd });
    }
    return summaries;
  }

  async resumeSession(sessionId: string, options: DshResumeOptions = {}): Promise<void> {
    const core = this.#core;
    const client = core.requireClient();
    const cwd = options.cwd ?? core.registry.get(sessionId)?.cwd ?? core.cwdIndex.get(sessionId);
    if (cwd === undefined) {
      throw new SessionNotFound({
        sessionId,
        method: 'session/resume',
        message: `no cwd known for session ${sessionId}; pass options.cwd or call listSessions() first`,
      });
    }
    let mcpServers: AcpMcpServer[];
    try {
      mcpServers = toAcpMcpServers(options.mcpServers ?? []);
    } catch (error) {
      throw new ExecutorRequestFailed({
        method: 'session/resume',
        message: `invalid mcpServers: ${describeError(error, core.redact)}`,
        cause: error,
      });
    }
    const result = await client.request<unknown>(
      'session/resume',
      { sessionId, cwd, mcpServers },
      { timeoutMs: core.config.requestTimeoutMs, sessionId, cwd },
    );
    core.registry.register(sessionId, cwd, readConfigOptions(result));
    core.cwdIndex.set(sessionId, cwd);
  }

  async destroySession(sessionId: string): Promise<void> {
    const state = this.#core.registry.get(sessionId);
    if (state === undefined || state.status === 'closed') return;
    const client = this.#core.client;
    if (client?.isRunning === true) {
      try {
        await client.request('session/close', { sessionId }, {
          timeoutMs: this.#core.config.requestTimeoutMs,
          sessionId,
        });
      } catch (error) {
        // Closing an unknown session is the desired end state anyway.
        if (!isSessionNotFound(error)) throw error;
      }
    }
    state.close();
  }

  // --------------------------------------------------------------------- turns

  async runTask(sessionId: string, prompt: string, signal?: AbortSignal): Promise<DshTurnResult> {
    const core = this.#core;
    const client = core.requireClient();
    const state = core.requireLiveSession(sessionId);
    if (state.isRunning) {
      throw new ExecutorRequestFailed({
        method: 'session/prompt',
        code: -32602,
        message: `a prompt is already in flight for session ${sessionId}`,
      });
    }
    if (signal?.aborted === true) return { stopReason: 'cancelled', finalText: '' };
    state.beginTurn();
    const onAbort = (): void => {
      void this.cancel(sessionId);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await client.request<unknown>(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: prompt }] },
        { timeoutMs: core.config.turnTimeoutMs, sessionId },
      );
      const stopReason = isRecord(result) ? result['stopReason'] : undefined;
      if (typeof stopReason !== 'string') {
        throw new ProtocolViolation({
          message: 'session/prompt returned no stopReason',
          method: 'session/prompt',
          evidence: core.redact(JSON.stringify(result ?? null).slice(0, 400)),
          stderrExcerpt: client.stderrExcerpt,
        });
      }
      const settled = state.settleTurn();
      return settled.submission === undefined
        ? { stopReason, finalText: settled.finalText }
        : { stopReason, finalText: settled.finalText, submission: settled.submission };
    } catch (error) {
      state.abandonTurn();
      if (error instanceof RequestTimeout) {
        // Release the session: from our side the turn is over, and the agent pins the route until
        // the prompt settles. The late response lands as a stale-id report, never as an event.
        void this.cancel(sessionId);
        throw new PromptTimeout({ sessionId, timeoutMs: error.timeoutMs, cause: error });
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  sendMessage(sessionId: string, text: string, signal?: AbortSignal): Promise<DshTurnResult> {
    return this.runTask(sessionId, text, signal);
  }

  streamEvents(sessionId: string): AsyncIterable<DshEvent> {
    const state = this.#core.registry.get(sessionId);
    if (state === undefined) throw new SessionNotFound({ sessionId, method: 'streamEvents' });
    return state.events.subscribe();
  }

  /** `session/cancel` is a notification (probe 8.6): no id, no response, safe to call any time. */
  async cancel(sessionId: string): Promise<void> {
    const state = this.#core.registry.get(sessionId);
    const client = this.#core.client;
    if (state === undefined || state.status === 'closed' || client?.isRunning !== true) return;
    client.notify('session/cancel', { sessionId });
  }

  // ------------------------------------------------------------------- config

  async setModel(sessionId: string, model: string, reasoningEffort?: string): Promise<void> {
    await this.#core.applyModelSelection(sessionId, { model, reasoningEffort });
  }

  getStatus(sessionId: string): DshSessionStatus {
    return this.#core.registry.get(sessionId)?.reportedStatus ?? 'unknown';
  }

  // ---------------------------------------------------------------- extensions

  getState(): DshExecutorState {
    return this.#core.state;
  }

  getExecutorPid(): number | undefined {
    return this.#core.client?.childPid;
  }

  getStderrExcerpt(): string {
    return this.#core.client?.stderrExcerpt ?? '';
  }

  getExitReport(): DshExitReport | undefined {
    return this.#core.exitReport;
  }

  getProtocolViolations(): readonly ProtocolViolation[] {
    return [...this.#core.violations];
  }

  getAgentInfo(): unknown {
    return this.#core.agentInfo;
  }

  getAgentCapabilities(): unknown {
    return this.#core.agentCapabilities;
  }

  getSubmission(sessionId: string): DshSubmission | undefined {
    return this.#core.registry.get(sessionId)?.lastSubmission;
  }

  getStreamStats(sessionId: string): DshStreamStats | undefined {
    return this.#core.registry.get(sessionId)?.streamStats;
  }

  getConfigOptions(sessionId: string): readonly DshConfigOption[] | undefined {
    return this.#core.registry.get(sessionId)?.configOptions;
  }

  /** Session record for diagnostics; internal state object, not part of the public contract. */
  getSessionState(sessionId: string): SessionState | undefined {
    return this.#core.registry.get(sessionId);
  }
}

/** Factory: one adapter owns one long-lived child process. */
export function createDshExecutor(config: DshExecutorConfig = {}): DshExecutorAdapter {
  return new DshExecutorAdapter(config);
}
