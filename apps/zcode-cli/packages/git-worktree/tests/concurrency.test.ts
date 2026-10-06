/**
 * Concurrency tests.
 *
 * The spike's measurement (section 2) is the contract: separate worktrees are index-safe (0
 * `index.lock` failures across 150 concurrent commits) while writers in one worktree collide hard
 * (43 failures in 120 commits). The orchestrator therefore serializes only what it must: registry
 * mutations per repository, integrations per integration worktree.
 */

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';

import {
  addWorktree,
  commitsAhead,
  getStatus,
  hasUncommittedWork,
  listWorktrees,
  withIntegrationLock,
  withRepoLock,
} from '../src/index.js';
import { createScratchRepo, delay, type ScratchRepo } from './helpers/scratch.js';

let scratch: ScratchRepo;

before(async () => {
  scratch = await createScratchRepo();
});

after(async () => {
  await scratch.cleanup();
});

test('parallel workers commit in their own worktrees with zero index.lock collisions', async () => {
  const workers = await Promise.all([
    scratch.addWorktree('conc-1'),
    scratch.addWorktree('conc-2'),
    scratch.addWorktree('conc-3'),
  ]);

  const commitWork = async (worktree: string, name: string): Promise<{ failures: number; locks: number }> => {
    let failures = 0;
    let locks = 0;
    for (let index = 0; index < 5; index += 1) {
      await scratch.write(`${name}-${index}.txt`, `${name} ${index}\n`, worktree);
      const staged = await scratch.run(['add', '-A'], { cwd: worktree });
      if (staged.exitCode !== 0) failures += 1;
      const committed = await scratch.run(['commit', '-q', '-m', `${name} ${index}`], { cwd: worktree });
      if (committed.exitCode !== 0) failures += 1;
      if (committed.stderr.includes('index.lock') || staged.stderr.includes('index.lock')) locks += 1;
      if (committed.stderr.includes("cannot lock ref 'HEAD'")) locks += 1;
    }
    return { failures, locks };
  };
  const results = await Promise.all(workers.map((worktree, index) => commitWork(worktree, `w${index}`)));

  assert.deepEqual(
    results.map((result) => result.failures),
    [0, 0, 0],
  );
  assert.deepEqual(
    results.map((result) => result.locks),
    [0, 0, 0],
    'separate worktrees own separate index and HEAD files',
  );
  for (const [index, worktree] of workers.entries()) {
    assert.equal(await commitsAhead(scratch.repo, scratch.base, `zcode/conc-${index + 1}`), 5);
    assert.equal(await hasUncommittedWork(worktree), false);
  }

  // Each worktree has its own admin dir, which is why the parallel writers never met.
  const gitDirs = await Promise.all(
    workers.map(async (worktree) => (await scratch.ok(['rev-parse', '--absolute-git-dir'], worktree)).stdout.trim()),
  );
  assert.equal(new Set(gitDirs).size, 3);
  for (const gitDir of gitDirs) assert.match(gitDir, /\.git\/worktrees\//);
});

test('a change in one worktree is invisible to the others and to the main worktree', async () => {
  const worktrees = await Promise.all([
    scratch.addWorktree('isolated-1'),
    scratch.addWorktree('isolated-2'),
  ]);
  await writeFile(path.join(worktrees[0] ?? '', 'only-here.txt'), 'local\n', 'utf8');

  assert.equal(await hasUncommittedWork(worktrees[0] ?? ''), true);
  assert.equal(await hasUncommittedWork(worktrees[1] ?? ''), false);
  assert.equal(await hasUncommittedWork(scratch.repo), false);
  const first = await getStatus(worktrees[0] ?? '');
  assert.deepEqual(
    first.entries.map((entry) => entry.path),
    ['only-here.txt'],
  );
});

test('withRepoLock serializes tasks and survives a throwing task', async () => {
  let active = 0;
  let peak = 0;
  const order: string[] = [];
  const task = (name: string): Promise<void> =>
    withRepoLock(scratch.repo, async () => {
      active += 1;
      peak = Math.max(peak, active);
      order.push(`start:${name}`);
      await delay(20);
      order.push(`end:${name}`);
      active -= 1;
    });

  await Promise.all([task('a'), task('b'), task('c')]);
  assert.equal(peak, 1, 'registry mutations must not interleave');
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);

  await assert.rejects(() => withRepoLock(scratch.repo, async () => Promise.reject(new Error('boom'))));
  const after = await withRepoLock(scratch.repo, async () => 'still works');
  assert.equal(after, 'still works');
});

test('locks are keyed: different repositories and worktrees do not serialize', async () => {
  let active = 0;
  let peak = 0;
  const run = (key: string): Promise<void> =>
    withRepoLock(key, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(20);
      active -= 1;
    });
  await Promise.all([run(scratch.repo), run(path.join(scratch.root, 'other-repo'))]);
  assert.equal(peak, 2, 'independent keys are independent mutexes');

  let integrationPeak = 0;
  let integrationActive = 0;
  await Promise.all(
    ['integration-a', 'integration-b'].map((name) =>
      withIntegrationLock(scratch.worktreePath(name), async () => {
        integrationActive += 1;
        integrationPeak = Math.max(integrationPeak, integrationActive);
        await delay(20);
        integrationActive -= 1;
      }),
    ),
  );
  assert.equal(integrationPeak, 2);
});

test('concurrent addWorktree calls all register under the per-repository mutex', async () => {
  const before = (await listWorktrees(scratch.repo)).length;
  const created = await Promise.all([
    addWorktree(scratch.repo, {
      path: scratch.worktreePath('parallel-a'),
      branch: 'zcode/parallel-a',
      baseRef: scratch.base,
      quiet: true,
    }),
    addWorktree(scratch.repo, {
      path: scratch.worktreePath('parallel-b'),
      branch: 'zcode/parallel-b',
      baseRef: scratch.base,
      quiet: true,
    }),
    addWorktree(scratch.repo, {
      path: scratch.worktreePath('parallel-c'),
      branch: 'zcode/parallel-c',
      baseRef: scratch.base,
      quiet: true,
    }),
  ]);

  assert.deepEqual(
    created.map((worktree) => worktree.branch),
    ['zcode/parallel-a', 'zcode/parallel-b', 'zcode/parallel-c'],
  );
  const after = await listWorktrees(scratch.repo);
  assert.equal(after.length, before + 3);
  for (const worktree of created) {
    assert.equal(
      after.filter((entry) => entry.path === worktree.path).length,
      1,
      'each worktree is registered exactly once',
    );
  }
});

test('mutations can be composed inside one critical section with lock: false', async () => {
  const composed = await withRepoLock(scratch.repo, async () => {
    const worktree = await addWorktree(
      scratch.repo,
      {
        path: scratch.worktreePath('composed'),
        branch: 'zcode/composed',
        baseRef: scratch.base,
        quiet: true,
      },
      { lock: false },
    );
    const listed = await listWorktrees(scratch.repo);
    return { worktree, count: listed.filter((entry) => entry.path === worktree.path).length };
  });
  assert.equal(composed.worktree.branch, 'zcode/composed');
  assert.equal(composed.count, 1);
  assert.deepEqual(
    composed.worktree.path,
    scratch.worktreePath('composed'),
  );
});
