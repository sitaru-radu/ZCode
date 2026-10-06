/**
 * Worktree lifecycle tests against a real scratch repository.
 *
 * The two structural claims from the spike that these tests pin down: a worktree outside the repo
 * leaves the source repo byte-for-byte untouched (headline 1), and `worktree list --porcelain`
 * records must be parsed by key because a detached record has no `branch` line (section 1.2).
 */

import assert from 'node:assert/strict';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';

import {
  addWorktree,
  getWorktree,
  isGitError,
  isRegistered,
  listWorktrees,
  lockWorktree,
  parseWorktreeList,
  pruneWorktrees,
  unlockWorktree,
  type GitError,
} from '../src/index.js';
import { createScratchRepo, type ScratchRepo } from './helpers/scratch.js';

let scratch: ScratchRepo;

before(async () => {
  scratch = await createScratchRepo();
});

after(async () => {
  await scratch.cleanup();
});

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function captureRefusal(task: () => Promise<unknown>): Promise<GitError> {
  let captured: unknown;
  await assert.rejects(task, (thrown: unknown) => {
    captured = thrown;
    return true;
  });
  assert.ok(isGitError(captured), 'expected a GitError');
  return captured;
}

test('parseWorktreeList reads 2-4 line records by key, never by position', () => {
  const porcelain = [
    'worktree /tmp/wt-spike/repo',
    'HEAD 7f7689ada18f8966f9bc4e3b3f90e08b786a517b',
    'branch refs/heads/main',
    '',
    'worktree /tmp/wt-spike/projects/p1/m1/worktrees/task-1',
    'HEAD 7f7689ada18f8966f9bc4e3b3f90e08b786a517b',
    'detached',
    '',
    'worktree /tmp/wt-spike/projects/p1/m1/worktrees/task-2',
    'HEAD 7f7689ada18f8966f9bc4e3b3f90e08b786a517b',
    'branch refs/heads/zcode/mission-s1/task-2',
    'locked spike test lock',
    '',
    'worktree /tmp/wt-spike/projects/p1/m1/worktrees/gone',
    'HEAD 7f7689ada18f8966f9bc4e3b3f90e08b786a517b',
    'branch refs/heads/zc/gone',
    'prunable gitdir file points to non-existent location',
    '',
  ].join('\n');

  const worktrees = parseWorktreeList(porcelain);
  assert.equal(worktrees.length, 4);
  assert.deepEqual(
    worktrees.map((worktree) => worktree.path),
    [
      '/tmp/wt-spike/repo',
      '/tmp/wt-spike/projects/p1/m1/worktrees/task-1',
      '/tmp/wt-spike/projects/p1/m1/worktrees/task-2',
      '/tmp/wt-spike/projects/p1/m1/worktrees/gone',
    ],
  );
  assert.equal(worktrees[0]?.branch, 'main');
  assert.equal(worktrees[0]?.isMainWorktree, true);
  assert.equal(worktrees[1]?.branch, null);
  assert.equal(worktrees[1]?.detached, true);
  assert.equal(worktrees[1]?.isMainWorktree, false);
  assert.equal(worktrees[2]?.locked, true);
  assert.equal(worktrees[2]?.lockedReason, 'spike test lock');
  assert.equal(worktrees[2]?.prunable, false);
  assert.equal(worktrees[3]?.prunable, true);
  assert.equal(worktrees[3]?.prunableReason, 'gitdir file points to non-existent location');
  assert.equal(worktrees[3]?.locked, false);
});

