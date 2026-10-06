/**
 * Mission phase derivation and the two lifecycle state machines — spec `specs/projects/10-domain.md`
 * §2 (mission), §3 (task) and §4 (worker).
 *
 * `phase` is always derived from `status`, never stored independently (§2), so `missionPhaseFor`
 * returns a value for every possible status — including the terminal ones.
 */
import type { MissionPhase, MissionStatus, TaskStatus } from './types.js';

/**
 * Mission statuses from which no transition is allowed (§2). Terminal statuses never leave
 * themselves, which makes `canTransitionMission` return false for every pair starting here.
 */
const TERMINAL_MISSION_STATUSES: readonly MissionStatus[] = ['completed', 'failed', 'cancelled'];

/**
 * Mission transitions of §2, including `any non-terminal -> cancelled` (`cancelMission`).
 * `blocked -> running` is present because an explicit resume is the only way out of `blocked`;
 * nothing else may enter `running` from `blocked`.
 */
const MISSION_TRANSITIONS: Readonly<Record<MissionStatus, readonly MissionStatus[]>> = {
  draft: ['planning', 'cancelled'],
  planning: ['ready', 'failed', 'cancelled'],
  ready: ['running', 'cancelled'],
  running: ['reviewing', 'blocked', 'failed', 'cancelled'],
  blocked: ['running', 'cancelled'],
  reviewing: ['testing', 'running', 'blocked', 'cancelled'],
  testing: ['completed', 'running', 'blocked', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

/**
 * Task transitions of §3. `blocked -> pending` is the one transition that carries a guard: §3 allows
 * it only when the failed dependency is re-opened by a new plan version, so the caller must check
 * that precondition before applying it — it is never applied silently.
 */
const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['ready', 'blocked'],
  ready: ['running'],
  running: ['review', 'ready', 'failed'],
  review: ['done', 'ready', 'failed'],
  done: [],
  failed: [],
  blocked: ['pending'],
};

/**
 * Derive the mission phase from its status (§2).
 *
 * §2 fixes `draft|planning`, `ready|running`, `reviewing`, `testing` and `completed`; `blocked`,
 * `failed` and `cancelled` are not listed, so this module chooses: `blocked` stays in `execute`
 * (it resumes into `running`), and `failed`/`cancelled` report `complete` because no further phase
 * will run — `complete` means "the phase sequence is over", not "the mission succeeded".
 */
export function missionPhaseFor(status: MissionStatus): MissionPhase {
  switch (status) {
    case 'draft':
      return 'understand';
    case 'planning':
      return 'plan';
    case 'ready':
    case 'running':
    case 'blocked':
      return 'execute';
    case 'reviewing':
      return 'review';
    case 'testing':
      return 'test';
    case 'completed':
    case 'failed':
    case 'cancelled':
      return 'complete';
  }
}

/** True for `completed`, `failed` and `cancelled` (§2): no transition leaves a terminal status. */
export function isTerminalMission(status: MissionStatus): boolean {
  return TERMINAL_MISSION_STATUSES.includes(status);
}

/** Mission state machine of §2, including cancellation from any non-terminal status. */
export function canTransitionMission(from: MissionStatus, to: MissionStatus): boolean {
  return MISSION_TRANSITIONS[from].includes(to);
}

/** Task state machine of §3. Self-transitions are rejected. */
export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}
