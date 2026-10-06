/**
 * Conflict pre-flight and integration tests against real merges.
 *
 * What these tests exist for (spike section 3): the conflict report is on STDOUT with an empty
 * stderr and exit `1`, `MERGE_HEAD` alone is not a conflict, and `merge --abort` must leave no
 * residue. Ordering is covered too: prediction is read-only, and the merge is what decides "ours".
 */

import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';

import {
  abortMerge,
  addWorktree,
  getStatus,
  git,
  headSha,
  isMergeInProgress,
  mergeInto,
  parseMergeTreeOutput,
  parseUnmergedEntries,
  predictMerge,
} from '../src/index.js';
import { createScratchRepo, type ScratchRepo } from './helpers/scratch.js';

let scratch: ScratchRepo;

interface ConflictFixture {
  readonly base: string;
  readonly left: string;
  readonly right: string;
  readonly disjoint: string;
  readonly integration: string;
  readonly branches: {
    readonly left: string;
    readonly right: string;
    readonly disjoint: string;
    readonly integration: string;
  };
}

/** Two branches changing the same line of `u.txt`, a disjoint branch and an integration worktree. */
async function setupConflictFixture(tag: string): Promise<ConflictFixture> {
  await scratch.write('u.txt', 'line1\nline2\nline3\n');
  if ((await scratch.ok(['status', '--porcelain', 'u.txt'])).stdout.trim() !== '') {
    await scratch.commitAll('add u.txt');
  }
  const base = await scratch.revParse('HEAD');
  const branches = {
    left: `zcode/${tag}-left`,
    right: `zcode/${tag}-right`,
    disjoint: `zcode/${tag}-disjoint`,
    integration: `zcode/${tag}-integration`,
  };
  const create = async (name: keyof typeof branches): Promise<string> =>
    (
      await addWorktree(scratch.repo, {
        path: scratch.worktreePath(`${tag}-${name}`),
        branch: branches[name],
        baseRef: base,
        quiet: true,
      })
    ).path;

  const paths = {
    left: await create('left'),
    right: await create('right'),
    disjoint: await create('disjoint'),
    integration: await create('integration'),
  };

  await scratch.write('u.txt', 'line1\nCONFLICT-FROM-LEFT\nline3\n', paths.left);
  await scratch.commitAll('left: change u.txt', paths.left);
  await scratch.write('u.txt', 'line1\nCONFLICT-FROM-RIGHT\nline3\n', paths.right);
  await scratch.commitAll('right: change u.txt', paths.right);
  await scratch.write('only-left.txt', 'disjoint\n', paths.disjoint);
  await scratch.commitAll('disjoint: add only-left.txt', paths.disjoint);

  return { base, branches, ...paths };
}

before(async () => {
  scratch = await createScratchRepo();
});

after(async () => {
  await scratch.cleanup();
});

test('the merge-tree and ls-files parsers read the verbatim output shapes', () => {
  const conflict = [
    '763844b7754b99fcf6fe947e981d7a8db820e779',
    'u.txt',
    '',
    'Auto-merging u.txt',
    'CONFLICT (content): Merge conflict in u.txt',
    '',
  ].join('\n');
  const parsed = parseMergeTreeOutput(conflict);
  assert.equal(parsed.tree, '763844b7754b99fcf6fe947e981d7a8db820e779');
  assert.deepEqual(parsed.conflicts, ['u.txt']);
  assert.deepEqual(parsed.messages, ['Auto-merging u.txt', 'CONFLICT (content): Merge conflict in u.txt']);

  const clean = parseMergeTreeOutput('1684a81f068113e52f4771d1fed527cf1633c8f2\n');
  assert.equal(clean.tree, '1684a81f068113e52f4771d1fed527cf1633c8f2');
  assert.deepEqual(clean.conflicts, []);
  assert.deepEqual(clean.messages, []);

  const stages = parseUnmergedEntries(
    '100644 83db48f84ec878fbfb30b46d16630e944e34f205 1\tu.txt\0' +
      '100644 0c9ae36e6f232dd9e77fd7e9a0977c50dd282aa6 2\tu.txt\0' +
      '100644 e0d5e5593a28fb8b6c49f435120b4caacd2a7e91 3\tu.txt\0',
  );
  assert.deepEqual(stages.map((entry) => entry.stage), [1, 2, 3]);
  assert.ok(stages.every((entry) => entry.path === 'u.txt' && entry.sha.length === 40));
});

