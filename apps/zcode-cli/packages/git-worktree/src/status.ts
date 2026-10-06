/**
 * Read-only facts about a working tree, parsed from `status --porcelain=v2 --branch -z`.
 *
 * Why v2 and why `-z` (spike report section 1.3, G4, G15):
 * - v1 C-quotes paths containing spaces (`?? "file with spaces.txt"`) and renders renames as
 *   `R  old -> new`, which a naive split mis-associates. v2 never quotes and states the XY code as
 *   two separate fields.
 * - `-z` removes the TAB/NUL ambiguity: a rename record (`2`) is split over two NUL fields, path
 *   first and `origPath` second. Verified against git 2.47.3.
 * - `status` exits `0` even for a dirty tree, so cleanliness is derived from the parsed entries and
 *   never from the exit code.
 */

import { gitOrThrow, type CallTuning } from './runner.js';

export type StatusKind = 'ordinary' | 'renamed' | 'unmerged' | 'untracked' | 'ignored';

export interface StatusEntry {
  readonly kind: StatusKind;
  /** Record type as emitted by git: `1`, `2`, `u`, `?`, `!`. */
  readonly code: string;
  /** Two-character XY code (`'.M'`, `'R.'`, `'UU'`); `'??'`/`'!!'` for untracked/ignored. */
  readonly xy: string;
  /** Current path (destination for renames). */
  readonly path: string;
  /** Source path for rename/copy records (`2`), otherwise `null`. */
  readonly origPath: string | null;
  readonly submodule: string | null;
  readonly headMode: string | null;
  readonly indexMode: string | null;
  readonly worktreeMode: string | null;
  readonly headSha: string | null;
  readonly indexSha: string | null;
  /** Unmerged records (`u`) carry stages 1/2/3 instead of a single blob. */
  readonly mergeShas: readonly string[];
  /** Rename/copy score (`'R100'` -> `'100'`), otherwise `null`. */
  readonly renameScore: string | null;
}

export interface StatusReport {
  /** Branch name, or `null` when HEAD is detached (git prints `(detached)`). */
  readonly branch: string | null;
  readonly detached: boolean;
  /** HEAD commit, or `null` on an unborn branch (git prints `(initial)`). */
  readonly oid: string | null;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly entries: readonly StatusEntry[];
  /** No ordinary/renamed/unmerged/untracked entry. Ignored files do not make a tree dirty. */
  readonly clean: boolean;
  /** Unique paths with unmerged (conflict) entries; empty means "no conflict in the index". */
  readonly conflicted: readonly string[];
}

const ORDINARY = /^1 ([^ ]{2}) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (.*)$/s;
const RENAMED = /^2 ([^ ]{2}) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (.*)$/s;
const UNMERGED = /^u ([^ ]{2}) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (.*)$/s;
const SCORE = /^([RC])(\d*)$/;

function ordinaryEntry(match: RegExpExecArray): StatusEntry {
  return {
    kind: 'ordinary',
    code: '1',
    xy: match[1] ?? '',
    path: match[8] ?? '',
    origPath: null,
    submodule: match[2] ?? null,
    headMode: match[3] ?? null,
    indexMode: match[4] ?? null,
    worktreeMode: match[5] ?? null,
    headSha: match[6] ?? null,
    indexSha: match[7] ?? null,
    mergeShas: [],
    renameScore: null,
  };
}

function renamedEntry(match: RegExpExecArray, origPath: string | null): StatusEntry {
  const score = SCORE.exec(match[8] ?? '');
  return {
    kind: 'renamed',
    code: '2',
    xy: match[1] ?? '',
    path: match[9] ?? '',
    origPath,
    submodule: match[2] ?? null,
    headMode: match[3] ?? null,
    indexMode: match[4] ?? null,
    worktreeMode: match[5] ?? null,
    headSha: match[6] ?? null,
    indexSha: match[7] ?? null,
    mergeShas: [],
    renameScore: score?.[2] === undefined || score[2] === '' ? null : score[2],
  };
}

function unmergedEntry(match: RegExpExecArray): StatusEntry {
  // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`: stages 1/2/3 replace the single
  // head/index pair, so `headMode`/`indexMode` are stages 1 and 2 here.
  const stage1 = match[7] ?? '';
  const stage2 = match[8] ?? '';
  const stage3 = match[9] ?? '';
  return {
    kind: 'unmerged',
    code: 'u',
    xy: match[1] ?? '',
    path: match[10] ?? '',
    origPath: null,
    submodule: match[2] ?? null,
    headMode: match[3] ?? null,
    indexMode: match[4] ?? null,
    worktreeMode: match[6] ?? null,
    headSha: stage1 === '' ? null : stage1,
    indexSha: stage2 === '' ? null : stage2,
    mergeShas: [stage1, stage2, stage3],
    renameScore: null,
  };
}

