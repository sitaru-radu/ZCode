/**
 * The shape of a removal report: what the guard sequence returns and how it refuses.
 *
 * Types live here (next to the helpers that build them) so `removal.ts` stays a readable
 * implementation of the guard sequence — the repository gate is 400 lines per file.
 */

import type { WorktreeCallOptions } from './worktree.js';

export type RemovalGuardStep =
  | 'directory'
  | 'registration'
  | 'main-worktree'
  | 'locked'
  | 'dirty'
  | 'merge'
  | 'unmerged-commits'
  | 'remove'
  | 'registry-verify'
  | 'prune'
  | 'residue';

export type RemovalRefusalCode =
  | 'locked'
  | 'dirty'
  | 'merge-in-progress'
  | 'main-worktree'
  | 'not-registered'
  | 'unreadable'
  | 'remove-failed'
  | 'still-registered';

export interface RemovalStep {
  readonly step: RemovalGuardStep;
  readonly ok: boolean;
  readonly detail: string;
  readonly exitCode: number | null;
}

/** A typed refusal: the caller can persist it and decide; the package never decides for it. */
export interface RemovalRefusal {
  readonly code: RemovalRefusalCode;
  readonly message: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RemoveWorktreeOptions extends WorktreeCallOptions {
  /**
   * Explicit `-f`. Skips the merge and dirty guards. NEVER set this automatically: it destroys
   * uncommitted work.
   */
  readonly force?: boolean;
  /** Explicit `-f -f`, additionally overriding a lock. Implies {@link RemoveWorktreeOptions.force}. */
  readonly forceTwice?: boolean;
  /**
   * Release a lock this orchestrator took itself before removing. Default `false`: a locked worktree
   * is owned by someone else, so the default answer is to refuse (spike 4.3).
   */
  readonly unlockIfLocked?: boolean;
  /** Base ref used to count unmerged commits for the recovery record. */
  readonly baseRef?: string;
  /** Branch to report; defaults to the branch recorded in the registry entry. */
  readonly branch?: string;
}

export interface RemoveWorktreeReport {
  readonly removed: boolean;
  /** How the registry entry disappeared. `null` when the removal was refused. */
  readonly mode: 'removed' | 'pruned' | 'absent' | null;
  readonly path: string;
  /** Branch recorded in the registry, so a removed-but-unmerged worktree stays recoverable. */
  readonly branch: string | null;
  /** `rev-list --count <baseRef>..<branch>` when a base ref was supplied, otherwise `null`. */
  readonly unmergedCommits: number | null;
  /** A directory git left behind (it does not delete a pre-existing non-empty dir it did not create). */
  readonly residue: string | null;
  readonly refusal: RemovalRefusal | null;
  /** Set when `worktree prune` ran (it also runs after an already-missing directory). */
  readonly pruned: boolean;
  /** Audit trail of the guard sequence. */
  readonly steps: readonly RemovalStep[];
}

export function step(
  name: RemovalGuardStep,
  ok: boolean,
  detail: string,
  exitCode: number | null = null,
): RemovalStep {
  return { step: name, ok, detail, exitCode };
}

export function refusal(
  code: RemovalRefusalCode,
  message: string,
  raw: { exitCode?: number | null; stdout?: string; stderr?: string } = {},
): RemovalRefusal {
  return {
    code,
    message,
    exitCode: raw.exitCode ?? null,
    stdout: raw.stdout ?? '',
    stderr: raw.stderr ?? '',
  };
}

/** Human summary of what is dirty, used in the refusal message. */
export function describeDirty(status: { entries: readonly { kind: string; path: string }[] }): string {
  const dirty = status.entries.filter((entry) => entry.kind !== 'ignored');
  const shown = dirty.slice(0, 5).map((entry) => entry.path);
  const suffix = dirty.length > shown.length ? `, +${dirty.length - shown.length} more` : '';
  return `${dirty.length} uncommitted path(s): ${shown.join(', ')}${suffix}`;
}
