/**
 * The single choke point for every git invocation in the package.
 *
 * Non-negotiable properties (spike report sections 1.5, 2.3, 7.1, 8):
 * - `-C <path>` only. `--git-dir` without `--work-tree` silently redefines the working tree as the
 *   process cwd and reports bogus deletions (G3), so it is never used and `GIT_DIR`/`GIT_WORK_TREE`
 *   are scrubbed from the child environment.
 * - Config is pinned per invocation instead of written to the repository (`git config` inside a
 *   worktree writes the SHARED config, G8): `core.hooksPath=/dev/null` keeps agent runs hook-free,
 *   `core.pager=cat` guarantees no pager ever intercepts output.
 * - Environment is pinned: `GIT_TERMINAL_PROMPT=0` (never hang on a credential prompt),
 *   `GIT_CONFIG_NOSYSTEM=1`, `LC_ALL=C` (stable, parseable messages).
 * - Every call has a timeout and kills the whole process group, because a killed git can leave
 *   `index.lock` behind.
 * - stderr is diagnostics, never the failure signal: `worktree add` writes normal progress there and
 *   `core.autocrlf` warnings appear on successful commands (G14). Only the exit code decides.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

import { GitError, type GitFailureKind } from './errors.js';

/** Default timeout for local git operations. Tests override it per call when they need to. */
export const DEFAULT_TIMEOUT_MS = 60_000;

const GIT_BINARY = 'git';

/** Pinned with `-c` on every invocation; never written into any repository config. */
const PINNED_CONFIG_ARGS: readonly string[] = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.pager=cat',
];

/** A `--git-dir` in the environment is the same footgun as `--git-dir` on the command line (G3). */
const SCRUBBED_ENV_KEYS: readonly string[] = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_INDEX_VERSION',
  'GIT_CEILING_DIRECTORIES',
];

/**
 * Per-call tuning that higher-level functions accept. Deliberately does NOT contain `cwd`: the
 * directory is always the function's own path argument, so a caller can never redirect a git call
 * to a different tree by passing options through.
 */
export interface CallTuning {
  /** Hard kill after this many ms. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Text written to stdin before it is closed. stdin is always closed, git never waits on it. */
  readonly input?: string;
  readonly signal?: AbortSignal;
  /** Extra environment entries, applied after the pinned set. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface GitCallOptions extends CallTuning {
  /**
   * Directory handed to git as `-C <path>`. Always used; the child process inherits the host cwd so
   * that a missing directory still produces git's own `fatal: cannot change to ...` (exit 128)
   * instead of a spawn error.
   */
  readonly cwd: string;
  /**
   * Exit codes that `gitOrThrow` accepts. `git` itself ignores this field and never throws for a
   * non-zero exit.
   */
  readonly acceptCodes?: readonly number[];
}

export interface GitResult {
  /** Full argv: pinned `-c` options, `-C <absolute cwd>`, then the caller's args. */
  readonly argv: readonly string[];
  readonly cwd: string;
  /** `null` when git was killed by a signal (timeout, abort or explicit kill). */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly durationMs: number;
}

/** Build the exact argv. Exported so tests can assert the pinned options and the `-C` placement. */
export function buildGitArgv(args: readonly string[], cwd: string): string[] {
  return [...PINNED_CONFIG_ARGS, '-C', path.resolve(cwd), ...args];
}

/** Build the pinned child environment. Exported so tests can assert the mandated values. */
export function buildGitEnv(extra?: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of SCRUBBED_ENV_KEYS) delete env[key];
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ASKPASS = 'echo';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.LC_ALL = 'C';
  if (extra !== undefined) Object.assign(env, extra);
  return env;
}

function killProcessTree(child: { pid?: number | undefined; kill: (signal: NodeJS.Signals) => boolean }): void {
  const pid = child.pid;
  if (pid !== undefined && process.platform !== 'win32') {
    try {
      // The child is spawned detached, i.e. it leads its own process group: kill the group so that
      // helpers git spawned (editors, hooks, `sh -c` aliases) die with it.
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      // Not a group leader (or already reaped): fall through to the direct kill.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

function toErrorDetails(result: GitResult, message?: string, kind?: GitFailureKind) {
  return {
    args: result.argv,
    cwd: result.cwd,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    aborted: result.aborted,
    ...(kind === undefined ? {} : { kind }),
    ...(message === undefined ? {} : { message }),
  };
}

/**
 * Run git and capture everything. Resolves for any exit code, including failures: callers decide
 * what a code means (`1` from `rev-parse -q --verify` and `merge-tree` is a normal answer, G5).
 * Rejects with a {@link GitError} only when git could not be started at all.
 */
export function git(args: readonly string[], options: GitCallOptions): Promise<GitResult> {
  const argv = buildGitArgv(args, options.cwd);
  const env = buildGitEnv(options.env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = options.signal;

  return new Promise<GitResult>((resolve, reject) => {
    const startedAt = Date.now();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const child = spawn(GIT_BINARY, argv, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    let timedOut = false;
    let aborted = false;
    let killed = false;

    const kill = (): void => {
      if (killed) return;
      killed = true;
      killProcessTree(child);
    };

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            kill();
          }, timeoutMs)
        : undefined;
    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    // git can exit without reading stdin; that must not become an unhandled EPIPE.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.input ?? '');

    child.on('error', (error: Error) => {
      cleanup();
      const code = (error as NodeJS.ErrnoException).code;
      reject(
        new GitError({
          args: argv,
          cwd: options.cwd,
          exitCode: null,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          timedOut,
          aborted,
          kind: code === 'ENOENT' ? 'git-unavailable' : undefined,
          message: `failed to execute git: ${error.message}`,
          cause: error,
        }),
      );
    });

    child.on('close', (code: number | null) => {
      cleanup();
      resolve({
        argv,
        cwd: options.cwd,
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

/**
 * Run git and throw a {@link GitError} unless the exit code is accepted (default: `0` only).
 * Timeouts, aborts and signal kills are always errors. The thrown error carries the full evidence.
 */
export async function gitOrThrow(args: readonly string[], options: GitCallOptions): Promise<GitResult> {
  const acceptCodes = options.acceptCodes ?? [0];
  const result = await git(args, options);
  if (result.timedOut) {
    throw new GitError(toErrorDetails(result, `git timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`, 'timeout'));
  }
  if (result.aborted) {
    throw new GitError(toErrorDetails(result, 'git was aborted by the caller', 'aborted'));
  }
  if (result.exitCode === null || !acceptCodes.includes(result.exitCode)) {
    throw new GitError(toErrorDetails(result));
  }
  return result;
}
