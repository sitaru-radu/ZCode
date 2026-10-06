/**
 * Real tests for the world reader: every test drives the public surface
 * (`createWorldReader(...).executeWorldRead(op, args)`) against a scratch repository under the
 * system temp directory. Nothing outside the scratch directory is read or written, and the
 * `after` hook removes it.
 */

import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createWorldReader, WorldReadError } from "../src/world-read.js";
import type {
  GrepMatch,
  GitCommitResult,
  GitStatusResult,
  WorldReadOp,
  WorldRunResult,
} from "../src/world-read-types.js";

/** Ripgrep is optional: `grep` falls back to a Node walker when it is absent. */
let ripgrepAvailable = false;

/** Long line (610 bytes) used to drive the grep byte cap: under the match cap, over the byte cap. */
const LONG_LINE = `needle-long ${"x".repeat(600)}`;

/** Node executable for the `world.run` tests. */
const NODE = process.execPath;

/** Scratch root, scratch repositories and the readers bound to them. */
let scratchDir = "";
let scriptRepo = "";
let gitRepo = "";
let scriptWorld: ReturnType<typeof createWorldReader>;
let gitWorld: ReturnType<typeof createWorldReader>;
let limitedWorld: ReturnType<typeof createWorldReader>;
let walkerWorld: ReturnType<typeof createWorldReader>;

/** Run a git command in `cwd`, failing the test on a nonzero exit. */
function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        error === null ? resolve(stdout) : reject(new Error(`${error.message}\n${stderr}`)),
    );
  });
}

