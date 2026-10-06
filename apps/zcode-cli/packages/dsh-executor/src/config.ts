/**
 * Executor configuration (spec 40-dsh-executor.md §9) and the child environment builder.
 *
 * Two rules from the probe drive this file:
 *  - The child environment is built explicitly (`PATH`, `HOME`, plus configured values only);
 *    ambient secrets are never forwarded wholesale (spec §9, last paragraph).
 *  - `DSH_PERMISSION_MODE` is the sandbox knob: under the default `workspace-write`, a write to an
 *    absolute path outside the session cwd can report success and never reach the host (probe 8.1),
 *    so callers that need strict persistence semantics must start workers with
 *    `danger-full-access`. Exposed as `permissionMode` / `env.DSH_PERMISSION_MODE`.
 */

import os from 'node:os';

import type { DshEvent } from './types.js';

export const DSH_PERMISSION_MODE_ENV = 'DSH_PERMISSION_MODE';

export type DshPermissionMode = 'workspace-write' | 'danger-full-access';
export type DshPermissionPolicy = 'deny-unapproved' | 'allow-all';

export interface DshExecutorConfig {
  /** Default `dsh` from `PATH`. */
  binary?: string;
  /** Default `acp`. */
  profile?: string;
  /** Extra launcher args appended after `--profile <profile>`. */
  args?: readonly string[];
  /** Per-request deadline for control calls. Default 30_000. */
  requestTimeoutMs?: number;
  /** Turn deadline for `session/prompt`. Default 15 * 60_000. */
  turnTimeoutMs?: number;
  /** Merged over the scrubbed parent environment. */
  env?: Readonly<Record<string, string>>;
  /** Receives redacted stderr lines and adapter diagnostics. */
  logSink?: (line: string) => void;
  /** How `session/request_permission` is answered if it ever arrives (probe 8.14). Default: deny. */
  permissionPolicy?: DshPermissionPolicy;
  /** Sandbox mode exported to the child as `DSH_PERMISSION_MODE`. Unset means the agent default. */
  permissionMode?: DshPermissionMode;
  /** Working directory of the spawned child. Default `process.cwd()`. */
  childCwd?: string;
  /** Frame cap; a longer line is dropped and reported as a protocol violation. Default 8 MiB. */
  maxLineChars?: number;
  /** Retained stderr lines. Default 200. */
  stderrBufferLines?: number;
  clientName?: string;
  clientVersion?: string;
  /** MCP server name used by the `submit_result` bridge. Must match `^[A-Za-z0-9_-]{1,32}$`. */
  submitServerName?: string;
  /** Tool name the bridge exposes; matched as `mcp__*__<submitToolName>`. */
  submitToolName?: string;
  /** Extra literal secrets to redact from stderr and error messages. */
  secrets?: readonly string[];
  /** How long `dispose()` waits for a clean exit before SIGKILL. Default 5_000. */
  disposeGraceMs?: number;
  /** Callback for adapter-level diagnostics (protocol violations, ignored spec fields). */
  onDiagnostic?: (event: DshEvent | { sessionId?: string; message: string; at: number }) => void;
}

export interface ResolvedDshExecutorConfig {
  readonly binary: string;
  readonly profile: string;
  readonly args: readonly string[];
  readonly requestTimeoutMs: number;
  readonly turnTimeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
  readonly logSink: ((line: string) => void) | undefined;
  readonly permissionPolicy: DshPermissionPolicy;
  readonly permissionMode: DshPermissionMode | undefined;
  readonly childCwd: string;
  readonly maxLineChars: number;
  readonly stderrBufferLines: number;
  readonly clientName: string;
  readonly clientVersion: string;
  readonly submitServerName: string;
  readonly submitToolName: string;
  readonly secrets: readonly string[];
  readonly disposeGraceMs: number;
  readonly onDiagnostic: DshExecutorConfig['onDiagnostic'];
}

export const DEFAULT_BINARY = 'dsh';
export const DEFAULT_PROFILE = 'acp';
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_TURN_TIMEOUT_MS = 15 * 60_000;
export const DEFAULT_MAX_LINE_CHARS = 8 * 1024 * 1024;
export const DEFAULT_STDERR_BUFFER_LINES = 200;
export const DEFAULT_SUBMIT_SERVER_NAME = 'submit';
export const DEFAULT_SUBMIT_TOOL_NAME = 'submit_result';
export const DEFAULT_DISPOSE_GRACE_MS = 5_000;
export const DEFAULT_CLIENT_NAME = '@zcode/dsh-executor';
export const DEFAULT_CLIENT_VERSION = '0.1.0';

export function resolveConfig(config: DshExecutorConfig = {}): ResolvedDshExecutorConfig {
  return {
    binary: config.binary ?? DEFAULT_BINARY,
    profile: config.profile ?? DEFAULT_PROFILE,
    args: [...(config.args ?? [])],
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    turnTimeoutMs: config.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
    env: { ...config.env },
    logSink: config.logSink,
    permissionPolicy: config.permissionPolicy ?? 'deny-unapproved',
    permissionMode: config.permissionMode,
    childCwd: config.childCwd ?? process.cwd(),
    maxLineChars: config.maxLineChars ?? DEFAULT_MAX_LINE_CHARS,
    stderrBufferLines: config.stderrBufferLines ?? DEFAULT_STDERR_BUFFER_LINES,
    clientName: config.clientName ?? DEFAULT_CLIENT_NAME,
    clientVersion: config.clientVersion ?? DEFAULT_CLIENT_VERSION,
    submitServerName: config.submitServerName ?? DEFAULT_SUBMIT_SERVER_NAME,
    submitToolName: config.submitToolName ?? DEFAULT_SUBMIT_TOOL_NAME,
    secrets: [...(config.secrets ?? [])],
    disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
    onDiagnostic: config.onDiagnostic,
  };
}

/** Launcher argv after the binary: `--profile <profile> [extra args...]`. */
export function buildChildArgs(config: ResolvedDshExecutorConfig): string[] {
  const args: string[] = [];
  if (config.profile !== '') args.push('--profile', config.profile);
  args.push(...config.args);
  return args;
}

/**
 * Explicit child environment. `PATH` is required to resolve the binary, `HOME` is required by the
 * harness session store; on Windows `SystemRoot`/`ComSpec`/`PATHEXT` are required to spawn shims.
 * Everything else must be configured on purpose.
 */
export function buildChildEnv(
  config: ResolvedDshExecutorConfig,
  parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  const path = parent['PATH'] ?? parent['Path'] ?? '';
  if (path !== '') env['PATH'] = path;
  const home = parent['HOME'] ?? parent['USERPROFILE'] ?? os.homedir();
  if (home !== '') env['HOME'] = home;
  if (process.platform === 'win32') {
    for (const name of ['SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) {
      const value = parent[name];
      if (typeof value === 'string' && value !== '') env[name] = value;
    }
  }
  if (config.permissionMode !== undefined) env[DSH_PERMISSION_MODE_ENV] = config.permissionMode;
  for (const [name, value] of Object.entries(config.env)) env[name] = value;
  return env;
}
