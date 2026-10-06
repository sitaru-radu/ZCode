/**
 * World reads for the mission driver: `files.*`, `git.*` and `world.run`.
 *
 * A compiled workflow script calls facade members (`files.glob`, `git.diff`, `world.run`, …);
 * the engine lowers every one of them to `driver.executeWorldRead(op, args)`. This module is
 * that routing table for our driver:
 *
 * ```ts
 * const reader = createWorldReader({ workspaceRoot, worldCwd });
 * await reader.executeWorldRead("git-status", []);
 * ```
 *
 * The op strings are exactly the ones in the `WORLD_READ_REGISTRY` table and the result shapes
 * are exactly the ones in the facade `.d.ts` the script is compiled against. Nothing here is
 * imported from `@zcode/dynamic-workflow`: the world reader stays independently testable and
 * does not depend on a sibling package's build order.
 *
 * Two rules hold for every op:
 *  - **Arguments are validated, never coerced.** `String(args[0])` would turn `undefined` into
 *    a path named "undefined" and report an ENOENT that points nowhere near the mistake.
 *  - **Every failure is a catchable {@link WorldReadError}.** Argument shape, path escape, cap
 *    overflow, timeout and spawn failure all travel as rejections with a stable `code`, so a
 *    script can fall back to another op instead of dying.
 */

import { resolve } from "node:path";

import { invalidArgs, failed, WorldReadError } from "./world-read-errors.js";
import {
  detectRipgrep,
  globFiles,
  grepFiles,
  readFileText,
  type AvailabilityProbe,
} from "./world-read-files.js";
import {
  gitChangedFiles,
  gitDiff,
  gitLog,
  gitStatus,
  type GitDeps,
} from "./world-read-git.js";
import {
  defaultSpawn,
  exitCodeOf,
  firstLine,
  runProcess,
  type SpawnOptions,
  type WorldSpawn,
} from "./world-read-spawn.js";
import {
  GIT_DEFAULT_TIMEOUT_MS,
  WORLD_READ_CAPS,
  type WorldReadOp,
  type WorldRunResult,
} from "./world-read-types.js";

export {
  WORLD_READ_CAPS,
  isWorldReadError,
  type GitCommitResult,
  type GitStatusResult,
  type GrepMatch,
  type WorldReadErrorCode,
  type WorldReadFailure,
  type WorldReadOp,
  type WorldRunResult,
} from "./world-read-types.js";
export { WorldReadError } from "./world-read-errors.js";
export type { SpawnOptions, SpawnResult, WorldSpawn } from "./world-read-spawn.js";

/** Dependencies of {@link createWorldReader}. */
export interface WorldReaderDeps {
  /** Repository root. Paths and git pathspecs are validated against it. */
  workspaceRoot: string;
  /** Directory that commands and file reads resolve against (the integration worktree). */
  worldCwd: string;
  /** Subprocess runner. Defaults to the pinned `node:child_process` spawn. */
  spawn?: WorldSpawn;
  /**
   * Ripgrep availability probe, called once per reader. Defaults to a real `rg --version`
   * probe; injecting one forces either the accelerator or the pure-Node walker, which is how a
   * test pins the fallback path on a host that has ripgrep installed.
   */
  detectRipgrep?: AvailabilityProbe;
  /** Wall clock for one internal git or ripgrep call. Defaults to 60s. */
  timeoutMs?: number;
  /** Default timeout of `world.run` when the script passes no `opts.timeoutMs`. Defaults to 300s. */
  runTimeoutMs?: number;
}

/** What the workflow engine's `executeWorldRead(op, args)` is bound to. */
export interface WorldReader {
  /**
   * Execute one world read. Resolves with the op's result value and rejects (catchably) with a
   * {@link WorldReadError}. Never throws synchronously, and never truncates: a cap that is
   * exceeded is a rejection.
   */
  executeWorldRead(op: WorldReadOp, args: unknown[]): Promise<unknown>;
}

