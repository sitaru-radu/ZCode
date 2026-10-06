import type {
  Mission,
  MissionPlan,
  PlanTask,
  Project,
  Review,
  TaskInsert,
  Validation,
  Worker,
} from '../src/index.js';

/** Deterministic ids/timestamps so round-trip assertions compare exact shapes. */
export const T0 = 1_759_600_000_000;
export const T1 = T0 + 1_000;
export const T2 = T0 + 2_000;

export const PROJECT_ID = 'prj_00000000-0000-4000-8000-000000000000';
export const MISSION_ID = 'msn_00000000-0000-4000-8000-000000000001';
export const PLAN_ID = 'pln_00000000-0000-4000-8000-000000000002';
export const TASK_ID = 'tsk_00000000-0000-4000-8000-000000000003';
export const WORKER_ID = 'wkr_00000000-0000-4000-8000-000000000004';
export const OTHER_MISSION_ID = 'msn_00000000-0000-4000-8000-000000000005';

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    name: 'projects-store',
    repositoryPath: '/home/radu/repos/zcode-projects',
    defaultBranch: 'projects/m1',
    status: 'active',
    createdAt: T0,
    ...overrides,
  };
}

export function makeMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: MISSION_ID,
    projectId: PROJECT_ID,
    title: 'Persist mission truth',
    objective: 'Add a dedicated SQLite store for projects, missions and their evidence',
    source: { kind: 'text', text: 'Implement the SQLite persistence layer' },
    status: 'draft',
    phase: 'understand',
    createdAt: T0,
    ...overrides,
  };
}

export function makePlanTask(overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    key: 'schema',
    title: 'Freeze the schema',
    description: 'Declare the DDL and the migration ledger',
    dependsOn: [],
    filesHint: ['src/schema.ts'],
    acceptance: ['DDL matches specs/projects/20-store.md'],
    required: true,
    ...overrides,
  };
}

export function makePlan(overrides: Partial<MissionPlan> = {}): MissionPlan {
  return {
    id: PLAN_ID,
    missionId: MISSION_ID,
    version: 1,
    summary: 'One migration, one store, one ledger',
    assumptions: ['Node 24 has node:sqlite', 'No other package opens projects.db'],
    affectedAreas: ['apps/zcode-cli/packages/projects-store'],
    tasks: [
      makePlanTask(),
      makePlanTask({
        key: 'store',
        title: 'Implement the store',
        dependsOn: ['schema'],
        filesHint: ['src/store.ts'],
        acceptance: ['Every method is synchronous'],
      }),
    ],
    validationPlan: ['pnpm --filter @zcode/projects-store test'],
    risks: ['Checksum drift if a released migration is edited'],
    createdAt: T0,
    ...overrides,
  };
}

export function makeTask(overrides: Partial<TaskInsert> = {}): TaskInsert {
  return {
    id: TASK_ID,
    missionId: MISSION_ID,
    planId: PLAN_ID,
    planKey: 'schema',
    title: 'Freeze the schema',
    description: 'Declare the DDL and the migration ledger',
    deps: [],
    required: true,
    filesHint: ['src/schema.ts'],
    acceptance: ['DDL matches specs/projects/20-store.md'],
    status: 'pending',
    attempts: 0,
    ...overrides,
  };
}

export function makeWorker(overrides: Partial<Worker> = {}): Worker {
  return {
    id: WORKER_ID,
    taskId: TASK_ID,
    sessionId: 'session-37429523-2981-4609-b9e7-f89b47520b87',
    state: 'provisioning',
    model: 'deepseek-flash',
    worktreePath: '/home/radu/.zcode/worktrees/msn_test/tsk_test',
    ...overrides,
  };
}

export function makeValidation(overrides: Partial<Validation> = {}): Validation {
  return {
    id: 'val_00000000-0000-4000-8000-000000000006',
    missionId: MISSION_ID,
    taskId: TASK_ID,
    phase: 'test',
    command: 'pnpm --filter @zcode/projects-store test',
    exitCode: 0,
    durationMs: 1_234,
    result: 'pass',
    logRef: 'artifacts/msn_test/test.log',
    ...overrides,
  };
}

export function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    id: 'rev_00000000-0000-4000-8000-000000000007',
    missionId: MISSION_ID,
    round: 1,
    verdict: 'fail',
    findings: [
      {
        severity: 'blocking',
        title: 'Events are not monotonic',
        detail: 'seq was allocated by the caller',
        file: 'src/store.ts',
        line: 42,
        requirement: 'seq must be allocated atomically',
      },
      { severity: 'advisory', title: 'Add an index', detail: 'tasks(mission_id, status)' },
    ],
    reviewedCommit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    createdAt: T2,
    ...overrides,
  };
}
