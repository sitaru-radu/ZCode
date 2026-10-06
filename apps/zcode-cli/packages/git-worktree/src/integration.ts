/**
 * Conflict pre-flight and integration.
 *
 * The spike's central warning is that a conflict report goes to **stdout** and stderr is empty
 * (G1), so the conflict predicate is never a stderr grep and never "status is dirty" (G2):
 *
 *     conflict  <=>  MERGE_HEAD exists  AND  `git ls-files -u` is non-empty
 *
 * `predictMerge` answers "will these two branches conflict?" read-only, with no worktree and no
 * index lock, which is what the orchestrator uses to order work; `mergeInto` performs the real
 * integration, one task branch at a time.
 */

import { git, gitOrThrow, type CallTuning } from './runner.js';
import { headSha } from './status.js';
import { maybeLock } from './mutex.js';

export interface ConflictEntry {
  readonly mode: string;
  readonly sha: string;
  /** 1 = base, 2 = ours, 3 = theirs. */
  readonly stage: number;
  readonly path: string;
}

export interface ConflictState {
  /** `MERGE_HEAD` exists. On its own this is NOT a conflict: `merge --no-commit` sets it too. */
  readonly inMerge: boolean;
  /** Unique paths with unmerged index entries (`ls-files -u`). */
  readonly conflicted: readonly string[];
  readonly entries: readonly ConflictEntry[];
  /** The only correct "there is a conflict right now" answer. */
  readonly hasConflict: boolean;
}

export interface MergePrediction {
  readonly clean: boolean;
  /** Tree OID computed by `merge-tree --write-tree`; `null` only if git printed nothing. */
  readonly tree: string | null;
  /** Conflicting paths (machine-readable section of the output). */
  readonly conflicts: readonly string[];
  /** Human `CONFLICT (...)`/`Auto-merging` lines, which git prints on STDOUT. */
  readonly messages: readonly string[];
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type MergeOutcome = 'merged' | 'up-to-date' | 'conflict' | 'failed';

export interface MergeResult {
  readonly outcome: MergeOutcome;
  readonly branch: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Populated whenever the merge did not succeed; `null` for `merged`/`up-to-date`. */
  readonly conflict: ConflictState | null;
  /** HEAD of the worktree after the attempt. */
  readonly head: string | null;
}

export interface MergeOptions extends CallTuning {
  /** Commit subject for the merge commit. */
  readonly message?: string;
  /** `--no-ff` (default `true`) so every task leaves an auditable merge commit. */
  readonly noFf?: boolean;
  /** Set `false` only inside an existing `withIntegrationLock`. */
  readonly lock?: boolean;
}

export interface AbortMergeResult {
  readonly aborted: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly conflict: ConflictState;
}

const MERGE_STATUS = /^(\d{6}) ([0-9a-f]+) (\d)\t(.*)$/s;

/** `MERGE_HEAD` exists? Exit code 1 is a normal negative answer here, not an error (G5). */
export async function isMergeInProgress(cwd: string, options?: CallTuning): Promise<boolean> {
  const result = await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd, acceptCodes: [0, 1], ...options });
  return result.exitCode === 0;
}

/** Parse `ls-files -u -z`: `<mode> <object> <stage>\t<path>` per NUL-separated entry. */
export function parseUnmergedEntries(stdout: string): ConflictEntry[] {
  const entries: ConflictEntry[] = [];
  for (const record of stdout.split('\0')) {
    if (record === '') continue;
    const match = MERGE_STATUS.exec(record);
    if (match === null) continue;
    entries.push({
      mode: match[1] ?? '',
      sha: match[2] ?? '',
      stage: Number.parseInt(match[3] ?? '0', 10),
      path: match[4] ?? '',
    });
  }
  return entries;
}

