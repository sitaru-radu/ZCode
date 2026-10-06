/**
 * Typed failure taxonomy for the DSH executor (spec 40-dsh-executor.md §7).
 *
 * Every failure carries a stable `kind` (never parse messages to branch), the raw evidence that
 * produced it (`method`, json-rpc `code`, `data`, stderr excerpt) and a message that has already
 * been through the redactor. `ExecutorRequestFailed` is the general JSON-RPC failure; the spec's
 * named errors are specializations of it so `instanceof ExecutorRequestFailed` still catches them.
 */

import type { AcpExitInfo } from './types.js';

export type DshErrorKind =
  | 'spawn-failed'
  | 'handshake-failed'
  | 'executor-exited'
  | 'request-failed'
  | 'session-create-failed'
  | 'session-not-found'
  | 'request-timeout'
  | 'prompt-timeout'
  | 'protocol-violation';

export interface DshErrorOptions {
  readonly cause?: unknown;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export class DshExecutorError extends Error {
  #kind: DshErrorKind;

  /** Structured, redacted evidence. Safe to log. */
  readonly detail: Record<string, unknown>;

  constructor(kind: DshErrorKind, message: string, options: DshErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.#kind = kind;
    this.detail = { ...options.detail };
  }

  get kind(): DshErrorKind {
    return this.#kind;
  }

  /** Subclasses that refine an inherited failure (e.g. request-failed -> session-not-found). */
  protected retag(kind: DshErrorKind): void {
    this.#kind = kind;
  }
}

/** The `dsh` binary could not be spawned (ENOENT, EACCES, ...). Runner: mission failed, max 1 retry. */
export class ExecutorSpawnFailed extends DshExecutorError {
  readonly binary: string;
  readonly args: readonly string[];

  constructor(input: { binary: string; args: readonly string[]; message?: string; cause?: unknown }) {
    super('spawn-failed', input.message ?? `failed to spawn executor: ${input.binary}`, {
      cause: input.cause,
      detail: { binary: input.binary, args: input.args },
    });
    this.binary = input.binary;
    this.args = input.args;
  }
}

/** `initialize` failed or answered with a protocol version this adapter does not speak. */
export class ExecutorHandshakeFailed extends DshExecutorError {
  readonly method: string;

  constructor(input: {
    method?: string;
    message: string;
    cause?: unknown;
    detail?: Record<string, unknown>;
  }) {
    super('handshake-failed', input.message, { cause: input.cause, detail: input.detail });
    this.method = input.method ?? 'initialize';
  }
}

/** The child exited (or was never started); every in-flight call failed with this error. */
export class ExecutorExited extends DshExecutorError {
  readonly exitInfo: AcpExitInfo | undefined;
  readonly stderrExcerpt: string;

  constructor(input: {
    message?: string;
    exitInfo?: AcpExitInfo;
    stderrExcerpt?: string;
    cause?: unknown;
  }) {
    const suffix =
      input.exitInfo === undefined
        ? ''
        : ` (code=${String(input.exitInfo.code)} signal=${String(input.exitInfo.signal)})`;
    super('executor-exited', input.message ?? `executor is not running${suffix}`, {
      cause: input.cause,
      detail: {
        exitCode: input.exitInfo?.code ?? null,
        exitSignal: input.exitInfo?.signal ?? null,
        stderr: input.stderrExcerpt ?? '',
      },
    });
    this.exitInfo = input.exitInfo;
    this.stderrExcerpt = input.stderrExcerpt ?? '';
  }
}

/** A JSON-RPC call answered with an `error` object that has no more specific mapping. */
export class ExecutorRequestFailed extends DshExecutorError {
  readonly method: string;
  readonly code: number | undefined;
  readonly serverMessage: string | undefined;
  readonly data: unknown;

  constructor(input: {
    method: string;
    code?: number;
    serverMessage?: string;
    data?: unknown;
    message?: string;
    cause?: unknown;
  }) {
    const parts = [`${input.method} failed`];
    if (input.code !== undefined) parts.push(`code=${String(input.code)}`);
    if (input.serverMessage !== undefined && input.serverMessage !== '') parts.push(input.serverMessage);
    super('request-failed', input.message ?? parts.join(': '), {
      cause: input.cause,
      detail: {
        method: input.method,
        code: input.code ?? null,
        serverMessage: input.serverMessage ?? '',
        data: input.data ?? null,
      },
    });
    this.method = input.method;
    this.code = input.code;
    this.serverMessage = input.serverMessage;
    this.data = input.data;
  }
}

/** `session/new` was rejected: bad cwd, malformed MCP entry, MCP startup failure, bad handshake. */
export class SessionCreateFailed extends ExecutorRequestFailed {
  readonly cwd: string;

  constructor(input: {
    cwd: string;
    code?: number;
    serverMessage?: string;
    data?: unknown;
    message?: string;
    cause?: unknown;
  }) {
    const detail =
      input.serverMessage === undefined || input.serverMessage === '' ? '' : `: ${input.serverMessage}`;
    super({
      method: 'session/new',
      code: input.code,
      serverMessage: input.serverMessage,
      data: input.data,
      message: input.message ?? `session/new failed for cwd ${input.cwd}${detail}`,
      cause: input.cause,
    });
    this.retag('session-create-failed');
    this.cwd = input.cwd;
  }
}

/** The agent does not know the session id (or it is not resumable from this connection). */
export class SessionNotFound extends ExecutorRequestFailed {
  readonly sessionId: string;

