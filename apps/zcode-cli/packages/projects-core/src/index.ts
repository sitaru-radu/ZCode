/**
 * @zcode/projects-core — public entry point (spec `specs/projects/10-domain.md` §6).
 *
 * The package is pure: no filesystem, no network, no ambient clock. The only runtime dependency is
 * `node:crypto` inside `ids.ts`, for hashing and the two user-facing random ids.
 *
 * This file is a re-export barrel and nothing else: every symbol promised by §6 (plus the id
 * helpers of §5) is exported here, and internal helpers stay internal.
 */

// §1 — vocabulary and entities.
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
  ShortId,
  Task,
  TaskId,
  TaskResult,
  TaskStatus,
  Validation,
  Worker,
  WorkerId,
  WorkerState,
} from './types.js';

// §5 — ids and determinism.
export { deriveId, newId, shortHash } from './ids.js';

// §2/§3 — lifecycle.
export { canTransitionMission, canTransitionTask, isTerminalMission, missionPhaseFor } from './lifecycle.js';

// §6 — planning.
export { ADVISORY_PLAN_ISSUE_CODES, materializeTasks, remediationTasksFor, validatePlan } from './planning.js';
export type { PlanIssue, PlanIssueCode, PlanLimits } from './planning.js';

// §6 — scheduling.
export { blockedTasks, hasProgress, readyTasks, selectDispatch } from './scheduling.js';

// §6 — completion gate.
export { evaluateCompletion } from './gates.js';
export type { Blocker, BlockerCode, CompletionInput } from './gates.js';
