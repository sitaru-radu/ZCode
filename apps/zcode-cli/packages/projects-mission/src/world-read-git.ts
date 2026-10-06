/**
 * `git.*` world reads.
 *
 * Read-only **by construction**, not by permission. This module can only build the argument
 * vectors of four allowlisted subcommands, every one of them with `-C <path>` and never a
 * shell string; a base ref passes a strict character set (no leading `-`, no `..` range) and a
 * path is always workspace-relative and always placed after `--`. There is no call this surface
 * can express that writes.
 *
 * Two output contracts, both load-bearing:
 *  1. **`-z` everywhere paths are listed.** Without it git C-quotes non-ASCII paths and a
 *     filename containing a newline silently splits into two non-existent paths.
 *  2. **Every returned path is workspace-relative.** On the wire git reports repository-root
 *     relative paths, so `rev-parse --show-prefix` is stripped once, here. Contrary to the
 *     facade's promise, an escaping path is a loud failure rather than a value: the pathspec
 *     scoped the read, so a path outside it means the scoping is broken.
 *
 * `git.log` is the deliberate exception to the workspace scoping, because commits are
 * repository-wide objects rather than paths.
 */

import { failed, tooLarge } from "./world-read-errors.js";
import { runProcess, type SpawnOptions, type WorldSpawn } from "./world-read-spawn.js";
import {
  WORLD_READ_CAPS,
  type GitCommitResult,
  type GitStatusResult,
} from "./world-read-types.js";

/** Environment pinned onto every git call, on top of the spawn module's base environment. */
export const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  LC_ALL: "C",
};

/** Flags prepended to every git invocation: never run repository hooks, never page. */
export const GIT_PREFIX_ARGV: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.pager=cat",
];

/** `git status --porcelain=v2` for the workspace. */
export const GIT_STATUS_ARGV: readonly string[] = [
  "status",
  "--porcelain=v2",
  "-z",
  "--branch",
  "--",
  ".",
];

/** `git ls-files --others --exclude-standard`; `--full-name` aligns it with status/diff. */
export const GIT_UNTRACKED_ARGV: readonly string[] = [
  "ls-files",
  "--others",
  "--exclude-standard",
  "-z",
  "--full-name",
  "--",
  ".",
];

/** Record and field separators of the log format; neither can occur in the four fields. */
const LOG_RECORD_SEPARATOR = "\u001e";
const LOG_FIELD_SEPARATOR = "\u001f";

/** `git log` format: hash, subject, author name, author date (ISO 8601). */
export const GIT_LOG_PRETTY = `--pretty=format:%H${LOG_FIELD_SEPARATOR}%s${LOG_FIELD_SEPARATOR}%an${LOG_FIELD_SEPARATOR}%aI${LOG_RECORD_SEPARATOR}`;

/** Inline ceiling for the text-producing git ops (path lists, status, log). */
const GIT_TEXT_MAX_BYTES = 4 * 1024 * 1024;

/** Git commands never use `--git-dir`: `-C` is the only accepted way to pick a worktree. */
const GIT_EXECUTABLE = "git";

/** What a git op needs from the reader. */
export interface GitDeps {
  /** Subprocess runner. */
  spawn: WorldSpawn;
  /** `-C` target: the directory git commands run against. */
  cwd: string;
  /** Wall clock for one git call. */
  timeoutMs: number;
}

/** Options for one git call, with the reader's pinned timeout already applied. */
function gitOptions(deps: GitDeps, stdoutLimitBytes: number): SpawnOptions {
  return {
    cwd: deps.cwd,
    env: GIT_ENV,
    timeoutMs: deps.timeoutMs,
    stdoutLimitBytes,
    stderrLimitBytes: 64 * 1024,
  };
}

/** Run one git command that must exit 0, returning its stdout. */
async function gitText(
  deps: GitDeps,
  argv: readonly string[],
  stdoutLimitBytes: number,
): Promise<string> {
  const result = await runProcess(
    deps.spawn,
    GIT_EXECUTABLE,
    [...GIT_PREFIX_ARGV, "-C", deps.cwd, ...argv],
    gitOptions(deps, stdoutLimitBytes),
    true,
  );
  if (result.stdoutOverflowed) {
    throw tooLarge(
      `git ${argv[0] ?? ""}: output is over ${stdoutLimitBytes} bytes. Narrow the request.`,
    );
  }
  return result.stdout;
}

/**
 * `git.changedFiles(base?)`.
 *
 * With no base this is the union of two commands: `diff --name-only HEAD` plus
 * `ls-files --others --exclude-standard`, because a brand-new file is a change to anyone
 * reading. With a base it is one command — "what changed relative to this ref" is a question
 * about tracked history, and a file git has never seen cannot be compared with any ref.
 * The union is deduplicated and sorted: the journal stores this value, so it must depend on
 * content rather than on which command finished first.
 */