/** Everything one op needs: the roots, the runner, and the resolved timeouts. */
interface OpContext {
  spawn: WorldSpawn;
  workspaceRoot: string;
  worldCwd: string;
  /** Timeout for internal git and ripgrep calls. */
  internalTimeoutMs: number;
  /** Default timeout of `world.run` when the script passes no `opts.timeoutMs`. */
  runTimeoutMs: number;
  /** Cached ripgrep availability probe. */
  rgAvailable: AvailabilityProbe;
}

/** Describe a rejected argument for an error message without echoing its content. */
function describeArg(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}

/** One required string argument, or a structured rejection. */
function requireString(op: string, value: unknown, name: string, index: number): string {
  if (typeof value !== "string") {
    throw invalidArgs(
      `world-read ${op}: arg ${index + 1} (${name}) must be a string, got ${describeArg(value)}.`,
    );
  }
  return value;
}

/**
 * Positional string arguments with an exactly-known name list.
 *
 * Extra arguments reject rather than being ignored: the facade's compile-time signature already
 * makes them impossible, so one arriving at runtime means the lowering or the wire protocol is
 * broken, and silently dropping it hides a bug as an unremarkable read.
 */
function stringArgs(op: string, args: unknown[], names: readonly string[]): string[] {
  if (args.length !== names.length) {
    throw invalidArgs(
      `world-read ${op} takes ${names.length} arguments (${names.join(", ")}), got ${args.length}.`,
    );
  }
  return names.map((name, index) => requireString(op, args[index], name, index));
}

/**
 * Required prefix plus optional tail (`files.grep(pattern, glob?)`, `git.diff(base?, path?)`).
 *
 * An explicit `undefined` in an optional slot counts as absent, because it is writable in a
 * script: `git.diff(undefined, "a.ts")` is legal under `base?: string` and lowering ships the
 * hole through untouched.
 */
function optionalStringArgs(
  op: string,
  args: unknown[],
  required: readonly string[],
  optional: readonly string[],
): (string | undefined)[] {
  const max = required.length + optional.length;
  if (args.length < required.length || args.length > max) {
    const range = required.length === max ? `${max}` : `${required.length}~${max}`;
    throw invalidArgs(
      `world-read ${op} takes ${range} arguments ` +
        `(${[...required, ...optional.map((name) => `${name}?`)].join(", ")}), got ${args.length}.`,
    );
  }
  const out: (string | undefined)[] = required.map((name, index) =>
    requireString(op, args[index], name, index),
  );
  for (const [offset, name] of optional.entries()) {
    const index = required.length + offset;
    const value = args[index];
    out.push(
      index >= args.length || value === undefined
        ? undefined
        : requireString(op, value, name, index),
    );
  }
  return out;
}

/**
 * `git.log(count?)`: an integer in `[1, gitLogMaxCount]`, defaulting to `gitLogDefaultCount`.
 *
 * Over the cap rejects instead of clamping: a script that asked for 500 commits and silently
 * received 100 has a mystery ("why is the history so short?"), while a named cap is a value it
 * can act on.
 */
function countArg(op: string, args: unknown[], max: number, fallback: number): number {
  if (args.length > 1) {
    throw invalidArgs(`world-read ${op} takes at most 1 argument (count?), got ${args.length}.`);
  }
  const raw = args[0];
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw invalidArgs(
      `world-read ${op}: argument 'count' must be an integer >= 1, got ${describeArg(raw)}.`,
    );
  }
  if (raw > max) {
    throw invalidArgs(
      `world-read ${op}: argument 'count'=${raw} is over the cap of ${max}; pass at most ${max}.`,
    );
  }
  return raw;
}

