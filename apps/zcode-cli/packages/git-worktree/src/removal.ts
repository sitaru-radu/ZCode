/**
 * Worktree removal, implementing the spike's mandatory guard sequence (section 4.3).
 *
 * Two facts make this file necessary:
 * - `worktree remove` refuses a dirty worktree with exit `128`, but removes a CLEAN worktree with
 *   unmerged commits at exit `0` without a word (G10). The branch is the only safety net, so branch
 *   deletion is never part of this package.
 * - `--force` destroys uncommitted work with no recovery path. This package NEVER escalates to it on
 *   its own; `force: true` is an explicit decision by the caller.
 *
 * Guard order (any failing step refuses; `forced` — implied by `forceTwice` — skips only steps 5-6):
 *   1. directory exists?     absent -> deregister (if registered) + prune
 *   2. registered?           no  -> refuse (`worktree remove` would exit 128)
 *   3. main worktree?        yes -> refuse; never remove the user's checkout
 *   4. locked?               yes -> refuse; unlock first, `-f -f` only on explicit force
 *   5. merge in progress?    yes -> refuse (run `abortMerge` first)
 *   6. uncommitted work?     yes -> refuse, do not touch
 *   7. `worktree remove`     non-zero -> refuse and report the raw output, never escalate
 *   8. registry verified     still registered -> prune, then refuse if still present
 *   9. `worktree prune`      also cleans a deleted-directory entry
 *  10. residue check         report a directory git did not delete (never `rm -rf` it here)
 *
 * Steps 5 and 6 are swapped relative to the spike's numbering: MERGE_HEAD + `ls-files -u` is asked
 * first so a mid-merge worktree is refused with the precise reason instead of an ambiguous dirty
 * status. Both orders refuse, so nothing is weakened.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';

import { commitsAhead } from './diff.js';
import { getConflictState } from './integration.js';
import { maybeLock } from './mutex.js';
import {
  describeDirty,
  refusal,
  step,
  type RemovalGuardStep,
  type RemovalRefusal,
  type RemovalStep,
  type RemoveWorktreeOptions,
  type RemoveWorktreeReport,
} from './removal-report.js';
import { git } from './runner.js';
import { getStatus } from './status.js';
import { getWorktree, isRegistered, pruneWorktrees, unlockWorktree, type WorktreeInfo } from './worktree.js';

async function directoryExists(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Remove a worktree after the full guard sequence. Refuses (never forces) when the worktree is
 * locked, dirty, mid-merge, unregistered or is the main worktree. Serialized per repository.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  options?: RemoveWorktreeOptions,
): Promise<RemoveWorktreeReport> {
  const { lock, force = false, forceTwice = false, unlockIfLocked = false, baseRef, branch, ...call } =
    options ?? {};
  const target = path.resolve(worktreePath);
  // `-f -f` implies `-f`: an explicit force-twice is strictly more destructive than a force.
  const forced = force || forceTwice;

  return maybeLock(lock, 'repo', repoPath, async () => {
    const steps: RemovalStep[] = [];
    const forceFlags = forceTwice ? ['-f', '-f'] : force ? ['-f'] : [];
    const record = (name: RemovalGuardStep, ok: boolean, detail: string, exitCode: number | null = null): void => {
      steps.push(step(name, ok, detail, exitCode));
    };
    const finish = (
      removed: boolean,
      mode: RemoveWorktreeReport['mode'],
      extra: {
        entry?: WorktreeInfo | null;
        unmergedCommits?: number | null;
        residue?: string | null;
        refusal?: RemovalRefusal | null;
        pruned?: boolean;
        branch?: string | null;
      } = {},
    ): RemoveWorktreeReport => ({
      removed,
      mode,
      path: target,
      branch: extra.branch ?? extra.entry?.branch ?? branch ?? null,
      unmergedCommits: extra.unmergedCommits ?? null,
      residue: extra.residue ?? null,
      refusal: extra.refusal ?? null,
      pruned: extra.pruned === true,
      steps,
    });

    // Step 1: does the directory still exist?
    const exists = await directoryExists(target);
    record('directory', true, exists ? 'present' : 'missing (deleted by hand)');

    if (!exists) {
      // A deleted directory needs `prune`, not `remove`; `worktree remove <missing>` also exits 0 and
      // silently deregisters it, so either way the registry entry goes away (spike 4.2, G11).
      const registered = await isRegistered(repoPath, target, call);
      if (!registered) {
        record('registration', true, 'not registered');
        const prune = await pruneWorktrees(repoPath, { lock: false, ...call });
        record('prune', true, prune.prunedIds.length > 0 ? 'stale entry pruned' : 'nothing to prune');
        return finish(true, 'absent', { pruned: prune.prunedIds.length > 0 });
      }
      const removal = await git(['worktree', 'remove', target], {
        cwd: repoPath,
        acceptCodes: [0, 128, 255],
        ...call,
      });
      record('remove', removal.exitCode === 0, 'deregistered a missing directory', removal.exitCode);
      await pruneWorktrees(repoPath, { lock: false, ...call });
      record('prune', true, 'registry pruned');
      return finish(true, 'pruned', { pruned: true });
    }

    // Step 2: is it a registered worktree of THIS repository?
    const entry = await getWorktree(repoPath, target, call);
    if (entry === null) {
      record('registration', false, 'not a registered worktree');
      const removalAttempt = await git(['worktree', 'remove', target], {
        cwd: repoPath,
        acceptCodes: [0, 1, 128, 255],
        ...call,
      });
      return finish(false, null, {
        refusal: refusal(
          'not-registered',
          `'${target}' is not a registered worktree of '${repoPath}'; refusing to touch it`,
          removalAttempt,
        ),
      });
    }
    record('registration', true, `registered (branch ${entry.branch ?? 'detached'})`);

    // Step 3: never remove the user's main worktree.
    if (entry.isMainWorktree) {
      record('main-worktree', false, 'main worktree');
      return finish(false, null, {
        entry,
        refusal: refusal('main-worktree', `'${target}' is the main worktree of '${repoPath}'; refusing to remove it`),
      });
    }
    record('main-worktree', true, 'linked worktree');

    // Record the recovery information before anything can destroy it: unmerged commits may be
    // removed, but the branch must survive so `git log <branch>` still finds them (G10).
    const effectiveBranch = branch ?? entry.branch;
    let unmergedCommits: number | null = null;
    if (baseRef !== undefined && effectiveBranch !== null) {
      unmergedCommits = await commitsAhead(repoPath, baseRef, effectiveBranch, call);
      record('unmerged-commits', true, `${unmergedCommits} commit(s) not in ${baseRef}`, null);
    }

    // Step 4: a locked worktree is owned by someone else.
    if (entry.locked) {
      if (unlockIfLocked) {
        await unlockWorktree(repoPath, target, { lock: false, ...call });
        record('locked', true, `unlocked (${entry.lockedReason ?? 'no reason given'}) before removal`);
      } else if (forceTwice) {
        record('locked', true, 'override with -f -f on explicit request');
      } else {
        record('locked', false, `locked: ${entry.lockedReason ?? 'no reason given'}`);
        return finish(false, null, {
          entry,
          unmergedCommits,
          refusal: refusal(
            'locked',
            `'${target}' is locked (${entry.lockedReason ?? 'no reason given'}); unlock it first or pass forceTwice explicitly`,
          ),
        });
      }
    } else {
      record('locked', true, 'not locked');
    }

    // Step 5: a merge in progress is not a removable state. This runs BEFORE the dirty check
    // because a dirty status cannot tell a conflict from a legitimate `merge --no-commit` (G2):
    // MERGE_HEAD + `ls-files -u` is asked first so the refusal names the real reason.
    if (forced) {
      record('merge', true, 'skipped (explicit force)');
    } else {
      const conflict = await getConflictState(target, call);
      if (conflict.inMerge) {
        record('merge', false, `MERGE_HEAD present, ${conflict.conflicted.length} unmerged path(s)`);
        return finish(false, null, {
          entry,
          unmergedCommits,
          refusal: refusal(
            'merge-in-progress',
            `'${target}' has a merge in progress; run abortMerge first`,
          ),
        });
      }
      record('merge', true, 'no merge in progress');
    }

    // Step 6: uncommitted work. Never auto-escalate to --force.
    if (forced) {
      record('dirty', true, forceTwice ? 'skipped (explicit -f -f)' : 'skipped (explicit -f)');
    } else {
      const status = await git(['status', '--porcelain=v2', '--branch', '-z'], {
        cwd: target,
        acceptCodes: [0, 128, 255],
        ...call,
      });
      if (status.exitCode !== 0) {
        record('dirty', false, 'status unavailable', status.exitCode);
        return finish(false, null, {
          entry,
          unmergedCommits,
          refusal: refusal(
            'unreadable',
            `cannot read the status of '${target}': ${status.stderr.trim() || `exit ${String(status.exitCode)}`}`,
            status,
          ),
        });
      }
      const report = await getStatus(target, call);
      if (!report.clean) {
        const detail = describeDirty(report);
        record('dirty', false, detail);
        return finish(false, null, {
          entry,
          unmergedCommits,
          refusal: refusal('dirty', `'${target}' has uncommitted work (${detail}); refusing to remove it`),
        });
      }
      record('dirty', true, 'clean');
    }

    // Step 7: remove. A non-zero exit is reported, never escalated.
    const removal = await git(['worktree', 'remove', ...forceFlags, target], {
      cwd: repoPath,
      acceptCodes: [0, 1, 128, 255],
      ...call,
    });
    if (removal.exitCode !== 0) {
      record('remove', false, removal.stderr.trim() || `exit ${String(removal.exitCode)}`, removal.exitCode);
      return finish(false, null, {
        entry,
        unmergedCommits,
        refusal: refusal(
          'remove-failed',
          `worktree remove failed for '${target}': ${removal.stderr.trim() || `exit ${String(removal.exitCode)}`}`,
          removal,
        ),
      });
    }
    record('remove', true, 'worktree remove exited 0', removal.exitCode);

    // Step 8: the registry must no longer list it.
    let pruned = false;
    let registeredAfter = await isRegistered(repoPath, target, call);
    if (registeredAfter) {
      await pruneWorktrees(repoPath, { lock: false, ...call });
      pruned = true;
      record('prune', true, 'registry pruned after removal');
      registeredAfter = await isRegistered(repoPath, target, call);
      if (registeredAfter) {
        record('registry-verify', false, 'still registered after remove + prune');
        return finish(false, null, {
          entry,
          unmergedCommits,
          pruned,
          refusal: refusal('still-registered', `'${target}' is still registered after remove + prune`),
        });
      }
    }
    record('registry-verify', true, 'no longer registered');

    // Step 9: prune is idempotent and cleans a deleted-directory entry.
    if (!pruned) {
      await pruneWorktrees(repoPath, { lock: false, ...call });
      pruned = true;
      record('prune', true, 'registry pruned');
    }

    // Step 10: `remove` is not `rm -rf`; report anything it left behind instead of deleting it.
    const residue = (await directoryExists(target)) ? target : null;
    record('residue', residue === null, residue === null ? 'no residue' : 'directory still on disk');

    return finish(true, 'removed', { entry, unmergedCommits, residue, pruned });
  });
}
