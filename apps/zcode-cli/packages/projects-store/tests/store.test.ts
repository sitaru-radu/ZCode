import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isProjectsStoreError,
  ProjectsStore,
  type TaskPatch,
} from '../src/index.js';
import {
  MISSION_ID,
  makeMission,
  makePlan,
  makePlanTask,
  makeProject,
  makeTask,
  PLAN_ID,
  PROJECT_ID,
  T0,
  T1,
  T2,
  TASK_ID,
} from './fixtures.js';

function withStore(t: test.TestContext): ProjectsStore {
  const store = new ProjectsStore(':memory:');
  t.after(() => store.close());
  return store;
}

test('projects round-trip and update', (t) => {
  const store = withStore(t);
  const project = makeProject();
  assert.deepEqual(store.createProject(project), project);
  assert.deepEqual(store.getProject(project.id), project);
  assert.deepEqual(store.listProjects(), [project]);

  const archived = store.updateProjectStatus(project.id, 'archived');
  assert.equal(archived.status, 'archived');
  assert.deepEqual(store.getProject(project.id), { ...project, status: 'archived' });
  assert.equal(store.getProject('prj_missing'), undefined);
});

test('project conflicts and missing rows raise typed errors', (t) => {
  const store = withStore(t);
  const project = makeProject();
  store.createProject(project);
  assert.throws(
    () => store.createProject(project),
    (error: unknown) => isProjectsStoreError(error, 'conflict'),
  );
  assert.throws(
    () => store.updateProjectStatus('prj_missing', 'archived'),
    (error: unknown) => isProjectsStoreError(error, 'not_found'),
  );
});

test('projects are listed oldest first', (t) => {
  const store = withStore(t);
  store.createProject(makeProject({ id: 'prj_late', createdAt: T1 }));
  store.createProject(makeProject({ id: 'prj_early', createdAt: T0 }));
  assert.deepEqual(
    store.listProjects().map((project) => project.id),
    ['prj_early', 'prj_late'],
  );
});

test('a minimal mission round-trips with its optional columns absent', (t) => {
  const store = withStore(t);
  const mission = makeMission();
  assert.deepEqual(store.createMission(mission), mission);

  const stored = store.getMission(mission.id);
  assert.ok(stored);
  assert.deepEqual(stored, mission);
  for (const field of ['runId', 'planVersion', 'startedAt', 'completedAt', 'summary', 'blockReason']) {
    assert.equal(Object.hasOwn(stored, field), false, `${field} must stay absent`);
  }
});

test('a fully populated mission round-trips including its JSON source', (t) => {
  const store = withStore(t);
  const mission = makeMission({
    status: 'reviewing',
    phase: 'review',
    source: { kind: 'spec', path: 'specs/projects/20-store.md' },
    runId: 'run_abc123',
    planVersion: 3,
    startedAt: T1,
    completedAt: T2,
    summary: 'review passed',
    blockReason: 'none',
  });
  store.createMission(mission);
  assert.deepEqual(store.getMission(mission.id), mission);
});

test('missions are listed per project, newest first', (t) => {
  const store = withStore(t);
  store.createProject(makeProject());
  store.createProject(makeProject({ id: 'prj_other' }));
  store.createMission(makeMission({ id: 'msn_old', createdAt: T0 }));
  store.createMission(makeMission({ id: 'msn_new', createdAt: T2 }));
  store.createMission(makeMission({ id: 'msn_elsewhere', projectId: 'prj_other' }));

  assert.deepEqual(
    store.listMissionsByProject(PROJECT_ID).map((mission) => mission.id),
    ['msn_new', 'msn_old'],
  );
});

