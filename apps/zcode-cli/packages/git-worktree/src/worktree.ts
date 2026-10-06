/**
 * Worktree lifecycle: create, list, lock, move, repair, prune.
 *
 * Worktrees live OUTSIDE the repository tree. This is not a style preference: a worktree inside the
 * repo is not ignored (`?? inside-wt/`, `check-ignore` exit 1) and `git add -A` stages it as an
 * embedded git repository, corrupting the source index (spike G6, section 5.1). {@link addWorktree}
 * therefore refuses an in-repo target unless the caller explicitly opts in.
 *
 * Every function that mutates the shared registry takes the per-repository mutex, pass
 * `{ lock: false }` from inside an existing `withRepoLock` (the mutex is not reentrant).
 */

import { mkdir, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { maybeLock } from './mutex.js';
import { git, gitOrThrow, type CallTuning } from './runner.js';

export interface WorktreeInfo {
  /** Absolute path exactly as reported by git. */
  readonly path: string;
  readonly head: string | null;
  /** Short branch name (`refs/heads/` stripped), or `null` when detached. */
  readonly branch: string | null;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
  /** Free-form lock reason, `null` when unlocked or locked without a reason. */
  readonly lockedReason: string | null;
  readonly prunable: boolean;
  /** `gitdir file points to non-existent location` for a deleted directory. */
  readonly prunableReason: string | null;
  /**
   * The first record of `worktree list` is the main worktree (the user's checkout). It must never be
   * removed by the orchestrator, and {@link removeWorktree} refuses to.
   */
  readonly isMainWorktree: boolean;
}

export interface AddWorktreeSpec {
  /** Absolute target path. Must be outside the repository unless `allowInsideRepo` is set. */
  readonly path: string;
  /** New branch to create. Required unless `detach`. */
  readonly branch?: string;
  /** Commit-ish to start from. Defaults to git's own choice (current HEAD). */
  readonly baseRef?: string;
  /** Create a detached worktree instead of a branch. */
  readonly detach?: boolean;
  /**
   * Check out the EXISTING branch named `branch` instead of creating it (omits `-b`). Used to
   * re-attach a worktree to a task branch after a prune; fails with exit `128` when the branch is
   * already checked out in another worktree, and `baseRef` is not allowed with it.
   */
  readonly reuseBranch?: boolean;
  /** `--no-checkout`: files stay absent and status looks catastrophically dirty (G7). */
  readonly noCheckout?: boolean;
  /** `-q`: no progress output at all. Default `false` so stderr progress stays visible (G14). */
  readonly quiet?: boolean;
  /** Escape hatch for the G6 hazard. Default `false`. */
  readonly allowInsideRepo?: boolean;
}

export interface WorktreeCallOptions extends CallTuning {
  /** Set `false` only inside an existing `withRepoLock`. */
  readonly lock?: boolean;
}

export interface PruneOptions extends WorktreeCallOptions {
  /** `--dry-run --verbose`: report what would be pruned without touching the registry. */
  readonly dryRun?: boolean;
  /** `--expire <date>`: only prune entries older than this. */
  readonly expire?: string;
}

export interface PruneResult {
  readonly dryRun: boolean;
  readonly stdout: string;
  /** `prune --verbose` writes its `Removing worktrees/<id>: <reason>` lines to STDERR. */
  readonly stderr: string;
  /** Best-effort extraction of the pruned worktree ids from `stderr`. */
  readonly prunedIds: readonly string[];
}

const PRUNE_LINE = /^Removing (\S+): /gm;

/**
 * Parse `worktree list --porcelain`. Records are blank-line separated and 2-4 lines long; a
 * detached record has NO branch line, so lines are never indexed by position (spike 1.2).
 */
export function parseWorktreeList(stdout: string): WorktreeInfo[] {
  const records: WorktreeInfo[] = [];
  let current: {
    path?: string;
    head?: string | null;
    branch?: string | null;
    detached?: boolean;
    bare?: boolean;
    locked?: boolean;
    lockedReason?: string | null;
    prunable?: boolean;
    prunableReason?: string | null;
  } | null = null;

  const flush = (): void => {
    if (current?.path === undefined) {
      current = null;
      return;
    }
    records.push({
      path: current.path,
      head: current.head ?? null,
      branch: current.branch ?? null,
      detached: current.detached === true,
      bare: current.bare === true,
      locked: current.locked === true,
      lockedReason: current.lockedReason ?? null,
      prunable: current.prunable === true,
      prunableReason: current.prunableReason ?? null,
      isMainWorktree: records.length === 0,
    });
    current = null;
  };

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') {
      flush();
      continue;
    }
    const separator = line.indexOf(' ');
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1);
    if (key === 'worktree') {
      flush();
      current = { path: value };
      continue;
    }
    if (current === null) continue;
    switch (key) {
      case 'HEAD':
        current.head = value;
        break;
      case 'branch':
        current.branch = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value;
        break;
      case 'detached':
        current.detached = true;
        break;
      case 'bare':
        current.bare = true;
        break;
      case 'locked':
        current.locked = true;
        current.lockedReason = value === '' ? null : value;
        break;
      case 'prunable':
        current.prunable = true;
        current.prunableReason = value === '' ? null : value;
        break;
      default:
        break;
    }
  }
  flush();
  return records;
}

