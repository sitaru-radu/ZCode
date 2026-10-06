import assert from 'node:assert/strict';
import test from 'node:test';

import { packageName, ProjectsStore } from '../src/index.js';

test('@zcode/projects-store scaffold loads', () => {
  assert.equal(packageName, '@zcode/projects-store');
});

/**
 * Safety net for the layered store: declaration merging is not used, so every declared method must
 * exist at runtime on the composed class. A missing layer (a method that never got attached) fails
 * here instead of at the first call in production.
 */
test('every public store method exists on the composed class', () => {
  const expected = [
    'createProject',
    'getProject',
    'listProjects',
    'updateProjectStatus',
    'createMission',
    'getMission',
    'listMissionsByProject',
    'listActiveMissions',
    'recoverableMissionIds',
    'updateMission',
    'insertPlan',
    'getLatestPlan',
    'listPlans',
    'insertTasks',
    'getTask',
    'listTasks',
    'updateTask',
    'updateTaskStatus',
    'incrementTaskAttempts',
    'setTaskWorktree',
    'setTaskResult',
    'insertWorker',
    'updateWorkerState',
    'getWorker',
    'listWorkersByTask',
    'appendEvent',
    'listEvents',
    'lastEventSeq',
    'insertValidation',
    'listValidations',
    'insertReview',
    'listReviews',
    'latestReview',
    'close',
  ];
  const store = new ProjectsStore(':memory:');
  try {
    const surface = store as unknown as Record<string, unknown>;
    for (const method of expected) {
      assert.equal(typeof surface[method], 'function', `${method} must be a function`);
    }
  } finally {
    store.close();
  }
});

test('close is idempotent and using a closed store fails loudly', () => {
  const store = new ProjectsStore(':memory:');
  store.close();
  assert.doesNotThrow(() => store.close());
  assert.throws(() => store.listProjects());
});
