import { invalidArgument } from "./errors.js";
import { decodeJson, decodeJsonArray } from "./json.js";
import type {
  EpochMs,
  Mission,
  MissionPhase,
  MissionPlan,
  MissionSource,
  MissionStatus,
  PlanTask,
  Project,
  ProjectStatus,
  Review,
  ReviewFinding,
  StoredTask,
  StoredValidation,
  TaskId,
  TaskResult,
  TaskStatus,
  Validation,
  Worker,
  WorkerState,
} from "./domain.js";

/**
 * Row shapes and row → domain mappers.
 *
 * Columns are read as SQLite returns them (`snake_case`, 0/1 integers, JSON text). Mappers rebuild
 * the exact domain shape: booleans become booleans, optional columns become ABSENT properties rather
 * than `undefined` ones, so `deepEqual(store.getMission(id), mission)` holds after any round trip.
 */

export interface ProjectRow {
  id: string;
  name: string;
  repository_path: string;
  default_branch: string;
  status: string;
  created_at: number;
}

export interface MissionRow {
  id: string;
  project_id: string;
  title: string;
  objective: string;
  source_json: string;
  status: string;
  phase: string;
  run_id: string | null;
  plan_version: number | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  summary: string | null;
  block_reason: string | null;
}

export interface PlanRow {
  id: string;
  mission_id: string;
  version: number;
  summary: string;
  assumptions_json: string;
  affected_areas_json: string;
  validation_plan_json: string;
  risks_json: string;
  tasks_json: string;
  created_at: number;
}

export interface TaskRow {
  id: string;
  mission_id: string;
  plan_id: string;
  plan_key: string;
  plan_index: number;
  title: string;
  description: string;
  deps_json: string;
  required: number;
  files_hint_json: string;
  acceptance_json: string;
  status: string;
  worker_id: string | null;
  worktree_path: string | null;
  branch: string | null;
  attempts: number;
  result_json: string | null;
  last_error: string | null;
}

export interface WorkerRow {
  id: string;
  task_id: string;
  session_id: string;
  state: string;
  model: string | null;
  worktree_path: string;
  started_at: number | null;
  completed_at: number | null;
}

export interface ValidationRow {
  id: string;
  mission_id: string;
  task_id: string | null;
  phase: string;
  command: string;
  exit_code: number;
  duration_ms: number;
  result: string;
  log_ref: string | null;
  commit_sha: string | null;
  created_at: number;
}

export interface ReviewRow {
  id: string;
  mission_id: string;
  round: number;
  verdict: string;
  findings_json: string;
  reviewed_commit: string;
  created_at: number;
}

/** Assigns only present, non-null optionals so absent domain fields stay absent. */
export function withOptional<T extends object>(
  base: T,
  optional: Readonly<Record<string, unknown>>,
): T {
  const target = base as Record<string, unknown>;
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined && value !== null) target[key] = value;
  }
  return base;
}

/** SQLite returns 0/1 for booleans; anything else would be a corrupted row. */
export function toBoolean(value: number, context: string): boolean {
  if (value !== 0 && value !== 1) throw invalidArgument(`${context} must be 0 or 1`);
  return value === 1;
}

export function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    repositoryPath: row.repository_path,
    defaultBranch: row.default_branch,
    status: row.status as ProjectStatus,
    createdAt: row.created_at,
  };
}

export function mapMission(row: MissionRow): Mission {
  return withOptional<Mission>(
    {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      objective: row.objective,
      source: decodeJson<MissionSource>(row.source_json, "missions.source_json"),
      status: row.status as MissionStatus,
      phase: row.phase as MissionPhase,
      createdAt: row.created_at,
    },
    {
      runId: row.run_id,
      planVersion: row.plan_version,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      summary: row.summary,
      blockReason: row.block_reason,
    },
  );
}

export function mapPlan(row: PlanRow): MissionPlan {
  return {
    id: row.id,
    missionId: row.mission_id,
    version: row.version,
    summary: row.summary,
    assumptions: decodeJsonArray<string>(row.assumptions_json, "mission_plans.assumptions_json"),
    affectedAreas: decodeJsonArray<string>(
      row.affected_areas_json,
      "mission_plans.affected_areas_json",
    ),
    tasks: decodeJsonArray<PlanTask>(row.tasks_json, "mission_plans.tasks_json"),
    validationPlan: decodeJsonArray<string>(
      row.validation_plan_json,
      "mission_plans.validation_plan_json",
    ),
    risks: decodeJsonArray<string>(row.risks_json, "mission_plans.risks_json"),
    createdAt: row.created_at,
  };
}

export function mapTask(row: TaskRow): StoredTask {
  return withOptional<StoredTask>(
    {
      id: row.id,
      missionId: row.mission_id,
      planId: row.plan_id,
      planKey: row.plan_key,
      planIndex: row.plan_index,
      title: row.title,
      description: row.description,
      deps: decodeJsonArray<TaskId>(row.deps_json, "tasks.deps_json"),
      required: toBoolean(row.required, "tasks.required"),
      filesHint: decodeJsonArray<string>(row.files_hint_json, "tasks.files_hint_json"),
      acceptance: decodeJsonArray<string>(row.acceptance_json, "tasks.acceptance_json"),
      status: row.status as TaskStatus,
      attempts: row.attempts,
    },
    {
      workerId: row.worker_id,
      worktreePath: row.worktree_path,
      branch: row.branch,
      result:
        row.result_json === null
          ? null
          : decodeJson<TaskResult>(row.result_json, "tasks.result_json"),
      lastError: row.last_error,
    },
  );
}

export function mapWorker(row: WorkerRow): Worker {
  return withOptional<Worker>(
    {
      id: row.id,
      taskId: row.task_id,
      sessionId: row.session_id,
      state: row.state as WorkerState,
      worktreePath: row.worktree_path,
    },
    { model: row.model, startedAt: row.started_at, completedAt: row.completed_at },
  );
}

export function mapValidation(row: ValidationRow): StoredValidation {
  return withOptional<StoredValidation>(
    {
      id: row.id,
      missionId: row.mission_id,
      phase: row.phase as Validation["phase"],
      command: row.command,
      exitCode: row.exit_code,
      durationMs: row.duration_ms,
      result: row.result as Validation["result"],
      createdAt: row.created_at as EpochMs,
    },
    { taskId: row.task_id, logRef: row.log_ref, commitSha: row.commit_sha },
  );
}

export function mapReview(row: ReviewRow): Review {
  return {
    id: row.id,
    missionId: row.mission_id,
    round: row.round,
    verdict: row.verdict as Review["verdict"],
    findings: decodeJsonArray<ReviewFinding>(row.findings_json, "reviews.findings_json"),
    reviewedCommit: row.reviewed_commit,
    createdAt: row.created_at,
  };
}
