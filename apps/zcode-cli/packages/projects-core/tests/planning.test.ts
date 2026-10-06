/**
 * §6 plan validation and plan materialization (invariants 2 and 8).
 *
 * Every `PlanIssueCode` of the spec is produced here at least once, and the advisory code is proved
 * to be advisory: it is reported, but never together with a structural defect it caused.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADVISORY_PLAN_ISSUE_CODES,
  deriveId,
  materializeTasks,
  validatePlan,
  type PlanIssueCode,
  type PlanTask,
} from '../src/index.js';
import { MISSION_ID, NOW, PLAN_ID, PLAN_VERSION, makePlan, planTask, taskByKey } from './fixtures.js';

/** Declaration order of §6; the returned report must follow it so results are reproducible. */
const CODE_ORDER: readonly PlanIssueCode[] = [
  'no-tasks',
  'duplicate-key',
  'self-dependency',
  'unknown-dependency',
  'dependency-cycle',
  'empty-title',
  'too-many-tasks',
  'overlapping-files',
];

function codesOf(tasks: PlanTask[], limits?: { maxTasks?: number }): PlanIssueCode[] {
  return validatePlan({ tasks }, limits).map((issue) => issue.code);
}

function manyTasks(count: number): PlanTask[] {
  return Array.from({ length: count }, (_unused, index) => planTask(`t${index}`));
}

test('validatePlan accepts a well-formed plan', () => {
  const plan = makePlan([
    planTask('a', { filesHint: ['src/a.ts'] }),
    planTask('b', { dependsOn: ['a'], acceptance: ['b works'] }),
    planTask('c', { dependsOn: ['a'], required: false }),
  ]);
  assert.deepEqual(validatePlan(plan), []);
  assert.deepEqual(validatePlan(plan, { maxTasks: 12 }), []);
});

test('validatePlan reports no-tasks for an empty plan and stops there', () => {
  assert.deepEqual(validatePlan({ tasks: [] }), [
    { code: 'no-tasks', message: 'plan contains no tasks' },
  ]);
  assert.deepEqual(validatePlan({ tasks: [] }, { maxTasks: 0 }), [
    { code: 'no-tasks', message: 'plan contains no tasks' },
  ]);
});

test('validatePlan reports duplicate-key once per repeated key', () => {
  const plan = makePlan([planTask('a'), planTask('b'), planTask('a'), planTask('a')]);
  const issues = validatePlan(plan);
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ['duplicate-key'],
  );
  assert.deepEqual(issues[0]?.taskKeys, ['a']);
  assert.match(issues[0]?.message ?? '', /"a"/);
});

test('validatePlan reports self-dependency for a task that depends on its own key', () => {
  const plan = makePlan([planTask('a', { dependsOn: ['a'] }), planTask('b', { dependsOn: ['a'] })]);
  const issues = validatePlan(plan);
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ['self-dependency'],
  );
  assert.deepEqual(issues[0]?.taskKeys, ['a']);
});

test('validatePlan rejects unknown dependency keys (invariant 8)', () => {
  const plan = makePlan([
    planTask('a', { dependsOn: ['ghost', 'b'] }),
    planTask('b'),
  ]);
  const issues = validatePlan(plan);
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ['unknown-dependency'],
  );
  assert.deepEqual(issues[0]?.taskKeys, ['a']);
  assert.match(issues[0]?.message ?? '', /"ghost"/);
});

test('validatePlan rejects dependency cycles, including longer ones (invariant 8)', () => {
  const twoCycle = makePlan([planTask('a', { dependsOn: ['b'] }), planTask('b', { dependsOn: ['a'] })]);
  const twoIssues = validatePlan(twoCycle);
  assert.deepEqual(
    twoIssues.map((issue) => issue.code),
    ['dependency-cycle'],
  );
  assert.deepEqual(twoIssues[0]?.taskKeys, ['a', 'b']);
  assert.equal(twoIssues[0]?.message, 'dependency cycle: a -> b -> a');

  const threeCycle = makePlan([
    planTask('a', { dependsOn: ['c'] }),
    planTask('b', { dependsOn: ['a'] }),
    planTask('c', { dependsOn: ['b'] }),
    planTask('d'),
  ]);
  const threeIssues = validatePlan(threeCycle);
  assert.deepEqual(
    threeIssues.map((issue) => issue.code),
    ['dependency-cycle'],
  );
  assert.deepEqual(threeIssues[0]?.taskKeys, ['a', 'c', 'b']);

  const cycleWithBranch = makePlan([
    planTask('root'),
    planTask('a', { dependsOn: ['root', 'b'] }),
    planTask('b', { dependsOn: ['a'] }),
  ]);
  assert.deepEqual(
    validatePlan(cycleWithBranch).map((issue) => issue.code),
    ['dependency-cycle'],
  );
});

