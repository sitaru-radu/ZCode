import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ProjectsStore } from '../src/index.js';
import {
  makeMission,
  makePlan,
  makeProject,
  makeReview,
  makeTask,
  makeValidation,
  makeWorker,
  MISSION_ID,
  T1,
  WORKER_ID,
} from './fixtures.js';

function tempDirectory(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'projects-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('everything written to a real file survives close and reopen', (t) => {
  const file = join(tempDirectory(t), 'projects.db');
  const project = makeProject();
  const mission = makeMission({
    status: 'running',
    phase: 'execute',
    runId: 'run_1',
    planVersion: 1,
    startedAt: T1,
  });
  const plan = makePlan();
  const task = makeTask({
    status: 'running',
    workerId: WORKER_ID,
    worktreePath: '/tmp/wt/1',
    branch: 'zcode/msn/tsk',
    attempts: 1,
  });
  const worker = makeWorker({ state: 'running', startedAt: T1 });
  const validation = makeValidation();
  const review = makeReview({ round: 2, verdict: 'pass', findings: [] });
  const payload = { taskId: task.id, attempt: 1 };
  let seq = 0;

  const writer = new ProjectsStore({ file });
  try {
    writer.createProject(project);
    writer.createMission(mission);
    writer.insertPlan(plan);
    writer.insertTasks([task]);
    writer.insertWorker(worker);
    seq = writer.appendEvent(mission.id, 'task.dispatched', payload, 3, { createdAt: T1 }).seq;
    writer.insertValidation(validation, { commitSha: 'sha_head', createdAt: T1 });
    writer.insertReview(review);
  } finally {
    writer.close();
  }
  assert.ok(existsSync(file));

  const reader = new ProjectsStore({ file });
  try {
    assert.deepEqual(reader.getProject(project.id), project);
    assert.deepEqual(reader.getMission(mission.id), mission);
    assert.deepEqual(reader.getLatestPlan(mission.id), plan);
    assert.deepEqual(reader.listPlans(mission.id), [plan]);
    assert.deepEqual(reader.getTask(task.id), { ...task, planIndex: 0 });
    assert.deepEqual(reader.getWorker(worker.id), worker);
    assert.deepEqual(reader.listWorkersByTask(task.id), [worker]);
    assert.deepEqual(reader.listEvents(mission.id), [
      {
        missionId: mission.id,
        seq,
        type: 'task.dispatched',
        payload,
        runSeq: 3,
        createdAt: T1,
      },
    ]);
    assert.deepEqual(reader.listValidations(mission.id, 'sha_head'), [
      { ...validation, commitSha: 'sha_head', createdAt: T1 },
    ]);
    assert.deepEqual(reader.latestReview(mission.id), review);
    assert.deepEqual(reader.recoverableMissionIds(), [mission.id]);

    const resumed = reader.appendEvent(mission.id, 'mission.resumed', { after: seq });
    assert.equal(resumed.seq, seq + 1, 'event seq must continue after a restart');
    assert.equal(reader.lastEventSeq(mission.id), seq + 1);
  } finally {
    reader.close();
  }
});

test('the store creates missing parent directories for its file', (t) => {
  const file = join(tempDirectory(t), 'nested', 'deeper', 'projects.db');
  const store = new ProjectsStore({ file });
  try {
    store.createProject(makeProject());
    assert.equal(store.listProjects().length, 1);
  } finally {
    store.close();
  }
  assert.ok(existsSync(file));
});

test('two connections on one file allocate distinct event sequences', (t) => {
  const file = join(tempDirectory(t), 'projects.db');
  const first = new ProjectsStore({ file });
  const second = new ProjectsStore({ file });
  t.after(() => {
    first.close();
    second.close();
  });
  first.createMission(makeMission());

  for (let index = 0; index < 5; index += 1) {
    first.appendEvent(MISSION_ID, 'from.first', { index });
    second.appendEvent(MISSION_ID, 'from.second', { index });
  }
  const seqs = first.listEvents(MISSION_ID).map((event) => event.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(second.lastEventSeq(MISSION_ID), 10);
});
