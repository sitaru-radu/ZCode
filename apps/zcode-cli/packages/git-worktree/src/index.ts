/**
 * @zcode/git-worktree — public entry point.
 *
 * This package owns every git interaction the mission layer needs: worktree/branch lifecycle,
 * read-only facts, integration and safe removal. No other package shells out to git.
 *
 * Read CONTRACT.md before using it: it documents the removal guard sequence, the locking rules and
 * the invariants the orchestrator must uphold (one writer per worktree, worktrees outside the repo).
 */

export const packageName = '@zcode/git-worktree' as const;

export {
  GitError,
  classifyGitFailure,
  isGitError,
  type GitErrorDetails,
  type GitFailureKind,
} from './errors.js';

export {
  DEFAULT_TIMEOUT_MS,
  buildGitArgv,
  buildGitEnv,
  git,
  gitOrThrow,
  type CallTuning,
  type GitCallOptions,
  type GitResult,
} from './runner.js';

export {
  AsyncMutex,
  KeyedMutex,
  awaitMutexesIdle,
  integrationMutex,
  maybeLock,
  repoMutex,
  withIntegrationLock,
  withRepoLock,
} from './mutex.js';

export {
  currentBranch,
  getStatus,
  hasUncommittedWork,
  headSha,
  parseStatusV2,
  type StatusEntry,
  type StatusKind,
  type StatusReport,
} from './status.js';

export {
  aheadBehind,
  changedFiles,
  commitsAhead,
  diffPatch,
  diffStat,
  listCommits,
  mergeBase,
  parseNameStatusZ,
  threeDotRange,
  twoDotRange,
  type ChangeKind,
  type ChangedFile,
  type CommitInfo,
  type CommitListOptions,
  type DiffOptions,
} from './diff.js';

export {
  abortMerge,
  getConflictState,
  isMergeInProgress,
  mergeInto,
  parseMergeTreeOutput,
  parseUnmergedEntries,
  predictMerge,
  type AbortMergeResult,
  type ConflictEntry,
  type ConflictState,
  type MergeOptions,
  type MergeOutcome,
  type MergePrediction,
  type MergeResult,
} from './integration.js';

export {
  addWorktree,
  getWorktree,
  isRegistered,
  isSamePath,
  listWorktrees,
  lockWorktree,
  moveWorktree,
  parseWorktreeList,
  pruneWorktrees,
  repairWorktrees,
  unlockWorktree,
  type AddWorktreeSpec,
  type PruneOptions,
  type PruneResult,
  type WorktreeCallOptions,
  type WorktreeInfo,
} from './worktree.js';

export { removeWorktree } from './removal.js';

export {
  type RemovalGuardStep,
  type RemovalRefusal,
  type RemovalRefusalCode,
  type RemovalStep,
  type RemoveWorktreeOptions,
  type RemoveWorktreeReport,
} from './removal-report.js';
