/**
 * Deterministic fixtures shared by the projects-core tests.
 *
 * Builders are intentionally explicit (no randomness, no clock reads): every test must produce the
 * same rows on every run, and generated ids must match the §5 derivation used by the implementation.
 */
import {
  deriveId,
  type CompletionInput,
  type Mission,
  type MissionPlan,
  type PlanTask,
  type Review,
  type ReviewFinding,
  type Task,
  type TaskStatus,
  type Validation,
} from '../src/index.js';

export const MISSION_ID = 'msn_test';
export const PROJECT_ID = 'prj_test';
export const PLAN_ID = 'pln_test';
export const PLAN_VERSION = 1;
export const NOW = 1_700_000_000_000;
export const HEAD_COMMIT = 'c0ffee1';

/** Task id derivation of spec §5, re-derived here so tests never use a magic string. */
export function taskId(key: string, missionId: string = MISSION_ID, planVersion: number = PLAN_VERSION): string {
  return deriveId('tsk', missionId, String(planVersion), key);
}

export function planTask(key: string, over: Partial<PlanTask> = {}): PlanTask {
  return { key, title: `Task ${key}`, description: `Description of ${key}`, dependsOn: [], ...over };
}

export function makePlan(tasks: PlanTask[], over: Partial<MissionPlan> = {}): MissionPlan {
  return {
    id: PLAN_ID,
    missionId: MISSION_ID,
    version: PLAN_VERSION,
    summary: 'Plan summary',
    assumptions: [],
    affectedAreas: [],
    tasks,
    validationPlan: [],
    risks: [],
    createdAt: NOW,
    ...over,
  };
}

export function makeMission(over: Partial<Mission> = {}): Mission {
  return {
    id: MISSION_ID,
    projectId: PROJECT_ID,
    title: 'Test mission',
    objective: 'Make the tests pass',
    source: { kind: 'text', text: 'Make the tests pass' },
    status: 'testing',
    phase: 'test',
    createdAt: NOW,
    ...over,
  };
}

export interface TaskSpec {
  key: string;
  deps?: string[];
  status?: TaskStatus;
  required?: boolean;
}

export function makeTasks(
  specs: TaskSpec[],
  options: { missionId?: string; planVersion?: number } = {},
): Task[] {
  const missionId = options.missionId ?? MISSION_ID;
  const planVersion = options.planVersion ?? PLAN_VERSION;
  return specs.map((spec) => ({
    id: taskId(spec.key, missionId, planVersion),
    missionId,
    planId: PLAN_ID,
    planKey: spec.key,
    title: `Task ${spec.key}`,
    description: `Description of ${spec.key}`,
    deps: (spec.deps ?? []).map((dep) => taskId(dep, missionId, planVersion)),
    required: spec.required !== false,
    filesHint: [],
    acceptance: [],
    status: spec.status ?? 'pending',
    attempts: 0,
  }));
}

export function makeFinding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return { severity: 'blocking', title: 'Broken behaviour', detail: 'The behaviour is broken', ...over };
}

export function makeReview(over: Partial<Review> = {}): Review {
  return {
    id: 'rev_1',
    missionId: MISSION_ID,
    round: 1,
    verdict: 'pass',
    findings: [],
    reviewedCommit: HEAD_COMMIT,
    createdAt: NOW,
    ...over,
  };
}

export function makeValidation(over: Partial<Validation> = {}): Validation {
  return {
    id: 'val_1',
    missionId: MISSION_ID,
    phase: 'test',
    command: 'pnpm test',
    exitCode: 0,
    durationMs: 1200,
    result: 'pass',
    ...over,
  };
}

/** Input that satisfies every rule of the completion gate; override one field to break one rule. */
export function greenCompletion(over: Partial<CompletionInput> = {}): CompletionInput {
  return {
    mission: makeMission(),
    tasks: makeTasks([{ key: 'a', status: 'done' }]),
    reviews: [makeReview()],
    validations: [makeValidation()],
    dirtyWorktrees: [],
    maxReviewRounds: 2,
    ...over,
  };
}

/** First element, or an explicit failure instead of `undefined` from indexed access. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`expected an element at index ${index}, got ${items.length} element(s)`);
  }
  return item;
}

export function taskByKey(tasks: readonly Task[], planKey: string): Task {
  const task = tasks.find((candidate) => candidate.planKey === planKey);
  if (task === undefined) {
    throw new Error(`no task with planKey "${planKey}"`);
  }
  return task;
}

export function keysOf(items: readonly { key: string }[]): string[] {
  return items.map((item) => item.key);
}

export function planKeysOf(tasks: readonly Task[]): string[] {
  return tasks.map((task) => task.planKey);
}