test('updateMission patches present columns and clears nulls', (t) => {
  const store = withStore(t);
  store.createMission(makeMission({ status: 'ready', phase: 'execute', runId: 'run_1' }));

  const updated = store.updateMission(MISSION_ID, {
    status: 'running',
    phase: 'execute',
    runId: null,
    planVersion: 2,
    startedAt: T1,
  });
  assert.deepEqual(updated, {
    ...makeMission({ status: 'running', phase: 'execute' }),
    planVersion: 2,
    startedAt: T1,
  });
  assert.equal(Object.hasOwn(updated, 'runId'), false);

  assert.deepEqual(store.updateMission(MISSION_ID, {}), updated);
  assert.throws(
    () => store.updateMission(MISSION_ID, { nope: 1 } as unknown as Parameters<typeof store.updateMission>[1]),
    (error: unknown) => isProjectsStoreError(error, 'invalid_argument'),
  );
  assert.throws(
    () => store.updateMission('msn_missing', { status: 'running' }),
    (error: unknown) => isProjectsStoreError(error, 'not_found'),
  );
});

test('plans round-trip with their task list, versions and JSON arrays', (t) => {
  const store = withStore(t);
  store.createMission(makeMission());
  const plan = makePlan();
  assert.deepEqual(store.insertPlan(plan), plan);
  assert.deepEqual(store.getLatestPlan(MISSION_ID), plan);
  assert.deepEqual(store.listPlans(MISSION_ID), [plan]);

  const next = makePlan({
    id: 'pln_2',
    version: 2,
    tasks: [
      makePlanTask({ key: 'fix-1-1', title: 'Advisory fix', dependsOn: [], filesHint: [] }),
      makePlanTask({ key: 'schema', required: true }),
    ],
    risks: [],
    createdAt: T1,
  });
  store.insertPlan(next);
  assert.deepEqual(store.getLatestPlan(MISSION_ID), next);
  assert.deepEqual(
    store.listPlans(MISSION_ID).map((entry) => entry.version),
    [1, 2],
  );

  assert.throws(
    () => store.insertPlan(next),
    (error: unknown) => isProjectsStoreError(error, 'conflict'),
  );
  assert.equal(store.getLatestPlan('msn_missing'), undefined);
});

test('tasks round-trip: plan position, booleans, deps and JSON result', (t) => {
  const store = withStore(t);
  store.createMission(makeMission());
  store.insertPlan(makePlan());

  const first = makeTask();
  const second = makeTask({
    id: 'tsk_second',
    planKey: 'store',
    title: 'Implement the store',
    deps: [TASK_ID],
    required: false,
    filesHint: [],
    acceptance: [],
    status: 'ready',
    attempts: 1,
    workerId: 'wkr_1',
    worktreePath: '/tmp/wt/tsk_second',
    branch: 'zcode/msn_test/tsk_second',
    lastError: 'transient',
    result: {
      summary: 'schema frozen',
      filesChanged: ['src/schema.ts'],
      commits: ['a1b2c3d4'],
      branch: 'zcode/msn_test/tsk_second',
    },
  });

  const stored = store.insertTasks([first, second]);
  assert.equal(stored.length, 2);
  assert.equal(stored[0]?.planIndex, 0);
  assert.equal(stored[1]?.planIndex, 1);
  assert.deepEqual(store.getTask(TASK_ID), { ...first, planIndex: 0 });
  assert.deepEqual(store.getTask('tsk_second'), { ...second, planIndex: 1 });
  assert.deepEqual(
    store.listTasks(MISSION_ID).map((task) => task.id),
    [TASK_ID, 'tsk_second'],
  );
  assert.equal(store.getTask('tsk_missing'), undefined);
});

test('listTasks returns plan order, not insertion order', (t) => {
  const store = withStore(t);
  store.createMission(makeMission());
  store.insertTasks([
    makeTask({ id: 'tsk_c', planKey: 'c', planIndex: 2 }),
    makeTask({ id: 'tsk_a', planKey: 'a', planIndex: 0 }),
    makeTask({ id: 'tsk_b', planKey: 'b', planIndex: 1 }),
  ]);
  assert.deepEqual(
    store.listTasks(MISSION_ID).map((task) => task.planKey),
    ['a', 'b', 'c'],
  );
});