test('validatePlan reports one dependency-cycle issue per distinct cycle group', () => {
  const plan = makePlan([
    planTask('a', { dependsOn: ['b'] }),
    planTask('b', { dependsOn: ['a'] }),
    planTask('c', { dependsOn: ['d'] }),
    planTask('d', { dependsOn: ['c'] }),
  ]);
  const issues = validatePlan(plan);
  assert.equal(issues.length, 2);
  assert.deepEqual(issues.map((issue) => issue.taskKeys), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

test('validatePlan reports empty-title for titles that are blank after trimming', () => {
  const plan = makePlan([planTask('a', { title: '   ' }), planTask('b', { title: '\t\n' }), planTask('c')]);
  const issues = validatePlan(plan);
  assert.deepEqual(
    issues.map((issue) => [issue.code, issue.taskKeys]),
    [
      ['empty-title', ['a']],
      ['empty-title', ['b']],
    ],
  );
});

test('validatePlan enforces maxTasks with a default of 12 (§8)', () => {
  assert.deepEqual(codesOf(manyTasks(12)), []);
  assert.deepEqual(codesOf(manyTasks(13)), ['too-many-tasks']);
  assert.deepEqual(codesOf(manyTasks(13), {}), ['too-many-tasks']);
  assert.deepEqual(codesOf(manyTasks(3), { maxTasks: 2 }), ['too-many-tasks']);
  assert.deepEqual(codesOf(manyTasks(2), { maxTasks: 2 }), []);
  const message = validatePlan({ tasks: manyTasks(13) })[0]?.message ?? '';
  assert.match(message, /13 tasks/);
  assert.match(message, /12/);
});

test('overlapping filesHint is advisory only (invariant 8)', () => {
  const plan = makePlan([
    planTask('a', { filesHint: ['src/shared.ts'] }),
    planTask('b', { filesHint: ['src/shared.ts'] }),
    planTask('c', { filesHint: ['src/other.ts'] }),
  ]);
  const issues = validatePlan(plan);
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ['overlapping-files'],
  );
  assert.deepEqual(issues[0]?.taskKeys, ['a', 'b']);
  assert.equal(ADVISORY_PLAN_ISSUE_CODES.includes('overlapping-files'), true);
  assert.ok(issues.every((issue) => ADVISORY_PLAN_ISSUE_CODES.includes(issue.code)));
});

test('overlapping filesHint normalizes separators, leading ./ and whitespace', () => {
  const plan = makePlan([
    planTask('a', { filesHint: ['src\\deep\\file.ts'] }),
    planTask('b', { filesHint: ['./src/deep/file.ts'] }),
    planTask('c', { filesHint: ['  src/deep/file.ts  '] }),
    planTask('d', { filesHint: ['./', '   '] }),
  ]);
  const issues = validatePlan(plan);
  assert.deepEqual(
    issues.map((issue) => [issue.code, issue.taskKeys]),
    [['overlapping-files', ['a', 'b', 'c']]],
  );
});

test('validatePlan does not report an overlap twice for the same task', () => {
  const plan = makePlan([planTask('a', { filesHint: ['src/x.ts', './src/x.ts'] }), planTask('b')]);
  assert.deepEqual(validatePlan(plan), []);
});

test('validatePlan returns issues in the declaration order of PlanIssueCode and is deterministic', () => {
  const plan = makePlan([
    planTask('a', { title: '  ', dependsOn: ['b'], filesHint: ['src\\x.ts'] }),
    planTask('a', { title: 'duplicate key row' }),
    planTask('b', { dependsOn: ['a'], filesHint: ['./src/x.ts'] }),
    planTask('ghost', { dependsOn: ['missing'] }),
  ]);
  const issues = validatePlan(plan);
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ['duplicate-key', 'unknown-dependency', 'dependency-cycle', 'empty-title', 'overlapping-files'],
  );
  const positions = issues.map((issue) => CODE_ORDER.indexOf(issue.code));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
  assert.deepEqual(validatePlan(plan), issues);
});

test('materializeTasks derives task ids from (missionId, planVersion, planKey)', () => {
  const plan = makePlan([planTask('a'), planTask('b', { dependsOn: ['a'] })]);
  const tasks = materializeTasks(MISSION_ID, plan, NOW);

  assert.deepEqual(
    tasks.map((task) => task.id),
    [deriveId('tsk', MISSION_ID, '1', 'a'), deriveId('tsk', MISSION_ID, '1', 'b')],
  );
  assert.deepEqual(taskByKey(tasks, 'b').deps, [deriveId('tsk', MISSION_ID, '1', 'a')]);
  assert.deepEqual(
    tasks.map((task) => task.planKey),
    ['a', 'b'],
  );
});

test('re-materializing the same plan version is idempotent (invariant 2)', () => {
  const plan = makePlan([
    planTask('a', { filesHint: ['src/a.ts'], acceptance: ['a is done'] }),
    planTask('b', { dependsOn: ['a'], required: false }),
  ]);
  const first = materializeTasks(MISSION_ID, plan, NOW);
  const second = materializeTasks(MISSION_ID, plan, NOW + 60_000);
  assert.deepEqual(second, first);
});

test('materialization is scoped by mission id and plan version', () => {
  const plan = makePlan([planTask('a')]);
  const otherMission = materializeTasks('msn_other', plan, NOW);
  const otherVersion = materializeTasks(MISSION_ID, makePlan([planTask('a')], { version: 2 }), NOW);

  assert.notEqual(otherMission[0]?.id, materializeTasks(MISSION_ID, plan, NOW)[0]?.id);
  assert.notEqual(otherVersion[0]?.id, materializeTasks(MISSION_ID, plan, NOW)[0]?.id);
  assert.equal(otherMission[0]?.missionId, 'msn_other');
});

test('materializeTasks copies plan fields and applies the documented defaults', () => {
  const plan = makePlan([
    planTask('a', { title: 'Alpha', description: 'Do alpha', filesHint: ['src/a.ts'], acceptance: ['ok'] }),
    planTask('b', { required: false }),
  ]);
  const [first, second] = materializeTasks(MISSION_ID, plan, NOW);

  assert.equal(first?.planId, PLAN_ID);
  assert.equal(first?.planKey, 'a');
  assert.equal(first?.title, 'Alpha');
  assert.equal(first?.description, 'Do alpha');
  assert.equal(first?.required, true);
  assert.deepEqual(first?.filesHint, ['src/a.ts']);
  assert.deepEqual(first?.acceptance, ['ok']);
  assert.equal(first?.status, 'pending');
  assert.equal(first?.attempts, 0);
  assert.deepEqual(first?.deps, []);
  assert.equal(second?.required, false);
  assert.deepEqual(second?.filesHint, []);
  assert.deepEqual(second?.acceptance, []);
});

test('materializeTasks drops dependencies that are not plan keys and never depends on itself', () => {
  const plan = makePlan([
    planTask('a', { dependsOn: ['ghost', 'a', 'b', 'b'] }),
    planTask('b'),
  ]);
  const [first] = materializeTasks(MISSION_ID, plan, NOW);
  assert.deepEqual(first?.deps, [deriveId('tsk', MISSION_ID, String(PLAN_VERSION), 'b')]);
});

test('materializeTasks returns fresh arrays and keeps duplicate keys from creating duplicate rows', () => {
  const plan = makePlan([planTask('a', { filesHint: ['src/a.ts'] }), planTask('a')]);
  const tasks = materializeTasks(MISSION_ID, plan, NOW);
  assert.equal(tasks.length, 1);

  const hint = taskByKey(tasks, 'a').filesHint;
  hint.push('src/mutated.ts');
  assert.deepEqual(plan.tasks[0]?.filesHint, ['src/a.ts']);
});

test('materializeTasks validates the explicit clock parameter', () => {
  const plan = makePlan([planTask('a')]);
  assert.throws(() => materializeTasks(MISSION_ID, plan, Number.NaN), RangeError);
  assert.throws(() => materializeTasks(MISSION_ID, plan, Number.POSITIVE_INFINITY), RangeError);
  assert.equal(materializeTasks(MISSION_ID, plan, 0).length, 1);
});