/** `world.run(cmd, args?, opts?)` argument shape. */
function runArgs(
  op: string,
  args: unknown[],
  defaultTimeoutMs: number,
): { argv: string[]; cmd: string; timeoutMs: number } {
  if (args.length < 1 || args.length > 3) {
    throw invalidArgs(
      `world-read ${op} takes 1 to 3 arguments (cmd, args?, opts?), got ${args.length}.`,
    );
  }
  const cmd = requireString(op, args[0], "cmd", 0);

  const rawArgv = args[1];
  let argv: string[] = [];
  if (rawArgv !== undefined) {
    if (!Array.isArray(rawArgv)) {
      throw invalidArgs(
        `world-read ${op}: argument 2 (args) must be an array of strings, ` +
          `got ${describeArg(rawArgv)}.`,
      );
    }
    argv = rawArgv.map((item, index) => {
      if (typeof item !== "string") {
        throw invalidArgs(
          `world-read ${op}: args[${index}] must be a string, got ${describeArg(item)}. ` +
            `Stringify values.`,
        );
      }
      return item;
    });
  }

  const rawOpts = args[2];
  if (rawOpts === undefined) return { argv, cmd, timeoutMs: defaultTimeoutMs };
  if (typeof rawOpts !== "object" || rawOpts === null || Array.isArray(rawOpts)) {
    throw invalidArgs(
      `world-read ${op}: arg 3 (opts) must be an options object or omitted, ` +
        `got ${describeArg(rawOpts)}.`,
    );
  }
  const rawTimeout = (rawOpts as { timeoutMs?: unknown }).timeoutMs;
  if (rawTimeout === undefined) return { argv, cmd, timeoutMs: defaultTimeoutMs };
  if (typeof rawTimeout !== "number" || !Number.isInteger(rawTimeout) || rawTimeout < 1) {
    throw invalidArgs(
      `world-read ${op}: opts.timeoutMs must be an integer >= 1, got ${describeArg(rawTimeout)}.`,
    );
  }
  // Deliberately uncapped upwards: a long-running test is a legitimate thing to gate on, and
  // cancellation remains the outer control.
  return { argv, cmd, timeoutMs: rawTimeout };
}

/**
 * `world.run(cmd, args?, opts?)`: journaled command execution, fixed argv, never a shell.
 *
 * A completed process with a **nonzero exit code resolves** — a failing check is the gating
 * loop's normal case, not an exception. The promise rejects only when the command could not run
 * as an observation at all: it could not be spawned, or it outlived its timeout.
 *
 * stdout and stderr are captured up to 256KB each. Beyond that the excess is dropped and
 * reported through `truncated`; a script that needs bounded output should quiet the command or
 * have it write a file, and an agent can read that file.
 */
