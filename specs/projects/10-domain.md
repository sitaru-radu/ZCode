# Projects — domain model and deterministic decisions

Status: interface freeze for M1. Package: `@zcode/projects-core` (pure: no IO, no `await`).

This document is normative: the exported API of `projects-core` must match it. Any change requires
updating this spec first (repository rule: spec before behaviour).

## 1. Vocabulary

```ts
/** All ids are opaque; deterministic derivation is defined in §5. */
export type ProjectId = string;   // prj_…
export type MissionId = string;   // msn_…
export type PlanId = string;      // pln_…
export type TaskId = string;      // tsk_…
export type WorkerId = string;    // wkr_…
export type EpochMs = number;
export type ShortId = string;     // 10 chars, base32, filesystem-safe (see §5)

export type ProjectStatus = 'active' | 'archived';

export type MissionStatus =
  | 'draft' | 'planning' | 'ready' | 'running' | 'blocked'
  | 'reviewing' | 'testing' | 'completed' | 'failed' | 'cancelled';

export type MissionPhase = 'understand' | 'plan' | 'execute' | 'review' | 'test' | 'complete';

export type TaskStatus = 'pending' | 'ready' | 'running' | 'review' | 'done' | 'failed' | 'blocked';

export type WorkerState = 'provisioning' | 'running' | 'idle' | 'completed' | 'failed' | 'cancelled';

export type MissionSource =
  | { kind: 'text'; text: string }                       // M1 mandatory
  | { kind: 'spec'; path: string }                       // M1 (repo-relative or absolute)
  | { kind: 'githubIssue'; ref: string };                // M2

export interface Project {
  id: ProjectId; name: string; repositoryPath: string; defaultBranch: string;
  status: ProjectStatus; createdAt: EpochMs;
}

export interface Mission {
  id: MissionId; projectId: ProjectId; title: string; objective: string;
  source: MissionSource; status: MissionStatus; phase: MissionPhase;
  runId?: string;                       // workflow run id (execution truth lives in the journal)
  planVersion?: number;                 // latest accepted plan version
  createdAt: EpochMs; startedAt?: EpochMs; completedAt?: EpochMs;
  summary?: string;                     // final result summary, set only by the completion gate
  blockReason?: string;
}

export interface MissionPlan {
  id: PlanId; missionId: MissionId; version: number;
  summary: string; assumptions: string[]; affectedAreas: string[];
  tasks: PlanTask[]; validationPlan: string[]; risks: string[];
  createdAt: EpochMs;
}

/** What the planner model is allowed to propose (validated deterministically). */
export interface PlanTask {
  key: string;                 // stable local key, unique within the plan
  title: string;
  description: string;
  dependsOn: string[];         // other PlanTask keys
  filesHint?: string[];
  acceptance?: string[];
  required?: boolean;          // default true
}

export interface Task {
  id: TaskId; missionId: MissionId; planId: PlanId; planKey: string;
  title: string; description: string; deps: TaskId[]; required: boolean;
  filesHint: string[]; acceptance: string[];
  status: TaskStatus; workerId?: WorkerId;
  worktreePath?: string; branch?: string;
  attempts: number;                    // completed dispatch attempts
  result?: TaskResult;
  lastError?: string;
}

export interface TaskResult {
  summary: string;
  filesChanged: string[];              // deterministic: from git, never from the model
  commits: string[];                   // sha list
  branch: string;
}

export interface Worker {
  id: WorkerId; taskId: TaskId; sessionId: string; state: WorkerState;
  model?: string; worktreePath: string;
  startedAt?: EpochMs; completedAt?: EpochMs;
}

export interface Validation {
  id: string; missionId: MissionId; taskId?: TaskId;
  phase: 'review' | 'test';
  command: string; exitCode: number; durationMs: number;
  result: 'pass' | 'fail'; logRef?: string;
}

export interface ReviewFinding {
  severity: 'blocking' | 'advisory';
  title: string; detail: string;
  file?: string; line?: number;
  requirement?: string;                // which objective/acceptance item it maps to
}

export interface Review {
  id: string; missionId: MissionId; round: number;
  verdict: 'pass' | 'fail'; findings: ReviewFinding[];
  reviewedCommit: string; createdAt: EpochMs;
}
```

## 2. Mission state machine

| From | To | Trigger (owner) |
|------|----|-----------------|
| `draft` | `planning` | `planMission` accepted |
| `planning` | `ready` | plan validated and persisted (`projects-core`) |
| `planning` | `failed` | planner output invalid after repair budget |
| `ready` | `running` | `startMission` (human or API) |
| `running` | `reviewing` | every required task `done` |
| `running` | `blocked` | required task `failed` with attempts exhausted, budget exceeded, or no progress |
| `running` | `failed` | fatal orchestration error (store/executor unavailable) |
| `reviewing` | `testing` | review `pass` |
| `reviewing` | `running` | review `fail` → remediation tasks materialized |
| `reviewing` | `blocked` | review rounds exhausted (`maxReviewRounds`) |
| `testing` | `completed` | completion gate passes |
| `testing` | `running` | mandatory validation `fail` → remediation task |
| `testing` | `blocked` | remediation rounds exhausted |
| `blocked` | `running` | explicit resume (never automatic) |
| any non-terminal | `cancelled` | `cancelMission` |

`phase` is derived, never set independently: `draft|planning → plan|understand`,
`ready|running → execute`, `reviewing → review`, `testing → test`, `completed → complete`.
Terminal statuses are `completed`, `failed`, `cancelled`; no transition leaves them.

