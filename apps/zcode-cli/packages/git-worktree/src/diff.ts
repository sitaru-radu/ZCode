/**
 * Read-only diff and history facts. Nothing here writes, locks or needs a mutex.
 *
 * Three-dot vs two-dot is not cosmetic (spike report section 1.4): `${base}...${ref}` diffs against
 * the merge base, so "what did this worker change" stays correct after the base branch moves, while
 * `..` compares the two tips directly and reports the base branch's own newer commits as reversions.
 * `changedFiles` is therefore three-dot, and `listCommits` is deliberately two-dot ("commits this
 * branch has that the base does not").
 */

import { gitOrThrow, type CallTuning } from './runner.js';

export type ChangeKind =
  | 'added'
  | 'copied'
  | 'deleted'
  | 'modified'
  | 'renamed'
  | 'type-changed'
  | 'unmerged'
  | 'unknown'
  | 'broken';

export interface ChangedFile {
  /** Raw status token, e.g. `'M'`, `'A'`, `'R100'`. */
  readonly status: string;
  readonly kind: ChangeKind;
  /** Rename/copy score digits (`'100'`), otherwise `null`. */
  readonly score: string | null;
  /** Destination path: what the branch has now. */
  readonly path: string;
  /** Source path for renames/copies, otherwise `null`. */
  readonly origPath: string | null;
}

export interface CommitInfo {
  readonly sha: string;
  readonly shortSha: string;
  readonly author: string;
  /** Author date, strict ISO 8601 (`%aI`). */
  readonly authoredAt: string;
  readonly subject: string;
}

export interface DiffOptions extends CallTuning {
  /** Extra `--diff-filter` value, e.g. `'U'` for unmerged paths only. */
  readonly diffFilter?: string;
}

export interface CommitListOptions extends CallTuning {
  /** `--reverse`: oldest first. Default is git's order (newest first). */
  readonly reverse?: boolean;
}

const CHANGE_KINDS: Readonly<Record<string, ChangeKind>> = {
  A: 'added',
  C: 'copied',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
  T: 'type-changed',
  U: 'unmerged',
  X: 'unknown',
  B: 'broken',
};

const STATUS_TOKEN = /^([A-Z])(\d*)$/;
const COMMIT_FIELD_SEPARATOR = '\u001f';
const COMMIT_FORMAT = `%H${COMMIT_FIELD_SEPARATOR}%h${COMMIT_FIELD_SEPARATOR}%an${COMMIT_FIELD_SEPARATOR}%aI${COMMIT_FIELD_SEPARATOR}%s`;

/** `base...ref`: diff against the merge base, the only correct "what did the worker change". */
export function threeDotRange(baseRef: string, ref: string): string {
  return `${baseRef}...${ref}`;
}

/** `base..ref`: commits reachable from `ref` but not from `baseRef`. */
export function twoDotRange(baseRef: string, ref: string): string {
  return `${baseRef}..${ref}`;
}

/**
 * Parse `diff --name-status -z`. Verified shape on git 2.47.3:
 * `M\0a.txt\0D\0b.txt\0R100\0src/one.txt\0renamed.txt\0` — for renames/copies the source comes
 * first, then the destination.
 */
export function parseNameStatusZ(stdout: string): ChangedFile[] {
  const tokens = stdout.split('\0').filter((token) => token !== '');
  const files: ChangedFile[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    const match = STATUS_TOKEN.exec(token);
    if (match === null) continue;
    const letter = match[1] ?? '';
    const kind = CHANGE_KINDS[letter] ?? 'unknown';
    const score = match[2] === undefined || match[2] === '' ? null : match[2];
    if (kind === 'renamed' || kind === 'copied') {
      const origPath = tokens[index + 1] ?? '';
      const path = tokens[index + 2] ?? '';
      files.push({ status: token, kind, score, path, origPath });
      index += 2;
      continue;
    }
    files.push({ status: token, kind, score, path: tokens[index + 1] ?? '', origPath: null });
    index += 1;
  }
  return files;
}

