# @zcode/git-worktree

Owns every git interaction needed to run isolated parallel workers: worktree/branch lifecycle,
read-only facts (status/diff/log), conflict pre-flight and integration, and safety-guarded removal.
No other package shells out to git.

* Public API, guard sequence, concurrency rules and invariants: [CONTRACT.md](./CONTRACT.md)
* Specification: `specs/projects/` and the measurement report `git-worktree-spike.md` (repository root)
* Tests are real-git integration tests on a scratch repository under the OS temp dir:
  `pnpm --filter @zcode/git-worktree test`

```ts
import { addWorktree, getStatus, predictMerge, mergeInto, removeWorktree } from '@zcode/git-worktree';

const worktree = await addWorktree(repo, { path: outsidePath, branch, baseRef });
const prediction = await predictMerge(repo, branch, integrationBranch); // order work by conflict-freedom
const merge = await mergeInto(integrationWorktree, branch, { message: `${taskId}: ${subject}` });
const removal = await removeWorktree(repo, worktree.path, { baseRef }); // refuses on uncommitted work
```
