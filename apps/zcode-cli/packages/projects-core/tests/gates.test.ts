/**
 * §6 completion gate (invariants 3, 4 and 5).
 *
 * Every `BlockerCode` of the spec is produced at least once, the happy path proves that a complete
 * mission has no blocker at all, and the blocker report is shown to be deterministic and ordered.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateCompletion, type Blocker, type BlockerCode, type CompletionInput } from '../src/index.js';
import { HEAD_COMMIT, NOW, greenCompletion, makeFinding, makeReview, makeTasks, makeValidation } from './fixtures.js';

function codesOf(blockers: Blocker[]): BlockerCode[] {
  return blockers.map((blocker) => blocker.code);
}

function evaluate(over: Partial<CompletionInput>): Blocker[] {
  return evaluateCompletion(greenCompletion(over)).blockers;
}

test('a validated mission branch passes the gate without blockers', () => {
  const result = evaluateCompletion(greenCompletion());
  assert.deepEqual(result, { complete: true, blockers: [] });
});

test('complete is true exactly when the blocker list is empty (invariant 3)', () => {
  const inputs: Partial<CompletionInput>[] = [
    {},
    { tasks: makeTasks([{ key: 'a' }]) },
    { reviews: [] },
    { reviews: [makeReview({ verdict: 'fail' })] },
    { validations: [] },
    { validations: [makeValidation({ result: 'fail', exitCode: 1 })] },
    { dirtyWorktrees: ['/var/zcode/worktrees/t1'] },
    { reviews: [makeReview({ findings: [makeFinding()] })] },
  ];
  for (const input of inputs) {
    const result = evaluateCompletion(greenCompletion(input));
    assert.equal(result.complete, result.blockers.length === 0);
    if (result.complete) {
      assert.deepEqual(result.blockers, []);
    } else {
      assert.ok(result.blockers.length > 0);
    }
  }
});

test('tasks-incomplete lists every required task that is not done', () => {
  const blockers = evaluate({
    tasks: makeTasks([
      { key: 'done', status: 'done' },
      { key: 'pending' },
      { key: 'failed', status: 'failed' },
      { key: 'blocked', status: 'blocked' },
      { key: 'optional', status: 'pending', required: false },
    ]),
  });
  assert.deepEqual(codesOf(blockers), ['tasks-incomplete']);
  assert.deepEqual(blockers[0]?.taskIds, makeTasks([{ key: 'pending' }, { key: 'failed' }, { key: 'blocked' }]).map((task) => task.id));
  assert.match(blockers[0]?.message ?? '', /"pending" \(pending\)/);
  assert.match(blockers[0]?.message ?? '', /"failed" \(failed\)/);
});

test('tasks-incomplete ignores optional tasks that are not done', () => {
  const result = evaluateCompletion(
    greenCompletion({ tasks: makeTasks([{ key: 'a', status: 'done' }, { key: 'b', required: false }]) }),
  );
  assert.deepEqual(result, { complete: true, blockers: [] });
});

test('no-review is reported when the mission branch head was never reviewed', () => {
  const blockers = evaluate({ reviews: [] });
  assert.deepEqual(codesOf(blockers), ['no-review']);
  assert.match(blockers[0]?.message ?? '', /not been reviewed/);
});

test('review-failed is reported when the latest round did not pass, and a stale pass never satisfies the gate', () => {
  const blockers = evaluate({
    reviews: [
      makeReview({ id: 'rev_1', round: 1, verdict: 'pass', reviewedCommit: HEAD_COMMIT }),
      makeReview({ id: 'rev_2', round: 2, verdict: 'fail', reviewedCommit: 'sha-after-fix', createdAt: NOW + 1000 }),
    ],
  });
  assert.deepEqual(codesOf(blockers), ['no-review', 'review-failed', 'review-rounds-exhausted']);
  assert.match(blockers[1]?.message ?? '', /round 2/);
});

test('exactly one passing review must cover the current head (invariant 4)', () => {
  const duplicated = evaluate({
    reviews: [
      makeReview({ id: 'rev_1', round: 1, verdict: 'pass' }),
      makeReview({ id: 'rev_2', round: 2, verdict: 'pass' }),
    ],
  });
  assert.deepEqual(codesOf(duplicated), ['no-review']);
  assert.match(duplicated[0]?.message ?? '', /found 2/);

  const single = evaluateCompletion(
    greenCompletion({
      reviews: [
        makeReview({ id: 'rev_1', round: 1, verdict: 'fail' }),
        makeReview({ id: 'rev_2', round: 2, verdict: 'pass', createdAt: NOW + 1000 }),
      ],
    }),
  );
  assert.deepEqual(single, { complete: true, blockers: [] });
});

test('the newest review round decides, with deterministic tie-breaking', () => {
  const byRound = evaluate({
    reviews: [
      makeReview({ id: 'rev_2', round: 2, verdict: 'fail', createdAt: NOW }),
      makeReview({ id: 'rev_1', round: 1, verdict: 'pass', createdAt: NOW + 5000 }),
    ],
  });
  assert.ok(codesOf(byRound).includes('review-failed'));

  const byCreatedAt = evaluate({
    reviews: [
      makeReview({ id: 'rev_1', round: 1, verdict: 'pass', createdAt: NOW }),
      makeReview({ id: 'rev_1b', round: 1, verdict: 'fail', createdAt: NOW + 1 }),
    ],
  });
  assert.ok(codesOf(byCreatedAt).includes('review-failed'));

  const byId = evaluate({
    reviews: [
      makeReview({ id: 'rev_a', round: 1, verdict: 'pass' }),
      makeReview({ id: 'rev_b', round: 1, verdict: 'fail' }),
    ],
  });
  assert.ok(codesOf(byId).includes('review-failed'));
});

test('review-rounds-exhausted is reported when a failing round reaches maxReviewRounds', () => {
  const exhausted = evaluate({
    maxReviewRounds: 2,
    reviews: [
      makeReview({ id: 'rev_1', round: 1, verdict: 'fail' }),
      makeReview({ id: 'rev_2', round: 2, verdict: 'fail', createdAt: NOW + 1 }),
    ],
  });
  assert.ok(codesOf(exhausted).includes('review-rounds-exhausted'));
  assert.match(exhausted.find((blocker) => blocker.code === 'review-rounds-exhausted')?.message ?? '', /2 round/);

  const headroom = evaluate({
    maxReviewRounds: 2,
    reviews: [makeReview({ id: 'rev_1', round: 1, verdict: 'fail' })],
  });
  assert.equal(codesOf(headroom).includes('review-rounds-exhausted'), false);

  const exhaustedAtZero = evaluate({
    maxReviewRounds: 0,
    reviews: [makeReview({ id: 'rev_1', round: 1, verdict: 'fail' })],
  });
  assert.ok(codesOf(exhaustedAtZero).includes('review-rounds-exhausted'));
});

test('blocking findings block, advisory findings do not', () => {
  const blocking = evaluate({
    reviews: [makeReview({ findings: [makeFinding({ title: 'Missing null check' })] })],
  });
  assert.deepEqual(codesOf(blocking), ['blocking-findings']);
  assert.match(blocking[0]?.message ?? '', /Missing null check/);

  const advisory = evaluate({
    reviews: [makeReview({ findings: [makeFinding({ severity: 'advisory', title: 'Naming nit' })] })],
  });
  assert.deepEqual(advisory, []);
});

test('validation-missing is reported until a mandatory (test phase) validation exists (invariant 4)', () => {
  assert.deepEqual(codesOf(evaluate({ validations: [] })), ['validation-missing']);

  const reviewOnly = evaluate({ validations: [makeValidation({ phase: 'review' })] });
  assert.deepEqual(codesOf(reviewOnly), ['validation-missing']);

  const tested = evaluate({ validations: [makeValidation({ phase: 'test' })] });
  assert.deepEqual(tested, []);
});

test('a failing validation on a required command always blocks (invariant 5)', () => {
  const failed = evaluate({ validations: [makeValidation({ result: 'fail', exitCode: 1 })] });
  assert.deepEqual(codesOf(failed), ['validation-failed']);
  assert.match(failed[0]?.message ?? '', /pnpm test/);
  assert.match(failed[0]?.message ?? '', /exit 1/);

  const failedWithoutUsefulExitCode = evaluate({
    validations: [makeValidation({ result: 'fail', exitCode: 0 })],
  });
  assert.deepEqual(codesOf(failedWithoutUsefulExitCode), ['validation-failed']);

  const inconsistentExitCode = evaluate({ validations: [makeValidation({ result: 'pass', exitCode: 2 })] });
  assert.deepEqual(codesOf(inconsistentExitCode), ['validation-failed']);

  // Every recorded validation counts as required (`Validation` has no `required` column).
  const failingReviewCommand = evaluate({
    validations: [makeValidation(), makeValidation({ id: 'val_2', phase: 'review', result: 'fail', exitCode: 1 })],
  });
  assert.deepEqual(codesOf(failingReviewCommand), ['validation-failed']);

  const passing = evaluate({ validations: [makeValidation(), makeValidation({ id: 'val_2', command: 'pnpm lint' })] });
  assert.deepEqual(passing, []);
});

test('dirty-worktrees blocks, deduplicated and sorted in the message', () => {
  const blockers = evaluate({ dirtyWorktrees: ['/w/b', '/w/a', '/w/a'] });
  assert.deepEqual(codesOf(blockers), ['dirty-worktrees']);
  assert.match(blockers[0]?.message ?? '', /2 worktree\(s\)/);
  assert.match(blockers[0]?.message ?? '', /\/w\/a, \/w\/b/);

  assert.deepEqual(evaluate({ dirtyWorktrees: [] }), []);
});

test('every BlockerCode is reachable and the report follows the declaration order', () => {
  const blockers = evaluate({
    tasks: makeTasks([{ key: 'a' }]),
    reviews: [
      makeReview({
        round: 2,
        verdict: 'fail',
        reviewedCommit: 'sha-head',
        findings: [makeFinding()],
      }),
    ],
    validations: [makeValidation({ result: 'fail', exitCode: 1 })],
    dirtyWorktrees: ['/w/a'],
    maxReviewRounds: 2,
  });
  assert.deepEqual(codesOf(blockers), [
    'tasks-incomplete',
    'no-review',
    'review-failed',
    'review-rounds-exhausted',
    'validation-failed',
    'dirty-worktrees',
    'blocking-findings',
  ]);
  const result = evaluateCompletion(
    greenCompletion({
      tasks: makeTasks([{ key: 'a' }]),
      reviews: [makeReview({ round: 2, verdict: 'fail', findings: [makeFinding()] })],
      validations: [],
      dirtyWorktrees: ['/w/a'],
      maxReviewRounds: 5,
    }),
  );
  assert.equal(result.complete, false);
  assert.deepEqual(codesOf(result.blockers), [
    'tasks-incomplete',
    'no-review',
    'review-failed',
    'validation-missing',
    'dirty-worktrees',
    'blocking-findings',
  ]);
});

test('evaluateCompletion is deterministic and does not mutate its input', () => {
  const input = greenCompletion({ dirtyWorktrees: ['/w/b', '/w/a'] });
  const snapshot = structuredClone(input);
  assert.deepEqual(evaluateCompletion(input), evaluateCompletion(input));
  assert.deepEqual(input, snapshot);
});