test('addWorktree works outside the repo and leaves the source repo untouched', async () => {
  const before = await scratch.tree();
  const target = scratch.worktreePath('wt-basic');
  const info = await addWorktree(scratch.repo, {
    path: target,
    branch: 'zcode/wt-basic',
    baseRef: scratch.base,
  });

  assert.equal(info.path, target);
  assert.equal(info.branch, 'zcode/wt-basic');
  assert.equal(info.head, scratch.base);
  assert.equal(info.detached, false);
  assert.equal(info.isMainWorktree, false);
  assert.equal(info.locked, false);
  assert.equal(info.prunable, false);
  assert.equal(target.startsWith(`${scratch.repo}${path.sep}`), false);
  assert.equal(await scratch.read('a.txt', target), 'a2\n');

  // Headline result 1: the source repo is byte-for-byte untouched by an outside worktree.
  const status = await scratch.ok(['status', '--porcelain']);
  assert.equal(status.stdout, '');
  assert.deepEqual(await scratch.tree(), before);

  const listed = await listWorktrees(scratch.repo);
  assert.equal(listed.filter((worktree) => worktree.path === target).length, 1);
  assert.equal(await isRegistered(scratch.repo, target), true);
  assert.equal((await getWorktree(scratch.repo, target))?.branch, 'zcode/wt-basic');
  assert.equal(await getWorktree(scratch.repo, path.join(scratch.root, 'nope')), null);
});

test('a detached worktree is reported without a branch', async () => {
  const target = scratch.worktreePath('wt-detached');
  const info = await addWorktree(scratch.repo, { path: target, detach: true, baseRef: scratch.base });
  assert.equal(info.detached, true);
  assert.equal(info.branch, null);
  assert.equal(info.head, scratch.base);

  const reread = await getWorktree(scratch.repo, target);
  assert.equal(reread?.detached, true);
  assert.equal(reread?.branch, null);
});

