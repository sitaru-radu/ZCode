/**
 * ACP transport (spec §2).
 *
 * One client owns one long-lived child (`dsh --profile acp` by default). Responsibilities:
 *  - spawn with an explicitly built environment (config.ts),
 *  - NDJSON framing on stdout only (stderr is free text and never mixed into the protocol),
 *  - monotonic request ids with response/notification correlation,
 *  - a per-request deadline (`RequestTimeout`; `session/prompt` callers turn it into `PromptTimeout`),
 *  - a bounded, redacting stderr ring buffer for error evidence,
 *  - child-exit handling that rejects every in-flight call with `ExecutorExited`,
 *  - `dispose()` that closes stdin (EOF is the agent's clean-shutdown signal, probe 8.13) and only
 *    then escalates to SIGTERM/SIGKILL.
 *
 * Framing policy: a line that is not JSON, or JSON that is not a JSON-RPC frame, is a fatal
 * `ProtocolViolation` — stdout is protocol-only (probe 8.15), so the stream cannot be trusted after
 * that. A response for an unknown id is reported but not fatal: it is the normal outcome of a
 * request that already timed out.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import {
  ExecutorExited,
  ExecutorSpawnFailed,
  PromptTimeout,
  ProtocolViolation,
  RequestTimeout,
  RpcMethodNotFound,
  requestFailedError,
  type RpcErrorShape,
} from './errors.js';
import {
  classifyFrame,
  encodeError,
  encodeNotification,
  encodeRequest,
  encodeResult,
  RPC_INTERNAL_ERROR,
  RPC_METHOD_NOT_FOUND,
} from './jsonrpc.js';
import { ClientDiagnostics } from './diagnostics.js';
import { LineSplitter } from './line-splitter.js';
import type { AcpExitInfo } from './types.js';

export interface AcpClientOptions {
  readonly binary: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly requestTimeoutMs: number;
  readonly maxLineChars?: number;
  readonly stderrBufferLines?: number;
  readonly logSink?: (line: string) => void;
  readonly secrets?: readonly string[];
  readonly onNotification?: (method: string, params: unknown) => void;
  readonly onServerRequest?: (method: string, params: unknown) => unknown | Promise<unknown>;
  readonly onProtocolViolation?: (violation: ProtocolViolation) => void;
  readonly onExit?: (info: AcpExitInfo) => void;
  readonly onDiagnostic?: (message: string) => void;
  readonly disposeGraceMs?: number;
}

export interface AcpRequestOptions {
  readonly timeoutMs?: number;
  readonly sessionId?: string;
  readonly cwd?: string;
}

interface PendingCall {
  readonly method: string;
  readonly sessionId: string | undefined;
  readonly cwd: string | undefined;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

export class AcpClient {
  readonly #options: AcpClientOptions;
  readonly #diag: ClientDiagnostics;
  readonly #splitter: LineSplitter;
  readonly #pending = new Map<number, PendingCall>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #nextId = 1;
  #exitInfo: AcpExitInfo | undefined;
  #fatal: ProtocolViolation | undefined;
  #disposePromise: Promise<void> | undefined;

  constructor(options: AcpClientOptions) {
    this.#options = options;
    this.#diag = new ClientDiagnostics({
      secrets: options.secrets,
      logSink: options.logSink,
      stderrBufferLines: options.stderrBufferLines,
      onProtocolViolation: options.onProtocolViolation,
      onDiagnostic: options.onDiagnostic,
    });
    this.#splitter = new LineSplitter(options.maxLineChars);
  }

  get childPid(): number | undefined {
    return this.#child?.pid ?? undefined;
  }

  get isRunning(): boolean {
    return this.#child !== undefined && this.#exitInfo === undefined && this.#fatal === undefined;
  }

  get exitInfo(): AcpExitInfo | undefined {
    return this.#exitInfo;
  }

  get fatalViolation(): ProtocolViolation | undefined {
    return this.#fatal;
  }

  get violations(): readonly ProtocolViolation[] {
    return [...this.#diag.violations];
  }

  get staleResponseCount(): number {
    return this.#diag.staleResponses;
  }

  get stderrExcerpt(): string {
    return this.#diag.excerpt;
  }

  /** Redacted stderr lines still retained by the ring (for diagnostics and tests). */
  get stderrLines(): readonly string[] {
    return this.#diag.lines;
  }

  /** Stderr lines evicted because the ring is bounded. */
  get stderrDroppedLines(): number {
    return this.#diag.droppedLines;
  }

  /** Spawn the child. Resolves once the OS confirms the process started. */
  async start(): Promise<void> {
    if (this.#child !== undefined) return;
    const child = spawn(this.#options.binary, [...this.#options.args], {
      cwd: this.#options.cwd,
      env: { ...this.#options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.#onStdout(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      this.#diag.pushStderr(chunk);
    });
    child.stdin.on('error', (error: Error) => {
      // EPIPE after the child died; the exit path reports the real failure.
      this.#diag.noteMessage(`stdin error: ${this.#diag.redact(error.message)}`);
    });
    child.on('error', (error: Error) => {
      this.#diag.noteMessage(`child error: ${this.#diag.redact(error.message)}`);
    });
    child.on('exit', (code, signal) => {
      this.#onExit(code, signal);
    });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off('error', onError);
        resolve();
      };
      const onError = (error: Error): void => {
        child.off('spawn', onSpawn);
        this.#exitInfo = { code: null, signal: null, at: Date.now() };
        reject(
          new ExecutorSpawnFailed({
            binary: this.#options.binary,
            args: this.#options.args,
            message: `failed to spawn executor (${this.#options.binary}): ${this.#diag.redact(error.message)}`,
            cause: error,
          }),
        );
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
  }

  /** Send one request and await its response. Never throws a bare Error: see errors.ts. */
  request<T>(method: string, params: unknown, options: AcpRequestOptions = {}): Promise<T> {
    const notRunning = this.#notRunningError();
    if (notRunning !== undefined) return Promise.reject(notRunning);
    const id = this.#nextId;
    this.#nextId += 1;
    const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          method === 'session/prompt'
            ? new PromptTimeout({ sessionId: options.sessionId ?? '', timeoutMs })
            : new RequestTimeout({ method, timeoutMs }),
        );
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        sessionId: options.sessionId,
        cwd: options.cwd,
        resolve: (value: unknown) => {
          resolve(value as T);
        },
        reject,
        timer,
      });
      if (!this.#write(encodeRequest(id, method, params))) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(
          new ExecutorExited({
            message: 'executor stdin is closed',
            exitInfo: this.#exitInfo,
            stderrExcerpt: this.#diag.excerpt,
          }),
        );
      }
    });
  }

  /** Send a notification (no id, no response). Returns false when the pipe is closed. */
  notify(method: string, params: unknown): boolean {
    return this.#write(encodeNotification(method, params));
  }

  /** Close stdin, wait for a clean exit, then escalate. Idempotent. */
  async dispose(): Promise<void> {
    this.#disposePromise ??= this.#doDispose();
    return this.#disposePromise;
  }

  async #doDispose(): Promise<void> {
    const child = this.#child;
    if (child === undefined || this.#exitInfo !== undefined) {
      this.#rejectAll(this.#exitedError('executor disposed'));
      return;
    }
    try {
      child.stdin.end();
    } catch {
      // Already destroyed: the exit wait below still applies.
    }
    const grace = this.#options.disposeGraceMs ?? 5_000;
    if (!(await this.#waitForExit(grace))) {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore: the process may have exited between the check and the call
      }
      if (!(await this.#waitForExit(1_000))) {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }
    this.#rejectAll(this.#exitedError('executor disposed'));
  }

  #waitForExit(ms: number): Promise<boolean> {
    if (this.#exitInfo !== undefined) return Promise.resolve(true);
    const child = this.#child;
    if (child === undefined) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.off('exit', onExit);
        resolve(false);
      }, ms);
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once('exit', onExit);
    });
  }

  #onStdout(chunk: string): void {
    if (this.#fatal !== undefined) return;
    const { lines, oversized } = this.#splitter.push(chunk);
    if (oversized > 0) {
      this.#violate(
        new ProtocolViolation({
          message: `dropped ${String(oversized)} oversized frame(s) from executor stdout`,
          evidence: `maxLineChars=${String(this.#options.maxLineChars ?? 'default')}`,
          stderrExcerpt: this.#diag.excerpt,
        }),
      );
      return;
    }
    for (const line of lines) {
      if (this.#fatal !== undefined) return;
      this.#handleLine(line);
    }
  }

  #handleLine(line: string): void {
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      this.#violate(
        new ProtocolViolation({
          message: 'malformed frame from executor stdout (not JSON)',
          evidence: this.#diag.redact(line.slice(0, 400)),
          stderrExcerpt: this.#diag.excerpt,
        }),
      );
      return;
    }
    const frame = classifyFrame(decoded);
    switch (frame.type) {
      case 'response':
        this.#settle(frame.id, { result: frame.result });
        return;
      case 'error':
        this.#settle(frame.id, { error: frame.error });
        return;
      case 'notification':
        this.#dispatchNotification(frame.method, frame.params);
        return;
      case 'request':
        void this.#dispatchServerRequest(frame.id, frame.method, frame.params);
        return;
      default:
        this.#violate(
          new ProtocolViolation({
            message: `invalid JSON-RPC frame: ${frame.reason}`,
            evidence: this.#diag.redact(line.slice(0, 400)),
            stderrExcerpt: this.#diag.excerpt,
          }),
        );
    }
  }

  #settle(id: number, outcome: { result?: unknown; error?: RpcErrorShape }): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      // Normally a late answer to a call that already timed out; recorded, never fatal.
      this.#diag.staleResponses += 1;
      this.#diag.note(
        new ProtocolViolation({
          message: `response for unknown request id ${String(id)}`,
          evidence: this.#diag.redact(JSON.stringify(outcome).slice(0, 400)),
          fatal: false,
        }),
      );
      return;
    }
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (outcome.error !== undefined) {
      pending.reject(
        requestFailedError({
          method: pending.method,
          rpc: outcome.error,
          serverMessage: this.#diag.redact(outcome.error.message ?? ''),
          sessionId: pending.sessionId,
          cwd: pending.cwd,
        }),
      );
      return;
    }
    pending.resolve(outcome.result);
  }

  #dispatchNotification(method: string, params: unknown): void {
    try {
      this.#options.onNotification?.(method, params);
    } catch (error) {
      this.#diag.noteMessage(
        `notification handler failed for ${method}: ${
          error instanceof Error ? this.#diag.redact(error.message) : String(error)
        }`,
      );
    }
  }

  async #dispatchServerRequest(id: number, method: string, params: unknown): Promise<void> {
    const handler = this.#options.onServerRequest;
    if (handler === undefined) {
      this.#write(encodeError(id, RPC_METHOD_NOT_FOUND, `Method not found: ${method}`));
      return;
    }
    try {
      const result = await handler(method, params);
      this.#write(encodeResult(id, result ?? {}));
    } catch (error) {
      if (error instanceof RpcMethodNotFound) {
        this.#write(encodeError(id, RPC_METHOD_NOT_FOUND, `Method not found: ${method}`));
        return;
      }
      this.#write(
        encodeError(
          id,
          RPC_INTERNAL_ERROR,
          this.#diag.redact(error instanceof Error ? error.message : String(error)),
        ),
      );
    }
  }

  #write(payload: string): boolean {
    const stdin = this.#child?.stdin;
    if (stdin === undefined || stdin.destroyed || !stdin.writable) return false;
    stdin.write(payload);
    return true;
  }

  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#exitInfo !== undefined) return;
    this.#exitInfo = { code, signal: signal ?? null, at: Date.now() };
    this.#diag.flushStderr();
    this.#rejectAll(this.#exitedError(`executor exited (code=${String(code)} signal=${String(signal)})`));
    this.#options.onExit?.(this.#exitInfo);
  }

  #exitedError(message: string): ExecutorExited {
    return new ExecutorExited({
      message,
      exitInfo: this.#exitInfo,
      stderrExcerpt: this.#diag.excerpt,
    });
  }

  #notRunningError(): ExecutorExited | ProtocolViolation | undefined {
    if (this.#fatal !== undefined) return this.#fatal;
    if (this.#child === undefined) return this.#exitedError('executor was never started');
    if (this.#exitInfo !== undefined) return this.#exitedError('executor is not running');
    return undefined;
  }

  #rejectAll(error: unknown): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #violate(violation: ProtocolViolation): void {
    this.#diag.note(violation);
    if (!violation.fatal || this.#fatal !== undefined) return;
    this.#fatal = violation;
    this.#rejectAll(violation);
    void this.dispose();
  }
}