/** The authoritative conflict state: `MERGE_HEAD` plus non-empty `ls-files -u` (spike 3.2). */
export async function getConflictState(cwd: string, options?: CallTuning): Promise<ConflictState> {
  const inMerge = await isMergeInProgress(cwd, options);
  const result = await gitOrThrow(['ls-files', '-u', '-z'], { cwd, ...options });
  const entries = parseUnmergedEntries(result.stdout);
  const conflicted = [...new Set(entries.map((entry) => entry.path))].sort();
  return { inMerge, conflicted, entries, hasConflict: inMerge && conflicted.length > 0 };
}

/**
 * Parse `merge-tree --write-tree --name-only` output. Exit 0 prints just the tree OID; exit 1 prints
 * the tree OID, the conflicting paths, a blank line and then the human messages — all on stdout.
 */
export function parseMergeTreeOutput(stdout: string): {
  tree: string | null;
  conflicts: string[];
  messages: string[];
} {
  const lines = stdout.split('\n');
  const tree = (lines[0] ?? '').trim() === '' ? null : (lines[0] ?? '').trim();
  const conflicts: string[] = [];
  let index = 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      index += 1;
      break;
    }
    if (/^(CONFLICT|Auto-merging|error|warning|hint:)/.test(line)) break;
    conflicts.push(line);
  }
  const messages = lines
    .slice(index)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  return { tree, conflicts, messages };
}

/**
 * Predict whether merging `branchA` and `branchB` conflicts, without touching any worktree:
 * read-only, no `index.lock`, milliseconds. Exit `1` means "would conflict" and is a normal answer.
 */
export async function predictMerge(
  repoPath: string,
  branchA: string,
  branchB: string,
  options?: CallTuning,
): Promise<MergePrediction> {
  const result = await gitOrThrow(['merge-tree', '--write-tree', '--name-only', branchA, branchB], {
    cwd: repoPath,
    acceptCodes: [0, 1],
    ...options,
  });
  const parsed = parseMergeTreeOutput(result.stdout);
  return {
    clean: result.exitCode === 0,
    tree: parsed.tree,
    conflicts: parsed.conflicts,
    messages: parsed.messages,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * Merge `branch` into the worktree's checked-out branch with `--no-ff --no-edit`. A conflict is a
 * reported outcome (`outcome: 'conflict'`), never a thrown error, and never a stderr inspection.
 * Serialized per integration worktree.
 */
export async function mergeInto(
  worktreePath: string,
  branch: string,
  options?: MergeOptions,
): Promise<MergeResult> {
  const { message, noFf = true, lock, ...call } = options ?? {};
  return maybeLock(lock, 'integration', worktreePath, async () => {
    const result = await git(
      [
        'merge',
        ...(noFf ? ['--no-ff'] : []),
        '--no-edit',
        ...(message === undefined ? [] : ['-m', message]),
        branch,
      ],
      { cwd: worktreePath, acceptCodes: [0, 1, 128], ...call },
    );

    if (result.exitCode === 0) {
      return {
        outcome: /Already up to date/i.test(result.stdout) ? 'up-to-date' : 'merged',
        branch,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        conflict: null,
        head: await headSha(worktreePath, call),
      };
    }

    const conflict = await getConflictState(worktreePath, call);
    return {
      outcome: result.exitCode === 1 && conflict.hasConflict ? 'conflict' : 'failed',
      branch,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      conflict,
      head: await headSha(worktreePath, call),
    };
  });
}

/**
 * `merge --abort`. Exit `128` with "There is no merge to abort" simply means there was nothing to
 * abort: it is a safe, non-destructive no-op, so it is reported as `aborted: false`, not an error.
 * Serialized per integration worktree.
 */
export async function abortMerge(
  worktreePath: string,
  options?: MergeOptions,
): Promise<AbortMergeResult> {
  const { lock, ...call } = options ?? {};
  return maybeLock(lock, 'integration', worktreePath, async () => {
    const result = await gitOrThrow(['merge', '--abort'], {
      cwd: worktreePath,
      acceptCodes: [0, 128],
      ...call,
    });
    return {
      aborted: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      conflict: await getConflictState(worktreePath, call),
    };
  });
}