export async function gitChangedFiles(deps: GitDeps, base: string | undefined): Promise<string[]> {
  const ref = base === undefined ? "HEAD" : validateGitRef("git-changed-files", base);
  const plans: string[][] = [["diff", "--name-only", "-z", ref, "--", "."]];
  if (base === undefined) plans.push([...GIT_UNTRACKED_ARGV]);
  const prefix = await gitWorkspacePrefix(deps);
  const paths: string[] = [];
  for (const argv of plans) {
    paths.push(...parsePathList(await gitText(deps, argv, GIT_TEXT_MAX_BYTES), prefix));
  }
  return [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * `git.diff(base?, path?)`: a unified patch, capped at 512KB.
 *
 * `--relative` is required rather than cosmetic: the patch's `a/… b/…` headers are written by
 * git and cannot be re-prefixed afterwards, so the base has to be the workspace. Without it
 * `changedFiles()` and `diff()` would disagree about what changed. The explicit `-- .`
 * pathspec is redundant next to `--relative` and kept on purpose: the scoping should not
 * quietly depend on another flag's side effect.
 */
export async function gitDiff(
  deps: GitDeps,
  base: string | undefined,
  path: string | undefined,
): Promise<string> {
  const cap = WORLD_READ_CAPS.gitDiffMaxBytes;
  const ref = base === undefined ? "HEAD" : validateGitRef("git-diff", base);
  const pathspec = path === undefined ? "." : validateGitPath("git-diff", path);
  const result = await runProcess(
    deps.spawn,
    GIT_EXECUTABLE,
    [...GIT_PREFIX_ARGV, "-C", deps.cwd, "diff", "--relative", ref, "--", pathspec],
    gitOptions(deps, cap + 1),
    true,
  );
  const bytes = Buffer.byteLength(result.stdout, "utf8");
  if (bytes > cap || result.stdoutOverflowed) {
    throw tooLarge(
      `git.diff: output is ${bytes} bytes, over the ${cap}-byte cap. Pass a path to narrow.`,
    );
  }
  return result.stdout;
}

/** `git.status()`: the working tree as git.status() reports it, scoped to the workspace. */
export async function gitStatus(deps: GitDeps): Promise<GitStatusResult> {
  const prefix = await gitWorkspacePrefix(deps);
  return parseStatusPorcelainV2(await gitText(deps, GIT_STATUS_ARGV, GIT_TEXT_MAX_BYTES), prefix);
}

/**
 * `git.log(count?)`: newest first, repository-wide.
 *
 * No pathspec, deliberately and unlike the rest of the family: a commit is a repository-level
 * object, and adding a pathspec would silently redefine the op as "commits that touched the
 * workspace".
 */
export async function gitLog(deps: GitDeps, count: number): Promise<GitCommitResult[]> {
  const argv = ["log", `-n${count}`, GIT_LOG_PRETTY];
  return parseLog(await gitText(deps, argv, GIT_TEXT_MAX_BYTES));
}

/** Workspace-relative prefix of the repository root (empty when they are the same directory). */
async function gitWorkspacePrefix(deps: GitDeps): Promise<string> {
  const stdout = await gitText(deps, ["rev-parse", "--show-prefix"], 64 * 1024);
  return stdout.replace(/\r?\n$/, "");
}

/**
 * Base ref validation. The only security-relevant rule is the first character: a base starting
 * with `-` would be read by git as an option, and which options exist is not ours to decide.
 * `..` ranges and reflog/syntax characters are excluded because v1 accepts a single plain ref.
 */
export function validateGitRef(op: string, value: string): string {
  if (value.length === 0) {
    throw failed(`world-read ${op}: base must not be empty. Pass a ref such as "main" or omit it.`);
  }
  if (value.startsWith("-")) {
    throw failed(
      `world-read ${op}: base '${value}' starts with '-', which git would read as an option, ` +
        `not a ref. Pass a plain ref.`,
    );
  }
  if (value.includes("..")) {
    throw failed(
      `world-read ${op}: base '${value}' is a '..' range; only a single ref is accepted.`,
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@^~-]*$/.test(value)) {
    throw failed(
      `world-read ${op}: base '${value}' is not a valid ref. A ref starts with a letter or ` +
        `digit, followed by letters, digits and . _ / @ ^ ~ - (no whitespace or {} :).`,
    );
  }
  return value;
}

/** Path validation: workspace-relative, no `..` segment, no leading `-`, forward slashes. */
export function validateGitPath(op: string, value: string): string {
  if (value.length === 0) {
    throw failed(`world-read ${op}: path must not be empty. Pass a workspace-relative path.`);
  }
  if (value.startsWith("-")) {
    throw failed(
      `world-read ${op}: path '${value}' starts with '-', which git could read as an option.`,
    );
  }
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]?/.test(value)) {
    throw failed(
      `world-read ${op}: path '${value}' is absolute; only workspace-relative paths are ` +
        `accepted.`,
    );
  }
  // Normalize separators *before* the `..` test, or `..\x` would slip past the segment split.
  const normalized = value.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) {
    throw failed(
      `world-read ${op}: path '${value}' contains a '..' segment and would leave the workspace.`,
    );
  }
  return normalized;
}