## 3. Task state machine

| From | To | Trigger |
|------|----|---------|
| `pending` | `ready` | all `deps` are `done` (recomputed on every scheduling pass) |
| `pending` | `blocked` | a dependency is `failed`/`blocked` and cannot be retried |
| `ready` | `running` | worker dispatched |
| `running` | `review` | worker turn completed and its worktree committed |
| `running` | `ready` | retryable failure, `attempts < maxTaskAttempts` |
| `running` | `failed` | attempts exhausted or non-retryable failure |
| `review` | `done` | integration into the mission branch succeeded |
| `review` | `ready` | integration conflict → new attempt (counts as an attempt) |
| `review` | `failed` | conflict and attempts exhausted |

`done`, `failed`, `blocked` are terminal for scheduling purposes; `blocked` may return to `pending`
only when its failed dependency is re-opened by a new plan version (never silently).

## 4. Worker state machine

`provisioning → running ↔ idle → completed | failed | cancelled`. A worker never returns from a
terminal state; a retry creates a **new** worker row (history is preserved).

## 5. Ids and determinism

- `newId(prefix)` = `${prefix}_${randomUUID()}` for user-facing entities (project, mission).
- `deriveId(prefix, ...parts)` = `${prefix}_${shortHash(parts.join('\u0000'))}` where
  `shortHash` is the first 10 chars of base32(sha256(input)) using alphabet `abcdefghijklmnopqrstuvwxyz234567`.
- Task ids are **derived** from `(missionId, planVersion, planKey)` so that re-materializing the same
  plan version is idempotent (crash recovery must not create duplicate tasks).
- Worker ids are derived from `(taskId, attempt)`; worktree path and branch are derived from
  `(mission.id, task.id)` (see the git-worktree spec), never random.

## 6. Exported pure API (frozen for M1)

```ts
// lifecycle
export function missionPhaseFor(status: MissionStatus): MissionPhase;
export function isTerminalMission(status: MissionStatus): boolean;
export function canTransitionMission(from: MissionStatus, to: MissionStatus): boolean;
export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean;

// planning
export interface PlanIssue { code: PlanIssueCode; message: string; taskKeys?: string[] }
export type PlanIssueCode =
  | 'no-tasks' | 'duplicate-key' | 'self-dependency' | 'unknown-dependency'
  | 'dependency-cycle' | 'empty-title' | 'too-many-tasks' | 'overlapping-files';
export function validatePlan(plan: Pick<MissionPlan, 'tasks'>, limits?: PlanLimits): PlanIssue[];
export function materializeTasks(missionId: MissionId, plan: MissionPlan, now: EpochMs): Task[];

// scheduling (deterministic; no model input)
export function readyTasks(tasks: Task[]): Task[];          // sorted by (planIndex, id)
export function blockedTasks(tasks: Task[]): Task[];
export function selectDispatch(tasks: Task[], maxWorkers: number): Task[];
export function hasProgress(tasks: Task[]): boolean;

// gates
export interface CompletionInput {
  mission: Mission;
  tasks: Task[];
  reviews: Review[];
  validations: Validation[];
  dirtyWorktrees: string[];      // worktrees with uncommitted work or unmerged commits
  maxReviewRounds: number;
}
export interface Blocker { code: BlockerCode; message: string; taskIds?: TaskId[] }
export type BlockerCode =
  | 'tasks-incomplete' | 'no-review' | 'review-failed' | 'review-rounds-exhausted'
  | 'validation-missing' | 'validation-failed' | 'dirty-worktrees' | 'blocking-findings';
export function evaluateCompletion(input: CompletionInput): { complete: boolean; blockers: Blocker[] };

// review remediation
export function remediationTasksFor(review: Review, plan: MissionPlan, missionId: MissionId): PlanTask[];
```

## 7. Invariants (each one becomes a unit test)

1. No task is `running` unless every dependency is `done` (readiness is enforced at dispatch, not by the model).
2. `materializeTasks` is idempotent for a given `(missionId, planVersion)`.
3. A mission never reaches `completed` while `evaluateCompletion` reports any blocker.
4. `evaluateCompletion` requires exactly one `pass` review whose `reviewedCommit` equals the current
   mission-branch head, and every required validation recorded against that same commit as `pass`.
5. A validation with `result: 'fail'` on a `required` command always yields a blocker.
6. Task status transitions outside the table in §3 are rejected (`canTransitionTask` false).
7. Terminal mission statuses never transition.
8. `validatePlan` rejects dependency cycles and unknown keys; overlapping `filesHint` is advisory only.
9. Dispatch order is stable: same input ⇒ same output order (sorted by plan order, then id).
10. `remediationTasksFor` produces at most one task per blocking finding, each depending on the
    reviewed tasks, with deterministic keys (`fix-<round>-<n>`).

## 8. Limits (defaults; configuration lives in the mission runner)

| Limit | Default | Meaning |
|-------|---------|---------|
| `maxWorkers` | 3 | Concurrent workers (maps to the engine's `Caps.maxConcurrency`) |
| `maxTaskAttempts` | 2 | Dispatch/integration attempts per task before `failed` |
| `maxTasks` | 12 | Plan validation ceiling (a smaller feature must produce fewer) |
| `maxReviewRounds` | 2 | Review → remediation cycles before `blocked` |
| `plannerRepairAttempts` | 3 | Schema-repair rounds for the planner session |
| `tokenBudgetPerMission` | none | Optional hard stop that moves the mission to `blocked` |
