import type {
  AppendEventOptions,
  MissionEventRecord,
  MissionId,
  TaskId,
  Worker,
  WorkerId,
  WorkerState,
  WorkerStateOptions,
} from "./domain.js";
import { conflict, notFound } from "./errors.js";
import { decodeJson, encodeJson } from "./json.js";
import { mapWorker, type WorkerRow } from "./rows.js";
import { PlanMethods } from "./store-plans.js";

const WORKER_COLUMNS =
  "id, task_id, session_id, state, model, worktree_path, started_at, completed_at";
const EVENT_COLUMNS = "mission_id, seq, type, payload_json, run_seq, created_at";

interface EventRow {
  mission_id: string;
  seq: number;
  type: string;
  payload_json: string;
  run_seq: number | null;
  created_at: number;
}

/** Worker sessions and the normalized mission event stream. */
export interface ExecutionApi {
  insertWorker(worker: Worker): Worker;
  updateWorkerState(id: WorkerId, state: WorkerState, options?: WorkerStateOptions): Worker;
  getWorker(id: WorkerId): Worker | undefined;
  listWorkersByTask(taskId: TaskId): Worker[];
  appendEvent(
    missionId: MissionId,
    type: string,
    payload: unknown,
    runSeq?: number | null,
    options?: AppendEventOptions,
  ): MissionEventRecord;
  listEvents(missionId: MissionId, afterSeq?: number): MissionEventRecord[];
  lastEventSeq(missionId: MissionId): number;
}

export class ExecutionMethods extends PlanMethods implements ExecutionApi {
  insertWorker(worker: Worker): Worker {
    if (this.getWorker(worker.id)) throw conflict("worker", worker.id);
    this.execute(
      "INSERT INTO workers(id, task_id, session_id, state, model, worktree_path, started_at, completed_at) VALUES(?,?,?,?,?,?,?,?)",
      worker.id,
      worker.taskId,
      worker.sessionId,
      worker.state,
      worker.model ?? null,
      worker.worktreePath,
      worker.startedAt ?? null,
      worker.completedAt ?? null,
    );
    return this.requireWorker(worker.id);
  }

  /** A worker never returns from a terminal state; a retry creates a new row (history is kept). */
  updateWorkerState(id: WorkerId, state: WorkerState, options: WorkerStateOptions = {}): Worker {
    if (options.completedAt === undefined) {
      this.execute("UPDATE workers SET state = ? WHERE id = ?", state, id);
    } else {
      this.execute(
        "UPDATE workers SET state = ?, completed_at = ? WHERE id = ?",
        state,
        options.completedAt,
        id,
      );
    }
    return this.requireWorker(id);
  }

  getWorker(id: WorkerId): Worker | undefined {
    const row = this.queryOne<WorkerRow>(
      `SELECT ${WORKER_COLUMNS} FROM workers WHERE id = ?`,
      id,
    );
    return row ? mapWorker(row) : undefined;
  }

  /** Every attempt for a task, oldest first (a retry adds a row rather than overwriting one). */
  listWorkersByTask(taskId: TaskId): Worker[] {
    return this.query<WorkerRow>(
      `SELECT ${WORKER_COLUMNS} FROM workers WHERE task_id = ? ORDER BY COALESCE(started_at, 0) ASC, id ASC`,
      taskId,
    ).map(mapWorker);
  }

  /**
   * Appends one mission event, allocating `seq` inside the store (monotonic per mission from 1).
   * The read-modify-write runs in an immediate transaction, so concurrent processes cannot reuse a
   * seq, and `seq` is never caller-supplied.
   */
  appendEvent(
    missionId: MissionId,
    type: string,
    payload: unknown,
    runSeq?: number | null,
    options: AppendEventOptions = {},
  ): MissionEventRecord {
    const createdAt = options.createdAt ?? Date.now();
    return this.transaction(() => {
      const next = this.queryOne<{ next: number }>(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM mission_events WHERE mission_id = ?",
        missionId,
      );
      const seq = next?.next ?? 1;
      this.execute(
        "INSERT INTO mission_events(mission_id, seq, type, payload_json, run_seq, created_at) VALUES(?,?,?,?,?,?)",
        missionId,
        seq,
        type,
        encodeJson(payload, "event.payload"),
        runSeq ?? null,
        createdAt,
      );
      const record: MissionEventRecord = { missionId, seq, type, payload, createdAt };
      if (runSeq !== undefined && runSeq !== null) record.runSeq = runSeq;
      return record;
    });
  }

  /** Events of a mission with `seq` strictly greater than `afterSeq`, in seq order. */
  listEvents(missionId: MissionId, afterSeq = 0): MissionEventRecord[] {
    return this.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM mission_events WHERE mission_id = ? AND seq > ? ORDER BY seq ASC`,
      missionId,
      afterSeq,
    ).map((row) => {
      const record: MissionEventRecord = {
        missionId: row.mission_id,
        seq: row.seq,
        type: row.type,
        payload: decodeJson<unknown>(row.payload_json, "mission_events.payload_json"),
        createdAt: row.created_at,
      };
      if (row.run_seq !== null) record.runSeq = row.run_seq;
      return record;
    });
  }

  /** Highest event seq of a mission, or 0 when it has no events yet. */
  lastEventSeq(missionId: MissionId): number {
    const row = this.queryOne<{ seq: number }>(
      "SELECT COALESCE(MAX(seq), 0) AS seq FROM mission_events WHERE mission_id = ?",
      missionId,
    );
    return row?.seq ?? 0;
  }

  protected requireWorker(id: WorkerId): Worker {
    const worker = this.getWorker(id);
    if (!worker) throw notFound("worker", id);
    return worker;
  }
}
