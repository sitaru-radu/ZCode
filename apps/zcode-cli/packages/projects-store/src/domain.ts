/**
 * Domain vocabulary for the Projects store.
 *
 * Every domain type is RE-EXPORTED from `@zcode/projects-core` (frozen interface, see
 * specs/projects/10-domain.md §1) — the store never redefines them. Type-only imports also keep the
 * store independent of core's build output at runtime: nothing in this package imports a core value.
 *
 * The remaining declarations are store-local: they describe persistence concerns the pure domain has
 * no opinion about (row position, commit scope, patch shapes, stored event records).
 */
export type {
  EpochMs,
  Mission,
  MissionId,
  MissionPhase,
  MissionPlan,
  MissionSource,
  MissionStatus,
  PlanId,
  PlanTask,
  Project,
  ProjectId,
  ProjectStatus,
  Review,
  ReviewFinding,
  Task,
  TaskId,
  TaskResult,
  TaskStatus,
  Validation,
  Worker,
  WorkerId,
  WorkerState,
} from "@zcode/projects-core";

import type {
  EpochMs,
  MissionId,
  MissionPhase,
  MissionSource,
  MissionStatus,
  Task,
  TaskResult,
  TaskStatus,
  Validation,
  WorkerId,
} from "@zcode/projects-core";

/** `completed`, `failed`, `cancelled` — mirrors `isTerminalMission` in `@zcode/projects-core`. */
export const TERMINAL_MISSION_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly MissionStatus[];

/** Everything else is recoverable after a restart (decision: restart recovery). */
export const NON_TERMINAL_MISSION_STATUSES = [
  "draft",
  "planning",
  "ready",
  "running",
  "blocked",
  "reviewing",
  "testing",
] as const satisfies readonly MissionStatus[];

/** Location of the store's database file, or `:memory:` for an ephemeral one. */
export interface ProjectsStoreOptions {
  file: string;
}

/** A persisted mission event; `seq` is allocated by the store, monotonic per mission from 1. */
export interface MissionEventRecord {
  missionId: MissionId;
  seq: number;
  type: string;
  /** JSON-serializable payload, marshalled to/from `payload_json`. */
  payload: unknown;
  /** Position in the workflow journal this event maps to, when it maps to one. */
  runSeq?: number;
  createdAt: EpochMs;
}

/**
 * A persisted task plus its position inside the plan. The position is a storage concern (the domain
 * `Task` has no `planIndex`), it is returned so consumers can restore plan order deterministically.
 */
export type StoredTask = Task & { planIndex: number };

/** Task insert shape: `planIndex` defaults to the position in the array being inserted. */
export type TaskInsert = Task & { planIndex?: number };

/** A persisted validation plus the commit it was recorded against (completion-gate scope). */
export type StoredValidation = Validation & { commitSha?: string; createdAt: EpochMs };

/** Mutable mission columns. `null` clears an optional column; omitted keys are left untouched. */
export interface MissionPatch {
  title?: string;
  objective?: string;
  source?: MissionSource;
  status?: MissionStatus;
  phase?: MissionPhase;
  runId?: string | null;
  planVersion?: number | null;
  startedAt?: EpochMs | null;
  completedAt?: EpochMs | null;
  summary?: string | null;
  blockReason?: string | null;
}

/** Mutable task columns (plan-derived fields are immutable by design). */
export interface TaskPatch {
  status?: TaskStatus;
  workerId?: WorkerId | null;
  worktreePath?: string | null;
  branch?: string | null;
  attempts?: number;
  result?: TaskResult | null;
  lastError?: string | null;
}

/** Everything mutable about a task except its status, for `updateTaskStatus` convenience. */
export type TaskStatusPatch = Omit<TaskPatch, "status">;

/** Extra (non-domain) validation facts: commit scope and the row's creation time. */
export interface ValidationExtras {
  commitSha?: string | null;
  createdAt?: EpochMs;
}

/** Extra facts for `appendEvent`; `seq` is never caller-supplied. */
export interface AppendEventOptions {
  createdAt?: EpochMs;
}

/** Extra facts for `updateWorkerState`. */
export interface WorkerStateOptions {
  completedAt?: EpochMs | null;
}
