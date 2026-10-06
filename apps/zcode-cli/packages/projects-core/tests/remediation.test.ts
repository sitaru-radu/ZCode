/**
 * §6 review remediation (invariant 10): at most one task per blocking finding, deterministic
 * `fix-<round>-<n>` keys, and a dependency on the tasks that were reviewed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ADVISORY_PLAN_ISSUE_CODES, remediationTasksFor, validatePlan } from '../src/index.js';
import { MISSION_ID, keysOf, makeFinding, makePlan, makeReview, planTask } from './fixtures.js';

const PLAN = makePlan([
  planTask('a', { filesHint: ['src/a.ts'] }),
  planTask('b', { dependsOn: ['a'] }),
  planTask('c', { dependsOn: ['b'] }),
]);

test('remediationTasksFor produces one required task per blocking finding, in order', () => {
  const review = makeReview({
    round: 2,
    verdict: 'fail',
    findings: [
      makeFinding({ title: 'First problem', detail: 'Detail one', file: 'src/a.ts', line: 12 }),
      makeFinding({ severity: 'advisory', title: 'Nit' }),
      makeFinding({ title: 'Second problem', detail: 'Detail two', requirement: 'objective 1' }),
    ],
  });
  const tasks = remediationTasksFor(review, PLAN, MISSION_ID);

  assert.deepEqual(keysOf(tasks), ['fix-2-1', 'fix-2-2']);
  assert.deepEqual(tasks.map((task) => task.required), [true, true]);
  assert.equal(tasks[0]?.title, 'Fix (src/a.ts:12): First problem');
  assert.equal(tasks[1]?.title, 'Fix: Second problem');
  assert.equal(tasks[0]?.description, 'Detail one');
  assert.equal(tasks[1]?.description, 'Detail two\nRequirement: objective 1');
  assert.deepEqual(tasks[0]?.filesHint, ['src/a.ts']);
  assert.deepEqual(tasks[1]?.filesHint, []);
  assert.deepEqual(tasks[1]?.acceptance, [
    'the blocking finding "Second problem" no longer reproduces',
    'requirement still satisfied: objective 1',
  ]);
});

test('each remediation task depends on every reviewed task, in plan order', () => {
  const review = makeReview({ round: 1, verdict: 'fail', findings: [makeFinding()] });
  const [task] = remediationTasksFor(review, PLAN, MISSION_ID);
  assert.deepEqual(task?.dependsOn, ['a', 'b', 'c']);
});

test('remediation is deterministic and produces nothing for a pass verdict or without blocking findings', () => {
  const failing = makeReview({ round: 3, verdict: 'fail', findings: [makeFinding(), makeFinding({ title: 'Other' })] });
  assert.deepEqual(remediationTasksFor(failing, PLAN, MISSION_ID), remediationTasksFor(failing, PLAN, MISSION_ID));

  assert.deepEqual(remediationTasksFor(makeReview({ verdict: 'pass', findings: [makeFinding()] }), PLAN, MISSION_ID), []);
  assert.deepEqual(
    remediationTasksFor(makeReview({ verdict: 'fail', findings: [makeFinding({ severity: 'advisory' })] }), PLAN, MISSION_ID),
    [],
  );
  assert.deepEqual(remediationTasksFor(makeReview({ verdict: 'fail', findings: [] }), PLAN, MISSION_ID), []);
});

test('remediation keys never collide with keys that already exist in the plan', () => {
  const plan = makePlan([planTask('a'), planTask('fix-1-1'), planTask('fix-1-1-2')]);
  const review = makeReview({ round: 1, verdict: 'fail', findings: [makeFinding(), makeFinding({ title: 'Second' })] });
  const tasks = remediationTasksFor(review, plan, MISSION_ID);
  assert.deepEqual(keysOf(tasks), ['fix-1-1-3', 'fix-1-2']);
});

test('a plan extended with its remediation tasks stays structurally valid (invariant 8)', () => {
  const review = makeReview({
    round: 1,
    verdict: 'fail',
    findings: [
      makeFinding({ title: 'First', file: 'src/a.ts' }),
      makeFinding({ title: 'Second', file: 'src/b.ts' }),
      makeFinding({ severity: 'advisory', title: 'Nit' }),
    ],
  });
  const remediation = remediationTasksFor(review, PLAN, MISSION_ID);
  const merged = makePlan([...PLAN.tasks, ...remediation], { version: PLAN.version + 1 });

  const blocking = validatePlan(merged, { maxTasks: 12 }).filter(
    (issue) => !ADVISORY_PLAN_ISSUE_CODES.includes(issue.code),
  );
  assert.deepEqual(blocking, []);
  assert.equal(merged.tasks.length, 5);
  assert.deepEqual(
    remediation.map((task) => task.dependsOn.length),
    [3, 3],
  );
});

test('remediation does not mutate the plan it extends', () => {
  const plan = makePlan([planTask('a')]);
  const snapshot = structuredClone(plan);
  remediationTasksFor(makeReview({ verdict: 'fail', findings: [makeFinding()] }), plan, MISSION_ID);
  assert.deepEqual(plan, snapshot);
});
