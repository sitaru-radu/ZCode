# @zcode/git-worktree — contract

Everything git-related the mission layer needs, in one package: **no other package shells out to
git.** The behaviour below is derived from `specs/projects/` and from the measurement report
`git-worktree-spike.md` (git 2.47.3, Debian 13); where the report records an exact message or exit
code, this package reproduces it and the tests assert it.

## 1. Invariants

| # | Invariant | Why |
|---|-----------|-----|
| I1 | `-C <path>` only, never `--git-dir`/`--work-tree`; `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`, `GIT_NAMESPACE`, `GIT_PREFIX`, `GIT_CEILING_DIRECTORIES` are scrubbed from the child environment | `--git-dir` without `--work-tree` silently makes git treat the process cwd as the working tree and report bogus deletions (spike G3) |
| I2 | Every invocation is pinned `-c core.hooksPath=/dev/null -c core.pager=cat`, with `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo`, `GIT_CONFIG_NOSYSTEM=1`, `LC_ALL=C` | agents must not run repo hooks; no pager; no hanging credential prompt; stable messages. Config is never written with `git config`, which inside a worktree writes the SHARED config (G8) |
| I3 | Exit code is the only failure signal; stderr is diagnostics. `worktree add` prints progress on stderr, `core.autocrlf` warns on stderr of successful commands (G14) | classifying by stderr text breaks on success |
| I4 | Every call has a timeout (default 60 s) and kills the whole process group | a killed git can leave `index.lock`; a hung orchestrator is worse |
| I5 | Worktrees live outside the repository. `addWorktree` refuses an in-repo target unless `allowInsideRepo: true` | an in-repo worktree is not ignored (`?? inside-wt/`) and `git add -A` stages it as an embedded git repository (G6) |
| I6 | One writer per worktree, one integration at a time per integration worktree | same-worktree writers produced 43 `index.lock` failures in 120 commits; separate worktrees produced 0 in 150 |
| I7 | Removal never escalates to `--force`, and never deletes a branch | `--force` destroys uncommitted work with no recovery path; a removed-but-unmerged worktree is only recoverable through its branch (G10) |
| I8 | Conflict means `MERGE_HEAD exists AND ls-files -u is non-empty` | a dirty status is ambiguous (conflict vs `merge --no-commit`) and a clean status says nothing about unmerged commits (G2) |
| I9 | Read-only facts never lock, never write, never touch a worktree | `status`/`diff`/`log`/`merge-tree` are safe to run wide |

## 2. Public API

### Core runner (`runner.ts`)

| Function | Contract |
|----------|----------|
| `git(args, { cwd, timeoutMs?, input?, acceptCodes?, signal?, env? })` | The single spawn choke point. Resolves for **any** exit code with `{ argv, cwd, exitCode, stdout, stderr, timedOut, aborted, durationMs }`. Rejects with `GitError` only when git could not be started. |
| `gitOrThrow(args, options)` | Same, but throws `GitError` unless the exit code is in `acceptCodes` (default `[0]`). Timeout/abort/signal-kill always throw. |
| `buildGitArgv(args, cwd)` / `buildGitEnv(extra?)` | Pure builders, exported so the pinned argv/env are assertable. |
| `GitError` | `{ args, cwd, exitCode: number \| null, stdout, stderr, timedOut, aborted, kind }`; `kind` is classified from the verbatim message (`classifyGitFailure`). |
| `classifyGitFailure(stderr)` | `index-lock`, `ref-lock`, `locked-worktree`, `dirty-worktree`, `merge-in-progress`, `no-merge-in-progress`, `branch-in-use`, `branch-exists`, `path-exists`, `not-a-worktree`, `no-such-directory`, `not-a-directory`, `outside-repository`, `unknown`. |

### Worktree lifecycle (`worktree.ts`) — per-repository mutex

`addWorktree(repo, { path, branch?, baseRef?, detach?, noCheckout?, reuseBranch?, quiet?, allowInsideRepo? })`
→ `WorktreeInfo`. Observed failures: `128` path exists, `128` branch already checked out elsewhere
(`reuseBranch`), `255` branch name already taken. A failed add removes the directory it created.
`reuseBranch: true` checks out the existing branch named `branch` (no `-b`, re-attaches a pruned
task branch); `baseRef` is rejected with it.

