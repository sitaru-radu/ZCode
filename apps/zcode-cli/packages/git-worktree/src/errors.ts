/**
 * Typed git failures.
 *
 * Every failure the package reports is a `GitError` carrying the raw evidence (`args`, `cwd`,
 * `exitCode`, `stdout`, `stderr`) plus a `kind` classified from git's verbatim message. Exit codes
 * alone are ambiguous (see spike report section 5.2: `1` is both "merge conflict" and "no merge in
 * progress", `255` and `128` are both `worktree add` failures), so classification uses text that was
 * actually observed on git 2.47.3.
 */

export type GitFailureKind =
  | 'unknown'
  | 'git-unavailable'
  | 'timeout'
  | 'aborted'
  | 'index-lock'
  | 'ref-lock'
  | 'locked-worktree'
  | 'dirty-worktree'
  | 'merge-in-progress'
  | 'no-merge-in-progress'
  | 'branch-in-use'
  | 'branch-exists'
  | 'path-exists'
  | 'not-a-worktree'
  | 'no-such-directory'
  | 'not-a-directory'
  | 'outside-repository';

/** Most specific pattern first: `index.lock` also mentions "another git process". */
const FAILURE_PATTERNS: readonly (readonly [GitFailureKind, RegExp])[] = [
  ['index-lock', /Unable to create '[^']*index\.lock'/],
  ['index-lock', /Another git process seems to be running/],
  ['ref-lock', /cannot lock ref '/],
  ['locked-worktree', /cannot remove a locked working tree/],
  ['dirty-worktree', /contains modified or untracked files/],
  ['branch-in-use', /is already used by worktree at/],
  ['branch-exists', /a branch named '[^']*' already exists/],
  ['path-exists', /'[^']*' already exists/],
  ['not-a-worktree', /is not a working tree/],
  ['no-merge-in-progress', /There is no merge (?:to abort|in progress)/],
  ['merge-in-progress', /You have not concluded your merge|Merging is not possible because you have unmerged files/],
  ['no-such-directory', /cannot change to '[^']*': No such file or directory/],
  ['not-a-directory', /cannot change to '[^']*': Not a directory/],
  ['outside-repository', /is outside repository/],
];

/**
 * Classify a git failure from its stderr. Never throws, always returns a kind; `unknown` means the
 * message was not in the spike's catalogue and the caller must inspect `stderr` itself.
 */
export function classifyGitFailure(stderr: string): GitFailureKind {
  for (const [kind, pattern] of FAILURE_PATTERNS) {
    if (pattern.test(stderr)) return kind;
  }
  return 'unknown';
}

export interface GitErrorDetails {
  /** Full argv including the pinned `-c` options and `-C <cwd>`. */
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
  readonly aborted?: boolean;
  readonly kind?: GitFailureKind;
  readonly message?: string;
  readonly cause?: unknown;
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}

function defaultMessage(details: GitErrorDetails): string {
  if (details.kind === 'git-unavailable') return 'git could not be executed';
  if (details.timedOut === true) return `git timed out: ${details.args.join(' ')}`;
  if (details.aborted === true) return `git was aborted: ${details.args.join(' ')}`;
  const detail = firstLine(details.stderr);
  const suffix = detail === '' ? '' : `: ${detail}`;
  return `git exited with code ${String(details.exitCode)}${suffix} (${details.args.join(' ')})`;
}

export class GitError extends Error {
  /** Full argv that was executed, including pinned options and `-C <cwd>`. */
  readonly args: readonly string[];
  readonly cwd: string;
  /** Process exit code, or `null` when git was killed by a signal, timed out or never started. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly kind: GitFailureKind;

  constructor(details: GitErrorDetails) {
    const kind =
      details.kind ??
      (details.timedOut === true
        ? 'timeout'
        : details.aborted === true
          ? 'aborted'
          : classifyGitFailure(details.stderr));
    super(details.message ?? defaultMessage({ ...details, kind }), {
      cause: details.cause,
    });
    this.name = 'GitError';
    this.args = details.args;
    this.cwd = details.cwd;
    this.exitCode = details.exitCode;
    this.stdout = details.stdout;
    this.stderr = details.stderr;
    this.timedOut = details.timedOut === true;
    this.aborted = details.aborted === true;
    this.kind = kind;
  }
}

export function isGitError(value: unknown): value is GitError {
  return value instanceof GitError;
}