/** Same-path test that survives trailing separators and relative spellings. */
export function isSamePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/** All registered worktrees, main worktree first. Read-only: takes no lock. */
export async function listWorktrees(repoPath: string, options?: CallTuning): Promise<WorktreeInfo[]> {
  const result = await gitOrThrow(['worktree', 'list', '--porcelain'], { cwd: repoPath, ...options });
  return parseWorktreeList(result.stdout);
}

/** Registry entry for one path, or `null`. Read-only: takes no lock. */
export async function getWorktree(
  repoPath: string,
  worktreePath: string,
  options?: CallTuning,
): Promise<WorktreeInfo | null> {
  const worktrees = await listWorktrees(repoPath, options);
  return worktrees.find((worktree) => isSamePath(worktree.path, worktreePath)) ?? null;
}

/** Is the path a registered worktree of this repository? Read-only: takes no lock. */
export async function isRegistered(
  repoPath: string,
  worktreePath: string,
  options?: CallTuning,
): Promise<boolean> {
  return (await getWorktree(repoPath, worktreePath, options)) !== null;
}

/** Repository top level, used for the outside-the-repo guard (spike G6). */
async function repositoryTopLevel(repoPath: string, options?: CallTuning): Promise<string | null> {
  const result = await git(['rev-parse', '--show-toplevel'], { cwd: repoPath, acceptCodes: [0, 128], ...options });
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Create a worktree with a new branch (or detached) at an absolute path outside the repository.
 * Exit codes observed for the failures (spike 5): `128` path exists / branch already checked out,
 * `255` branch name already taken; both surface as a {@link GitError} with the raw output.
 */
export async function addWorktree(
  repoPath: string,
  spec: AddWorktreeSpec,
  options?: WorktreeCallOptions,
): Promise<WorktreeInfo> {
  const { lock, ...call } = options ?? {};
  const target = path.resolve(spec.path);

  if (!path.isAbsolute(spec.path)) {
    throw new TypeError(`addWorktree requires an absolute path, received '${spec.path}'`);
  }
  if (spec.detach === true && spec.branch !== undefined) {
    throw new TypeError('addWorktree: a detached worktree cannot create a branch');
  }
  if (spec.reuseBranch === true && spec.baseRef !== undefined) {
    throw new TypeError('addWorktree: `baseRef` cannot be combined with `reuseBranch`');
  }
  if (spec.detach !== true && (spec.branch === undefined || spec.branch === '')) {
    throw new TypeError('addWorktree: either `branch` or `detach: true` is required');
  }
  if (spec.detach === true && spec.reuseBranch === true) {
    throw new TypeError('addWorktree: `detach` and `reuseBranch` are mutually exclusive');
  }
  if (spec.allowInsideRepo !== true) {
    const topLevel = await repositoryTopLevel(repoPath, call);
    if (topLevel !== null && isInside(topLevel, target)) {
      throw new TypeError(
        `addWorktree refuses to create '${target}' inside the repository '${topLevel}': ` +
          'worktrees must live outside the repository tree (spike G6)',
      );
    }
  }

  return maybeLock(lock, 'repo', repoPath, async () => {
    // An existing EMPTY directory is accepted by git; a non-empty one fails with exit 128. Creating
    // the directory ourselves (including missing parents) keeps the failure modes identical, and the
    // directory is removed again if the add fails, so a failed add leaves no residue.
    const createdDirectory = !(await pathExists(target));
    if (createdDirectory) await mkdir(target, { recursive: true });
    // `reuseBranch` names the ref AFTER the path (`worktree add <path> <branch>`); otherwise the
    // optional commit-ish is the base ref.
    const commitish = spec.reuseBranch === true ? spec.branch : spec.baseRef;
    try {
      await gitOrThrow(
        [
          'worktree',
          'add',
          ...(spec.quiet === true ? ['-q'] : []),
          ...(spec.detach === true ? ['--detach'] : []),
          ...(spec.noCheckout === true ? ['--no-checkout'] : []),
          ...(spec.detach === true || spec.reuseBranch === true ? [] : ['-b', spec.branch ?? '']),
          target,
          ...(commitish === undefined ? [] : [commitish]),
        ],
        { cwd: repoPath, ...call },
      );
    } catch (error) {
      if (createdDirectory) {
        await rmdir(target).catch(() => undefined);
      }
      throw error;
    }
    const created = await getWorktree(repoPath, target, call);
    if (created === null) {
      throw new Error(`worktree add reported success but '${target}' is not registered`);
    }
    return created;
  });
}

/** Lock a worktree so that `remove` and `prune` leave it alone (`--reason` is recorded by git). */
export async function lockWorktree(
  repoPath: string,
  worktreePath: string,
  reason?: string,
  options?: WorktreeCallOptions,
): Promise<void> {
  const { lock, ...call } = options ?? {};
  await maybeLock(lock, 'repo', repoPath, async () => {
    await gitOrThrow(
      ['worktree', 'lock', ...(reason === undefined ? [] : ['--reason', reason]), path.resolve(worktreePath)],
      { cwd: repoPath, ...call },
    );
  });
}

/** Release a lock. Preferred over `remove -f -f` when this orchestrator took the lock itself. */
export async function unlockWorktree(
  repoPath: string,
  worktreePath: string,
  options?: WorktreeCallOptions,
): Promise<void> {
  const { lock, ...call } = options ?? {};
  await maybeLock(lock, 'repo', repoPath, async () => {
    await gitOrThrow(['worktree', 'unlock', path.resolve(worktreePath)], { cwd: repoPath, ...call });
  });
}

/** `worktree move <from> <to>`: the supported way to relocate a worktree (G12). */
export async function moveWorktree(
  repoPath: string,
  from: string,
  to: string,
  options?: WorktreeCallOptions,
): Promise<WorktreeInfo | null> {
  const { lock, ...call } = options ?? {};
  return maybeLock(lock, 'repo', repoPath, async () => {
    await gitOrThrow(['worktree', 'move', path.resolve(from), path.resolve(to)], { cwd: repoPath, ...call });
    return getWorktree(repoPath, to, call);
  });
}

/** `worktree repair`: fix the registration of a worktree that was moved by hand (G12). */
export async function repairWorktrees(targetPath: string, options?: CallTuning): Promise<string> {
  const result = await gitOrThrow(['worktree', 'repair'], { cwd: targetPath, ...options });
  return result.stderr + result.stdout;
}

/**
 * `worktree prune`: forget registry entries whose directory is gone. Safe for live worktrees —
 * `prune` never touched one, even with a back-dated gitdir mtime (G11). The branch survives.
 */
export async function pruneWorktrees(
  repoPath: string,
  options?: PruneOptions,
): Promise<PruneResult> {
  const { lock, dryRun = false, expire, ...call } = options ?? {};
  return maybeLock(lock, 'repo', repoPath, async () => {
    const result = await gitOrThrow(
      [
        'worktree',
        'prune',
        ...(dryRun ? ['--dry-run'] : []),
        // `--verbose` is always on: it is the only source of the `Removing <id>: <reason>` lines
        // (written to STDERR), and `prunedIds` is what tells the caller what actually happened.
        '--verbose',
        ...(expire === undefined ? [] : ['--expire', expire]),
      ],
      { cwd: repoPath, ...call },
    );
    return {
      dryRun,
      stdout: result.stdout,
      stderr: result.stderr,
      prunedIds: [...result.stderr.matchAll(PRUNE_LINE)].map((match) => match[1] ?? ''),
    };
  });
}
