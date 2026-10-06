import assert from 'node:assert/strict';
import test from 'node:test';

import { isProjectsStoreError, ProjectsStore, type Validation } from '../src/index.js';
import {
  makeMission,
  makeReview,
  makeValidation,
  MISSION_ID,
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

/** The domain type has optional fields; a stored row must keep them absent, not `undefined`. */
function withoutOptionalFacts(validation: Validation): Validation {
  const minimal = { ...validation };
  delete minimal.taskId;
  delete minimal.logRef;
  return minimal;
}

test('validations round-trip with and without their optional facts', (t) => {
  const store = withStore(t);
  store.createMission(makeMission());

  const full = makeValidation();
  const stored = store.insertValidation(full, { commitSha: 'abc123', createdAt: T1 });
  assert.deepEqual(stored, { ...full, commitSha: 'abc123', createdAt: T1 });

  const minimal = withoutOptionalFacts(
    makeValidation({ id: 'val_minimal', phase: 'review', result: 'fail', exitCode: 1 }),
  );
  const storedMinimal = store.insertValidation(minimal, { createdAt: T2 });
  assert.deepEqual(storedMinimal, { ...minimal, createdAt: T2 });
  for (const field of ['taskId', 'logRef', 'commitSha']) {
    assert.equal(Object.hasOwn(storedMinimal, field), false, `${field} must stay absent`);
  }

  assert.deepEqual(store.listValidations(MISSION_ID), [stored, storedMinimal]);
  assert.throws(
    () => store.insertValidation(full, { commitSha: 'abc123' }),
    (error: unknown) => isProjectsStoreError(error, 'conflict'),
  );
});

test('validations can be scoped to the commit the gate checked', (t) => {
  const store = withStore(t);
  store.createMission(makeMission());
  store.insertValidation(makeValidation({ id: 'val_old' }), { commitSha: 'old_sha', createdAt: T0 });
  store.insertValidation(makeValidation({ id: 'val_head', command: 'pnpm typecheck' }), {
    commitSha: 'head_sha',
    createdAt: T1,
  });
  store.insertValidation(makeValidation({ id: 'val_unscoped' }), { createdAt: T2 });

  assert.deepEqual(
    store.listValidations(MISSION_ID, 'head_sha').map((validation) => validation.id),
    ['val_head'],
  );
  assert.deepEqual(
    store.listValidations(MISSION_ID).map((validation) => validation.id),
    ['val_old', 'val_head', 'val_unscoped'],
  );
  assert.deepEqual(store.listValidations(MISSION_ID, 'missing_sha'), []);
  assert.equal(store.listValidations(MISSION_ID, 'head_sha')[0]?.taskId, TASK_ID);
});

test('reviews round-trip their findings and pick the highest round as latest', (t) => {
  const store = withStore(t);
  store.createMission(makeMission());

  const second = makeReview({ id: 'rev_2', round: 2, verdict: 'pass', findings: [], createdAt: T2 });
  const first = makeReview({ round: 1, createdAt: T0 });
  assert.deepEqual(store.insertReview(second), second);
  assert.deepEqual(store.insertReview(first), first);

  assert.deepEqual(store.listReviews(MISSION_ID), [first, second]);
  assert.deepEqual(store.latestReview(MISSION_ID), second);
  assert.deepEqual(store.latestReview(MISSION_ID)?.findings, []);
  assert.deepEqual(store.listReviews(MISSION_ID)[0]?.findings, [
    {
      severity: 'blocking',
      title: 'Events are not monotonic',
      detail: 'seq was allocated by the caller',
      file: 'src/store.ts',
      line: 42,
      requirement: 'seq must be allocated atomically',
    },
    { severity: 'advisory', title: 'Add an index', detail: 'tasks(mission_id, status)' },
  ]);
  assert.equal(store.latestReview('msn_missing'), undefined);
  assert.throws(
    () => store.insertReview(first),
    (error: unknown) => isProjectsStoreError(error, 'conflict'),
  );
});
