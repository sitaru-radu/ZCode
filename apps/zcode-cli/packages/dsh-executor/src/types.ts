/**
 * Shared types: the adapter surface frozen by specs/projects/40-dsh-executor.md §3 plus the
 * protocol-level shapes confirmed by the S3/S4/S5 probe (see CONTRACT.md).
 *
 * This file has no imports on purpose: every other module may depend on it.
 */

/** ACP protocol version this adapter speaks. `initialize` must answer with exactly this value. */
export const ACP_PROTOCOL_VERSION = 1;

/** How the child process ended. `code === null` means it was killed by a signal. */
export interface AcpExitInfo {
  readonly code: number | null;
  readonly signal: string | null;
  /** Epoch ms of the `exit` event. */
  readonly at: number;
}

/** Event kinds a caller can observe through `streamEvents`. Frozen by spec §3. */
export type DshEventKind =
  | 'message'
  | 'thought'
  | 'tool_call'
  | 'tool_result'
  | 'config'
  | 'usage'
  | 'other';

/** Normalized `session/update` notification (spec §3). */
export interface DshEvent {
  readonly sessionId: string;
  readonly kind: DshEventKind;
  /** Present for `message` / `thought`; longer text is truncated. */
  readonly text?: string;
  /** Tool title as sent by the agent (`bash`, `write`, `mcp__submit__submit_result`, ...). */
  readonly toolName?: string;
  readonly toolCallId?: string;
  /** Normalized, truncated copy of the raw update. Never the raw object graph. */
  readonly payload?: unknown;
  /** Epoch ms. */
  readonly at: number;
}

/** Session lifecycle as reported by `getStatus` (spec §3). */
export type DshSessionStatus = 'unknown' | 'idle' | 'running' | 'closed';

/** Executor-wide state, exposed as an extension so a runner can pick recovery strategy. */
export type DshExecutorState = 'idle' | 'starting' | 'ready' | 'failed' | 'disposed';

/** One `session/list` row. `updatedAt` is not part of the confirmed result shape. */
export interface DshSessionSummary {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly updatedAt?: number;
}

/** Where a typed worker result came from (spec §5: MCP bridge first, fenced JSON second). */
export type DshSubmissionSource = 'mcp' | 'fenced-json';

export interface DshSubmission {
  readonly value: unknown;
  readonly source: DshSubmissionSource;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly at: number;
}

export interface DshTurnResult {
  readonly stopReason: string;
  readonly finalText: string;
  /** Extension over spec §3: the result the worker submitted, when one was observed. */
  readonly submission?: DshSubmission;
}

/** Counters for the hot `streamEvents` stream. */
export interface DshStreamStats {
  /** Events delivered to at least one attached subscriber. */
  readonly delivered: number;
  /** Events published while no subscriber was attached (spec §3: dropped with a counter). */
  readonly dropped: number;
  /** Events dropped because a subscriber did not keep up with the per-subscriber buffer cap. */
  readonly overflow: number;
  readonly subscribers: number;
}

/** ACP `EnvVariable`: MCP stdio/http entries carry env and headers as arrays, never maps. */
export interface AcpEnvVariable {
  readonly name: string;
  readonly value: string;
}

/** Exact stdio shape `session/new` accepts: no `type` key, absolute `command`, `env` array. */
export interface AcpMcpServerStdio {
  readonly name: string;
  readonly command: string;
  readonly args: string[];
  readonly env: AcpEnvVariable[];
}

/** Exact http shape: `type` present, `headers` array (an incomplete entry is dropped silently). */
export interface AcpMcpServerHttp {
  readonly name: string;
  readonly type: 'http';
  readonly url: string;
  readonly headers: AcpEnvVariable[];
}

export type AcpMcpServer = AcpMcpServerStdio | AcpMcpServerHttp;

/** Caller-facing stdio entry. Env may be a map; it is always sent to the agent as an array. */
export interface DshMcpServerStdio {
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>> | readonly AcpEnvVariable[];
}

/** Caller-facing http entry. `headers` defaults to `[]` because DSH drops header-less entries. */
export interface DshMcpServerHttp {
  readonly name: string;
  readonly type: 'http';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | readonly AcpEnvVariable[];
}

export type DshMcpServer = DshMcpServerStdio | DshMcpServerHttp;

/** One advertised session config option (model, reasoning_effort, ...). Catalogue is not cached. */
export interface DshConfigOption {
  readonly id: string;
  readonly name?: string;
  readonly category?: string;
  readonly type?: string;
  readonly currentValue?: string;
  readonly options?: readonly DshConfigOptionChoice[];
}

export interface DshConfigOptionChoice {
  readonly value?: string;
  readonly name?: string;
  readonly group?: string;
  readonly description?: string;
  readonly options?: readonly DshConfigOptionChoice[];
}

/** `session/new` inputs; frozen by spec §3. */
export interface DshSessionSpec {
  /** Absolute; also the sandbox's writable root (probe gotcha 8.1). */
  cwd: string;
  /** Opaque value from the live catalogue, or a bare model id resolved against it. */
  model?: string;
  reasoningEffort?: string;
  mcpServers?: readonly DshMcpServer[];
  /** Not supported by ACP (one long-lived child per adapter); recorded, never silently applied. */
  env?: Record<string, string>;
}

/** Why the adapter can no longer talk to the child. */
export type DshExitReason = 'exit' | 'protocol-violation' | 'disposed';

export interface DshExitReport extends AcpExitInfo {
  readonly reason: DshExitReason;
  /** Redacted tail of the child's stderr. */
  readonly stderrExcerpt: string;
}