/** Files the ref changed relative to the merge base with `baseRef` (three-dot). */
export async function changedFiles(
  cwd: string,
  baseRef: string,
  ref: string,
  options?: DiffOptions,
): Promise<ChangedFile[]> {
  const { diffFilter, ...call } = options ?? {};
  const result = await gitOrThrow(
    [
      'diff',
      '--name-status',
      '-z',
      ...(diffFilter === undefined ? [] : [`--diff-filter=${diffFilter}`]),
      threeDotRange(baseRef, ref),
    ],
    { cwd, ...call },
  );
  return parseNameStatusZ(result.stdout);
}

/** `diff --stat` for the three-dot range, returned verbatim (human-facing summary). */
export async function diffStat(
  cwd: string,
  baseRef: string,
  ref: string,
  options?: DiffOptions,
): Promise<string> {
  const { diffFilter, ...call } = options ?? {};
  const result = await gitOrThrow(
    [
      'diff',
      '--stat',
      ...(diffFilter === undefined ? [] : [`--diff-filter=${diffFilter}`]),
      threeDotRange(baseRef, ref),
    ],
    { cwd, ...call },
  );
  return result.stdout;
}

/** Full unified patch for the three-dot range. */
export async function diffPatch(
  cwd: string,
  baseRef: string,
  ref: string,
  options?: DiffOptions,
): Promise<string> {
  const { diffFilter, ...call } = options ?? {};
  const result = await gitOrThrow(
    ['diff', ...(diffFilter === undefined ? [] : [`--diff-filter=${diffFilter}`]), threeDotRange(baseRef, ref)],
    { cwd, ...call },
  );
  return result.stdout;
}

/** Commits in `baseRef..ref` (two-dot), newest first unless `reverse` is set. */
export async function listCommits(
  cwd: string,
  baseRef: string,
  ref: string,
  options?: CommitListOptions,
): Promise<CommitInfo[]> {
  const { reverse, ...call } = options ?? {};
  const result = await gitOrThrow(
    ['log', '-z', `--format=${COMMIT_FORMAT}`, ...(reverse === true ? ['--reverse'] : []), twoDotRange(baseRef, ref)],
    { cwd, ...call },
  );
  return result.stdout
    .split('\0')
    .filter((record) => record !== '')
    .map((record) => {
      const [sha = '', shortSha = '', author = '', authoredAt = '', ...subject] = record.split(COMMIT_FIELD_SEPARATOR);
      return { sha, shortSha, author, authoredAt, subject: subject.join(COMMIT_FIELD_SEPARATOR) };
    });
}

/** Number of commits reachable from `ref` but not from `baseRef` (two-dot). */
export async function commitsAhead(
  cwd: string,
  baseRef: string,
  ref: string,
  options?: CallTuning,
): Promise<number> {
  const result = await gitOrThrow(['rev-list', '--count', twoDotRange(baseRef, ref)], { cwd, ...options });
  return Number.parseInt(result.stdout.trim(), 10);
}

/** `rev-list --left-right --count base...ref`: left is `behind`, right is `ahead`. */
export async function aheadBehind(
  cwd: string,
  baseRef: string,
  ref: string,
  options?: CallTuning,
): Promise<{ behind: number; ahead: number }> {
  const result = await gitOrThrow(['rev-list', '--left-right', '--count', threeDotRange(baseRef, ref)], {
    cwd,
    ...options,
  });
  const [behind = '', ahead = ''] = result.stdout.trim().split(/\s+/);
  return { behind: Number.parseInt(behind, 10) || 0, ahead: Number.parseInt(ahead, 10) || 0 };
}

/** Merge base of two refs. Fails (exit 1) when the histories are unrelated, e.g. in a shallow clone. */
export async function mergeBase(cwd: string, refA: string, refB: string, options?: CallTuning): Promise<string> {
  const result = await gitOrThrow(['merge-base', refA, refB], { cwd, ...options });
  return result.stdout.trim();
}
