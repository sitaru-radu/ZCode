/**
 * Read-only fact tests: status parsing, three-dot vs two-dot diffs, history and error
 * classification. The fixtures reproduce the spike's own experiments (sections 1.3, 1.4, 2.3, 5).
 */

import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';

import {
  addWorktree,
  aheadBehind,
  changedFiles,
  classifyGitFailure,
  commitsAhead,
  currentBranch,
  diffPatch,
  diffStat,
  getStatus,
  git,
  gitOrThrow,
  hasUncommittedWork,
  headSha,
  isGitError,
  listCommits,
  mergeBase,
  parseNameStatusZ,
  parseStatusV2,
} from '../src/index.js';
import { createScratchRepo, type ScratchRepo } from './helpers/scratch.js';

let scratch: ScratchRepo;

before(async () => {
  scratch = await createScratchRepo();
});

after(async () => {
  await scratch.cleanup();
});

test('getStatus parses the v2 -z fixture: rename across two NUL fields, spaces unquoted', async () => {
  const worktree = await scratch.addWorktree('facts-status');

  await writeFile(path.join(worktree, 'a.txt'), 'a3\n', 'utf8');
  await rm(path.join(worktree, 'b.txt'));
  await scratch.ok(['mv', 'src/one.txt', 'renamed.txt'], worktree);
  await scratch.write('staged spaces.txt', 'staged\n', worktree);
  await scratch.ok(['add', 'staged spaces.txt'], worktree);
  await writeFile(path.join(worktree, 'file with spaces.txt'), 'untracked\n', 'utf8');

  const status = await getStatus(worktree);
  assert.equal(status.branch, 'zcode/facts-status');
  assert.equal(status.detached, false);
  assert.equal(status.oid, scratch.base);
  assert.equal(status.clean, false);
  assert.deepEqual(status.conflicted, []);

  const byPath = new Map(status.entries.map((entry) => [entry.path, entry]));

  // `1 .M` / `1 .D`: unstaged modification and deletion.
  assert.equal(byPath.get('a.txt')?.kind, 'ordinary');
  assert.equal(byPath.get('a.txt')?.xy, '.M');
  assert.equal(byPath.get('b.txt')?.xy, '.D');

  // `2 R. ... R100 <path>\0<origPath>`: the rename record spans two NUL-separated fields.
  const rename = byPath.get('renamed.txt');
  assert.equal(rename?.kind, 'renamed');
  assert.equal(rename?.xy, 'R.');
  assert.equal(rename?.origPath, 'src/one.txt');
  assert.equal(rename?.renameScore, '100');

  // Spaces are never quoted in v2 (G4); the path is exactly the file name.
  assert.equal(byPath.get('file with spaces.txt')?.kind, 'untracked');
  assert.equal(byPath.get('staged spaces.txt')?.kind, 'ordinary');
  assert.equal(byPath.get('staged spaces.txt')?.xy, 'A.');

  assert.equal(await hasUncommittedWork(worktree), true);
  assert.equal(await currentBranch(worktree), 'zcode/facts-status');
  assert.equal(await headSha(worktree), scratch.base);

  // A pristine worktree is clean, and cleanliness never comes from the exit code.
  const pristine = await scratch.addWorktree('facts-pristine');
  const clean = await getStatus(pristine);
  assert.deepEqual(clean.entries, []);
  assert.equal(clean.clean, true);
  assert.equal(await hasUncommittedWork(pristine), false);
});

test('parseStatusV2 is pure and never indexes records positionally', () => {
  const stdout = [
    '# branch.oid 3314f260090b9d8285816d9e51814da0acf56c8d',
    '# branch.head (detached)',
    '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaaa bbbb a.txt',
    '2 R. N... 100644 100644 100644 cccc dddd R100 renamed.txt',
    'src/one.txt',
    'u UU N... 100644 100644 100644 100644 e1 e2 e3 u.txt',
    '? untracked.txt',
    '! ignored.txt',
    '',
  ].join('\0');

  const status = parseStatusV2(stdout);
  assert.equal(status.detached, true);
  assert.equal(status.branch, null);
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 1);
  assert.equal(status.entries.length, 5);
  assert.deepEqual(status.conflicted, ['u.txt']);

  const unmerged = status.entries.find((entry) => entry.kind === 'unmerged');
  assert.equal(unmerged?.xy, 'UU');
  assert.deepEqual(unmerged?.mergeShas, ['e1', 'e2', 'e3']);

  const renamed = status.entries.find((entry) => entry.kind === 'renamed');
  assert.equal(renamed?.path, 'renamed.txt');
  assert.equal(renamed?.origPath, 'src/one.txt');

  // Ignored files do not make a tree dirty.
  assert.equal(parseStatusV2('! ignored.txt\0').clean, true);
  assert.equal(parseStatusV2('? untracked.txt\0').clean, false);
});