interface HeaderState {
  branch: string | null;
  detached: boolean;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

/** `# branch.oid`, `# branch.head`, `# branch.upstream`, `# branch.ab +N -M`. */
function applyHeaderLine(line: string, state: HeaderState): void {
  const [key, ...rest] = line.slice(1).trim().split(' ');
  const value = rest.join(' ');
  switch (key) {
    case 'branch.oid':
      state.oid = value === '(initial)' ? null : value;
      break;
    case 'branch.head':
      state.detached = value === '(detached)';
      state.branch = state.detached ? null : value;
      break;
    case 'branch.upstream':
      state.upstream = value === '' ? null : value;
      break;
    case 'branch.ab': {
      const [ahead, behind] = value.split(' ');
      state.ahead = Number.parseInt((ahead ?? '+0').replace('+', ''), 10) || 0;
      state.behind = Number.parseInt((behind ?? '-0').replace('-', ''), 10) || 0;
      break;
    }
    default:
      break;
  }
}

/** Parse the raw stdout of `status --porcelain=v2 --branch -z`. Pure, so it is directly testable. */
export function parseStatusV2(stdout: string): StatusReport {
  const header: HeaderState = {
    branch: null,
    detached: false,
    oid: null,
    upstream: null,
    ahead: 0,
    behind: 0,
  };
  const entries: StatusEntry[] = [];
  const fields = stdout.split('\0');

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined || field === '') continue;

    if (field.startsWith('#')) {
      for (const line of field.split('\n')) {
        if (line.startsWith('#')) applyHeaderLine(line, header);
      }
      continue;
    }
    if (field.startsWith('2 ')) {
      const match = RENAMED.exec(field);
      if (match !== null) {
        // A rename record spans two NUL fields: <path> then <origPath>.
        const next = fields[index + 1];
        entries.push(renamedEntry(match, next === undefined || next === '' ? null : next));
        index += 1;
      }
      continue;
    }
    if (field.startsWith('1 ')) {
      const match = ORDINARY.exec(field);
      if (match !== null) entries.push(ordinaryEntry(match));
      continue;
    }
    if (field.startsWith('u ')) {
      const match = UNMERGED.exec(field);
      if (match !== null) entries.push(unmergedEntry(match));
      continue;
    }
    if (field.startsWith('? ')) {
      entries.push({
        kind: 'untracked',
        code: '?',
        xy: '??',
        path: field.slice(2),
        origPath: null,
        submodule: null,
        headMode: null,
        indexMode: null,
        worktreeMode: null,
        headSha: null,
        indexSha: null,
        mergeShas: [],
        renameScore: null,
      });
      continue;
    }
    if (field.startsWith('! ')) {
      entries.push({
        kind: 'ignored',
        code: '!',
        xy: '!!',
        path: field.slice(2),
        origPath: null,
        submodule: null,
        headMode: null,
        indexMode: null,
        worktreeMode: null,
        headSha: null,
        indexSha: null,
        mergeShas: [],
        renameScore: null,
      });
    }
  }

  const conflicted = [
    ...new Set(entries.filter((entry) => entry.kind === 'unmerged').map((entry) => entry.path)),
  ].sort();

  return {
    branch: header.branch,
    detached: header.detached,
    oid: header.oid,
    upstream: header.upstream,
    ahead: header.ahead,
    behind: header.behind,
    entries,
    clean: entries.every((entry) => entry.kind === 'ignored'),
    conflicted,
  };
}

/** Full status of a worktree (or the main repository). Read-only: takes no lock. */
export async function getStatus(cwd: string, options?: CallTuning): Promise<StatusReport> {
  const result = await gitOrThrow(['status', '--porcelain=v2', '--branch', '-z'], { cwd, ...options });
  return parseStatusV2(result.stdout);
}

/**
 * `true` when the tree has any tracked, unmerged or untracked entry.
 * The exit code of `status` is always `0`, so only the output can answer this (G5).
 */
export async function hasUncommittedWork(cwd: string, options?: CallTuning): Promise<boolean> {
  const result = await gitOrThrow(['status', '--porcelain=v2', '-z'], { cwd, ...options });
  return result.stdout.length > 0;
}

/** Branch checked out in this worktree, or `null` for a detached HEAD. */
export async function currentBranch(cwd: string, options?: CallTuning): Promise<string | null> {
  const result = await gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    acceptCodes: [0, 128],
    ...options,
  });
  if (result.exitCode !== 0) return null;
  const name = result.stdout.trim();
  return name === '' || name === 'HEAD' ? null : name;
}

/** HEAD commit of this worktree, or `null` on an unborn branch / unresolvable HEAD. */
export async function headSha(cwd: string, options?: CallTuning): Promise<string | null> {
  const result = await gitOrThrow(['rev-parse', '-q', '--verify', 'HEAD'], {
    cwd,
    acceptCodes: [0, 1],
    ...options,
  });
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}