/** Split `-z` output into segments; the trailing NUL only ever produces an empty segment. */
function nulSegments(stdout: string): string[] {
  return stdout.split("\u0000").filter((segment) => segment.length > 0);
}

/** Strip the workspace prefix; a path outside it is a broken scoping assumption, not a value. */
function stripWorkspacePrefix(prefix: string, path: string): string {
  if (prefix.length === 0) return path;
  if (path.startsWith(prefix)) return path.slice(prefix.length);
  throw failed(
    `git reported path '${path}' outside the workspace prefix '${prefix}'. The pathspec should ` +
      `have scoped the read to the workspace; report this as a bug.`,
  );
}

/**
 * Parse `git status --porcelain=v2 -z --branch`.
 *
 * Segment kinds: `#` header, `1` ordinary, `2` rename/copy, `u` unmerged, `?` untracked,
 * `!` ignored. The two `XY` characters are the staged and the working-tree state, so one file
 * can legitimately appear in both `staged` and `unstaged`. Rename/copy records consume one
 * extra segment (the original path, which is not reported: the caller asked what changed
 * *now*). The path is the record's tail, never a fixed-index field, because a path may contain
 * spaces.
 */
export function parseStatusPorcelainV2(stdout: string, prefix = ""): GitStatusResult {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  let branch: string | undefined;

  const segments = nulSegments(stdout);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment.startsWith("# branch.head ")) {
      const head = segment.slice("# branch.head ".length);
      // A detached HEAD reports the literal "(detached)"; branch stays absent rather than
      // carrying a placeholder a script would happily diff against.
      if (head !== "(detached)") branch = head;
      continue;
    }
    if (segment.startsWith("#")) continue;

    const kind = segment[0];
    if (kind === "1" || kind === "2") {
      const xy = segment.split(" ")[1] ?? "..";
      const path = fieldTail(segment, kind === "1" ? 8 : 9);
      if (kind === "2") index += 1;
      if (path.length === 0) continue;
      const relative = stripWorkspacePrefix(prefix, path);
      if (xy[0] !== undefined && xy[0] !== ".") staged.push(relative);
      if (xy[1] !== undefined && xy[1] !== ".") unstaged.push(relative);
      continue;
    }
    if (kind === "u") {
      // Unmerged is pending work in the working tree; counting it as staged would claim a
      // conflicted file is ready to commit.
      const path = fieldTail(segment, 10);
      if (path.length > 0) unstaged.push(stripWorkspacePrefix(prefix, path));
      continue;
    }
    if (kind === "?") {
      const path = fieldTail(segment, 1);
      if (path.length > 0) untracked.push(stripWorkspacePrefix(prefix, path));
    }
  }

  return {
    ...(branch === undefined ? {} : { branch }),
    clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
    staged: sortedUnique(staged),
    unstaged: sortedUnique(unstaged),
    untracked: sortedUnique(untracked),
  };
}

/**
 * Parse {@link GIT_LOG_PRETTY} output.
 *
 * Records are separated by U+001E and fields by U+001F, so a subject, an author name or a date
 * containing any printable character — a newline can never reach either field — parses
 * unambiguously. A record without exactly four fields means the format and the parser drifted
 * apart, which is a loud failure: a half-filled commit would flow into the journal and into the
 * model's context.
 */
export function parseLog(stdout: string): GitCommitResult[] {
  const commits: GitCommitResult[] = [];
  for (const raw of stdout.split(LOG_RECORD_SEPARATOR)) {
    // Only structural newlines are removed — never whitespace *inside* a field, because a commit
    // subject is allowed to start with a space and the value is journaled verbatim.
    const record = raw.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    if (record.length === 0) continue;
    const fields = record.split(LOG_FIELD_SEPARATOR);
    if (fields.length !== 4) {
      throw failed(
        `world-read git-log: cannot parse the output; a record should have 4 fields, got ` +
          `${fields.length}. Retry, and report this as a bug if it persists.`,
      );
    }
    commits.push({
      hash: fields[0]!,
      subject: fields[1]!,
      author: fields[2]!,
      date: fields[3]!,
    });
  }
  return commits;
}

/** Parse a `-z` path list (git reports repository-root relative paths; strip the prefix). */
export function parsePathList(stdout: string, prefix = ""): string[] {
  return nulSegments(stdout).map((path) => stripWorkspacePrefix(prefix, path));
}

/** The whole remainder of a porcelain record from its `index`-th space-separated field on. */
function fieldTail(line: string, index: number): string {
  let at = 0;
  for (let i = 0; i < index; i += 1) {
    const next = line.indexOf(" ", at);
    if (next === -1) return "";
    at = next + 1;
  }
  return line.slice(at);
}

/** Deduplicate and sort: journaled values must not depend on git's output order. */
function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
