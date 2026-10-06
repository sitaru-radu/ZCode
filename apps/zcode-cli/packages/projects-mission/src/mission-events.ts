/**
 * Mission event catalogue.
 *
 * Mission events are the mission-level narrative (what the coordinator decided and did). Execution
 * detail stays in the workflow journal and in DSH sessions; this catalogue is what the store keeps and
 * what a UI reads, so it is deliberately small and free of token-level noise.
 */
import type { EpochMs, MissionId, TaskId, WorkerId } from '@zcode/projects-core';
import type { MissionEventRecord } from '@zcode/projects-store';

export type { MissionEventRecord };

export type MissionEventType =
  | 'mission.created'
  | 'mission.planned'
  | 'mission.started'
  | 'mission.phase_changed'
  | 'mission.instructed'
  | 'mission.blocked'
  | 'mission.completed'
  | 'mission.failed'
  | 'mission.cancelled'
  | 'mission.recovered'
  | 'plan.revised'
  | 'task.ready'
  | 'task.started'
  | 'task.completed'
  | 'task.failed'
  | 'task.retry'
  | 'worker.started'
  | 'worker.completed'
  | 'worker.failed'
  | 'worktree.created'
  | 'worktree.committed'
  | 'worktree.integrated'
  | 'review.started'
  | 'review.passed'
  | 'review.failed'
  | 'tests.started'
  | 'tests.passed'
  | 'tests.failed';

/** Payload shapes per event; every field is JSON-serializable by construction. */
export interface MissionEventPayloads {
  'mission.created': { projectId: string; objective: string };
  'mission.planned': { planId: string; version: number; taskCount: number };
  'mission.started': { runId?: string; maxWorkers: number };
  'mission.phase_changed': { from: string; to: string };
  'mission.instructed': { text: string };
  'mission.blocked': { reason: string; blockers?: unknown };
  'mission.completed': { summary: string; branch: string; commit?: string };
  'mission.failed': { reason: string };
  'mission.cancelled': { reason?: string };
  'mission.recovered': { state: 'running' | 'recoverable' | 'interrupted'; detail: string };
  'plan.revised': { version: number; taskCount: number; reason: string };
  'task.ready': { taskId: TaskId; planKey: string };
  'task.started': { taskId: TaskId; workerId: WorkerId; worktreePath: string; branch: string };
  'task.completed': { taskId: TaskId; commit: string; filesChanged: string[] };
  'task.failed': { taskId: TaskId; attempts: number; reason: string };
  'task.retry': { taskId: TaskId; attempt: number; reason: string };
  'worker.started': { workerId: WorkerId; taskId: TaskId; sessionId: string; model?: string };
  'worker.completed': { workerId: WorkerId; taskId: TaskId };
  'worker.failed': { workerId: WorkerId; taskId: TaskId; reason: string };
  'worktree.created': { taskId: TaskId; worktreePath: string; branch: string; baseRef: string };
  'worktree.committed': { taskId: TaskId; commit: string; filesChanged: string[] };
  'worktree.integrated': { taskId: TaskId; branch: string; into: string; commit: string };
  'review.started': { round: number; commit: string; sessionId: string };
  'review.passed': { round: number; commit: string };
  'review.failed': { round: number; commit: string; blocking: number; advisory: number };
  'tests.started': { commands: string[] };
  'tests.passed': { commands: string[]; durationMs: number };
  'tests.failed': { failures: { command: string; exitCode: number }[] };
}

/**
 * The store method this module appends through. Kept structural so the store stays the owner of the
 * `seq` allocation and of the row shape.
 */
export interface MissionEventSink {
  appendEvent(
    missionId: MissionId,
    type: string,
    payload: unknown,
    runSeq?: number | null,
    options?: { createdAt?: EpochMs },
  ): MissionEventRecord;
}

/** Append one mission event; the store allocates `seq`, so ordering stays single-writer. */
export function emitMissionEvent<T extends MissionEventType>(
  sink: MissionEventSink,
  missionId: MissionId,
  type: T,
  payload: MissionEventPayloads[T],
  at: EpochMs,
  runSeq?: number,
): MissionEventRecord {
  return sink.appendEvent(missionId, type, payload, runSeq ?? null, { createdAt: at });
}
