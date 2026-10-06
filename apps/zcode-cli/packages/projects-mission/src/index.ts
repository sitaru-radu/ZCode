/**
 * @zcode/projects-mission — public entry point.
 *
 * The mission layer: planning, execution over DeepSeek Harness workers in isolated git worktrees,
 * independent review, validation gates, recovery, and the workflow-driver binding.
 *
 * Specs: `specs/projects/` (00 overview and decisions, 10 domain, 20 store, 40 executor,
 * 50 mission runner). The runner is the only component that moves mission state.
 */

export const packageName = '@zcode/projects-mission' as const;

export { MissionRunner, type MissionRunnerDeps, type MissionResultView, type MissionStatusView } from './runner.js';

export {
  DEFAULT_INSTRUCTION_MAX_BYTES,
  RunnerConfigError,
  createRunnerConfig,
  discoverValidationCommands,
  readRepositoryInstructions,
  type DiscoverValidationInput,
  type DiscoveredCommand,
  type MissionConfig,
  type ReadInstructionsInput,
  type ValidationCommandSource,
} from './runner-config.js';

export {
  PlanInvalidError,
  buildPlanPrompt,
  parsePlanPayload,
  planMission,
  type PlanMissionInput,
  type PlanMissionResult,
} from './runner-plan.js';

export {
  ScriptCompileError,
  compileMissionScript,
  executeMission,
  extractMissionReport,
  missionValidate,
  persistValidations,
  readSettlementStatus,
  type ExecuteMissionInput,
  type ExecuteMissionResult,
  type MissionReport,
  type ScriptValidationResult,
} from './runner-execute.js';

export {
  createTaskFlow,
  taskKeyFromActorName,
  type TaskFlow,
  type TaskFlowDeps,
  type WorktreePort,
} from './runner-taskflow.js';

export { createWorktreePort } from './worktree-port.js';

export {
  createDshWorkflowDriver,
  type AskSettledInfo,
  type BeforeSubmitInfo,
  type BeforeSubmitResult,
  type DshDriverDeps,
  type DshDriverFactory,
  type SessionCreatedInfo,
  type TaskEnvironment,
} from './workflow-driver.js';

export { composeAskPrompt, extractResultPayload, nudgePrompt, repairPrompt } from './workflow-driver-prompt.js';

export { emitMissionEvent, type MissionEventPayloads, type MissionEventType } from './mission-events.js';

export { createWorldReader, type WorldReader, type WorldReaderDeps } from './world-read.js';

export {
  assessCompletion,
  buildReviewBrief,
  parseReviewVerdict,
  reviewerWorkspaceIsClean,
  summarizeValidationRun,
  type AssessInput,
  type AssessResult,
  type ReviewBriefInput,
  type ReviewBriefTask,
  type ReviewChangeFacts,
  type ReviewVerdictResult,
  type ValidationRunInput,
  type ValidationRunSummary,
} from './runner-review.js';

export {
  compilePlanToScript,
  type CompilePlanInput,
  type CompilePlanResult,
  type ValidationCommand,
} from './compile-plan.js';

export { reconcileMissions, type ReconcileInput, type RecoveryReport, type RecoveryState } from './runner-recovery.js';