/** Read one file of the script repository. */
async function writeScriptFile(relativePath: string, content: string): Promise<void> {
  const absolute = path.join(scriptRepo, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

/** Commit with a fixed identity and date, so `git.log` assertions stay exact. */
async function commit(message: string, date: string): Promise<void> {
  await writeFile(path.join(gitRepo, "src", "note.txt"), `${message}\n`, "utf8");
  await runGit(gitRepo, ["add", "-A"]);
  return await new Promise((resolve, reject) => {
    execFile(
      "git",
      ["commit", "-q", "-m", message],
      {
        cwd: gitRepo,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
          GIT_AUTHOR_NAME: "Ada Lovelace",
          GIT_AUTHOR_EMAIL: "ada@example.test",
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_NAME: "Ada Lovelace",
          GIT_COMMITTER_EMAIL: "ada@example.test",
          GIT_COMMITTER_DATE: date,
        },
      },
      (error, _stdout, stderr) =>
        error === null ? resolve() : reject(new Error(`${error.message}\n${stderr}`)),
    );
  });
}

/** Call one op and return the rejection, failing the test when the call resolves. */
async function rejectionOf(
  reader: ReturnType<typeof createWorldReader>,
  op: WorldReadOp,
  args: unknown[],
): Promise<WorldReadError> {
  try {
    const value = await reader.executeWorldRead(op, args);
    throw new Error(`expected ${op}(${JSON.stringify(args)}) to reject, resolved: ${String(value)}`);
  } catch (error) {
    assert.equal((error as Error).name, "WorldReadError", (error as Error).message);
    return error as WorldReadError;
  }
}

/** Assert a rejection code for one op call. */
async function expectCode(
  reader: ReturnType<typeof createWorldReader>,
  op: WorldReadOp,
  args: unknown[],
  code: string,
): Promise<WorldReadError> {
  const error = await rejectionOf(reader, op, args);
  assert.equal(error.code, code, error.message);
  return error;
}

before(async () => {
  scratchDir = await mkdtemp(path.join(tmpdir(), "zcode-worldread-"));
  scriptRepo = path.join(scratchDir, "scripts");
  gitRepo = path.join(scratchDir, "project");
  await mkdir(scriptRepo, { recursive: true });
  await mkdir(gitRepo, { recursive: true });

  await writeScriptFile("README.md", "# readme\nfindme here\n");
  await writeScriptFile("b.txt", "no trailing newline");
  await writeScriptFile("src/a.ts", "export const a = 1;\n// findme in a.ts\n");
  await writeScriptFile("src/b.ts", "export const b = 2;\n");
  await writeScriptFile("src/mod/c.ts", "export const c = 3;\n");
  await writeScriptFile("node_modules/pkg/index.js", "// findme hidden by the ignore list\n");
  await writeScriptFile("big.txt", "x".repeat(300 * 1024));
  // A dotfile, so the accelerator (`rg --hidden`) and the walker agree on the shape of the world.
  await writeScriptFile(".env", "dotfile-marker=1\n");
  await writeScriptFile("many/f0.txt", "needle-many\n");
  for (let index = 0; index < 2100; index += 1) {
    await writeScriptFile(`many/f${index + 1}.txt`, `needle-many ${index}\n`);
  }
  await writeScriptFile("long/one.txt", "needle-long\n");
  // 1500 matches × ~640 serialized bytes ≈ 960KB: under the 2000-match cap, well over the
  // 256KB byte cap.
  for (let index = 0; index < 1500; index += 1) {
    await writeScriptFile(`long/l${index}.txt`, `${LONG_LINE}\n`);
  }

  const outside = path.join(scratchDir, "outside.txt");
  await writeFile(outside, "outside the workspace\n", "utf8");
  try {
    await symlink(outside, path.join(scriptRepo, "link.txt"));
  } catch {
    // Symlinks may be unavailable (Windows without developer mode); the escape test adapts.
  }

  scriptWorld = createWorldReader({ workspaceRoot: scriptRepo, worldCwd: scriptRepo });

  // ——— the git repository: committed history, then a dirty working tree ———
  await mkdir(path.join(gitRepo, "src"), { recursive: true });
  await mkdir(path.join(gitRepo, "docs"), { recursive: true });
  await writeFile(
    path.join(gitRepo, "src", "a.ts"),
    "export const a = 1;\nexport const b = 2;\n",
    "utf8",
  );
  await writeFile(path.join(gitRepo, "docs", "readme.md"), "# docs\n", "utf8");
  await writeFile(path.join(gitRepo, ".gitignore"), "ignored-dir/\n", "utf8");
  await writeFile(path.join(gitRepo, "src", "note.txt"), "c1\n", "utf8");

  await runGit(gitRepo, ["init", "-q"]);
  await runGit(gitRepo, ["add", "-A"]);
  await commit("c1", "2024-01-01T00:00:00Z");
  await commit("c2: second", "2024-01-02T00:00:00Z");

  await writeFile(path.join(gitRepo, "src", "dirty.txt"), "dirty\n", "utf8");
  await writeFile(path.join(gitRepo, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await mkdir(path.join(gitRepo, "newdir"), { recursive: true });
  await writeFile(path.join(gitRepo, "newdir", "new.txt"), "new\n", "utf8");
  await writeFile(path.join(gitRepo, "dirty-root.txt"), "dirty at the root\n", "utf8");
  await mkdir(path.join(gitRepo, "ignored-dir"), { recursive: true });
  await writeFile(path.join(gitRepo, "ignored-dir", "skip.txt"), "ignored\n", "utf8");

  gitWorld = createWorldReader({ workspaceRoot: gitRepo, worldCwd: gitRepo });
  limitedWorld = createWorldReader({
    workspaceRoot: scriptRepo,
    worldCwd: scriptRepo,
    timeoutMs: 1_000,
    runTimeoutMs: 1_000,
  });
  // The pure-Node fallback path, forced by a probe that always says "no ripgrep": the two caps
  // and the ignore list must hold there too, not only on the accelerator path.
  walkerWorld = createWorldReader({
    workspaceRoot: scriptRepo,
    worldCwd: scriptRepo,
    detectRipgrep: () => Promise.resolve(false),
  });

  try {
    const probe = await new Promise<number | null>((resolve) => {
      const child = spawn("rg", ["--version"], { stdio: "ignore" });
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code));
    });
    ripgrepAvailable = probe === 0;
  } catch {
    ripgrepAvailable = false;
  }
});

after(async () => {
  if (scratchDir !== "") await rm(scratchDir, { recursive: true, force: true });
});

// ——————————————————————————————— files.glob ———————————————————————————————

test("files.glob: matches at any depth, sorts, and returns workspace-relative paths", async () => {
  const files = (await scriptWorld.executeWorldRead("glob", ["*.ts"])) as string[];
  assert.deepEqual(files, ["src/a.ts", "src/b.ts", "src/mod/c.ts"]);
});

test("files.glob: a **/ pattern matches top-level files too", async () => {
  const files = (await scriptWorld.executeWorldRead("glob", ["**/*.md"])) as string[];
  assert.deepEqual(files, ["README.md"]);
});

test("files.glob: a directory-scoped pattern stays inside that directory", async () => {
  const files = (await scriptWorld.executeWorldRead("glob", ["src/**"])) as string[];
  assert.deepEqual(files, ["src/a.ts", "src/b.ts", "src/mod/c.ts"]);
});

test("files.glob: ignored directories are pruned", async () => {
  const files = (await scriptWorld.executeWorldRead("glob", ["**/*.js"])) as string[];
  assert.deepEqual(files, []);
});

test("files.glob: over the 2000-file cap rejects instead of truncating", async () => {
  const error = await expectCode(scriptWorld, "glob", ["many/*.txt"], "WORLD_READ_TOO_LARGE");
  assert.match(error.message, /over 2000 files/);
});

// ——————————————————————————————— files.read ———————————————————————————————

test("files.read: returns the file's text", async () => {
  const text = (await scriptWorld.executeWorldRead("read", ["README.md"])) as string;
  assert.equal(text, "# readme\nfindme here\n");
});

test("files.read: content without a trailing newline is preserved byte for byte", async () => {
  const text = (await scriptWorld.executeWorldRead("read", ["b.txt"])) as string;
  assert.equal(text, "no trailing newline");
});

test("files.read: a missing file rejects catchably and names the path", async () => {
  const error = await expectCode(scriptWorld, "read", ["nope.txt"], "WORLD_READ_FAILED");
  assert.match(error.message, /nope\.txt/);
});

test("files.read: a directory rejects", async () => {
  await expectCode(scriptWorld, "read", ["src"], "WORLD_READ_FAILED");
});

test("files.read: over the 256KB cap rejects instead of truncating", async () => {
  const error = await expectCode(scriptWorld, "read", ["big.txt"], "WORLD_READ_TOO_LARGE");
  assert.match(error.message, /over the 262144-byte cap/);
});

test("files.read: escaping the workspace rejects with WORLD_READ_PATH_ESCAPE", async () => {
  await expectCode(scriptWorld, "read", ["../outside.txt"], "WORLD_READ_PATH_ESCAPE");
});

test("files.read: an absolute path outside the workspace rejects", async () => {
  const outside = path.join(scratchDir, "outside.txt");
  await expectCode(scriptWorld, "read", [outside], "WORLD_READ_PATH_ESCAPE");
});

test("files.read: the workspace root itself is inside the workspace", async () => {
  await expectCode(scriptWorld, "read", ["."], "WORLD_READ_FAILED");
});

test("files.read: a symlink pointing outside is readable (lexical boundary, no realpath)", async () => {
  let linked = true;
  try {
    await readFile(path.join(scriptRepo, "link.txt"), "utf8");
  } catch {
    linked = false;
  }
  if (!linked) return; // Symlinks unavailable on this host.
  const text = (await scriptWorld.executeWorldRead("read", ["link.txt"])) as string;
  assert.equal(text, "outside the workspace\n");
});

// ——————————————————————————————— files.grep ———————————————————————————————

test("files.grep: one entry per matching line with one-based line numbers", async () => {
  const matches = (await scriptWorld.executeWorldRead("grep", ["findme"])) as GrepMatch[];
  assert.deepEqual(matches, [
    { path: "README.md", line: 2, text: "findme here" },
    { path: "src/a.ts", line: 2, text: "// findme in a.ts" },
  ]);
});

test("files.grep: the pattern is a regex, not a literal", async () => {
  const matches = (await scriptWorld.executeWorldRead("grep", ["^export const [bc]"])) as GrepMatch[];
  assert.deepEqual(
    matches.map((match) => `${match.path}:${match.line}`),
    ["src/b.ts:1", "src/mod/c.ts:1"],
  );
});

test("files.grep: a glob narrows the search", async () => {
  const matches = (await scriptWorld.executeWorldRead("grep", ["export", "src/a.ts"])) as GrepMatch[];
  assert.deepEqual(matches.map((match) => match.path), ["src/a.ts"]);
});

test("files.grep: no match is an empty array, not an error", async () => {
  const matches = (await scriptWorld.executeWorldRead("grep", ["nothing-matches-this"])) as GrepMatch[];
  assert.deepEqual(matches, []);
});

test("files.grep: an invalid regex rejects catchably", async () => {
  const error = await expectCode(scriptWorld, "grep", ["("], "WORLD_READ_FAILED");
  assert.match(error.message, /regular expression|ripgrep/);
});

test("files.grep: the ripgrep accelerator reports 'no match' as a value", async (context) => {
  if (!ripgrepAvailable) return context.skip("rg is not installed");
  const matches = (await scriptWorld.executeWorldRead("grep", ["zzz-nothing"])) as GrepMatch[];
  assert.deepEqual(matches, []);
});

test("files.grep: dotfiles are searched on both paths (walker and rg agree)", async () => {
  const viaWalker = (await walkerWorld.executeWorldRead("grep", ["dotfile-marker"])) as GrepMatch[];
  const viaAccelerator = (await scriptWorld.executeWorldRead("grep", [
    "dotfile-marker",
  ])) as GrepMatch[];
  assert.deepEqual(viaWalker, [{ path: ".env", line: 1, text: "dotfile-marker=1" }]);
  assert.deepEqual(viaAccelerator, viaWalker);
});

test("files.grep: over the 2000-match cap rejects instead of truncating", async () => {
  const error = await expectCode(scriptWorld, "grep", ["needle-many"], "WORLD_READ_TOO_LARGE");
  assert.match(error.message, /over 2000 matches/);
});

test("files.grep: over the 256KB result cap rejects", async () => {
  // 1500 matches is inside the count cap, so the byte cap is the only thing that can reject.
  const error = await expectCode(scriptWorld, "grep", ["needle-long", "long/*"], "WORLD_READ_TOO_LARGE");
  assert.match(error.message, /bytes, over the 262144-byte cap/);
});

test("files.grep: the pure-Node fallback returns the same matches as the accelerator", async () => {
  const viaWalker = (await walkerWorld.executeWorldRead("grep", ["findme"])) as GrepMatch[];
  assert.deepEqual(viaWalker, [
    { path: "README.md", line: 2, text: "findme here" },
    { path: "src/a.ts", line: 2, text: "// findme in a.ts" },
  ]);
  const scoped = (await walkerWorld.executeWorldRead("grep", ["export", "*.ts"])) as GrepMatch[];
  assert.deepEqual(
    scoped.map((match) => match.path),
    ["src/a.ts", "src/b.ts", "src/mod/c.ts"],
  );
  const ignored = (await walkerWorld.executeWorldRead("grep", [
    "hidden by the ignore list",
  ])) as GrepMatch[];
  assert.deepEqual(ignored, []);
});

test("files.grep: the fallback also rejects over the match cap", async () => {
  const error = await expectCode(walkerWorld, "grep", ["needle-many"], "WORLD_READ_TOO_LARGE");
  assert.match(error.message, /over 2000 matches/);
  const bytes = await expectCode(
    walkerWorld,
    "grep",
    ["needle-long", "long/*"],
    "WORLD_READ_TOO_LARGE",
  );
  assert.match(bytes.message, /bytes, over the 262144-byte cap/);
});
// ——————————————————————————————— git.status ———————————————————————————————

test("git.status: reports the branch and classified paths, ignoring ignored files", async () => {
  const status = (await gitWorld.executeWorldRead("git-status", [])) as GitStatusResult;
  assert.equal(typeof status.branch, "string");
  assert.ok((status.branch ?? "").length > 0);
  assert.equal(status.clean, false);
  assert.deepEqual(status.staged, []);
  assert.deepEqual(status.unstaged, ["src/a.ts"]);
  // `git status` collapses a fully-untracked directory into one entry with a trailing slash;
  // git.changedFiles (ls-files --others) lists the file inside it instead.
  assert.deepEqual(status.untracked, ["dirty-root.txt", "newdir/", "src/dirty.txt"]);
});

// ——————————————————————————————— git.changedFiles ———————————————————————————————

test("git.changedFiles: no base is the union of tracked changes and untracked files", async () => {
  const files = (await gitWorld.executeWorldRead("git-changed-files", [])) as string[];
  assert.deepEqual(files, ["dirty-root.txt", "newdir/new.txt", "src/a.ts", "src/dirty.txt"]);
});

test("git.changedFiles: a base reports tracked history only", async () => {
  // Both files were rewritten by the second commit, and the untracked ones are invisible to a
  // ref comparison: a file git has never seen cannot differ from a ref.
  const files = (await gitWorld.executeWorldRead("git-changed-files", ["HEAD~1"])) as string[];
  assert.deepEqual(files, ["src/a.ts", "src/note.txt"]);
});

test("git.changedFiles: a revision range is rejected before git runs", async () => {
  const error = await expectCode(
    gitWorld,
    "git-changed-files",
    ["HEAD~1..HEAD"],
    "WORLD_READ_FAILED",
  );
  assert.match(error.message, /\.\./);
});

test("git.changedFiles: a base that looks like an option is rejected", async () => {
  await expectCode(gitWorld, "git-changed-files", ["--help"], "WORLD_READ_FAILED");
});

// ——————————————————————————————— git.diff ———————————————————————————————

test("git.diff: defaults to HEAD and covers the whole workspace", async () => {
  const diff = (await gitWorld.executeWorldRead("git-diff", [])) as string;
  assert.match(diff, /^diff --git a\/src\/a\.ts b\/src\/a\.ts$/m);
  assert.match(diff, /^-export const b = 2;$/m);
});

test("git.diff: base and path together narrow the patch", async () => {
  // Against HEAD~1 the change to src/a.ts is the removal of the second line, and src/note.txt
  // is included too because the commit also rewrote it.
  const diff = (await gitWorld.executeWorldRead("git-diff", ["HEAD~1"])) as string;
  assert.match(diff, /^-export const b = 2;$/m);
  assert.match(diff, /^\+c2: second$/m);
  const narrowed = (await gitWorld.executeWorldRead("git-diff", ["HEAD~1", "src/a.ts"])) as string;
  assert.match(narrowed, /^-export const b = 2;$/m);
  assert.doesNotMatch(narrowed, /note\.txt/);
});

test("git.diff: a path outside the workspace is rejected", async () => {
  await expectCode(gitWorld, "git-diff", [undefined, "../outside.txt"], "WORLD_READ_FAILED");
});

test("git.diff: over the 512KB cap rejects instead of truncating", async () => {
  // The patch has to be real output, so the file is staged: an untracked file is not part of
  // any diff.
  await writeFile(path.join(gitRepo, "big-diff.txt"), `${"y\n".repeat(300 * 1024)}`, "utf8");
  await runGit(gitRepo, ["add", "--", "big-diff.txt"]);
  try {
    const error = await expectCode(gitWorld, "git-diff", [], "WORLD_READ_TOO_LARGE");
    assert.match(error.message, /512KB|524288|over the/);
  } finally {
    await runGit(gitRepo, ["rm", "-q", "--cached", "--", "big-diff.txt"]).catch(() => undefined);
    await rm(path.join(gitRepo, "big-diff.txt"), { force: true });
  }
});

// ——————————————————————————————— git.log ———————————————————————————————

test("git.log: newest first, with hash, subject, author and ISO date", async () => {
  const commits = (await gitWorld.executeWorldRead("git-log", [1])) as GitCommitResult[];
  assert.equal(commits.length, 1);
  const [commit] = commits;
  assert.match(commit!.hash, /^[0-9a-f]{40}$/);
  assert.equal(commit!.subject, "c2: second");
  assert.equal(commit!.author, "Ada Lovelace");
  // `%aI` is strict ISO 8601: UTC renders as `Z`, and either spelling is valid.
  assert.match(commit!.date, /^2024-01-02T00:00:00(Z|\+00:00)$/);
});

test("git.log: without a count it defaults to at most 20 commits", async () => {
  const commits = (await gitWorld.executeWorldRead("git-log", [])) as GitCommitResult[];
  assert.equal(commits.length, 2);
  assert.equal(commits[0]!.subject, "c2: second");
  assert.equal(commits[1]!.subject, "c1");
});

test("git.log: whitespace inside a message survives parsing", async () => {
  // git keeps the leading spaces of a subject and strips the trailing ones; the parser must do
  // exactly the same and nothing more.
  await commit("   indented subject  ", "2024-01-03T00:00:00Z");
  try {
    const commits = (await gitWorld.executeWorldRead("git-log", [1])) as GitCommitResult[];
    assert.equal(commits.length, 1);
    assert.equal(commits[0]!.subject, "   indented subject");
    assert.equal(commits[0]!.author, "Ada Lovelace");
  } finally {
    await runGit(gitRepo, ["reset", "-q", "--hard", "HEAD~1"]);
  }
});

test("git.log: a count over the cap rejects instead of clamping", async () => {
  const error = await expectCode(gitWorld, "git-log", [101], "WORLD_READ_INVALID_ARGS");
  assert.match(error.message, /over the cap of 100/);
});

test("git.log: a non-integer count rejects", async () => {
  await expectCode(gitWorld, "git-log", [1.5], "WORLD_READ_INVALID_ARGS");
  await expectCode(gitWorld, "git-log", ["2"], "WORLD_READ_INVALID_ARGS");
  await expectCode(gitWorld, "git-log", [0], "WORLD_READ_INVALID_ARGS");
});

// ——————————————————————————————— world.run ———————————————————————————————

test("world.run: a successful command resolves with exitCode, stdout and stderr", async () => {
  const result = (await scriptWorld.executeWorldRead("run", [
    NODE,
    ["-e", "process.stdout.write('out\\n'); process.stderr.write('err\\n');"],
  ])) as WorldRunResult;
  assert.deepEqual(result, { exitCode: 0, stdout: "out", stderr: "err" });
});

test("world.run: a nonzero exit resolves — a failing check is a value, not an exception", async () => {
  const result = (await scriptWorld.executeWorldRead("run", [
    NODE,
    ["-e", "process.stdout.write('out'); process.exit(3);"],
  ])) as WorldRunResult;
  assert.deepEqual(result, { exitCode: 3, stdout: "out", stderr: "" });
});

test("world.run: a command that cannot be spawned rejects catchably", async () => {
  const error = await expectCode(
    scriptWorld,
    "run",
    ["zcode-no-such-binary-xyz"],
    "WORLD_READ_FAILED",
  );
  assert.match(error.message, /zcode-no-such-binary-xyz/);
});

test("world.run: a timeout rejects and never returns a partial observation", async () => {
  const error = await expectCode(
    limitedWorld,
    "run",
    [NODE, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 200 }],
    "WORLD_READ_TIMEOUT",
  );
  assert.match(error.message, /timed out after 200ms/);
});