test('re-inserting a materialized plan version keeps stored progress', (t) => {
  const store = withStore(t);
  store.createMission(makeMission());
  const tasks = [makeTask(), makeTask({ id: 'tsk_second', planKey: 'store' })];
  store.insertTasks(tasks);
  store.updateTaskStatus(TASK_ID, 'running', { workerId: 'wkr_1', attempts: 1 });
  store.setTaskWorktree(TASK_ID, '/tmp/wt/1', 'zcode/branch');

  const again = store.insertTasks(tasks.map((task) => ({ ...task, status: 'pending' })));
  assert.equal(again[0]?.status, 'running');
  assert.equal(again[0]?.attempts, 1);
  assert.equal(again[0]?.workerId, 'wkr_1');
  assert.equal(store.listTasks(MISSION_ID).length, 2);
});

test('a failing batch insert rolls the whole batch back', (t) => {
  const store = withStore(t);
  store.createMission(makeMission());
  const poisoned = makeTask({
    id: 'tsk_poisoned',
    deps: [1n] as unknown as string[],
  });
  assert.throws(
    () => store.insertTasks([makeTask(), poisoned]),
    (error: unknown) => isProjectsStoreError(error, 'invalid_argument'),
  );
  assert.equal(store.getTask(TASK_ID), undefined);
  assert.equal(store.getTask('tsk_poisoned'), undefined);
});

test('task updates: status, patch, attempts, worktree and result lifecycle', (t) => {
  const store = withStore(t);
  store.createMission(makeMission());
  store.insertTasks([makeTask()]);

  const running = store.updateTaskStatus(TASK_ID, 'running', {
    workerId: 'wkr_1',
    lastError: null,
  });
  assert.equal(running.status, 'running');
  assert.equal(running.workerId, 'wkr_1');

  const incremented = store.incrementTaskAttempts(TASK_ID);
  assert.equal(incremented.attempts, 1);
  assert.equal(store.incrementTaskAttempts(TASK_ID).attempts, 2);

  const withWorktree = store.setTaskWorktree(TASK_ID, '/tmp/wt/1', 'zcode/branch');
  assert.equal(withWorktree.worktreePath, '/tmp/wt/1');
  assert.equal(withWorktree.branch, 'zcode/branch');

  const result = {
    summary: 'done',
    filesChanged: ['src/store.ts'],
    commits: ['deadbeef'],
    branch: 'zcode/branch',
  };
  assert.deepEqual(store.setTaskResult(TASK_ID, result).result, result);
  const cleared = store.setTaskResult(TASK_ID, null);
  assert.equal(Object.hasOwn(cleared, 'result'), false);

  const patched = store.updateTask(TASK_ID, { status: 'failed', lastError: 'boom', attempts: 9 });
  assert.equal(patched.status, 'failed');
  assert.equal(patched.lastError, 'boom');
  assert.equal(patched.attempts, 9);

  assert.deepEqual(store.updateTask(TASK_ID, {}), patched);
  assert.throws(
    () => store.updateTask(TASK_ID, { role: 'x' } as unknown as TaskPatch),
    (error: unknown) => isProjectsStoreError(error, 'invalid_argument'),
  );
  assert.throws(
    () => store.updateTaskStatus('tsk_missing', 'ready'),
    (error: unknown) => isProjectsStoreError(error, 'not_found'),
  );
  assert.throws(
    () => store.incrementTaskAttempts('tsk_missing'),
    (error: unknown) => isProjectsStoreError(error, 'not_found'),
  );
});

test('plan and task ids can be stored for several missions independently', (t) => {
  const store = withStore(t);
  store.createMission(makeMission());
  store.createMission(makeMission({ id: 'msn_two' }));
  store.insertPlan(makePlan());
  store.insertPlan(makePlan({ id: 'pln_two', missionId: 'msn_two' }));
  store.insertTasks([
    makeTask(),
    makeTask({ id: 'tsk_two', missionId: 'msn_two', planId: 'pln_two' }),
  ]);
  assert.equal(store.listTasks(MISSION_ID).length, 1);
  assert.equal(store.listTasks('msn_two').length, 1);
  assert.equal(store.getLatestPlan('msn_two')?.id, 'pln_two');
  assert.equal(store.listPlans(MISSION_ID)[0]?.id, PLAN_ID);
});
