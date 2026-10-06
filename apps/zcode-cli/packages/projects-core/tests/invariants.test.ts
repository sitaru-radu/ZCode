/**
 * The ten invariants of spec §7, one test each, written against the public API only.
 *
 * These tests restate the spec in executable form: if a rule below ever disagrees with
 * `specs/projects/10-domain.md`, the spec wins and this file must change with it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADVISORY_PLAN_ISSUE_CODES,
  blockedTasks,
  canTransitionMission,
  canTransitionTask,
  evaluateCompletion,
  materializeTasks,
  readyTasks,
  remediationTasksFor,
  selectDispatch,
  validatePlan,
  type MissionStatus,
  type Task,
  type TaskStatus,
} from '../src/index.js';
import {
  MISSION_ID,
  NOW,
  at,
  greenCompletion,
  keysOf,
  makeFinding,
  makePlan,
  makeReview,
  makeTasks,
  makeValidation,
  planKeysOf,
  planTask,
} from './fixtures.js';

test('invariant 1: no task runs before every dependency is done', () => {
  const plan = makePlan([
    planTask('a'),
    planTask('b'),
    planTask('c', { dependsOn: ['a', 'b'] }),
    planTask('d', { dependsOn: ['c'] }),
    planTask('e', { dependsOn: ['c'] }),
  ]);
  let tasks = materializeTasks(MISSION_ID, plan, NOW);
  const started: string[] = [];

  for (let pass = 0; pass < 10; pass += 1) {
    const batch = selectDispatch(tasks, 2);
    if (batch.length === 0) {
      break;
    }
    for (const task of batch) {
      for (const depId of task.deps) {
        const dependency = tasks.find((candidate) => candidate.id === depId);
        assert.equal(dependency?.status, 'done', `${task.planKey} started before its dependency`);
      }
      started.push(task.planKey);
    }
    const batchIds = new Set(batch.map((task) => task.id));
    tasks = tasks.map((task): Task => (batchIds.has(task.id) ? { ...task, status: 'done' } : task));
  }

  assert.deepEqual(started, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(
    tasks.map((task) => task.status),
    ['done', 'done', 'done', 'done', 'done'],
  );
});

test('invariant 1 (dispatch side): a stored status never overrides an unfinished dependency', () => {
  const tasks: Task[] = [
    { ...at(makeTasks([{ key: 'a' }]), 0), status: 'ready' },
    { ...at(makeTasks([{ key: 'b', deps: ['a'] }]), 0), status: 'running' },
  ];
  // `a` has no dependencies, so it is genuinely dispatchable; `b` may not be selected while `a` is
  // unfinished, even though its stored status claims it is already running.
  assert.deepEqual(planKeysOf(readyTasks(tasks)), ['a']);
  assert.equal(planKeysOf(selectDispatch(tasks, 3)).includes('b'), false);
  for (const task of [...readyTasks(tasks), ...selectDispatch(tasks, 3)]) {
    for (const depId of task.deps) {
      const dependency = tasks.find((candidate) => candidate.id === depId);
      assert.equal(dependency?.status, 'done', `${task.planKey} was selected with an unfinished dependency`);
    }
  }
});

test('invariant 2: materializeTasks is idempotent for a given (missionId, planVersion)', () => {
  const plan = makePlan([
    planTask('a', { filesHint: ['src/a.ts'] }),
    planTask('b', { dependsOn: ['a'] }),
  ]);
  const first = materializeTasks(MISSION_ID, plan, NOW);
  const second = materializeTasks(MISSION_ID, plan, NOW + 3_600_000);
  assert.deepEqual(second, first);

  // Crash recovery: rows that already advanced keep the ids a fresh materialization derives.
  const advanced = first.map((task) => ({ ...task, status: 'done' as const, attempts: 1 }));
  const recovered = materializeTasks(MISSION_ID, plan, NOW + 7_200_000);
  assert.deepEqual(
    advanced.map((task) => task.id),
    recovered.map((task) => task.id),
  );
});

test('invariant 3: a mission only completes when the gate reports no blocker', () => {
  const broken = [
    greenCompletion({ tasks: makeTasks([{ key: 'a' }]) }),
    greenCompletion({ reviews: [] }),
    greenCompletion({ reviews: [makeReview({ verdict: 'fail' })] }),
    greenCompletion({ validations: [] }),
    greenCompletion({ validations: [makeValidation({ result: 'fail', exitCode: 1 })] }),
    greenCompletion({ dirtyWorktrees: ['/w/a'] }),
  ];
  for (const input of broken) {
    const result = evaluateCompletion(input);
    assert.equal(result.complete, false);
    assert.ok(result.blockers.length > 0);
  }

  const green = evaluateCompletion(greenCompletion());
  assert.deepEqual(green, { complete: true, blockers: [] });

  // The only edge into `completed` is `testing -> completed` (§2), and `complete` is the guard.
  assert.equal(canTransitionMission('testing', 'completed'), true);
  assert.equal(canTransitionMission('running', 'completed'), false);
  assert.equal(canTransitionMission('reviewing', 'completed'), false);
});

test('invariant 4: the gate needs exactly one pass review for the head and passing required validations', () => {
  // The frozen types carry no mission-branch head, so the head is the reviewed commit of the latest
  // review round (see `gates.ts`): a pass is current exactly when no newer round supersedes it.
  const superseded = evaluateCompletion(
    greenCompletion({
      reviews: [
        makeReview({ round: 1, verdict: 'pass' }),
        makeReview({ id: 'rev_2', round: 2, verdict: 'fail', createdAt: NOW + 1, reviewedCommit: 'sha-after-fix' }),
      ],
    }),
  );
  assert.equal(superseded.complete, false);
  assert.ok(superseded.blockers.some((blocker) => blocker.code === 'review-failed'));
  assert.ok(superseded.blockers.some((blocker) => blocker.code === 'no-review'));

  const ambiguous = evaluateCompletion(
    greenCompletion({
      reviews: [makeReview({ round: 1, verdict: 'pass' }), makeReview({ id: 'rev_2', round: 2, verdict: 'pass' })],
    }),
  );
  assert.equal(ambiguous.complete, false);
  assert.ok(ambiguous.blockers.some((blocker) => blocker.code === 'no-review'));

  const reviewedAndTested = evaluateCompletion(
    greenCompletion({
      reviews: [makeReview({ round: 1, verdict: 'fail' }), makeReview({ id: 'rev_2', round: 2, verdict: 'pass', createdAt: NOW + 1 })],
      validations: [makeValidation({ command: 'pnpm test' }), makeValidation({ id: 'val_2', command: 'pnpm lint' })],
    }),
  );
  assert.deepEqual(reviewedAndTested, { complete: true, blockers: [] });

  const unvalidated = evaluateCompletion(greenCompletion({ validations: [] }));
  assert.deepEqual(
    unvalidated.blockers.map((blocker) => blocker.code),
    ['validation-missing'],
  );

  const passingReviewButFailingValidation = evaluateCompletion(
    greenCompletion({ validations: [makeValidation({ result: 'fail', exitCode: 1 })] }),
  );
  assert.equal(passingReviewButFailingValidation.complete, false);
});

test('invariant 5: a failing validation on a required command always blocks', () => {
  for (const validation of [
    makeValidation({ phase: 'test', result: 'fail', exitCode: 1 }),
    makeValidation({ phase: 'test', result: 'fail', exitCode: 0 }),
    makeValidation({ phase: 'test', result: 'pass', exitCode: 3 }),
    makeValidation({ phase: 'test', result: 'fail', exitCode: 127, command: 'pnpm typecheck' }),
  ]) {
    const result = evaluateCompletion(greenCompletion({ validations: [validation] }));
    assert.equal(result.complete, false, validation.command);
    assert.ok(result.blockers.some((blocker) => blocker.code === 'validation-failed'));
  }
});

test('invariant 6: task transitions outside §3 are rejected', () => {
  const statuses: readonly TaskStatus[] = ['pending', 'ready', 'running', 'review', 'done', 'failed', 'blocked'];
  const allowed: Record<TaskStatus, TaskStatus[]> = {
    pending: ['ready', 'blocked'],
    ready: ['running'],
    running: ['review', 'ready', 'failed'],
    review: ['done', 'ready', 'failed'],
    done: [],
    failed: [],
    blocked: ['pending'],
  };
  const accepted: string[] = [];
  for (const from of statuses) {
    for (const to of statuses) {
      if (canTransitionTask(from, to)) {
        accepted.push(`${from}->${to}`);
      }
    }
  }
  const expected = statuses.flatMap((from) => allowed[from].map((to) => `${from}->${to}`)).sort();
  assert.deepEqual(accepted.sort(), expected);
  assert.equal(canTransitionTask('pending', 'running'), false);
  assert.equal(canTransitionTask('running', 'done'), false);
});

test('invariant 7: terminal mission statuses never transition', () => {
  const statuses: readonly MissionStatus[] = [
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
  for (const from of ['completed', 'failed', 'cancelled'] as const) {
    for (const to of statuses) {
      assert.equal(canTransitionMission(from, to), false, `${from}->${to}`);
    }
  }
});

test('invariant 8: validatePlan rejects cycles and unknown keys, overlaps stay advisory', () => {
  const defective = makePlan([
    planTask('a', { dependsOn: ['b', 'ghost'] }),
    planTask('b', { dependsOn: ['a'] }),
  ]);
  const codes = validatePlan(defective).map((issue) => issue.code);
  assert.ok(codes.includes('dependency-cycle'));
  assert.ok(codes.includes('unknown-dependency'));

  const overlapping = makePlan([
    planTask('a', { filesHint: ['src/shared.ts'] }),
    planTask('b', { filesHint: ['src/shared.ts'] }),
  ]);
  const issues = validatePlan(overlapping);
  assert.equal(issues.length > 0, true);
  assert.ok(issues.every((issue) => ADVISORY_PLAN_ISSUE_CODES.includes(issue.code)));
  assert.deepEqual(
    issues.map((issue) => issue.code),
    ['overlapping-files'],
  );

  const blocking = validatePlan(defective).filter(
    (issue) => !ADVISORY_PLAN_ISSUE_CODES.includes(issue.code),
  );
  assert.equal(blocking.length >= 2, true);
});

test('invariant 9: dispatch order is stable for the same input', () => {
  const tasks = makeTasks([{ key: 'a' }, { key: 'b' }, { key: 'c' }, { key: 'd' }]);
  const first = selectDispatch(tasks, 3).map((task) => task.planKey);
  const second = selectDispatch(tasks, 3).map((task) => task.planKey);
  assert.deepEqual(first, second);
  assert.deepEqual(first, ['a', 'b', 'c']);

  // Sorted by plan order first (the order tasks were materialized in) and by id as a tie-break.
  assert.deepEqual(
    readyTasks(tasks).map((task) => task.planKey),
    ['a', 'b', 'c', 'd'],
  );
  const reversed = [...tasks].reverse();
  assert.deepEqual(
    readyTasks(reversed).map((task) => task.planKey),
    ['d', 'c', 'b', 'a'],
  );
});

test('invariant 10: remediation yields at most one task per blocking finding with fix-<round>-<n> keys', () => {
  const plan = makePlan([planTask('a'), planTask('b', { dependsOn: ['a'] })]);
  const review = makeReview({
    round: 4,
    verdict: 'fail',
    findings: [
      makeFinding({ title: 'One' }),
      makeFinding({ severity: 'advisory', title: 'Nit' }),
      makeFinding({ title: 'Two' }),
      makeFinding({ title: 'Three' }),
    ],
  });
  const remediation = remediationTasksFor(review, plan, MISSION_ID);

  assert.deepEqual(keysOf(remediation), ['fix-4-1', 'fix-4-2', 'fix-4-3']);
  assert.equal(remediation.length, review.findings.filter((finding) => finding.severity === 'blocking').length);
  for (const task of remediation) {
    assert.deepEqual(task.dependsOn, ['a', 'b']);
  }

  const quiet = remediationTasksFor(makeReview({ round: 4, verdict: 'pass' }), plan, MISSION_ID);
  assert.deepEqual(quiet, []);
});

test('scheduling exposes blocked work instead of losing it', () => {
  const tasks = makeTasks([
    { key: 'a', status: 'failed' },
    { key: 'b', deps: ['a'] },
  ]);
  assert.deepEqual(planKeysOf(blockedTasks(tasks)), ['b']);
  assert.deepEqual(readyTasks(tasks), []);
  assert.deepEqual(selectDispatch(tasks, 3), []);
});
