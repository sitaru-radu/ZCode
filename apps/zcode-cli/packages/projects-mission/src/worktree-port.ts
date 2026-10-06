/**
 * Adapter from the mission layer's `WorktreePort` to `@zcode/git-worktree`.
 *
 * The git package deliberately does not commit (the worker owns its worktree index, and a second
 * write path would duplicate ownership), so the commit that turns a worker's product into history
 * lives here, using the package's exported `git` runner.
 */
import {
  addWorktree,
  changedFiles,
  diffPatch,
  getStatus,
  gitOrThrow,
  headSha,
  isRegistered,
  mergeInto as mergeBranchInto,
  predictMerge as predictBranchMerge,
} from '@zcode/git-worktree';

import type { WorktreePort } from './runner-taskflow.js';

/** Commit identity used for runner-made commits; never the user's, never global config. */
const COMMIT_IDENTITY = ['-c', 'user.name=ZCode Missions', '-c', 'user.email=missions@zcode.local'];

async function addOrReuse(input: {
  repositoryPath: string;
  path: string;
  branch: string;
  baseRef: string;
}): Promise<void> {
  if (await isRegistered(input.repositoryPath, input.path)) return;
  try {
    await addWorktree(input.repositoryPath, { path: input.path, branch: input.branch, baseRef: input.baseRef });
  } catch (error) {
    // A branch left over from an interrupted run is reused rather than recreated: the worktree is
    // the only thing missing, and deleting the branch would destroy recoverable work.
    const message = error instanceof Error ? error.message : String(error);
    if (!/already (exists|checked out)/i.test(message)) throw error;
    await addWorktree(input.repositoryPath, { path: input.path, branch: input.branch, reuseBranch: true });
  }
}

async function requireHead(worktreePath: string): Promise<string> {
  const sha = await headSha(worktreePath);
  if (sha === null) throw new Error(`worktree ${worktreePath} has no HEAD`);
  return sha;
}

/** Files touched by one commit, as repository-relative paths. */
async function filesOfCommit(worktreePath: string, commit: string): Promise<string[]> {
  const result = await gitOrThrow(['show', '--name-only', '--format=', '-z', commit], { cwd: worktreePath });
  return result.stdout.split('\u0000').filter((path) => path.length > 0);
}

/** Build the concrete port. One instance is safe to share: git-worktree serializes internally. */
export function createWorktreePort(): WorktreePort {
  return {
    async ensureIntegrationWorktree(input) {
      await addOrReuse(input);
      return { path: input.path, branch: input.branch, head: await requireHead(input.path) };
    },

    async createTaskWorktree(input) {
      await addOrReuse(input);
      return { path: input.path, branch: input.branch, baseRef: input.baseRef, head: await requireHead(input.path) };
    },

    async status(input) {
      const report = await getStatus(input.worktreePath);
      // `porcelainV2` is a textual echo for consumers that only ask "clean or not"; the parsed
      // report is the source of truth.
      const porcelainV2 = report.clean
        ? ''
        : report.entries.map((entry) => `${entry.kind} ${entry.path ?? ''}`).join('\n');
      return { dirty: !report.clean, porcelainV2 };
    },

    async commitAll(input) {
      await gitOrThrow(['add', '-A'], { cwd: input.worktreePath });
      await gitOrThrow([...COMMIT_IDENTITY, 'commit', '--no-verify', '-m', input.message], { cwd: input.worktreePath });
      const commit = await requireHead(input.worktreePath);
      return { commit, filesChanged: await filesOfCommit(input.worktreePath, commit) };
    },

    async changedFiles(input) {
      const files = await changedFiles(input.worktreePath, input.baseRef, input.branch ?? 'HEAD');
      return files.map((file) => file.path);
    },

    async predictMerge(input) {
      const prediction = await predictBranchMerge(input.repositoryPath, input.into, input.from);
      return { clean: prediction.clean, conflicts: [...prediction.conflicts] };
    },

    async mergeInto(input) {
      const result = await mergeBranchInto(input.worktreePath, input.branch, { message: input.message });
      if (result.outcome === 'merged' || result.outcome === 'up-to-date') {
        return { ok: true, commit: await requireHead(input.worktreePath) };
      }
      const conflicts = result.conflict?.conflicted ?? [];
      return { ok: false, conflicts: conflicts.length > 0 ? [...conflicts] : [result.outcome] };
    },

    async head(input) {
      return requireHead(input.worktreePath);
    },

    async diffPatch(input) {
      return diffPatch(input.worktreePath, input.base, 'HEAD');
    },
  };
}