test('predictMerge answers cleanly for disjoint branches without touching any worktree', async () => {
  const fixture = await setupConflictFixture('p1');
  const headBefore = await headSha(fixture.disjoint);

  const disjoint = await predictMerge(scratch.repo, fixture.branches.left, fixture.branches.disjoint);
  assert.equal(disjoint.clean, true);
  assert.equal(disjoint.exitCode, 0);
  assert.deepEqual(disjoint.conflicts, []);
  assert.equal(disjoint.stderr, '');
  assert.match(disjoint.tree ?? '', /^[0-9a-f]{40}$/);

  // Read-only: no worktree, no index, no lock, nothing changed.
  assert.equal(await headSha(fixture.disjoint), headBefore);
  assert.equal((await getStatus(fixture.disjoint)).clean, true);
  assert.equal(await isMergeInProgress(fixture.disjoint), false);

  const self = await predictMerge(scratch.repo, fixture.branches.left, fixture.branches.left);
  assert.equal(self.clean, true);
  const againstBase = await predictMerge(scratch.repo, fixture.branches.left, fixture.base);
  assert.equal(againstBase.clean, true);
});

test('predictMerge reports a conflict (exit 1) with paths and messages on STDOUT', async () => {
  const fixture = await setupConflictFixture('p2');
  const prediction = await predictMerge(scratch.repo, fixture.branches.left, fixture.branches.right);

  assert.equal(prediction.clean, false);
  assert.equal(prediction.exitCode, 1);
  assert.deepEqual(prediction.conflicts, ['u.txt']);
  assert.match(prediction.tree ?? '', /^[0-9a-f]{40}$/);
  // G1: the human half of the report is on stdout, stderr stays empty.
  assert.equal(prediction.stderr, '');
  assert.ok(prediction.messages.some((message) => message.startsWith('CONFLICT (content)')));
  assert.ok(prediction.messages.some((message) => message.startsWith('Auto-merging')));
  assert.ok(prediction.stdout.includes('CONFLICT (content): Merge conflict in u.txt'));
});

test('mergeInto integrates in order and detects conflicts without a stderr grep', async () => {
  const fixture = await setupConflictFixture('m1');

  const first = await mergeInto(fixture.integration, fixture.branches.left, { message: 'merge left' });
  assert.equal(first.outcome, 'merged');
  assert.equal(first.exitCode, 0);
  assert.match(first.stdout, /Merge made by the 'ort' strategy/);
  assert.equal(first.stderr, '');
  assert.equal(first.conflict, null);

  // --no-ff always leaves a merge commit with two parents (spike 3.3).
  const parents = await scratch.ok(['rev-list', '--parents', '-1', 'HEAD'], fixture.integration);
  assert.equal(parents.stdout.trim().split(/\s+/).length, 3);

  const second = await mergeInto(fixture.integration, fixture.branches.right, { message: 'merge right' });
  assert.equal(second.outcome, 'conflict');
  assert.equal(second.exitCode, 1);
  assert.equal(second.stderr, '', 'the conflict report is not on stderr');
  assert.match(second.stdout, /CONFLICT \(content\): Merge conflict in u\.txt/);
  assert.match(second.stdout, /Automatic merge failed; fix conflicts and then commit the result\./);
  assert.equal(second.conflict?.inMerge, true);
  assert.deepEqual(second.conflict?.conflicted, ['u.txt']);
  assert.equal(second.conflict?.hasConflict, true);

  // The three independent signals of spike 3.2 agree.
  assert.equal(await isMergeInProgress(fixture.integration), true);
  const stages = await scratch.ok(['ls-files', '-u'], fixture.integration);
  assert.equal(stages.stdout.trim().split('\n').length, 3, 'UU leaves stages 1, 2 and 3');
  assert.deepEqual(second.conflict?.entries.map((entry) => entry.stage).sort(), [1, 2, 3]);

  const status = await getStatus(fixture.integration);
  assert.equal(status.clean, false);
  assert.deepEqual(status.conflicted, ['u.txt']);
  const unmerged = status.entries.find((entry) => entry.kind === 'unmerged');
  assert.equal(unmerged?.xy, 'UU');
  assert.equal(unmerged?.mergeShas.length, 3);

  const conflictedFile = await scratch.read('u.txt', fixture.integration);
  assert.match(conflictedFile, /<<<<<<< HEAD/);
  assert.match(conflictedFile, />>>>>>> zcode\/m1-right/);
});

