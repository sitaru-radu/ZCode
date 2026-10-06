import type {
  MissionId,
  MissionPlan,
  StoredTask,
  TaskId,
  TaskInsert,
  TaskPatch,
  TaskResult,
  TaskStatus,
  TaskStatusPatch,
} from "./domain.js";
import { conflict, notFound } from "./errors.js";
import { encodeJson } from "./json.js";
import { mapPlan, mapTask, type PlanRow, type TaskRow } from "./rows.js";
import { buildUpdate, type PatchField } from "./sql.js";
import { ProjectMethods } from "./store-projects.js";

const PLAN_COLUMNS =
  "id, mission_id, version, summary, assumptions_json, affected_areas_json, validation_plan_json, risks_json, tasks_json, created_at";
const TASK_COLUMNS =
  "id, mission_id, plan_id, plan_key, plan_index, title, description, deps_json, required, files_hint_json, acceptance_json, status, worker_id, worktree_path, branch, attempts, result_json, last_error";

const TASK_PATCH: Readonly<Record<string, PatchField>> = {
  status: { column: "status" },
  workerId: { column: "worker_id" },
  worktreePath: { column: "worktree_path" },
  branch: { column: "branch" },
  attempts: { column: "attempts" },
  result: { column: "result_json", encode: (value) => encodeJson(value, "task.result") },
  lastError: { column: "last_error" },
};

/** Persisted plans and the task graph materialized from them. */
export interface PlansApi {
  insertPlan(plan: MissionPlan): MissionPlan;
  getLatestPlan(missionId: MissionId): MissionPlan | undefined;
  listPlans(missionId: MissionId): MissionPlan[];
  insertTasks(tasks: readonly TaskInsert[]): StoredTask[];
  getTask(id: TaskId): StoredTask | undefined;
  listTasks(missionId: MissionId): StoredTask[];
  updateTask(id: TaskId, patch: TaskPatch): StoredTask;
  updateTaskStatus(id: TaskId, status: TaskStatus, patch?: TaskStatusPatch): StoredTask;
  incrementTaskAttempts(id: TaskId): StoredTask;
  setTaskWorktree(id: TaskId, worktreePath: string | null, branch?: string | null): StoredTask;
  setTaskResult(id: TaskId, result: TaskResult | null): StoredTask;
}

export class PlanMethods extends ProjectMethods implements PlansApi {
  insertPlan(plan: MissionPlan): MissionPlan {
    const existing = this.queryOne<PlanRow>(
      `SELECT ${PLAN_COLUMNS} FROM mission_plans WHERE mission_id = ? AND version = ?`,
      plan.missionId,
      plan.version,
    );
    if (existing) throw conflict("mission plan", `${plan.missionId}#${plan.version}`);
    this.execute(
      "INSERT INTO mission_plans(id, mission_id, version, summary, assumptions_json, affected_areas_json, validation_plan_json, risks_json, tasks_json, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      plan.id,
      plan.missionId,
      plan.version,
      plan.summary,
      encodeJson(plan.assumptions, "plan.assumptions"),
      encodeJson(plan.affectedAreas, "plan.affectedAreas"),
      encodeJson(plan.validationPlan, "plan.validationPlan"),
      encodeJson(plan.risks, "plan.risks"),
      encodeJson(plan.tasks, "plan.tasks"),
      plan.createdAt,
    );
    return this.requirePlan(plan.id);
  }

  getLatestPlan(missionId: MissionId): MissionPlan | undefined {
    const row = this.queryOne<PlanRow>(
      `SELECT ${PLAN_COLUMNS} FROM mission_plans WHERE mission_id = ? ORDER BY version DESC LIMIT 1`,
      missionId,
    );
    return row ? mapPlan(row) : undefined;
  }

  listPlans(missionId: MissionId): MissionPlan[] {
    return this.query<PlanRow>(
      `SELECT ${PLAN_COLUMNS} FROM mission_plans WHERE mission_id = ? ORDER BY version ASC`,
      missionId,
    ).map(mapPlan);
  }

  /**
   * Inserts materialized tasks. Idempotent on task id: re-materializing a plan version after a crash
   * returns the already stored rows untouched instead of duplicating them or resetting progress.
   */
  insertTasks(tasks: readonly TaskInsert[]): StoredTask[] {
    return this.transaction(() => {
      const stored: StoredTask[] = [];
      tasks.forEach((task, position) => {
        const existing = this.getTask(task.id);
        if (existing) {
          stored.push(existing);
          return;
        }
        this.execute(
          "INSERT INTO tasks(id, mission_id, plan_id, plan_key, plan_index, title, description, deps_json, required, files_hint_json, acceptance_json, status, worker_id, worktree_path, branch, attempts, result_json, last_error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          task.id,
          task.missionId,
          task.planId,
          task.planKey,
          task.planIndex ?? position,
          task.title,
          task.description,
          encodeJson(task.deps, "task.deps"),
          task.required ? 1 : 0,
          encodeJson(task.filesHint, "task.filesHint"),
          encodeJson(task.acceptance, "task.acceptance"),
          task.status,
          task.workerId ?? null,
          task.worktreePath ?? null,
          task.branch ?? null,
          task.attempts,
          task.result === undefined || task.result === null
            ? null
            : encodeJson(task.result, "task.result"),
          task.lastError ?? null,
        );
        stored.push(this.requireTask(task.id));
      });
      return stored;
    });
  }

  getTask(id: TaskId): StoredTask | undefined {
    const row = this.queryOne<TaskRow>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`, id);
    return row ? mapTask(row) : undefined;
  }

  /** Tasks in plan order (`plan_index`, then id) — the order the scheduler consumes them in. */
  listTasks(missionId: MissionId): StoredTask[] {
    return this.query<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE mission_id = ? ORDER BY plan_index ASC, id ASC`,
      missionId,
    ).map(mapTask);
  }

  updateTask(id: TaskId, patch: TaskPatch): StoredTask {
    const update = buildUpdate("tasks", TASK_PATCH, patch);
    if (update) this.execute(update.sql, ...update.values, id);
    return this.requireTask(id);
  }

  updateTaskStatus(id: TaskId, status: TaskStatus, patch: TaskStatusPatch = {}): StoredTask {
    return this.updateTask(id, { ...patch, status });
  }

  incrementTaskAttempts(id: TaskId): StoredTask {
    const result = this.prepare("UPDATE tasks SET attempts = attempts + 1 WHERE id = ?").run(id);
    if (Number(result.changes) === 0) throw notFound("task", id);
    return this.requireTask(id);
  }

  setTaskWorktree(
    id: TaskId,
    worktreePath: string | null,
    branch: string | null = null,
  ): StoredTask {
    return this.updateTask(id, { worktreePath, branch });
  }

  setTaskResult(id: TaskId, result: TaskResult | null): StoredTask {
    return this.updateTask(id, { result });
  }

  protected requirePlan(id: string): MissionPlan {
    const row = this.queryOne<PlanRow>(
      `SELECT ${PLAN_COLUMNS} FROM mission_plans WHERE id = ?`,
      id,
    );
    if (!row) throw notFound("mission plan", id);
    return mapPlan(row);
  }

  protected requireTask(id: TaskId): StoredTask {
    const task = this.getTask(id);
    if (!task) throw notFound("task", id);
    return task;
  }
}