test("world.run: output is capped at 256KB per stream", async () => {
  const result = (await scriptWorld.executeWorldRead("run", [
    NODE,
    ["-e", "process.stdout.write('x'.repeat(600 * 1024))"],
  ])) as WorldRunResult;
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.length, 256 * 1024);
});

test("world.run: opts must be an object and timeoutMs a positive integer", async () => {
  await expectCode(scriptWorld, "run", [NODE, [], "nope"], "WORLD_READ_INVALID_ARGS");
  await expectCode(scriptWorld, "run", [NODE, [], { timeoutMs: 0 }], "WORLD_READ_INVALID_ARGS");
  await expectCode(scriptWorld, "run", [NODE, [], { timeoutMs: 1.5 }], "WORLD_READ_INVALID_ARGS");
  await expectCode(scriptWorld, "run", [NODE, [42]], "WORLD_READ_INVALID_ARGS");
  await expectCode(scriptWorld, "run", [NODE, "nope"], "WORLD_READ_INVALID_ARGS");
});

// ——————————————————————————————— argument validation ———————————————————————————————

test("argument validation: missing and extra arguments reject with WORLD_READ_INVALID_ARGS", async () => {
  await expectCode(scriptWorld, "glob", [], "WORLD_READ_INVALID_ARGS");
  await expectCode(scriptWorld, "glob", ["*.ts", "extra"], "WORLD_READ_INVALID_ARGS");
  await expectCode(scriptWorld, "glob", [42], "WORLD_READ_INVALID_ARGS");
  await expectCode(scriptWorld, "read", [null], "WORLD_READ_INVALID_ARGS");
  await expectCode(scriptWorld, "grep", [], "WORLD_READ_INVALID_ARGS");
  await expectCode(scriptWorld, "grep", ["a", "b", "c"], "WORLD_READ_INVALID_ARGS");
  await expectCode(scriptWorld, "git-status", ["extra"], "WORLD_READ_INVALID_ARGS");
  await expectCode(scriptWorld, "git-log", [1, 2], "WORLD_READ_INVALID_ARGS");
  await expectCode(scriptWorld, "git-diff", ["a", "b", "c"], "WORLD_READ_INVALID_ARGS");
});

