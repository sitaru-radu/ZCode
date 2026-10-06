/**
 * §6 deterministic scheduling: readiness, blocking, dispatch capacity and progress detection
 * (invariants 1, 9).
 *
 * `planIndex` is the position of a task in the array handed to the function — materialization
 * order — so the tests below always state the input order they rely on.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { blockedTasks, hasProgress, readyTasks, selectDispatch, type Task } from '../src/index.js';
import { at, makeTasks, planKeysOf, taskId } from './fixtures.js';

test('readyTasks returns pending tasks whose dependencies are all done', () => {
  const tasks = makeTasks([
    { key: 'a', status: 'done' },
    { key: 'b', deps: ['a'] },
    { key: 'c', deps: ['b'] },
    { key: 'd' },
  ]);
  assert.deepEqual(planKeysOf(readyTasks(tasks)), ['b', 'd']);
});

test('readyTasks treats only done dependencies as satisfied', () => {
  for (const status of ['pending', 'ready', 'running', 'review', 'failed', 'blocked'] as const) {
    const tasks = makeTasks([
      { key: 'a', status },
      { key: 'b', deps: ['a'] },
    ]);
    const ready = planKeysOf(readyTasks(tasks));
    assert.equal(ready.includes('b'), false, `dependent started with dependency status ${status}`);
  }

  const done = makeTasks([
    { key: 'a', status: 'done' },
    { key: 'b', deps: ['a'] },
  ]);
  assert.deepEqual(planKeysOf(readyTasks(done)), ['b']);
});

test('readyTasks includes a retried task (status ready) and excludes every non-dispatchable status', () => {
  const ready = makeTasks([{ key: 'a', status: 'ready' }]);
  assert.deepEqual(planKeysOf(readyTasks(ready)), ['a']);

  for (const status of ['running', 'review', 'done', 'failed', 'blocked'] as const) {
    const tasks = makeTasks([{ key: 'a', status }]);
    assert.deepEqual(planKeysOf(readyTasks(tasks)), [], status);
  }
});

test('readyTasks never reports a task whose dependency is not done, whatever its status claims (invariant 1)', () => {
  const tasks = makeTasks([
    { key: 'a' },
    { key: 'b', deps: ['a'], status: 'ready' },
    { key: 'c', deps: ['a'], status: 'running' },
  ]);
  // Only the dependency-free task may start; the stored `ready` (retry) and `running` rows may not.
  assert.deepEqual(planKeysOf(readyTasks(tasks)), ['a']);
  assert.deepEqual(planKeysOf(selectDispatch(tasks, 3)), ['a']);
});

test('readyTasks is sorted by plan order and is deterministic (invariant 9)', () => {
  const tasks = makeTasks([{ key: 'c' }, { key: 'a' }, { key: 'b' }]);
  assert.deepEqual(planKeysOf(readyTasks(tasks)), ['c', 'a', 'b']);
  assert.deepEqual(readyTasks(tasks), readyTasks(tasks));
  assert.deepEqual(
    readyTasks(tasks).map((task) => task.id),
    readyTasks(tasks).map((task) => task.id),
  );
});

test('blockedTasks reports direct, transitive and unknown dependencies', () => {
  const direct = makeTasks([
    { key: 'a', status: 'failed' },
    { key: 'b', deps: ['a'] },
  ]);
  assert.deepEqual(planKeysOf(blockedTasks(direct)), ['b']);

  const transitive = makeTasks([
    { key: 'a', status: 'failed' },
    { key: 'b', deps: ['a'] },
    { key: 'c', deps: ['b'] },
  ]);
  assert.deepEqual(planKeysOf(blockedTasks(transitive)), ['b', 'c']);

  const viaBlocked = makeTasks([
    { key: 'a', status: 'blocked' },
    { key: 'b', deps: ['a'] },
  ]);
  assert.deepEqual(planKeysOf(blockedTasks(viaBlocked)), ['b']);

  const missingDependency: Task = {
    ...at(makeTasks([{ key: 'a' }]), 0),
    deps: ['tsk_missing'],
  };
  assert.deepEqual(planKeysOf(blockedTasks([missingDependency])), ['a']);
});

test('blockedTasks only reports pending or ready tasks, and follows a blocked task downstream', () => {
  const tasks = makeTasks([
    { key: 'a', status: 'failed' },
    { key: 'b', deps: ['a'], status: 'blocked' },
    { key: 'c', deps: ['b'] },
    { key: 'd', deps: ['a'], status: 'done' },
  ]);
  assert.deepEqual(planKeysOf(blockedTasks(tasks)), ['c']);
});

test('blockedTasks keeps satisfied dependencies satisfied even when their own history failed', () => {
  const tasks = makeTasks([
    { key: 'a', status: 'failed' },
    { key: 'b', deps: ['a'], status: 'done' },
    { key: 'c', deps: ['b'] },
  ]);
  assert.deepEqual(planKeysOf(blockedTasks(tasks)), []);
  assert.deepEqual(planKeysOf(readyTasks(tasks)), ['c']);
});

test('blockedTasks does not loop on a dependency cycle and reports nothing without a failure', () => {
  const tasks = makeTasks([
    { key: 'a', deps: ['b'] },
    { key: 'b', deps: ['a'] },
  ]);
  assert.deepEqual(blockedTasks(tasks), []);
  assert.deepEqual(readyTasks(tasks), []);
  assert.equal(hasProgress(tasks), false);
});

test('blockedTasks is ordered by plan order', () => {
  const tasks = makeTasks([
    { key: 'z', deps: ['dead'] },
    { key: 'dead', status: 'failed' },
    { key: 'm', deps: ['dead'] },
  ]);
  assert.deepEqual(planKeysOf(blockedTasks(tasks)), ['z', 'm']);
});

test('selectDispatch takes up to maxWorkers from readyTasks in stable order (invariant 9)', () => {
  const tasks = makeTasks([{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }, { key: 'e' }]);
  assert.deepEqual(planKeysOf(selectDispatch(tasks, 3)), ['a', 'b', 'c']);
  assert.deepEqual(planKeysOf(selectDispatch(tasks, 10)), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(planKeysOf(selectDispatch(tasks, 1)), ['a']);
  assert.deepEqual(selectDispatch(tasks, 3), selectDispatch(tasks, 3));
});

test('selectDispatch counts running tasks against the worker cap', () => {
  const tasks = makeTasks([
    { key: 'run1', status: 'running' },
    { key: 'run2', status: 'running' },
    { key: 'a' },
    { key: 'b' },
    { key: 'c' },
  ]);
  assert.deepEqual(planKeysOf(selectDispatch(tasks, 3)), ['a']);
  assert.deepEqual(planKeysOf(selectDispatch(tasks, 4)), ['a', 'b']);
  assert.deepEqual(selectDispatch(tasks, 2), []);
  assert.deepEqual(selectDispatch(tasks, 1), []);
});

test('selectDispatch clamps a degenerate worker cap to zero', () => {
  const tasks = makeTasks([{ key: 'a' }, { key: 'b' }]);
  assert.deepEqual(selectDispatch(tasks, 0), []);
  assert.deepEqual(selectDispatch(tasks, -3), []);
  assert.deepEqual(selectDispatch(tasks, Number.NaN), []);
  assert.deepEqual(planKeysOf(selectDispatch(tasks, 2.9)), ['a', 'b']);
});

test('selectDispatch never returns a task with an unfinished dependency (invariant 1)', () => {
  const tasks = makeTasks([
    { key: 'a', status: 'running' },
    { key: 'b', deps: ['a'], status: 'ready' },
    { key: 'c', deps: ['b'] },
    { key: 'd', deps: ['a'] },
    { key: 'e' },
  ]);
  const dispatched = planKeysOf(selectDispatch(tasks, 10));
  assert.deepEqual(dispatched, ['e']);
  for (const task of selectDispatch(tasks, 10)) {
    for (const depId of task.deps) {
      const dependency = tasks.find((candidate) => candidate.id === depId);
      assert.equal(dependency?.status, 'done', `${task.planKey} dispatched with an unfinished dependency`);
    }
  }
});

test('hasProgress is true while a task runs or a task can be dispatched', () => {
  assert.equal(hasProgress(makeTasks([{ key: 'a', status: 'running' }])), true);
  assert.equal(hasProgress(makeTasks([{ key: 'a', status: 'done' }, { key: 'b', deps: ['a'] }])), true);
  assert.equal(hasProgress(makeTasks([{ key: 'a' }])), true);
});

test('hasProgress is false only when work remains and nothing can start it', () => {
  assert.equal(hasProgress([]), false);
  assert.equal(
    hasProgress(
      makeTasks([
        { key: 'a', status: 'failed' },
        { key: 'b', deps: ['a'] },
      ]),
    ),
    false,
  );
  assert.equal(
    hasProgress(
      makeTasks([
        { key: 'a', status: 'blocked' },
        { key: 'b', deps: ['a'] },
        { key: 'done-task', status: 'done' },
      ]),
    ),
    false,
  );
});

test('hasProgress treats a fully decided graph as progress towards the gate', () => {
  assert.equal(hasProgress(makeTasks([{ key: 'a', status: 'done' }, { key: 'b', status: 'done' }])), true);
  assert.equal(hasProgress(makeTasks([{ key: 'a', status: 'failed' }, { key: 'b', status: 'blocked' }])), true);
});

test('scheduling helpers agree on a partially executed plan', () => {
  const tasks = makeTasks([
    { key: 'a', status: 'done' },
    { key: 'b', status: 'done' },
    { key: 'c', deps: ['a', 'b'] },
    { key: 'd', deps: ['c'] },
    { key: 'e', status: 'failed' },
    { key: 'f', deps: ['e'] },
  ]);
  assert.deepEqual(planKeysOf(readyTasks(tasks)), ['c']);
  assert.deepEqual(planKeysOf(blockedTasks(tasks)), ['f']);
  assert.deepEqual(planKeysOf(selectDispatch(tasks, 2)), ['c']);
  assert.equal(hasProgress(tasks), true);
  assert.deepEqual(taskId('c'), tasks[2]?.id);
});
