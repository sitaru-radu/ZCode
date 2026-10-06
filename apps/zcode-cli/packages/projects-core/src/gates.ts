/**
 * Completion gate — spec `specs/projects/10-domain.md` §6 with invariants 3, 4 and 5.
 *
 * A mission becomes `completed` only when this gate reports no blocker; the gate is the single
 * writer of the final result summary (§1). Every rule is derived from stored facts (tasks, reviews,
 * validations, worktree cleanliness) — never from model text.
 *
 * Spec gap handled here: neither `Mission` nor `Validation` carries a commit column, so the
 * "current mission-branch head" is read as the `reviewedCommit` of the latest review round — the
 * only record produced *after* integration into the mission branch. A review is therefore current
 * exactly when it is the latest one, and any later round invalidates an earlier `pass`. Because
 * validations cannot be tied to a commit either, they are checked by existence and outcome only.
 */
import type { Mission, Review, Task, TaskId, Validation } from './types.js';

export interface CompletionInput {
  mission: Mission;
  tasks: Task[];
  reviews: Review[];
  validations: Validation[];
  dirtyWorktrees: string[]; // worktrees with uncommitted work or unmerged commits
  maxReviewRounds: number;
}

export interface Blocker {
  code: BlockerCode;
  message: string;
  taskIds?: TaskId[];
}

export type BlockerCode =
  | 'tasks-incomplete'
  | 'no-review'
  | 'review-failed'
  | 'review-rounds-exhausted'
  | 'validation-missing'
  | 'validation-failed'
  | 'dirty-worktrees'
  | 'blocking-findings';

/**
 * Decide whether the mission may complete (§6).
 *
 * Blockers are appended in the declaration order of `BlockerCode`, so the report is deterministic.
 * `complete` is true only for an empty blocker list (invariant 3).
 *
 * `mission` is part of the frozen input; the gate needs none of its fields, because reviews and
 * validations are already scoped rows handed in by the caller.
 */
export function evaluateCompletion(input: CompletionInput): { complete: boolean; blockers: Blocker[] } {
  const blockers: Blocker[] = [];

  const incomplete = input.tasks.filter((task) => task.required !== false && task.status !== 'done');
  if (incomplete.length > 0) {
    blockers.push({
      code: 'tasks-incomplete',
      message: `${incomplete.length} required task(s) are not done: ${incomplete
        .map((task) => `"${task.planKey}" (${task.status})`)
        .join(', ')}`,
      taskIds: incomplete.map((task) => task.id),
    });
  }

  const latest = latestReview(input.reviews);
  if (latest === undefined) {
    blockers.push({ code: 'no-review', message: 'the mission branch head has not been reviewed' });
  } else {
    const passingForHead = input.reviews.filter(
      (review) => review.verdict === 'pass' && review.reviewedCommit === latest.reviewedCommit,
    );
    if (passingForHead.length !== 1) {
      blockers.push({
        code: 'no-review',
        message: `expected exactly one passing review for the current head ${latest.reviewedCommit}, found ${passingForHead.length}`,
      });
    }
    if (latest.verdict !== 'pass') {
      blockers.push({
        code: 'review-failed',
        message: `review round ${latest.round} reported "${latest.verdict}" for commit ${latest.reviewedCommit}`,
      });
    }
    if (latest.verdict !== 'pass' && latest.round >= input.maxReviewRounds) {
      blockers.push({
        code: 'review-rounds-exhausted',
        message: `review round ${latest.round} failed and the limit of ${input.maxReviewRounds} round(s) is reached`,
      });
    }
  }

  // `Validation` has no `required` flag, so every recorded validation is treated as required;
  // mandatory coverage is the test phase, and a repository that records none has not been validated.
  const failingValidations = input.validations.filter(isFailingValidation);
  if (!input.validations.some((validation) => validation.phase === 'test')) {
    blockers.push({
      code: 'validation-missing',
      message: 'no mandatory (test phase) validation has been recorded for the mission branch head',
    });
  }
  if (failingValidations.length > 0) {
    blockers.push({
      code: 'validation-failed',
      message: `${failingValidations.length} validation(s) failed: ${failingValidations
        .map((validation) => `"${validation.command}" (exit ${validation.exitCode})`)
        .join(', ')}`,
    });
  }

  const dirty = uniqueSorted(input.dirtyWorktrees);
  if (dirty.length > 0) {
    blockers.push({
      code: 'dirty-worktrees',
      message: `${dirty.length} worktree(s) hold uncommitted or unmerged work: ${dirty.join(', ')}`,
    });
  }

  // Last code of the `BlockerCode` union, so the report follows the declaration order of §6.
  const blockingFindings = (latest?.findings ?? []).filter((finding) => finding.severity === 'blocking');
  if (blockingFindings.length > 0) {
    blockers.push({
      code: 'blocking-findings',
      message: `${blockingFindings.length} blocking finding(s) must be resolved: ${blockingFindings
        .map((finding) => finding.title)
        .join('; ')}`,
    });
  }

  return { complete: blockers.length === 0, blockers };
}

/** A validation fails when its recorded result is `fail` or its exit code is non-zero. */
function isFailingValidation(validation: Validation): boolean {
  return validation.result === 'fail' || validation.exitCode !== 0;
}

/** Latest review round; ties break on `createdAt` and then on the id, so the choice is stable. */
function latestReview(reviews: Review[]): Review | undefined {
  let latest: Review | undefined;
  for (const review of reviews) {
    if (latest === undefined || compareReviews(review, latest) > 0) {
      latest = review;
    }
  }
  return latest;
}

function compareReviews(left: Review, right: Review): number {
  if (left.round !== right.round) {
    return left.round - right.round;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return compareStrings(left.id, right.id);
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}
