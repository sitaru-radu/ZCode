/**
 * `files.*` world reads: the file walker, glob matching, text search, and the ripgrep
 * accelerator that is used when `rg` happens to be on PATH.
 *
 * Three contracts hold for every function here:
 *  1. **Caps reject, never truncate.** Each op probes `cap + 1` so "exactly at the cap" and
 *     "cut off at the cap" stay distinguishable.
 *  2. **Paths are workspace-relative with forward slashes.** The value is journaled and
 *     interpolated into model prompts, so it must not vary with the host platform.
 *  3. **Reads never leave the workspace.** Resolution is lexical (no symlink chasing): a
 *     symlink inside the workspace that points outside still passes this layer, which is a
 *     deliberate, documented boundary for read-only observation.
 */

import { open, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { failed, pathEscape, tooLarge } from "./world-read-errors.js";
import { firstLine, runProcess, type WorldSpawn } from "./world-read-spawn.js";
import {
  WORLD_IGNORED_DIRECTORIES,
  WORLD_READ_CAPS,
  type GrepMatch,
} from "./world-read-types.js";

/** Fixed flags of the ripgrep accelerator; the pattern and globs are appended per call. */
export const RIPGREP_ARGV: readonly string[] = [
  // `--hidden` is load-bearing, not cosmetic: ripgrep skips dotfiles by default while the pure
  // walker sees them, so without it a repository would search differently depending on whether
  // `rg` happens to be installed. Ignored directories are excluded explicitly below instead.
  "--hidden",
  "--line-number",
  "--no-heading",
  "--color=never",
  "--json",
];

/** Concurrent directory reads. Bounded to stay clear of EMFILE on wide trees. */
const WALK_CONCURRENCY = 8;

/**
 * Default bound on how many files a walk collects.
 *
 * Deliberately an order of magnitude above the grep match cap: the two are different
 * quantities, and the fallback search must see *every* matching file before it can decide
 * whether the match cap was crossed. A tree with more files than this is past the point where
 * reading them all is a sensible observation, and the op rejects rather than guessing.
 */
export const WALK_MAX_FILES = 200_000;

/** Bytes tolerated from the ripgrep accelerator before the search is treated as an error. */
const RIPGREP_MAX_BYTES = 64 * 1024 * 1024;

/** Getter that is cheap after the first call; the reader probes `rg` once and caches. */
export type AvailabilityProbe = () => Promise<boolean>;

/** Absolute path of `arg` resolved against `root`, or `undefined` when it leaves the root. */
export function resolveInside(root: string, arg: string): string | undefined {
  const resolved = resolve(root, arg);
  const rel = relative(root, resolved);
  // ".." only ever appears at the front of a normalized relative path, so a leading ".."
  // segment (or an absolute result, which `relative` returns across Windows drives) is exactly
  // the "escaped the workspace" case. A `startsWith(root)` string test would be wrong: it
  // would accept a sibling directory whose name merely begins with the root's name.
  const escapes = rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../");
  return escapes || isAbsolute(rel) ? undefined : resolved;
}

/** Resolve a path argument inside the workspace or reject with `WORLD_READ_PATH_ESCAPE`. */
export function requireInside(op: string, root: string, arg: string, what: string): string {
  const resolved = resolveInside(root, arg);
  if (resolved === undefined) {
    throw pathEscape(
      `world-read ${op}: ${what} '${arg}' is outside the workspace; pass a path inside it.`,
    );
  }
  return resolved;
}

/** Absolute path → workspace-relative path with `/` separators. */
export function toWorkspaceRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

/**
 * Compile a glob to a RegExp over `/`-joined workspace-relative paths.
 *
 * - `*` matches within one path segment, `?` matches one character inside a segment.
 * - `**` crosses segments; a leading `**​/` — or a bare pattern with no separator at all, such
 *   as `*.ts` — matches at any depth, which is what a script means by "list the TypeScript
 *   files".
 * - A `./` prefix is dropped and backslashes are read as separators, so a Windows-shaped
 *   pattern behaves like a POSIX one.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = pattern
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
  if (!source.includes("/")) source = `**/${source}`;
  let out = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === "*") {
      if (source[index + 1] === "*") {
        if (source[index + 2] === "/") {
          out += "(?:[^/]+/)*";
          index += 2;
        } else {
          out += ".*";
          index += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      continue;
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Does a workspace-relative path match a glob pattern? */
export function globMatches(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

/**
 * Walk the workspace and return every file whose workspace-relative `/`-joined path matches
 * `pattern`, sorted lexicographically.
 *
 * `limit` bounds how many matching files are collected before the walk stops with
 * `overflowed: true`. Callers that need a complete file list must leave it at
 * {@link WALK_MAX_FILES}: a walker limit below the caller's own cap would stop the walk early
 * and hide exactly the overflow the caller is looking for. `files.glob` passes its own `cap + 1`
 * because for that op the file count *is* the capped quantity.
 *
 * Symlinks are skipped (`withFileTypes` reports them as neither file nor directory) and ignored
 * directories are pruned rather than filtered entry by entry.
 */
export async function walkFiles(
  root: string,
  pattern: string,
  limit: number = WALK_MAX_FILES,
): Promise<{ files: string[]; overflowed: boolean }> {
  const matcher = globToRegExp(pattern);
  const files: string[] = [];
  const pending: string[] = [""];
  let inFlight = 0;
  let overflowed = false;

  const step = async (): Promise<void> => {
    for (;;) {
      if (overflowed) return;
      const dir = pending.pop();
      if (dir === undefined) return;
      const entries = await readdir(join(root, dir), { withFileTypes: true });
      for (const entry of entries) {
        const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!WORLD_IGNORED_DIRECTORIES.includes(entry.name)) pending.push(rel);
          continue;
        }
        if (!entry.isFile() || !matcher.test(rel)) continue;
        files.push(rel);
        if (files.length > limit) {
          overflowed = true;
          return;
        }
      }
    }
  };

  await new Promise<void>((settle, reject) => {
    const startWorker = (): void => {
      inFlight += 1;
      void step()
        .catch(reject)
        .finally(() => {
          inFlight -= 1;
          if (overflowed || (pending.length === 0 && inFlight === 0)) settle();
          else if (pending.length > 0 && inFlight === 0) startWorker();
        });
    };
    for (let index = 0; index < WALK_CONCURRENCY; index += 1) startWorker();
  });

  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { files, overflowed };
}

/**
 * `files.glob(pattern)`: workspace-relative paths, lexicographically sorted.
 *
 * The cap is probed with `cap + 1` matches and the result rejects rather than returning a
 * partial view: a silently shortened file list collapses a fan-out into a single branch with no
 * error to explain it. Sorting is part of the contract — the value is journaled, so it must
 * depend on the tree's contents and nothing else.
 */
export async function globFiles(root: string, pattern: string): Promise<string[]> {
  const cap = WORLD_READ_CAPS.globMaxFiles;
  const { files, overflowed } = await walkFiles(root, pattern, cap);
  if (overflowed || files.length > cap) {
    throw tooLarge(`files.glob: over ${cap} files match (the cap). Narrow the pattern.`);
  }
  return files;
}

/**
 * `files.read(path)`: UTF-8 text of one workspace file.
 *
 * The size is checked on the descriptor that is then read, so a path swapped between the two
 * steps cannot smuggle an unbounded read past the cap.
 */
export async function readFileText(root: string, arg: string): Promise<string> {
  const path = requireInside("read", root, arg, "path");
  const cap = WORLD_READ_CAPS.readMaxBytes;
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    throw failed(`files.read: cannot open '${arg}': ${(error as Error).message}`);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw failed(`files.read: '${arg}' is not a regular file.`);
    if (info.size > cap) {
      throw tooLarge(
        `files.read: '${arg}' is ${info.size} bytes, over the ${cap}-byte cap. ` +
          `Read a narrower file, or hand the path to an agent.`,
      );
    }
    return await handle.readFile({ encoding: "utf8" });
  } catch (error) {
    if ((error as Error).name === "WorldReadError") throw error;
    throw failed(`files.read: cannot read '${arg}': ${(error as Error).message}`);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Callback form of a line scan: return false to stop early. */
type LineVisitor = (line: string, lineNumber: number) => boolean;

/** Read one file as a stream of lines; CRLF and LF both terminate a line. */
async function readLines(path: string, visit: LineVisitor): Promise<void> {
  const handle = await open(path, "r");
  try {
    const stream = handle.createReadStream({ encoding: "utf8" });
    let buffer = "";
    let lineNumber = 0;
    let stopped = false;
    const drain = (final: boolean): void => {
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        lineNumber += 1;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!visit(line, lineNumber)) stopped = true;
        newline = buffer.indexOf("\n");
      }
      if (final && !stopped && buffer.length > 0) {
        lineNumber += 1;
        if (!visit(buffer.replace(/\r$/, ""), lineNumber)) stopped = true;
      }
    };
    for await (const chunk of stream) {
      buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      drain(false);
      if (stopped) return;
    }
    drain(true);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Pure-walker search: one entry per matching line, probing `cap + 1`. */
async function grepWithWalker(
  root: string,
  pattern: string,
  glob: string | undefined,
  cap: number,
): Promise<{ matches: GrepMatch[]; overflowed: boolean }> {
  let matcher: RegExp;
  try {
    matcher = new RegExp(pattern);
  } catch (error) {
    throw failed(
      `files.grep: '${pattern}' is not a valid regular expression: ${(error as Error).message}`,
    );
  }
  // Walk the whole matching set (bounded by WALK_MAX_FILES, not by the match cap): stopping at
  // the match cap would make the result depend on traversal order, which is the silent
  // truncation this module exists to avoid.
  const { files, overflowed } = await walkFiles(root, glob ?? "**");
  if (overflowed) {
    throw tooLarge(
      `files.grep: over ${WALK_MAX_FILES} files match '${glob ?? "**"}' to search. ` +
        `Narrow the glob.`,
    );
  }
  const matches: GrepMatch[] = [];
  for (const file of files) {
    if (matches.length > cap) break;
    const found: GrepMatch[] = [];
    try {
      await readLines(join(root, file), (line, lineNumber) => {
        if (!matcher.test(line)) return true;
        found.push({ path: file, line: lineNumber, text: line });
        return matches.length + found.length <= cap;
      });
    } catch (error) {
      throw failed(`files.grep: cannot read '${file}': ${(error as Error).message}`);
    }
    matches.push(...found);
  }
  return { matches, overflowed: overflowed || matches.length > cap };
}

/** Argument vector for the ripgrep accelerator: fixed flags plus the shared ignore list. */
export function ripgrepArgv(pattern: string, glob: string | undefined): string[] {
  return [
    ...RIPGREP_ARGV,
    ...WORLD_IGNORED_DIRECTORIES.map((name) => `--glob=!**/${name}/**`),
    ...(glob === undefined ? [] : ["--glob", glob]),
    pattern,
    ".",
  ];
}

/** One `rg --json` match event's `data`, narrowed to the fields this module consumes. */
interface RipgrepMatchData {
  line_number?: unknown;
  lines?: { text?: unknown };
}

/** Decode `rg --json` output into matches; unparsable output is a loud failure. */
function parseRipgrepJson(
  stdout: string,
  cap: number,
): { matches: GrepMatch[]; overflowed: boolean } {
  const matches: GrepMatch[] = [];
  for (const raw of stdout.split("\n")) {
    if (raw.length === 0) continue;
    let event: { type?: unknown; data?: Record<string, unknown> };
    try {
      event = JSON.parse(raw) as { type?: unknown; data?: Record<string, unknown> };
    } catch {
      throw failed(`files.grep: cannot parse ripgrep output: ${firstLine(raw)}`);
    }
    if (event.type !== "match") continue;
    // `rg --json` reports one match event per matching line, shaped
    // `{data: {path: {text}, lines: {text}, line_number}}`.
    const data = (event.data ?? {}) as RipgrepMatchData & { path?: { text?: unknown } };
    const path = data.path?.text;
    const text = data.lines?.text;
    const line = data.line_number;
    if (typeof path !== "string" || typeof text !== "string" || typeof line !== "number") continue;
    // `rg` reports the path as it was given on the command line ("./src/a.ts"): normalize it
    // to the workspace-relative form every other op returns.
    matches.push({ path: normalizeSearchPath(path), line, text: text.replace(/\r?\n$/, "") });
    if (matches.length > cap) return { matches, overflowed: true };
  }
  return { matches, overflowed: false };
}

/** `./src/a.ts` → `src/a.ts`; absolute paths are made workspace-relative too. */
function normalizeSearchPath(path: string): string {
  return path.replace(/^\.\//, "");
}

/** Search with the ripgrep accelerator. */
async function grepWithRipgrep(
  spawn: WorldSpawn,
  root: string,
  pattern: string,
  glob: string | undefined,
  cap: number,
  timeoutMs: number,
): Promise<{ matches: GrepMatch[]; overflowed: boolean }> {
  const result = await runProcess(
    spawn,
    "rg",
    ripgrepArgv(pattern, glob),
    {
      cwd: root,
      timeoutMs,
      stdoutLimitBytes: RIPGREP_MAX_BYTES,
      stderrLimitBytes: RIPGREP_MAX_BYTES,
    },
    false,
  );
  // `rg` exits 1 for "no match" — a value — and 2 for a real error (bad regex, unreadable tree).
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw failed(`files.grep: ripgrep failed: ${firstLine(result.stderr) || "no output"}`);
  }
  if (result.stdoutOverflowed) {
    throw tooLarge(
      `files.grep: ripgrep produced over ${RIPGREP_MAX_BYTES} bytes of matches. ` +
        `Narrow the pattern or add a glob.`,
    );
  }
  return parseRipgrepJson(result.stdout, cap);
}

/**
 * Is ripgrep available? Probed once per reader; a miss silently selects the pure walker, so the
 * ops behave identically on a host without `rg` (only slower).
 */
export async function detectRipgrep(spawn: WorldSpawn, root: string): Promise<boolean> {
  try {
    const result = await runProcess(
      spawn,
      "rg",
      ["--version"],
      { cwd: root, timeoutMs: 10_000, stdoutLimitBytes: 64 * 1024, stderrLimitBytes: 64 * 1024 },
      true,
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** What `files.grep` needs from the reader. */
export interface GrepDeps {
  /** Subprocess runner (the ripgrep accelerator). */
  spawn: WorldSpawn;
  /** Workspace root every path is resolved against. */
  root: string;
  /** Cached ripgrep availability. */
  rgAvailable: AvailabilityProbe;
  /** Wall clock for one ripgrep call. */
  timeoutMs: number;
}

/**
 * `files.grep(pattern, glob?)`: one entry per matching line, capped at 2000 matches or 256KB of
 * serialized results, whichever comes first.
 *
 * Both limits reject. The match cap is probed with `cap + 1`; the byte cap is measured on the
 * serialized value, because that is what the journal stores. The fast path (`rg`) and the
 * fallback (the pure walker) apply the same two limits and the same directory ignore list, so
 * the choice of path changes speed and not semantics.
 */
export async function grepFiles(
  deps: GrepDeps,
  pattern: string,
  glob: string | undefined,
): Promise<GrepMatch[]> {
  const cap = WORLD_READ_CAPS.grepMaxMatches;
  const { matches, overflowed } = (await deps.rgAvailable())
    ? await grepWithRipgrep(deps.spawn, deps.root, pattern, glob, cap, deps.timeoutMs)
    : await grepWithWalker(deps.root, pattern, glob, cap);
  if (overflowed || matches.length > cap) {
    throw tooLarge(
      `files.grep: over ${cap} matches (the cap). Narrow the pattern or add a glob.`,
    );
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(matches), "utf8");
  if (serializedBytes > WORLD_READ_CAPS.grepMaxSerializedBytes) {
    throw tooLarge(
      `files.grep: result is ${serializedBytes} bytes, over the ` +
        `${WORLD_READ_CAPS.grepMaxSerializedBytes}-byte cap. Narrow the pattern or add a glob.`,
    );
  }
  return matches;
}

/** Bytes a grep result occupies once serialized (exported so a test can pin the byte cap). */
export function serializedBytesOf(matches: readonly GrepMatch[]): number {
  return Buffer.byteLength(JSON.stringify(matches), "utf8");
}