test('abortMerge restores the worktree with no residue, and is a safe no-op when idle', async () => {
  const fixture = await setupConflictFixture('a1');
  await mergeInto(fixture.integration, fixture.branches.left, { message: 'merge left' });
  const headBefore = await headSha(fixture.integration);
  await mergeInto(fixture.integration, fixture.branches.right, { message: 'merge right' });
  assert.equal(await isMergeInProgress(fixture.integration), true);

  const aborted = await abortMerge(fixture.integration);
  assert.equal(aborted.aborted, true);
  assert.equal(aborted.exitCode, 0);
  assert.equal(aborted.conflict.inMerge, false);
  assert.equal(aborted.conflict.hasConflict, false);

  assert.equal(await headSha(fixture.integration), headBefore);
  assert.equal(await isMergeInProgress(fixture.integration), false);
  const status = await getStatus(fixture.integration);
  assert.equal(status.clean, true);
  assert.deepEqual(status.conflicted, []);

  // MERGE_HEAD / MERGE_MSG are gone from the worktree's own admin dir, and no *.orig copy remains.
  const mergeHeadPath = (await scratch.ok(['rev-parse', '--git-path', 'MERGE_HEAD'], fixture.integration)).stdout.trim();
  const mergeMsgPath = (await scratch.ok(['rev-parse', '--git-path', 'MERGE_MSG'], fixture.integration)).stdout.trim();
  await assert.rejects(() => stat(mergeHeadPath));
  await assert.rejects(() => stat(mergeMsgPath));
  await assert.rejects(() => stat(path.join(fixture.integration, 'u.txt.orig')));

  // Nothing to abort: exit 128, "MERGE_HEAD missing" — a documented, non-destructive outcome.
  const second = await abortMerge(fixture.integration);
  assert.equal(second.aborted, false);
  assert.equal(second.exitCode, 128);
  assert.match(second.stderr, /There is no merge to abort \(MERGE_HEAD missing\)/);
  assert.equal((await getStatus(fixture.integration)).clean, true);
});

test('mergeInto reports up-to-date and failure outcomes without inventing a conflict', async () => {
  const fixture = await setupConflictFixture('u1');

  const first = await mergeInto(fixture.integration, fixture.branches.disjoint, { message: 'merge disjoint' });
  assert.equal(first.outcome, 'merged');
  const again = await mergeInto(fixture.integration, fixture.branches.disjoint, { message: 'again' });
  assert.equal(again.outcome, 'up-to-date');
  assert.equal(again.exitCode, 0);
  assert.match(again.stdout, /Already up to date/);
  assert.equal(again.conflict, null);

  const missing = await mergeInto(fixture.integration, 'zcode/does-not-exist', { message: 'nope' });
  assert.equal(missing.outcome, 'failed');
  assert.notEqual(missing.exitCode, 0);
  assert.equal(missing.conflict?.inMerge, false, 'a failed merge is not a conflict');
  assert.equal(missing.conflict?.hasConflict, false);
  assert.equal(await isMergeInProgress(fixture.integration), false);
});

test('integration does not disturb task branches or the main worktree', async () => {
  const fixture = await setupConflictFixture('i1');
  const leftBefore = await scratch.revParse(fixture.branches.left);
  const rightBefore = await scratch.revParse(fixture.branches.right);
  const mainBefore = await scratch.revParse('main');

  await mergeInto(fixture.integration, fixture.branches.left, { message: 'merge left' });

  assert.equal(await scratch.revParse(fixture.branches.left), leftBefore);
  assert.equal(await scratch.revParse(fixture.branches.right), rightBefore);
  assert.equal(await scratch.revParse('main'), mainBefore);
  assert.equal((await getStatus(scratch.repo)).clean, true);

  // Task worktrees still see only their own trees, and report their own toplevel.
  assert.equal(await scratch.read('u.txt', fixture.left), 'line1\nCONFLICT-FROM-LEFT\nline3\n');
  assert.equal(await scratch.read('u.txt', fixture.right), 'line1\nCONFLICT-FROM-RIGHT\nline3\n');
  const topLevel = (await git(['rev-parse', '--show-toplevel'], { cwd: fixture.left })).stdout.trim();
  assert.equal(topLevel, fixture.left);
});