  constructor(input: {
    sessionId: string;
    method?: string;
    code?: number;
    serverMessage?: string;
    data?: unknown;
    message?: string;
    cause?: unknown;
  }) {
    super({
      method: input.method ?? 'session/resume',
      code: input.code,
      serverMessage: input.serverMessage,
      data: input.data,
      message: input.message ?? `session not found: ${input.sessionId}`,
      cause: input.cause,
    });
    this.retag('session-not-found');
    this.sessionId = input.sessionId;
  }
}

/** A single request exceeded its deadline. The call is rejected; the child keeps running. */
export class RequestTimeout extends DshExecutorError {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(input: { method: string; timeoutMs: number; message?: string; cause?: unknown }) {
    super('request-timeout', input.message ?? `${input.method} timed out after ${String(input.timeoutMs)}ms`, {
      cause: input.cause,
      detail: { method: input.method, timeoutMs: input.timeoutMs },
    });
    this.method = input.method;
    this.timeoutMs = input.timeoutMs;
  }
}

/** The turn deadline expired. Runner: `cancel`, then fail the attempt (spec §7). */
export class PromptTimeout extends RequestTimeout {
  readonly sessionId: string;

  constructor(input: { sessionId: string; timeoutMs: number; message?: string; cause?: unknown }) {
    super({
      method: 'session/prompt',
      timeoutMs: input.timeoutMs,
      message:
        input.message ??
        `session/prompt for ${input.sessionId} timed out after ${String(input.timeoutMs)}ms`,
      cause: input.cause,
    });
    this.retag('prompt-timeout');
    this.sessionId = input.sessionId;
  }
}

/** Malformed frame / oversized line / response for an unknown id: the stream is not trustworthy. */
export class ProtocolViolation extends DshExecutorError {
  readonly method: string | undefined;
  readonly evidence: string | undefined;
  readonly stderrExcerpt: string;
  readonly fatal: boolean;

  constructor(input: {
    message: string;
    method?: string;
    evidence?: string;
    stderrExcerpt?: string;
    fatal?: boolean;
    detail?: Record<string, unknown>;
  }) {
    const fatal = input.fatal ?? true;
    super('protocol-violation', input.message, {
      detail: {
        ...input.detail,
        method: input.method ?? null,
        fatal,
        evidence: input.evidence ?? '',
      },
    });
    this.method = input.method;
    this.evidence = input.evidence;
    this.stderrExcerpt = input.stderrExcerpt ?? '';
    this.fatal = fatal;
  }
}

/** Thrown by the client's server-request hook: answered as JSON-RPC `-32601`. */
export class RpcMethodNotFound extends Error {
  constructor(method: string) {
    super(`method not found: ${method}`);
    this.name = 'RpcMethodNotFound';
  }
}

export function isDshExecutorError(value: unknown): value is DshExecutorError {
  return value instanceof DshExecutorError;
}

export function isProtocolViolation(value: unknown): value is ProtocolViolation {
  return value instanceof ProtocolViolation;
}

export function isExecutorExited(value: unknown): value is ExecutorExited {
  return value instanceof ExecutorExited;
}

export function isSessionNotFound(value: unknown): value is SessionNotFound {
  return value instanceof SessionNotFound;
}

/** JSON-RPC error object as it arrives on the wire. */
export interface RpcErrorShape {
  readonly code: number;
  readonly message?: string;
  readonly data?: unknown;
}

/**
 * Deliberately narrow: `-32602` also carries "unknown session config option: x" (probe §3), which is
 * a configuration error, not a missing session. Text matching is the only discriminator the protocol
 * offers here, so it is kept to phrases that can only mean the session itself is gone.
 */
const NOT_FOUND_PATTERNS: readonly RegExp[] = [
  /session not found/i,
  /no such session/i,
  /unknown session id/i,
  /session does not exist/i,
  /not found: [0-9a-fA-F-]{8,}/,
];

/**
 * Map a JSON-RPC error to the taxonomy. Message text is used only where the protocol gives no
 * discriminator (probe evidence: `-32602` is both "unknown config option" and "session not found").
 */
export function requestFailedError(input: {
  method: string;
  rpc: RpcErrorShape;
  serverMessage: string;
  sessionId?: string;
  cwd?: string;
}): DshExecutorError {
  const { method, rpc, serverMessage } = input;
  if (method === 'session/new') {
    return new SessionCreateFailed({
      cwd: input.cwd ?? '',
      code: rpc.code,
      serverMessage,
      data: rpc.data,
    });
  }
  const notFound = NOT_FOUND_PATTERNS.some((pattern) => pattern.test(serverMessage));
  if (input.sessionId !== undefined && notFound) {
    return new SessionNotFound({
      sessionId: input.sessionId,
      method,
      code: rpc.code,
      serverMessage,
      data: rpc.data,
    });
  }
  return new ExecutorRequestFailed({ method, code: rpc.code, serverMessage, data: rpc.data });
}