`listWorktrees(repo)` → `WorktreeInfo[]`; `getWorktree(repo, path)`; `isRegistered(repo, path)`;
`lockWorktree(repo, path, reason?)`; `unlockWorktree(repo, path)`; `moveWorktree(repo, from, to)`;
`repairWorktrees(path)`; `pruneWorktrees(repo, { dryRun?, expire? })` → `{ dryRun, stdout, stderr, prunedIds }`.

`WorktreeInfo` is parsed from `worktree list --porcelain` **by key**, never by line position:
records are 2–4 lines, a detached record has no `branch` line, `locked`/`prunable` carry free-form
reasons. `isMainWorktree` marks the first record (the user's checkout); removal refuses to touch it.
`prune` always runs with `--verbose`, because its `Removing <id>: <reason>` lines (written to
**stderr**) are the only source of `prunedIds`.

### Read-only facts (`status.ts`, `diff.ts`) — no lock

| Function | Command | Notes |
|----------|---------|-------|
| `getStatus(cwd)` | `status --porcelain=v2 --branch -z` | `{ branch, detached, oid, upstream, ahead, behind, entries, clean, conflicted }`. v2 + `-z` because v1 C-quotes paths and mangles renames; a rename record spans **two** NUL fields (path, then `origPath`). |
| `hasUncommittedWork(cwd)` | `status --porcelain=v2 -z` | Output-based: `status` always exits `0`. |
| `changedFiles(cwd, base, ref)` | `diff --name-status -z base...ref` | **Three dots** (merge base): stays correct after the base branch moves. For `R`/`C`, `origPath` is the source and `path` the destination. |
| `diffStat` / `diffPatch` | `diff --stat` / `diff` on `base...ref` | |
| `listCommits(cwd, base, ref, { reverse? })` | `log -z --format=%H\x1f%h\x1f%an\x1f%aI\x1f%s base..ref` | **Two dots**: commits reachable from `ref` but not `base`. Newest first. |
| `commitsAhead` / `aheadBehind` / `mergeBase` | `rev-list --count`, `rev-list --left-right --count`, `merge-base` | `aheadBehind` returns `{ behind, ahead }` in that order (left = behind). |
| `currentBranch` / `headSha` | `rev-parse --abbrev-ref HEAD` / `rev-parse -q --verify HEAD` | `null` for detached HEAD and unborn branches; exit `1` is a normal negative answer. |

### Pre-flight and integration (`integration.ts`) — per-integration-worktree mutex

| Function | Contract |
|----------|----------|
| `predictMerge(repo, branchA, branchB)` | `merge-tree --write-tree --name-only`. Read-only, no worktree, no lock. Exit `0` = clean (stdout is just the tree OID), exit `1` = conflict: tree OID, conflicting paths, blank line, then human `CONFLICT (…)` lines — all on **stdout**. Use it to order work: merge conflict-free branches first. |
| `mergeInto(worktree, branch, { message?, noFf = true })` | `merge --no-ff --no-edit -m <message> <branch>`. Never throws for a conflict: outcome is `merged` \| `up-to-date` \| `conflict` \| `failed`, plus `conflict: ConflictState \| null`. A conflict is `exit 1` with `MERGE_HEAD` + non-empty `ls-files -u`; a failure is not a conflict. |
| `getConflictState(cwd)` | `{ inMerge, conflicted, entries (stage 1/2/3), hasConflict }`; `hasConflict = inMerge && conflicted.length > 0`. |
| `abortMerge(worktree)` | `merge --abort`. Exit `128` with "There is no merge to abort" is a safe no-op → `aborted: false`, not an error. Leaves no `MERGE_HEAD`/`MERGE_MSG`/`.orig` residue. |

### Removal (`removal.ts`) — per-repository mutex

`removeWorktree(repo, path, { force?, forceTwice?, unlockIfLocked?, baseRef?, branch? })`
→ `RemoveWorktreeReport { removed, mode, path, branch, unmergedCommits, residue, refusal, pruned, steps }`
(types in `removal-report.ts`). `forceTwice` implies `force`.

The **mandatory guard sequence** (any failing step refuses; `force` skips only the merge and dirty
checks, and only when the caller asks for it explicitly):

1. Directory exists? Missing → deregister if registered, then `worktree prune`.
2. Registered worktree of *this* repository? No → refuse `not-registered` (git: exit 128, "is not a working tree").
3. Main worktree? Yes → refuse `main-worktree` (never remove the user's checkout).
4. Locked? Yes → refuse `locked` (with the reason). `unlockIfLocked: true` unlocks first; `-f -f` only with `forceTwice`.
5. `MERGE_HEAD` present? Yes → refuse `merge-in-progress`; run `abortMerge` first. *(Checked before the dirty check so the refusal names the real reason instead of an ambiguous dirty status — see §5.)*
6. Uncommitted work? Yes → refuse `dirty` (lists the paths). Never auto-escalate to `--force`.
7. `worktree remove [-f|-f -f] <path>`; non-zero → refuse `remove-failed` with the raw output. **No escalation.**
8. Registry must no longer contain the path (prune + re-check; else refuse `still-registered`).
9. `worktree prune` (idempotent, also cleans a deleted-directory entry).
10. Residue check: a directory git left behind is reported as `residue`, never deleted by force.

`branch` and `unmergedCommits` (from `rev-list --count <baseRef>..<branch>`) are recorded on **every**
report, including refusals, so a removed-but-unmerged worktree stays recoverable via `git log <branch>`.
Deleting the branch is deliberately not part of this package.

## 3. Concurrency rules

* **Per-repository mutex** (`withRepoLock`, exported as `repoMutex`) serializes `addWorktree`,
  `removeWorktree`, `pruneWorktrees`, `lockWorktree`, `unlockWorktree`, `moveWorktree`, because they
  mutate the shared `.git/worktrees/` registry and `refs/heads/`.
* **Per-integration-worktree mutex** (`withIntegrationLock`, `integrationMutex`) serializes
  `mergeInto` and `abortMerge`, so task branches integrate in dependency order.
* Every mutating function takes its lock by default. Pass `{ lock: false }` **only** from inside an
  already-held lock: the mutex is **not reentrant**, so nesting deadlocks. Compose like this:

  ```ts
  await withRepoLock(repo, async () => {
    await addWorktree(repo, spec, { lock: false });
    await removeWorktree(repo, other, { lock: false });
  });
  ```
* **Boundary:** this is an in-process mutex. It does not coordinate other processes, other machines
  or a human running git by hand. What makes that safe is the measurement in I6: distinct worktrees
  own distinct `index`/`HEAD` files, so the only rule the caller must uphold across processes is
  **one writer per worktree** — never share a worktree between two workers.
* Worker-side `git add`/`git commit` are intentionally **not** wrapped here: the worker owns its
  worktree index, and a second write path in this package would duplicate ownership. The `git`
  runner is exported for exactly that case (a worker's own shell may also just run git).
* After a `SIGKILL`, `index.lock` can survive. Recovery is manual by design (this package cannot
  prove no git process is alive): `rm -f "$(git -C <wt> rev-parse --git-path index.lock)"` and the
  same for `HEAD.lock`, only when no git for that worktree is running.

## 4. Exit codes seen in practice

| Code | Meaning | Retryable |
|------|---------|-----------|
| `0` | success (also `status` on a dirty tree, `diff --name-status` with changes) | — |
| `1` | "not clean" answer: merge conflict, `merge-tree` conflict prediction, `rev-parse -q --verify` not found, `--ff-only` refusal | depends |
| `128` | fatal: dirty worktree on remove, path exists, branch in use, locked, missing dir, not a working tree, `merge --abort` with nothing to abort | no |
| `255` | `worktree add -b <name>` when the branch name already exists | no |

## 5. Deviations and limits (explicit)

* **Guard steps 5/6 are swapped** relative to the spike's numbering (merge before dirty): both
  refuse, but the merge check gives the precise reason. Nothing is weakened.
* **Not implemented:** `git gc`/`git prune` (spike 2.4 requires a global lock *and* no active
  workers — that is an operator action, not an orchestrator call); automatic stale-`index.lock`
  removal (cannot be proven safe in-process); `--unshallow`/deepening for shallow clones (no network
  operations in this package — a shallow mission repo degrades `merge-base`/`merge-tree`, G13);
  per-worktree config via `extensions.worktreeConfig` (config is pinned per call instead, I2);
  branch deletion (deliberately out of scope, I7).
* `advice.detachedHead=false` and `core.autocrlf=false` from the spike's sample invocation (§7.1) are
  not pinned: advice text is stderr noise that I3 already ignores, and forcing `autocrlf` would
  override a repository's legitimate line-ending policy.
* `worktree add` in git 2.47.3 prints `HEAD is now at …` on **stdout** and `Preparing worktree …` on
  **stderr** (the report shows both on stderr). Tests assert the observed split, not the report's.
