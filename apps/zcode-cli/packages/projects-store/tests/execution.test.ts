import assert from 'node:assert/strict';
import test from 'node:test';

import { isProjectsStoreError, ProjectsStore } from '../src/index.js';
import {
  makeMission,
  makeTask,
  makeWorker,
  MISSION_ID,
  OTHER_MISSION_ID,
  T0,
  T1,
  T2,
  TASK_ID,
  WORKER_ID,
} from './fixtures.js';

function withStore(t: test.TestContext): ProjectsStore {
  const store = new ProjectsStore(':memory:');
  t.after(() => store.close());
  return store;
}

test('workers round-trip through every state with their optional facts', (t) => {
  const store = withStore(t);
  store.createMission(makeMission());
  store.insertTasks([makeTask()]);

  const worker = makeWorker();
  assert.deepEqual(store.insertWorker(worker), worker);
  assert.deepEqual(store.getWorker(worker.id), worker);
  assert.equal(Object.hasOwn(store.getWorker(worker.id) ?? {}, 'startedAt'), false);

  const running = store.updateWorkerState(WORKER_ID, 'running', { completedAt: null });
  assert.equal(running.state, 'running');
  assert.equal(Object.hasOwn(running, 'completedAt'), false);

  const completed = store.updateWorkerState(WORKER_ID, 'completed', { completedAt: T1 });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.completedAt, T1);
  assert.equal(store.getWorker('wkr_missing'), undefined);
});

test('a retry adds a new worker row instead of rewriting history', (t) => {
  const store = withStore(t);
  store.createMission(makeMission());
  store.insertTasks([makeTask()]);
  store.insertWorker(makeWorker({ startedAt: T1 }));
  store.insertWorker(makeWorker({ id: 'wkr_retry', state: 'provisioning', startedAt: T0 }));

  assert.deepEqual(
    store.listWorkersByTask(TASK_ID).map((worker) => worker.id),
    ['wkr_retry', WORKER_ID],
  );
  assert.throws(
    () => store.insertWorker(makeWorker()),
    (error: unknown) => isProjectsStoreError(error, 'conflict'),
  );
  assert.throws(
    () => store.updateWorkerState('wkr_missing', 'running'),
    (error: unknown) => isProjectsStoreError(error, 'not_found'),
  );
});

test('event seq is allocated by the store and stays monotonic per mission', (t) => {
  const store = withStore(t);
  store.createMission(makeMission());
  store.createMission(makeMission({ id: OTHER_MISSION_ID }));

  const seqs: number[] = [];
  for (let index = 0; index < 50; index += 1) {
    const event = store.appendEvent(MISSION_ID, 'task.dispatched', { index });
    seqs.push(event.seq);
    assert.equal(event.missionId, MISSION_ID);
    assert.equal(event.type, 'task.dispatched');
  }
  assert.deepEqual(
    seqs,
    Array.from({ length: 50 }, (_, index) => index + 1),
  );
  assert.equal(store.lastEventSeq(MISSION_ID), 50);

  const other = store.appendEvent(OTHER_MISSION_ID, 'mission.created', { text: 'other' });
  assert.equal(other.seq, 1, 'seq is per mission, not global');
  assert.equal(store.lastEventSeq(OTHER_MISSION_ID), 1);
  assert.equal(store.lastEventSeq('msn_unknown'), 0);
});

test('events round-trip payloads, runSeq and createdAt', (t) => {
  const store = withStore(t);
  store.createMission(makeMission());
  const payload = {
    taskId: TASK_ID,
    nested: { ok: true, count: 2, ratio: 0.5 },
    list: [1, 'two', null],
  };
  const withRun = store.appendEvent(MISSION_ID, 'review.finished', payload, 7, { createdAt: T2 });
  assert.deepEqual(withRun, {
    missionId: MISSION_ID,
    seq: 1,
    type: 'review.finished',
    payload,
    runSeq: 7,
    createdAt: T2,
  });
  const withoutRun = store.appendEvent(MISSION_ID, 'note', null);
  assert.equal(Object.hasOwn(withoutRun, 'runSeq'), false);

  assert.deepEqual(store.listEvents(MISSION_ID), [withRun, withoutRun]);
  assert.deepEqual(store.listEvents(MISSION_ID)[0]?.payload, payload);
});

test('listEvents supports resume-after-seq paging', (t) => {
  const store = withStore(t);
  store.createMission(makeMission());
  for (let index = 0; index < 6; index += 1) {
    store.appendEvent(MISSION_ID, 'tick', { index });
  }
  assert.deepEqual(
    store.listEvents(MISSION_ID, 4).map((event) => event.seq),
    [5, 6],
  );
  assert.deepEqual(store.listEvents(MISSION_ID, 6), []);
  assert.equal(store.listEvents(MISSION_ID).length, 6);
  assert.equal(store.listEvents('msn_unknown').length, 0);
});

test('a non-JSON payload is rejected instead of being stored as null', (t) => {
  const store = withStore(t);
  store.createMission(makeMission());
  assert.throws(
    () => store.appendEvent(MISSION_ID, 'bad', undefined),
    (error: unknown) => isProjectsStoreError(error, 'invalid_argument'),
  );
  assert.equal(store.lastEventSeq(MISSION_ID), 0);
});
