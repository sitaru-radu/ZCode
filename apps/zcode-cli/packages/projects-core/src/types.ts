/**
 * Domain vocabulary of the Projects module — spec `specs/projects/10-domain.md` §1.
 *
 * Ids are opaque strings; deterministic derivation lives in `ids.ts` (§5). This module holds types
 * only: no runtime code, no imports, so it can be consumed as types by every sibling package
 * (`projects-store`, `git-worktree`, `dsh-executor`, `projects-mission`) without pulling behaviour in.
 */

/** All ids are opaque; deterministic derivation is defined in §5. */
export type ProjectId = string; // prj_...
export type MissionId = string; // msn_...
export type PlanId = string; // pln_...
export type TaskId = string; // tsk_...
export type WorkerId = string; // wkr_...
export type EpochMs = number;
export type ShortId = string; // 10 chars, base32, filesystem-safe (see §5)

export type ProjectStatus = 'active' | 'archived';

export type MissionStatus =
  | 'draft'
  | 'planning'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'reviewing'
  | 'testing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type MissionPhase = 'understand' | 'plan' | 'execute' | 'review' | 'test' | 'complete';

export type TaskStatus = 'pending' | 'ready' | 'running' | 'review' | 'done' | 'failed' | 'blocked';

export type WorkerState = 'provisioning' | 'running' | 'idle' | 'completed' | 'failed' | 'cancelled';

export type MissionSource =
  | { kind: 'text'; text: string } // M1 mandatory
  | { kind: 'spec'; path: string } // M1 (repo-relative or absolute)
  | { kind: 'githubIssue'; ref: string }; // M2

export interface Project {
  id: ProjectId;
  name: string;
  repositoryPath: string;
  defaultBranch: string;
  status: ProjectStatus;
  createdAt: EpochMs;
}

export interface Mission {
  id: MissionId;
  projectId: ProjectId;
  title: string;
  objective: string;
  source: MissionSource;
  status: MissionStatus;
  phase: MissionPhase;
  runId?: string; // workflow run id (execution truth lives in the journal)
  planVersion?: number; // latest accepted plan version
  createdAt: EpochMs;
  startedAt?: EpochMs;
  completedAt?: EpochMs;
  summary?: string; // final result summary, set only by the completion gate
  blockReason?: string;
}

export interface MissionPlan {
  id: PlanId;
  missionId: MissionId;
  version: number;
  summary: string;
  assumptions: string[];
  affectedAreas: string[];
  tasks: PlanTask[];
  validationPlan: string[];
  risks: string[];
  createdAt: EpochMs;
}

/** What the planner model is allowed to propose (validated deterministically). */
export interface PlanTask {
  key: string; // stable local key, unique within the plan
  title: string;
  description: string;
  dependsOn: string[]; // other PlanTask keys
  filesHint?: string[];
  acceptance?: string[];
  required?: boolean; // default true
}

export interface Task {
  id: TaskId;
  missionId: MissionId;
  planId: PlanId;
  planKey: string;
  title: string;
  description: string;
  deps: TaskId[];
  required: boolean;
  filesHint: string[];
  acceptance: string[];
  status: TaskStatus;
  workerId?: WorkerId;
  worktreePath?: string;
  branch?: string;
  attempts: number; // completed dispatch attempts
  result?: TaskResult;
  lastError?: string;
}

export interface TaskResult {
  summary: string;
  filesChanged: string[]; // deterministic: from git, never from the model
  commits: string[]; // sha list
  branch: string;
}

export interface Worker {
  id: WorkerId;
  taskId: TaskId;
  sessionId: string;
  state: WorkerState;
  model?: string;
  worktreePath: string;
  startedAt?: EpochMs;
  completedAt?: EpochMs;
}

export interface Validation {
  id: string;
  missionId: MissionId;
  taskId?: TaskId;
  phase: 'review' | 'test';
  command: string;
  exitCode: number;
  durationMs: number;
  result: 'pass' | 'fail';
  logRef?: string;
}

export interface ReviewFinding {
  severity: 'blocking' | 'advisory';
  title: string;
  detail: string;
  file?: string;
  line?: number;
  requirement?: string; // which objective/acceptance item it maps to
}

export interface Review {
  id: string;
  missionId: MissionId;
  round: number;
  verdict: 'pass' | 'fail';
  findings: ReviewFinding[];
  reviewedCommit: string;
  createdAt: EpochMs;
}
