/**
 * Types and caps for the world-read surface of `@zcode/projects-mission`.
 *
 * The op vocabulary mirrors `WORLD_READ_REGISTRY` in `@zcode/dynamic-workflow` (facade
 * container, member) → op, and every result shape mirrors the facade `.d.ts` the workflow
 * script is compiled against. This module deliberately imports nothing from that package:
 * the world reader must be independently testable and must not depend on a sibling's build.
 *
 * The error type is re-exported here so a consumer has one import for the whole vocabulary.
 */

import type { WorldReadError } from "./world-read-errors.js";

export {
  WorldReadError,
  failed,
  invalidArgs,
  isWorldReadError,
  pathEscape,
  timedOut,
  tooLarge,
} from "./world-read-errors.js";

/** The error class re-exported above, in type position for the doc links below. */
export type WorldReadFailure = WorldReadError;

/** One op of the world-read vocabulary, exactly as the registry spells it. */
export type WorldReadOp =
  | "glob"
  | "read"
  | "grep"
  | "git-changed-files"
  | "git-diff"
  | "git-status"
  | "git-log"
  | "run";

/**
 * Structured, catchable failure of one world read. Every op rejects with this class — never a
 * silent truncation and never a bare throw.
 *
 * - `WORLD_READ_INVALID_ARGS` — arity or type of the positional arguments is wrong.
 * - `WORLD_READ_PATH_ESCAPE` — a path would resolve outside the workspace.
 * - `WORLD_READ_TOO_LARGE` — a cap was exceeded (rejection instead of truncation).
 * - `WORLD_READ_TIMEOUT` — the command did not finish inside its timeout.
 * - `WORLD_READ_FAILED` — the observation itself did not hold (spawn failure, git failure,
 *   unreadable file, unsupported op, unparsable git output).
 */
export type WorldReadErrorCode =
  | "WORLD_READ_INVALID_ARGS"
  | "WORLD_READ_PATH_ESCAPE"
  | "WORLD_READ_TOO_LARGE"
  | "WORLD_READ_TIMEOUT"
  | "WORLD_READ_FAILED";

/** One matching line found by `files.grep`. */
export interface GrepMatch {
  /** Workspace-relative path (forward slashes) of the file the match was found in. */
  path: string;
  /** One-based line number of the match. */
  line: number;
  /** The full text of the matching line, without its line terminator. */
  text: string;
}

/** The working tree's status, as reported by `git.status()`. */
export interface GitStatusResult {
  /** Current branch name; absent when HEAD is detached. */
  branch?: string;
  /** True when nothing is staged, modified, or untracked. */
  clean: boolean;
  /** Workspace-relative paths staged for the next commit. */
  staged: string[];
  /** Workspace-relative paths modified in the working tree but not staged. */
  unstaged: string[];
  /** Workspace-relative paths git does not track (honouring `.gitignore`). */
  untracked: string[];
}

/** One commit, as reported by `git.log()`. */
export interface GitCommitResult {
  /** Full commit hash. */
  hash: string;
  /** First line of the commit message. */
  subject: string;
  /** Author name. */
  author: string;
  /** Author date, ISO 8601. */
  date: string;
}

/** The outcome of one `world.run` command, including nonzero exits. */
export interface WorldRunResult {
  /** The process exit code. Nonzero is a normal, returned outcome. */
  exitCode: number;
  /** Captured stdout (UTF-8), up to the stdout cap. */
  stdout: string;
  /** Captured stderr (UTF-8), up to the stderr cap. */
  stderr: string;
}

/**
 * Caps, mirroring `WORLD_READ_CAPS` in `@zcode/dynamic-workflow`. Every cap **rejects**; none
 * truncates, because a silently shortened observation is the one value a script cannot reason
 * about. The `+ 1` probes that turn "exactly at the cap" into "over the cap" live in the ops.
 */
export const WORLD_READ_CAPS = {
  globMaxFiles: 2000,
  grepMaxMatches: 2000,
  grepMaxSerializedBytes: 256 * 1024,
  readMaxBytes: 256 * 1024,
  gitDiffMaxBytes: 512 * 1024,
  gitLogMaxCount: 100,
  gitLogDefaultCount: 20,
  runStdoutMaxBytes: 256 * 1024,
  runStderrMaxBytes: 256 * 1024,
  runDefaultTimeoutMs: 300_000,
} as const;

/** Default wall clock for one internal git call (`git.*` has no per-call timeout knob). */
export const GIT_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Directory names the file walker never descends into. `rg` gets the same list as `!` globs so
 * the two search paths agree on the shape of the world; ignored directories stay prunable rather
 * than being filtered one path at a time.
 */
export const WORLD_IGNORED_DIRECTORIES: readonly string[] = [
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "target",
  "__pycache__",
];
