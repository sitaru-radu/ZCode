/**
 * Safety-critical removal tests.
 *
 * The property under test is the one the spike calls out in G10 and section 4.3: `worktree remove`
 * protects uncommitted work with exit `128` but deletes a clean worktree with unmerged commits at
 * exit `0`, and `--force` destroys uncommitted work with no recovery path. This package must refuse
 * rather than escalate, and must always leave the branch (and therefore the commits) recoverable.
 */

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';

import {
  addWorktree,
  getConflictState,
  getWorktree,
  hasUncommittedWork,
  isRegistered,
  listWorktrees,
  lockWorktree,
  mergeInto,
  removeWorktree,
  type RemovalGuardStep,
  type RemoveWorktreeReport,
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

function stepsOf(report: { steps: readonly { step: RemovalGuardStep }[] }): RemovalGuardStep[] {
  return report.steps.map((entry) => entry.step);
}

function stepOk(report: { steps: readonly { step: RemovalGuardStep; ok: boolean }[] }, step: RemovalGuardStep): boolean {
  return report.steps.find((entry) => entry.step === step)?.ok === true;
}

/** Subjects of the commits `branch` has that the seed base does not. */
async function branchSubjects(branch: string): Promise<string[]> {
  const log = await scratch.ok(['log', '--format=%s', `${scratch.base}..${branch}`]);
  return log.stdout.split('\n').filter((line) => line !== '');
}

test('removal refuses a worktree with uncommitted work and never escalates to --force', async () => {
  const target = await scratch.addWorktree('guard-dirty');
  await writeFile(path.join(target, 'dirty.txt'), 'uncommitted\n', 'utf8');

  const report: RemoveWorktreeReport = await removeWorktree(scratch.repo, target, { baseRef: scratch.base });

  assert.equal(report.removed, false);
  assert.equal(report.mode, null);
  assert.equal(report.refusal?.code, 'dirty');
  assert.match(report.refusal?.message ?? '', /uncommitted work/);
  assert.match(report.refusal?.message ?? '', /dirty\.txt/);
  assert.equal(report.branch, 'zcode/guard-dirty');
  assert.equal(stepOk(report, 'directory'), true);
  assert.equal(stepOk(report, 'registration'), true);
  assert.equal(stepOk(report, 'main-worktree'), true);
  assert.equal(stepOk(report, 'locked'), true);
  assert.equal(stepOk(report, 'dirty'), false);
  assert.equal(stepOk(report, 'remove'), false, 'the guarded remove must never run');

  // Nothing was destroyed: directory, registry entry, file content and branch all survive.
  assert.equal(await exists(target), true);
  assert.equal(await isRegistered(scratch.repo, target), true);
  assert.equal(await readFile(path.join(target, 'dirty.txt'), 'utf8'), 'uncommitted\n');
  assert.equal((await scratch.ok(['branch', '--list', 'zcode/guard-dirty'])).stdout.trim().length > 0, true);
});

test('removal refuses an untracked-only worktree with the same typed refusal', async () => {
  const target = await scratch.addWorktree('guard-untracked');
  await mkdir(path.join(target, 'scratch-dir'), { recursive: true });
  await writeFile(path.join(target, 'scratch-dir', 'note.txt'), 'untracked\n', 'utf8');

  const report = await removeWorktree(scratch.repo, target);
  assert.equal(report.removed, false);
  assert.equal(report.refusal?.code, 'dirty');
  assert.equal(await isRegistered(scratch.repo, target), true);
});

test('removal refuses the main worktree', async () => {
  const report = await removeWorktree(scratch.repo, scratch.repo);
  assert.equal(report.removed, false);
  assert.equal(report.refusal?.code, 'main-worktree');
  assert.equal(stepOk(report, 'main-worktree'), false);
  assert.equal(await isRegistered(scratch.repo, scratch.repo), true);
  assert.equal(await hasUncommittedWork(scratch.repo), false);
});

test('removal refuses a directory that is not a registered worktree', async () => {
  const outsider = path.join(scratch.root, 'not-a-worktree');
  await mkdir(outsider, { recursive: true });
  await writeFile(path.join(outsider, 'keep.txt'), 'keep\n', 'utf8');

  const report = await removeWorktree(scratch.repo, outsider);
  assert.equal(report.removed, false);
  assert.equal(report.refusal?.code, 'not-registered');
  assert.equal(report.refusal?.exitCode, 128);
  assert.match(report.refusal?.stderr ?? '', /is not a working tree/);
  assert.equal(await readFile(path.join(outsider, 'keep.txt'), 'utf8'), 'keep\n');
});

test('removal refuses a locked worktree, and unlockIfLocked removes it explicitly', async () => {
  const target = await scratch.addWorktree('guard-locked');
  await lockWorktree(scratch.repo, target, 'agent working');

  const refused = await removeWorktree(scratch.repo, target);
  assert.equal(refused.removed, false);
  assert.equal(refused.refusal?.code, 'locked');
  assert.match(refused.refusal?.message ?? '', /locked/);
  assert.match(refused.refusal?.message ?? '', /agent working/);
  assert.equal(stepOk(refused, 'locked'), false);
  assert.equal(await exists(target), true);
  assert.equal(await isRegistered(scratch.repo, target), true);

  const unlocked = await removeWorktree(scratch.repo, target, { unlockIfLocked: true, baseRef: scratch.base });
  assert.equal(unlocked.removed, true);
  assert.equal(unlocked.mode, 'removed');
  assert.equal(unlocked.refusal, null);
  assert.equal(stepOk(unlocked, 'locked'), true);
  assert.equal(await exists(target), false);
  assert.equal(await isRegistered(scratch.repo, target), false);
  assert.ok(stepsOf(unlocked).includes('registry-verify'));
  assert.ok(stepsOf(unlocked).includes('prune'));
});

test('removal refuses a worktree with a merge in progress, then succeeds after abort', async () => {
  await scratch.write('u.txt', 'line1\nline2\nline3\n');
  await scratch.commitAll('add u.txt');
  const uBase = await scratch.revParse('HEAD');

  const create = async (name: string): Promise<string> =>
    (
      await addWorktree(scratch.repo, {
        path: scratch.worktreePath(name),
        branch: `zcode/${name}`,
        baseRef: uBase,
        quiet: true,
      })
    ).path;

  const left = await create('guard-merge-a');
  const right = await create('guard-merge-b');
  const integration = await create('guard-integration');

  await scratch.write('u.txt', 'line1\nFROM-A\nline3\n', left);
  await scratch.commitAll('a: change u.txt', left);
  await scratch.write('u.txt', 'line1\nFROM-B\nline3\n', right);
  await scratch.commitAll('b: change u.txt', right);

  const first = await mergeInto(integration, 'zcode/guard-merge-a', { message: 'merge a' });
  assert.equal(first.outcome, 'merged');
  const second = await mergeInto(integration, 'zcode/guard-merge-b', { message: 'merge b' });
  assert.equal(second.outcome, 'conflict');

  const inMerge = await getConflictState(integration);
  assert.equal(inMerge.inMerge, true);
  assert.deepEqual(inMerge.conflicted, ['u.txt']);

  const refused = await removeWorktree(scratch.repo, integration);
  assert.equal(refused.removed, false);
  assert.equal(refused.refusal?.code, 'merge-in-progress');
  assert.match(refused.refusal?.message ?? '', /abortMerge/);
  assert.equal(stepOk(refused, 'merge'), false);
  assert.equal(await exists(integration), true);
  assert.equal(await isRegistered(scratch.repo, integration), true);

  // The merge state is intact, so the orchestrator can still resolve or abort it.
  assert.equal((await getConflictState(integration)).hasConflict, true);

  await scratch.ok(['merge', '--abort'], integration);
  const removed = await removeWorktree(scratch.repo, integration, { baseRef: uBase });
  assert.equal(removed.removed, true);
  assert.equal(removed.refusal, null);
});

test('a clean worktree with unmerged commits is removed, and the branch keeps the work', async () => {
  const target = await scratch.addWorktree('guard-ahead');
  await scratch.write('work.txt', 'unmerged work\n', target);
  const commit = await scratch.commitAll('unmerged work', target);
  assert.equal(await hasUncommittedWork(target), false);

  const report = await removeWorktree(scratch.repo, target, { baseRef: scratch.base });

  assert.equal(report.removed, true);
  assert.equal(report.mode, 'removed');
  assert.equal(report.branch, 'zcode/guard-ahead');
  assert.equal(report.unmergedCommits, 1);
  assert.equal(report.residue, null);
  assert.equal(stepOk(report, 'unmerged-commits'), true);
  assert.equal(await isRegistered(scratch.repo, target), false);
  assert.equal(await exists(target), false);

  // The branch survives, so the removed-but-unmerged work is recoverable (spike G10).
  const branches = await scratch.ok(['branch', '--list', 'zcode/guard-ahead']);
  assert.match(branches.stdout, /zcode\/guard-ahead/);
  const subjects = await branchSubjects('zcode/guard-ahead');
  assert.deepEqual(subjects, ['unmerged work']);
  const reachable = await scratch.ok(['rev-parse', 'zcode/guard-ahead']);
  assert.equal(reachable.stdout.trim(), commit);
});

test('a hand-deleted worktree directory is deregistered through the prune path', async () => {
  const target = await scratch.addWorktree('guard-gone');
  await rm(target, { recursive: true, force: true });
  assert.equal((await getWorktree(scratch.repo, target))?.prunable, true);

  const report = await removeWorktree(scratch.repo, target);
  assert.equal(report.removed, true);
  assert.equal(report.mode, 'pruned');
  assert.equal(report.refusal, null);
  assert.equal(report.pruned, true);
  assert.equal(stepOk(report, 'directory'), true);
  assert.equal(await isRegistered(scratch.repo, target), false);

  // A path that is neither present nor registered is already clean: nothing to do, nothing destroyed.
  const absent = await removeWorktree(scratch.repo, target);
  assert.equal(absent.removed, true);
  assert.equal(absent.mode, 'absent');
  assert.equal(absent.pruned, false);
});

test('explicit force removes a dirty worktree; auto-escalation never happens', async () => {
  const dirty = await scratch.addWorktree('guard-force');
  await scratch.write('work.txt', 'committed\n', dirty);
  await scratch.commitAll('committed work', dirty);
  await writeFile(path.join(dirty, 'precious.txt'), 'uncommitted\n', 'utf8');

  const refused = await removeWorktree(scratch.repo, dirty, { baseRef: scratch.base });
  assert.equal(refused.removed, false);
  assert.equal(refused.refusal?.code, 'dirty');

  const forced = await removeWorktree(scratch.repo, dirty, { force: true, baseRef: scratch.base });
  assert.equal(forced.removed, true);
  assert.equal(forced.refusal, null);
  assert.equal(stepOk(forced, 'dirty'), true);
  assert.equal(await exists(dirty), false);
  assert.equal(await isRegistered(scratch.repo, dirty), false);
  // Committed work stays recoverable through the branch even after a forced removal.
  assert.deepEqual(await branchSubjects('zcode/guard-force'), ['committed work']);

  const lockedAndDirty = await scratch.addWorktree('guard-force-twice');
  await lockWorktree(scratch.repo, lockedAndDirty, 'agent working');
  await writeFile(path.join(lockedAndDirty, 'precious.txt'), 'uncommitted\n', 'utf8');

  const refusedLocked = await removeWorktree(scratch.repo, lockedAndDirty, { force: true });
  assert.equal(refusedLocked.removed, false);
  assert.equal(refusedLocked.refusal?.code, 'locked');

  const forcedTwice = await removeWorktree(scratch.repo, lockedAndDirty, { forceTwice: true });
  assert.equal(forcedTwice.removed, true);
  assert.equal(await exists(lockedAndDirty), false);
  assert.equal(await isRegistered(scratch.repo, lockedAndDirty), false);
});

test('every removal leaves the registry consistent and the source repo clean', async () => {
  const worktrees = await listWorktrees(scratch.repo);
  for (const worktree of worktrees) {
    assert.equal(await exists(worktree.path), true, `${worktree.path} is registered but missing`);
    assert.equal(worktree.prunable, false, `${worktree.path} should not be prunable`);
  }
  const status = await scratch.ok(['status', '--porcelain']);
  assert.equal(status.stdout, '');
});
