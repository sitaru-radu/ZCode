# M1 evidence

Every claim below is a real run on the build host (netcup VM, Debian 13, Node v24.20.0), not a
projection. Fixture: `~/repos/zcode-projects-e2e/health-demo`, a small JSON service whose two route
modules (`src/routes/health.mjs`, `src/routes/metrics.mjs`) are stubs and whose two tests fail until
the mission implements them. The user's checkout is never written to.

## 1. Package verification

| Package | lint | typecheck | tests |
|---|---|---|---|
| `@zcode/projects-core` | 0 | 0 | 90 pass / 0 fail |
| `@zcode/git-worktree` | 0 | 0 | 54 pass / 0 fail |
| `@zcode/projects-store` | 0 | 0 | 40 pass / 0 fail |
| `@zcode/dsh-executor` | 0 | 0 | 68 tests: 67 pass, 1 skipped (live gate), 0 fail |
| `@zcode/projects-mission` | 0 | 0 | 207 pass / 0 fail |

`@zcode/dsh-executor` additionally passed its live acceptance
(`DSH_EXECUTOR_LIVE=1 node --import tsx --test tests/live.test.ts`, 24.8 s): a real `dsh --profile acp`
session created a file with exact bytes asserted on the host, a second long turn was cancelled
(`stopReason=cancelled`, zero updates after settlement), and the session closed cleanly.

## 2. End-to-end mission — happy path

Command (see the runbook for the full form):

```
node --import tsx scripts/demo.mts --repo ~/repos/zcode-projects-e2e/health-demo \
  --data /tmp/zcode-mission-data --workers 3 --model deepseek-v4-flash \
  --objective "Add a /health endpoint returning {status: ok} and a /metrics endpoint returning a numeric uptime, each with tests. Do not change existing route behaviour."
```

Outcome:

```json
{ "status": "completed", "phase": "complete", "blockReason": null, "elapsedSeconds": 53.4 }
```

Event order recorded by the mission (21 events, `projects.db`):

```
mission.created, mission.planned, tests.started, mission.started,
worktree.created(task-1), task.started(task-1), worktree.created(task-2), task.started(task-2),
worker.started(task-1), worker.started(task-2),                 <-- both sessions opened before either settled
worktree.committed(task-2), worktree.integrated(task-2), task.completed(task-2),
worktree.committed(task-1), worktree.integrated(task-1), task.completed(task-1),
tests.passed, mission.phase_changed, review.started, review.passed, mission.completed
```

Evidence for the individual acceptance criteria:

| # | Criterion | Evidence |
|---|---|---|
| 1 | Create a project | `prj_…` row + `mission.created` event |
| 2 | Mission from natural language | the objective above produced plan v1 with 2 tasks |
| 3 | Persisted plan | `mission_plans` row v1 (`tests.started` follows) |
| 4 | Plan decomposed into tasks | `implement-health-route`, `implement-metrics-route` |
| 5 | Deterministic readiness | both tasks runnable ⇒ dispatched in one wave |
| 6 | DSH executes tasks | two ACP sessions, one per task, in their own worktrees |
| 7 | Isolated worktrees | `…/msn_…/task-1-…`, `task-2-…` plus `integration`, branches `zcode/mission-…/task-N` |
| 8 | Two tasks concurrently | both `worker.started` events precede every `worktree.committed` |
| 10 | Inspectable diff | `git diff main zcode/mission-…/integration` → `src/routes/health.mjs`, `src/routes/metrics.mjs` |
| 11 | Real repository commands | validations `npm run lint` (exit 0) and `npm run test` (exit 0), discovered from `package.json` |
| 12 | Independent review | `review.started` → `review.passed` at the integration commit |
| 15 | Mission reaches COMPLETE | `status: completed`, `phase: complete` |
| 17 | User working tree untouched | `git status --porcelain` in the clone → **0 lines** |
| 18 | DSH behind the adapter | only `dsh-executor` and `workflow-driver.ts` know DSH; no other package imports it |

Each task's commit contains exactly its own file:

```
task implement-health-route  → src/routes/health.mjs   (commit 05ead49e…)
task implement-metrics-route → src/routes/metrics.mjs  (commit 840e3c3a…)
```

## 3. Negative scenario — a failing mandatory validation blocks completion (criterion 14)

Same mission, but the validation command set is overridden with one that always fails:

```
… --validation false
```

Outcome:

```json
{ "status": "blocked", "blockReason": "1 validation(s) failed: \"false\" (exit 1)" }
```

with the persisted row `{ "command": "false", "exitCode": 1, "result": "fail" }`. Tasks stay `done`;
the mission does **not** complete. The gate, not the model, decided this.

## 4. Restart recovery (criterion 16)

`scripts/recover.mts` opens an existing data directory in a **fresh process**:

* completed mission ⇒ `statusBefore: completed`, `statusAfter: completed`, reconciliation `[]`
  (terminal missions are never touched, the result survives the restart);
* the blocked mission from §3 ⇒ reconciliation reports
  `{ "state": "interrupted", "detail": "no executor session is alive for this mission" }` and the
  mission **stays blocked** — it is never silently completed.

## 5. What is *not* demonstrated

* **Criterion 9 (activity visible in ZCode) and the Projects/Mission screens** are M2 work; M1 is
  headless by design. The read API the UI will call already exists (`getStatus`, `getTasks`,
  `getWorkers`, `getEvents`, `getValidations`, `getReviews`, `getResult`).
* **Criterion 13 (a failed review spawning remediation)** is covered by module tests
  (`remediationTasksFor`, `assessCompletion`, 20 tests) and by the runner's bounded review loop, but
  no live run has produced a real model `FAIL` verdict — forcing one deterministically needs a
  scripted reviewer, which is on the roadmap. Treat it as designed-and-unit-tested, not yet
  demonstrated end to end.
* **Retries**: `maxTaskAttempts` is recorded, but the current loop reports a failed task to the gate
  instead of re-dispatching it; a second run of the same mission is the manual equivalent. On the
  roadmap.
* **The run journal is in-memory** (`InMemoryJournalStore`): mission truth survives a restart,
  mid-flight run replay does not. On the roadmap.
