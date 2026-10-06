import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NON_TERMINAL_MISSION_STATUSES,
  ProjectsStore,
  TERMINAL_MISSION_STATUSES,
  type MissionStatus,
} from '../src/index.js';
import { makeMission, makeProject, PROJECT_ID } from './fixtures.js';

const ALL_STATUSES: MissionStatus[] = [
  'draft',
  'planning',
  'ready',
  'running',
  'blocked',
  'reviewing',
  'testing',
  'completed',
  'failed',
  'cancelled',
];

test('recoverableMissionIds returns every non-terminal mission, oldest first', (t) => {
  const store = new ProjectsStore(':memory:');
  t.after(() => store.close());
  store.createProject(makeProject());

  ALL_STATUSES.forEach((status, index) => {
    store.createMission(
      makeMission({ id: `msn_${status}`, status, phase: 'execute', createdAt: 1_000 + index }),
    );
  });

  const recoverable = store.recoverableMissionIds();
  assert.deepEqual(
    recoverable,
    NON_TERMINAL_MISSION_STATUSES.map((status) => `msn_${status}`),
  );
  for (const status of TERMINAL_MISSION_STATUSES) {
    assert.equal(recoverable.includes(`msn_${status}`), false, `${status} must not be recoverable`);
  }
  assert.deepEqual(
    store.listActiveMissions().map((mission) => mission.id),
    recoverable,
  );
  assert.equal(store.listActiveMissions().length, 7);
  assert.equal(store.listMissionsByProject(PROJECT_ID).length, 10);
});

test('a mission leaves the recovery set once it reaches a terminal status', (t) => {
  const store = new ProjectsStore(':memory:');
  t.after(() => store.close());
  store.createMission(makeMission({ id: 'msn_a', status: 'running', phase: 'execute' }));
  store.createMission(makeMission({ id: 'msn_b', status: 'blocked', phase: 'execute' }));
  assert.deepEqual(store.recoverableMissionIds(), ['msn_a', 'msn_b']);

  store.updateMission('msn_a', { status: 'completed', phase: 'complete', completedAt: 5_000 });
  store.updateMission('msn_b', { status: 'cancelled', phase: 'execute' });
  assert.deepEqual(store.recoverableMissionIds(), []);
  assert.deepEqual(store.listActiveMissions(), []);
});

test('the recovery query keeps terminal statuses out of the worklist', (t) => {
  const store = new ProjectsStore(':memory:');
  t.after(() => store.close());
  store.createMission(makeMission({ id: 'msn_draft', status: 'draft', phase: 'understand' }));
  store.createMission(makeMission({ id: 'msn_failed', status: 'failed', phase: 'execute' }));
  assert.deepEqual(store.recoverableMissionIds(), ['msn_draft']);
});