test("git operations outside a repository reject catchably (the fallback idiom)", async () => {
  const error = await expectCode(scriptWorld, "git-status", [], "WORLD_READ_FAILED");
  assert.match(error.message, /git/);
  await expectCode(scriptWorld, "git-log", [], "WORLD_READ_FAILED");
});

test("an unknown op rejects rather than throwing synchronously", async () => {
  const pending = scriptWorld.executeWorldRead("nope" as WorldReadOp, []);
  assert.ok(pending instanceof Promise);
  const error = await pending.then(
    () => undefined,
    (caught: WorldReadError) => caught,
  );
  assert.equal(error?.code, "WORLD_READ_FAILED");
});

test("executeWorldRead never throws synchronously, even for malformed args", async () => {
  const pending = scriptWorld.executeWorldRead("read" as WorldReadOp, []);
  assert.ok(pending instanceof Promise);
  await pending.then(
    () => assert.fail("expected a rejection"),
    (caught: WorldReadError) => assert.equal(caught.code, "WORLD_READ_INVALID_ARGS"),
  );
});

test("worldCwd and workspaceRoot are independent: reads resolve against workspaceRoot", async () => {
  const subCwd = path.join(gitRepo, "src");
  // Restore the dirt this test reads: an earlier test resets the repository to HEAD.
  await writeFile(path.join(gitRepo, "src", "a.ts"), "export const a = 1;\n", "utf8");
  const reader = createWorldReader({
    workspaceRoot: path.join(gitRepo, ".."),
    worldCwd: subCwd,
    timeoutMs: 30_000,
  });
  const text = (await reader.executeWorldRead("read", ["project/src/a.ts"])) as string;
  assert.match(text, /export const a = 1;/);
  const status = (await reader.executeWorldRead("git-status", [])) as GitStatusResult;
  // `git -C <worldCwd>` points at a subdirectory of the work tree, so git reports paths
  // relative to the repository root and the world reader strips that prefix back off.
  assert.ok(status.unstaged.includes("a.ts"), JSON.stringify(status));
});

test("world.run: a spawn that throws synchronously is normalized into a rejection", async () => {
  const reader = createWorldReader({
    workspaceRoot: scriptRepo,
    worldCwd: scriptRepo,
    spawn: (file, args, options) => {
      assert.equal(typeof file, "string");
      assert.ok(Array.isArray(args) && typeof options.timeoutMs === "number");
      throw new Error("spawn exploded");
    },
  });
  const error = await expectCode(reader, "run", [NODE, ["-e", ""]], "WORLD_READ_FAILED");
  assert.match(error.message, /spawn exploded/);
});
