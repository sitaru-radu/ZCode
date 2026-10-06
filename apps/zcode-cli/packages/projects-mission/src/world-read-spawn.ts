/**
 * The single process choke point of the world reader.
 *
 * Everything that spawns a process — git, the optional ripgrep search, and `world.run` — goes
 * through {@link defaultSpawn}. That keeps one place that owns the three properties the spike
 * report requires of every call:
 *
 *  1. **Fixed argv, never a shell.** No `shell: true` anywhere, so no pipes, redirection or
 *     variable expansion can be expressed by a script.
 *  2. **A pinned environment.** `GIT_TERMINAL_PROMPT=0` (never hang on a credential prompt),
 *     `GIT_CONFIG_NOSYSTEM=1` (user config cannot change parsing), `LC_ALL=C` (stable error
 *     text). `NO_COLOR` keeps captured bytes free of escape sequences.
 *  3. **A timeout on every call.** A hung child is a rejected promise, not a hung run.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

import { failed, timedOut } from "./world-read-errors.js";

/** Options for one child process. */
export interface SpawnOptions {
  /** Working directory of the child. */
  cwd: string;
  /** Environment overrides merged over the pinned base environment. */
  env?: Readonly<Record<string, string>>;
  /** Hard wall clock; the child is killed (SIGKILL) when it expires. */
  timeoutMs: number;
  /** Bytes kept for stdout before the excess is dropped. */
  stdoutLimitBytes: number;
  /** Bytes kept for stderr before the excess is dropped. */
  stderrLimitBytes: number;
}

/** What one child process produced. */
export interface SpawnResult {
  /** Exit code, or `null` when the child died from a signal. */
  exitCode: number | null;
  /** Signal that terminated the child, when one did. */
  signal: NodeJS.Signals | null;
  /** Captured stdout: UTF-8 decoded, the line terminator of the final line removed. */
  stdout: string;
  /** Captured stderr: UTF-8 decoded, the line terminator of the final line removed. */
  stderr: string;
  /** True when stdout exceeded `stdoutLimitBytes` and was dropped from there on. */
  stdoutOverflowed: boolean;
  /** True when stderr exceeded `stderrLimitBytes` and was dropped from there on. */
  stderrOverflowed: boolean;
  /** True when the child was killed because `timeoutMs` expired. */
  timedOut: boolean;
}

/**
 * How the world reader starts a process. Injectable so tests can force spawn failures,
 * timeouts and oversized output without having to find a binary that misbehaves on cue.
 * The default is {@link defaultSpawn}.
 */
export type WorldSpawn = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => Promise<SpawnResult>;

/** The pinned base environment shared by git and `world.run`. */
function baseEnv(overrides: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    LC_ALL: "C",
    NO_COLOR: "1",
    ...overrides,
  };
}

/** Drop the line terminator of the final line, if the buffer ends with one. */
function trimFinalNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

/** One captured stream. */
interface Capture {
  chunks: Buffer[];
  bytes: number;
  overflowed: boolean;
}

/** Append a chunk, keeping at most `limit` bytes and flagging the overflow. */
function appendChunk(capture: Capture, chunk: Buffer, limit: number): void {
  const room = limit - capture.bytes;
  if (room <= 0) {
    capture.overflowed = true;
    return;
  }
  if (chunk.length > room) {
    capture.chunks.push(chunk.subarray(0, room));
    capture.bytes = limit;
    capture.overflowed = true;
    return;
  }
  capture.chunks.push(chunk);
  capture.bytes += chunk.length;
}

/** Best-effort kill: the child may already be gone, and that is not an error. */
function killQuietly(child: ChildProcess): void {
  try {
    child.kill("SIGKILL");
  } catch {
    // The process ended between the check and the kill.
  }
}

/**
 * Default spawn: `spawn(file, args)` with pipes, capped capture buffers, and a hard timeout.
 * Rejects with `WORLD_READ_FAILED` when the process cannot start and `WORLD_READ_TIMEOUT` when
 * it outlives `timeoutMs`; a nonzero exit is a value, not an error.
 */
export const defaultSpawn: WorldSpawn = (file, args, options) =>
  new Promise<SpawnResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = nodeSpawn(file, [...args], {
        cwd: options.cwd,
        env: baseEnv(options.env),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(failed(`cannot start '${file}': ${(error as Error).message}`));
      return;
    }

    const stdout: Capture = { chunks: [], bytes: 0, overflowed: false };
    const stderr: Capture = { chunks: [], bytes: 0, overflowed: false };
    let killedByTimeout = false;
    let settled = false;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      killQuietly(child);
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      appendChunk(stdout, chunk, options.stdoutLimitBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      appendChunk(stderr, chunk, options.stderrLimitBytes);
    });

    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(failed(`cannot start '${file}': ${error.message}`));
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        stdout: trimFinalNewline(Buffer.concat(stdout.chunks).toString("utf8")),
        stderr: trimFinalNewline(Buffer.concat(stderr.chunks).toString("utf8")),
        stdoutOverflowed: stdout.overflowed,
        stderrOverflowed: stderr.overflowed,
        timedOut: killedByTimeout,
      });
    });
  });

/**
 * Run one child process and hand back {@link SpawnResult}, converting the two failure modes
 * that are not observations into structured rejections.
 *
 * `requireCleanExit` is how git calls get their "nonzero is a failure" rule; `world.run` uses
 * `false`, because a failing check is that op's normal case.
 */
export async function runProcess(
  spawn: WorldSpawn,
  file: string,
  args: readonly string[],
  options: SpawnOptions,
  requireCleanExit: boolean,
): Promise<SpawnResult> {
  const result = await spawn(file, args, options);
  if (result.timedOut) {
    throw timedOut(`'${file} ${args.join(" ")}' timed out after ${options.timeoutMs}ms.`);
  }
  if (requireCleanExit && result.exitCode !== 0) {
    const detail = firstLine(result.stderr) || firstLine(result.stdout) || "no output";
    throw failed(
      `'${file} ${args.join(" ")}' exited with ${describeExit(result)}: ${detail}`,
    );
  }
  return result;
}

/** Human-readable exit status for an error message. */
export function describeExit(result: Pick<SpawnResult, "exitCode" | "signal">): string {
  if (result.exitCode !== null) return `exit code ${result.exitCode}`;
  return result.signal === null ? "no exit status" : `signal ${result.signal}`;
}

/** Exit code to report for a process that produced none (killed by a signal). */
export function exitCodeOf(
  result: Pick<SpawnResult, "exitCode" | "signal">,
  signalBase: number,
): number {
  if (result.exitCode !== null) return result.exitCode;
  const number = result.signal === null ? 0 : (SIGNAL_NUMBERS[result.signal] ?? 0);
  return signalBase + number;
}

/** Signal numbers, so a signal death maps onto a shell-like exit code. */
const SIGNAL_NUMBERS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
};

/** First line of a stream, trimmed — the shape every error message wants. */
export function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
}