test('a detached worktree has no branch name', async () => {
  const target = scratch.worktreePath('facts-detached');
  await addWorktree(scratch.repo, { path: target, detach: true, baseRef: scratch.base, quiet: true });
  const detached = await getStatus(target);
  assert.equal(detached.detached, true);
  assert.equal(detached.branch, null);
  assert.equal(await currentBranch(target), null);
  assert.equal(await headSha(target), scratch.base);
});

test('three-dot changedFiles ignores the base branch moving on; two-dot reports reversions', async () => {
  const worktree = await scratch.addWorktree('facts-worker');
  await scratch.write('worker.txt', 'worker\n', worktree);
  await scratch.commitAll('worker: add worker.txt', worktree);
  await scratch.write('worker2.txt', 'worker\n', worktree);
  await scratch.commitAll('worker: add worker2.txt', worktree);

  // The base branch moves on after the worker branched off.
  await scratch.write('base-only.txt', 'base\n');
  await scratch.commitAll('base: add base-only.txt');

  const threeDot = await changedFiles(scratch.repo, 'main', 'zcode/facts-worker');
  assert.deepEqual(
    threeDot.map((file) => `${file.status} ${file.path}`),
    ['A worker.txt', 'A worker2.txt'],
  );

  // Two-dot compares tips directly, so the base's newer commit shows up as a deletion (spike 1.4).
  const twoDot = await git(['diff', '--name-status', '-z', 'main..zcode/facts-worker'], { cwd: scratch.repo });
  const parsedTwoDot = parseNameStatusZ(twoDot.stdout);
  assert.deepEqual(
    parsedTwoDot.map((file) => `${file.status} ${file.path}`).sort(),
    ['A worker.txt', 'A worker2.txt', 'D base-only.txt'],
  );

  const stat = await diffStat(scratch.repo, 'main', 'zcode/facts-worker');
  assert.match(stat, /worker\.txt/);
  assert.match(stat, /2 files changed/);

  const patch = await diffPatch(scratch.repo, 'main', 'zcode/facts-worker');
  assert.match(patch, /\+worker\n/);

  assert.equal(await mergeBase(scratch.repo, 'main', 'zcode/facts-worker'), scratch.base);
  assert.equal(await commitsAhead(scratch.repo, 'main', 'zcode/facts-worker'), 2);
  assert.deepEqual(await aheadBehind(scratch.repo, 'main', 'zcode/facts-worker'), { behind: 1, ahead: 2 });
});

test('parseNameStatusZ keeps the rename source and destination apart', () => {
  const parsed = parseNameStatusZ('M\0a.txt\0D\0b.txt\0R100\0src/one.txt\0renamed.txt\0A\0with space.txt\0');
  assert.deepEqual(parsed, [
    { status: 'M', kind: 'modified', score: null, path: 'a.txt', origPath: null },
    { status: 'D', kind: 'deleted', score: null, path: 'b.txt', origPath: null },
    { status: 'R100', kind: 'renamed', score: '100', path: 'renamed.txt', origPath: 'src/one.txt' },
    { status: 'A', kind: 'added', score: null, path: 'with space.txt', origPath: null },
  ]);
});

