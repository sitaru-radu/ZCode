/**
 * Restart recovery.
 *
 * A mission's truth is in `projects.db`; a run's truth is in the executor. On restart the two are
 * reconciled: a mission whose executor session is gone is never silently completed — it becomes
 * `interrupted` (recorded as a blocker), and resuming it stays an explicit decision.
 */
import type { Mission } from '@zcode/projects-core';
import type { DeepSeekHarnessAdapter } from '@zcode/dsh-executor';
import type { ProjectsStore } from '@zcode/projects-store';

import { emitMissionEvent } from './mission-events.js';

export type RecoveryState = 'running' | 'recoverable' | 'interrupted';

export interface RecoveryReport {
  missionId: string;
  previousStatus: Mission['status'];
  state: RecoveryState;
  detail: string;
}

export interface ReconcileInput {
  store: ProjectsStore;
  adapter?: DeepSeekHarnessAdapter;
  now: () => number;
  /** Worktree root used to recognise a mission's sessions by their working directory. */
  worktreeRoot?: string;
  /** When true a `recoverable` mission is left for the caller to resume; never auto-completes. */
  autoResume?: boolean;
  logger?: (message: string) => void;
}

/** Classify every non-terminal mission and record what was found. Never mutates a terminal mission. */
export async function reconcileMissions(input: ReconcileInput): Promise<RecoveryReport[]> {
  const ids = input.store.recoverableMissionIds();
  if (ids.length === 0) return [];

  const sessions = await listExecutorSessions(input);
  const reports: RecoveryReport[] = [];

  for (const missionId of ids) {
    const mission = input.store.getMission(missionId);
    if (mission === undefined) continue;
    const report = classify(mission, sessions, input.worktreeRoot);
    reports.push(report);

    if (report.state === 'interrupted') {
      input.store.updateMission(missionId, {
        status: 'blocked',
        blockReason: `interrupted: ${report.detail}`,
      });
    }
    emitMissionEvent(
      input.store,
      missionId,
      'mission.recovered',
      { state: report.state, detail: report.detail },
      input.now(),
    );
    input.logger?.(`mission ${missionId}: ${report.state} (${report.detail})`);
  }

  return reports;
}

async function listExecutorSessions(input: ReconcileInput): Promise<{ sessionId: string; cwd?: string }[]> {
  if (input.adapter === undefined) return [];
  try {
    return await input.adapter.listSessions();
  } catch (error) {
    input.logger?.(`could not list executor sessions: ${String(error)}`);
    return [];
  }
}

function classify(
  mission: Mission,
  sessions: { sessionId: string; cwd?: string }[],
  worktreeRoot: string | undefined,
): RecoveryReport {
  if (mission.status === 'draft' || mission.status === 'ready' || mission.status === 'planning') {
    return {
      missionId: mission.id,
      previousStatus: mission.status,
      state: 'recoverable',
      detail: 'mission had not started executing; it can be started again',
    };
  }

  if (worktreeRoot === undefined || sessions.length === 0) {
    return {
      missionId: mission.id,
      previousStatus: mission.status,
      state: 'interrupted',
      detail: 'no executor session is alive for this mission',
    };
  }

  const missionDir = `${worktreeRoot}/${mission.projectId}/${mission.id}`;
  const alive = sessions.filter((session) => (session.cwd ?? '').startsWith(missionDir));
  if (alive.length > 0) {
    return {
      missionId: mission.id,
      previousStatus: mission.status,
      state: 'running',
      detail: `${alive.length} executor session(s) still alive`,
    };
  }

  return {
    missionId: mission.id,
    previousStatus: mission.status,
    state: 'interrupted',
    detail: 'mission was mid-run but its executor sessions are gone',
  };
}