test('addWorktree rejects a target inside the repository (G6)', async () => {
  await assert.rejects(
    () =>
      addWorktree(scratch.repo, {
        path: scratch.inRepo('inside-wt'),
        branch: 'zcode/inside',
        baseRef: scratch.base,
      }),
    /refuses to create .* inside the repository/,
  );
  assert.equal(await exists(scratch.inRepo('inside-wt')), false);

  // The escape hatch proves the hazard is real: an in-repo worktree pollutes the source status.
  const inside = await addWorktree(scratch.repo, {
    path: scratch.inRepo('inside-wt'),
    branch: 'zcode/inside',
    baseRef: scratch.base,
    allowInsideRepo: true,
  });
  assert.equal(inside.path, scratch.inRepo('inside-wt'));
  const polluted = await scratch.ok(['status', '--porcelain']);
  assert.match(polluted.stdout, /\?\? inside-wt\//);
  await scratch.ok(['worktree', 'remove', scratch.inRepo('inside-wt')]);
});

test('addWorktree validates its arguments before touching git', async () => {
  await assert.rejects(
    () => addWorktree(scratch.repo, { path: 'relative/path', branch: 'zcode/x' }),
    TypeError,
  );
  await assert.rejects(
    () => addWorktree(scratch.repo, { path: scratch.worktreePath('x'), branch: 'zcode/x', detach: true }),
    TypeError,
  );
  await assert.rejects(() => addWorktree(scratch.repo, { path: scratch.worktreePath('x') }), TypeError);
});

test('addWorktree reports the documented failure exit codes', async () => {
  const target = scratch.worktreePath('wt-failures');
  await addWorktree(scratch.repo, { path: target, branch: 'zcode/failures', baseRef: scratch.base });

  // Non-empty target path: exit 128.
  const pathExists = await captureRefusal(() =>
    addWorktree(scratch.repo, { path: target, branch: 'zcode/failures-2', baseRef: scratch.base }),
  );
  assert.equal(pathExists.exitCode, 128);
  assert.equal(pathExists.kind, 'path-exists');
  assert.match(pathExists.stderr, /already exists/);

  // Existing branch checked out elsewhere (no -b): exit 128.
  const branchInUse = await captureRefusal(() =>
    addWorktree(scratch.repo, {
      path: scratch.worktreePath('wt-failures-3'),
      branch: 'zcode/failures',
      reuseBranch: true,
    }),
  );
  assert.equal(branchInUse.exitCode, 128);
  assert.equal(branchInUse.kind, 'branch-in-use');
  assert.match(branchInUse.stderr, /is already used by worktree at/);

  // `-b` with a branch name that already exists: exit 255.
  const branchExists = await captureRefusal(() =>
    addWorktree(scratch.repo, {
      path: scratch.worktreePath('wt-failures-4'),
      branch: 'zcode/failures',
      baseRef: scratch.base,
    }),
  );
  assert.equal(branchExists.exitCode, 255);
  assert.equal(branchExists.kind, 'branch-exists');

  // A rejected add must not leave its target directory behind.
  assert.equal(await exists(scratch.worktreePath('wt-failures-3')), false);
  assert.equal(await exists(scratch.worktreePath('wt-failures-4')), false);

  // An existing EMPTY directory is accepted.
  const empty = scratch.worktreePath('wt-empty-dir');
  await mkdir(empty, { recursive: true });
  const created = await addWorktree(scratch.repo, {
    path: empty,
    branch: 'zcode/empty-dir',
    baseRef: scratch.base,
  });
  assert.equal(created.branch, 'zcode/empty-dir');
});

test('lockWorktree and unlockWorktree round-trip through the porcelain list', async () => {
  const target = await scratch.addWorktree('wt-locked');

  await lockWorktree(scratch.repo, target, 'agent working');
  const locked = await getWorktree(scratch.repo, target);
  assert.equal(locked?.locked, true);
  assert.equal(locked?.lockedReason, 'agent working');

  await unlockWorktree(scratch.repo, target);
  const unlocked = await getWorktree(scratch.repo, target);
  assert.equal(unlocked?.locked, false);
  assert.equal(unlocked?.lockedReason, null);
});

test('a hand-deleted directory is prunable, and prune cleans it without touching the branch', async () => {
  const target = await scratch.addWorktree('wt-prunable');
  await rm(target, { recursive: true, force: true });

  const flagged = await getWorktree(scratch.repo, target);
  assert.equal(flagged?.prunable, true);
  assert.match(flagged?.prunableReason ?? '', /non-existent location/);

  // A live worktree is never prunable, dry-run included.
  const live = await scratch.addWorktree('wt-live');
  const dryRun = await pruneWorktrees(scratch.repo, { dryRun: true });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.prunedIds.length, 1);
  assert.match(dryRun.prunedIds[0] ?? '', /worktrees\/wt-prunable/);
  assert.equal(await isRegistered(scratch.repo, target), true, 'dry-run must not prune');

  const pruned = await pruneWorktrees(scratch.repo);
  assert.equal(pruned.prunedIds.length, 1);
  assert.equal(await isRegistered(scratch.repo, target), false);
  assert.equal(await isRegistered(scratch.repo, live), true);

  // The branch survives prune, which is what makes a removed-but-unmerged worktree recoverable.
  const branches = await scratch.ok(['branch', '--list', 'zcode/wt-prunable']);
  assert.match(branches.stdout, /zcode\/wt-prunable/);

  const again = await pruneWorktrees(scratch.repo);
  assert.equal(again.prunedIds.length, 0);
});

test('listWorktrees reports the main worktree first and unquoted absolute paths', async () => {
  const worktrees = await listWorktrees(scratch.repo);
  assert.equal(worktrees[0]?.path, scratch.repo);
  assert.equal(worktrees[0]?.isMainWorktree, true);
  assert.equal(worktrees[0]?.branch, 'main');
  assert.ok(worktrees.length >= 3);
  for (const worktree of worktrees.slice(1)) {
    assert.equal(worktree.isMainWorktree, false);
    assert.equal(worktree.path, path.resolve(worktree.path));
    assert.ok(worktree.path.startsWith(`${scratch.worktreeRoot}${path.sep}`));
  }
  const listed = new Set(worktrees.map((worktree) => worktree.path));
  assert.equal(listed.has(scratch.repo), true);
  assert.equal(listed.has(scratch.worktreePath('wt-basic')), true);
  // Every registered worktree except the main one lives in the worktree root, outside the repo.
  const insideRepo = worktrees.filter((worktree) =>
    worktree.path.startsWith(`${scratch.repo}${path.sep}`),
  );
  assert.deepEqual(insideRepo, []);
});