test('listCommits uses the two-dot range and reads one record per commit', async () => {
  const worktree = await scratch.addWorktree('facts-log');
  await scratch.write('one.txt', 'one\n', worktree);
  await scratch.commitAll('log: first', worktree);
  await scratch.write('two.txt', 'two\n', worktree);
  await scratch.commitAll('log: second', worktree);
  const head = await scratch.revParse('HEAD', worktree);

  const commits = await listCommits(scratch.repo, 'main', 'zcode/facts-log');
  assert.equal(commits.length, 2);
  // git logs newest first; the base branch's own commits are not in a two-dot range.
  assert.deepEqual(
    commits.map((commit) => commit.subject),
    ['log: second', 'log: first'],
  );
  assert.equal(commits[0]?.sha, head);
  assert.equal(commits[0]?.shortSha.length, 7);
  assert.equal(commits[0]?.author, 'ZCode Test');
  assert.match(commits[0]?.authoredAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(commits.every((commit) => commit.sha.length === 40));

  const oldestFirst = await listCommits(scratch.repo, 'main', 'zcode/facts-log', { reverse: true });
  assert.deepEqual(
    oldestFirst.map((commit) => commit.subject),
    ['log: first', 'log: second'],
  );
});

test('classifyGitFailure recognises the verbatim messages from the spike', () => {
  const indexLock =
    "fatal: Unable to create '/tmp/wt-spike/repo/.git/worktrees/hammer/index.lock': File exists.\n\n" +
    'Another git process seems to be running in this repository, e.g.\n' +
    "an editor opened by 'git commit'. Please make sure all processes\n" +
    'are terminated then try again. If it still fails, a git process\n' +
    'may have crashed in this repository earlier:\nremove the file manually to continue.';
  assert.equal(classifyGitFailure(indexLock), 'index-lock');
  assert.equal(
    classifyGitFailure("fatal: cannot lock ref 'HEAD': is at 8ea63f5 but expected af9353d"),
    'ref-lock',
  );
  assert.equal(
    classifyGitFailure("fatal: '/tmp/wt/x' contains modified or untracked files, use --force to delete it"),
    'dirty-worktree',
  );
  assert.equal(
    classifyGitFailure("fatal: cannot remove a locked working tree, lock reason: agent working"),
    'locked-worktree',
  );
  assert.equal(
    classifyGitFailure("fatal: 'zc/dup' is already used by worktree at '/tmp/wt/w1'"),
    'branch-in-use',
  );
  assert.equal(classifyGitFailure("fatal: a branch named 'zc/dup' already exists"), 'branch-exists');
  assert.equal(classifyGitFailure("fatal: '/tmp/wt/existing' already exists"), 'path-exists');
  assert.equal(classifyGitFailure("fatal: '/tmp/wt/notwt' is not a working tree"), 'not-a-worktree');
  assert.equal(
    classifyGitFailure("fatal: cannot change to '/tmp/wt/gone': No such file or directory"),
    'no-such-directory',
  );
  assert.equal(classifyGitFailure("fatal: cannot change to '/tmp/wt/a.txt': Not a directory"), 'not-a-directory');
  assert.equal(classifyGitFailure('fatal: There is no merge to abort (MERGE_HEAD missing).'), 'no-merge-in-progress');
  assert.equal(classifyGitFailure('warning: in the working copy of f, LF will be replaced by CRLF'), 'unknown');
});

test('a stale index.lock is classified by its real message (G9)', async () => {
  const worktree = await scratch.addWorktree('facts-indexlock');
  const lockPath = (await scratch.ok(['rev-parse', '--git-path', 'index.lock'], worktree)).stdout.trim();
  await scratch.write('new-file.txt', 'content\n', worktree);
  await writeFile(lockPath, '', 'utf8');

  try {
    const blocked = await git(['add', '-A'], { cwd: worktree });
    assert.equal(blocked.exitCode, 128);
    assert.match(blocked.stderr, /Unable to create '.*index\.lock'/);
    assert.equal(classifyGitFailure(blocked.stderr), 'index-lock');

    let captured: unknown;
    await assert.rejects(
      () => gitOrThrow(['add', '-A'], { cwd: worktree }),
      (thrown: unknown) => {
        captured = thrown;
        return true;
      },
    );
    assert.ok(isGitError(captured));
    assert.equal(captured.kind, 'index-lock');
    assert.equal(captured.exitCode, 128);
  } finally {
    await rm(lockPath, { force: true });
  }

  // With the stale lock gone the same command succeeds: the index is per-worktree state.
  const recovered = await git(['add', '-A'], { cwd: worktree });
  assert.equal(recovered.exitCode, 0);
});