async function worldRun(ctx: OpContext, args: unknown[]): Promise<WorldRunResult> {
  const { argv, cmd, timeoutMs } = runArgs("run", args, ctx.runTimeoutMs);
  const stdoutCap = WORLD_READ_CAPS.runStdoutMaxBytes;
  const stderrCap = WORLD_READ_CAPS.runStderrMaxBytes;
  const options: SpawnOptions = {
    cwd: ctx.worldCwd,
    timeoutMs,
    stdoutLimitBytes: stdoutCap,
    stderrLimitBytes: stderrCap,
  };
  let result;
  try {
    result = await ctx.spawn(cmd, argv, options);
  } catch (error) {
    if (error instanceof WorldReadError) throw error;
    throw failed(`world.run '${cmd}' could not be spawned: ${(error as Error).message}`);
  }
  if (result.timedOut) {
    throw new WorldReadError(
      "WORLD_READ_TIMEOUT",
      `world.run '${cmd}' timed out after ${timeoutMs}ms. Raise opts.timeoutMs or narrow the ` +
        `work; a partial observation is never returned.`,
    );
  }
  return {
    exitCode: exitCodeOf(result, 128),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** Resolve one `(op, args)` pair. Split out so every branch stays a single expression. */
async function dispatch(op: string, args: unknown[], ctx: OpContext): Promise<unknown> {
  switch (op) {
    case "glob":
      return await globFiles(ctx.workspaceRoot, stringArgs(op, args, ["pattern"])[0]!);
    case "read":
      return await readFileText(ctx.workspaceRoot, stringArgs(op, args, ["path"])[0]!);
    case "grep": {
      const [pattern, glob] = optionalStringArgs(op, args, ["pattern"], ["glob"]);
      return await grepFiles(grepDeps(ctx), pattern!, glob);
    }
    case "git-changed-files": {
      const [base] = optionalStringArgs(op, args, [], ["base"]);
      return await gitChangedFiles(gitDeps(ctx), base);
    }
    case "git-diff": {
      const [base, path] = optionalStringArgs(op, args, [], ["base", "path"]);
      return await gitDiff(gitDeps(ctx), base, path);
    }
    case "git-status":
      // A no-argument op: an empty name list means "exactly zero arguments", so one extra still
      // fails loudly.
      stringArgs(op, args, []);
      return await gitStatus(gitDeps(ctx));
    case "git-log":
      return await gitLog(
        gitDeps(ctx),
        countArg(op, args, WORLD_READ_CAPS.gitLogMaxCount, WORLD_READ_CAPS.gitLogDefaultCount),
      );
    case "run":
      return await worldRun(ctx, args);
    default:
      throw failed(
        `Unsupported world-read op '${op}'. The op vocabulary is fixed by the world-read ` +
          `registry; a different name is a wiring error.`,
      );
  }
}

/** What the git ops need from the context. */
function gitDeps(ctx: OpContext): GitDeps {
  return { spawn: ctx.spawn, cwd: ctx.worldCwd, timeoutMs: ctx.internalTimeoutMs };
}

/** What `files.grep` needs from the context. */
function grepDeps(ctx: OpContext): {
  spawn: WorldSpawn;
  root: string;
  rgAvailable: AvailabilityProbe;
  timeoutMs: number;
} {
  return {
    spawn: ctx.spawn,
    root: ctx.workspaceRoot,
    rgAvailable: ctx.rgAvailable,
    timeoutMs: ctx.internalTimeoutMs,
  };
}

/**
 * Create the world reader bound to one workspace and one working directory.
 *
 * `workspaceRoot` is the repository root: it is the boundary every path argument is validated
 * against and the root of the file walker. `worldCwd` is where commands run and where `git -C`
 * points — the integration worktree. When the worktree is the repository root the two coincide,
 * and the reader still treats them as separate values, because that is what makes the
 * distinction visible in the ops that need it.
 */
export function createWorldReader(deps: WorldReaderDeps): WorldReader {
  const workspaceRoot = resolve(deps.workspaceRoot);
  const worldCwd = resolve(deps.worldCwd);
  const spawn = deps.spawn ?? defaultSpawn;

  let ripgrepProbe: Promise<boolean> | undefined;
  const ctx: OpContext = {
    spawn,
    workspaceRoot,
    worldCwd,
    internalTimeoutMs: deps.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS,
    runTimeoutMs: deps.runTimeoutMs ?? WORLD_READ_CAPS.runDefaultTimeoutMs,
    rgAvailable: (): Promise<boolean> => {
      // Probed once per reader: "is rg installed" does not change while a run is in flight, and
      // a missing rg selects the pure walker rather than failing the op.
      const probe = deps.detectRipgrep ?? (() => detectRipgrep(spawn, workspaceRoot));
      ripgrepProbe ??= probe();
      return ripgrepProbe;
    },
  };

  return {
    // Declared `async` on purpose: argument validation must surface as a rejection of this
    // call's promise, matching every other failure mode, rather than as a synchronous throw
    // through the engine's dispatch.
    async executeWorldRead(op: WorldReadOp, args: unknown[]): Promise<unknown> {
      try {
        return await dispatch(op, args, ctx);
      } catch (error) {
        if (error instanceof WorldReadError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw failed(`world-read ${op} failed: ${firstLine(message) || "unknown error"}`);
      }
    },
  };
}

/** Re-exported so a caller can build a command argv without guessing the runner's conventions. */
export { runProcess, firstLine } from "./world-read-spawn.js";
