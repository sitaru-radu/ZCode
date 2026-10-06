# Projects — mission runner

Status: draft (Phase 0). Package: `@zcode/projects-mission`.

The runner is the only component allowed to mutate mission state. It owns exactly one live mission
execution per mission id, composes the other packages, and never asks a model for facts that git or
the filesystem can answer.

## 1. Responsibilities

1. Turn a persisted mission into an executable workflow run (plan → compile → submit).
2. Materialize tasks deterministically from the accepted plan.
3. Dispatch ready tasks to DSH workers, each in its own git worktree, within a worker cap.
4. Collect deterministic facts after each worker turn: git status/diff/commits, then commit.
5. Integrate task branches into the mission branch in dependency order; detect conflicts.
6. Run repository-defined validation commands in the integration worktree.
7. Run an independent review session; turn FAIL findings into remediation tasks (bounded).
8. Evaluate the completion gate and persist the final result.
9. Reconcile state after a restart; never fabricate completion.
10. Append normalized mission events for every state change.

## 2. Flow (owners in brackets)

```
createMission (human/API)                       [runner]
  └── planMission: read repo instructions, build MissionPlan via planner session   [runner + dsh-executor]
        ├── validatePlan (deterministic)         [projects-core]
        └── persist plan version                 [projects-store]
  └── materializeTasks (deterministic ids)       [projects-core + projects-store]
startMission
  └── create worktrees: integration + per task   [git-worktree]
  └── create workflow run with the compiled script [runner + dynamic-workflow entry point]
execute (loop, bounded)
  ├── readyTasks → selectDispatch(maxWorkers)     [projects-core]
  ├── per task: create worktree+branch, create DSH session (cwd=worktree), prompt the brief
  ├── on turn end: git status/diff/commits, commit, update task → review
  ├── integrate task branch into mission branch (dependency order, predictMerge first)
  └── on failure: retry up to maxTaskAttempts, else task failed → mission blocked
review
  ├── detectreviewer session in a detached worktree at the integrated commit (read-only)
  ├── PASS → testing;  FAIL → remediation tasks (bounded by maxReviewRounds)
testing
  ├── run discovered validation commands in the integration worktree
  └── all mandatory pass → gate
gate
  └── evaluateCompletion → completed (persist result) | remediation | blocked
```

## 3. Execution substrate (consequences of D10–D12)

- The runner creates **one** workflow run per mission through the engine harness:
  `runWorkflowScript({ askSpecs, caps, cwd: repositoryPath, lowered, makeDriver, runId, validate, timeoutMs })`
  — the same call shape the in-tree snippet service already uses
  (`dynamic-workflow-snippet-service.ts:129-149`).
- The script is **generated deterministically** by the runner (never authored by the model at run time):
  one `agent("task-<key>", persona)` per plan task, `await` chains that express the dependency graph,
  `phase()` markers for `execute`/`review`/`test`, `world.run` for validation commands, and a final
  `return` carrying the mission report (per-task outcome plus validation results).
- Each task ask is wrapped in `try/catch`, so a failing task fails **its node**, not the whole run; the
  script returns a structured report in both cases.
- `makeDriver` returns `createDshWorkflowDriver(deps)`, where deps carry: the executor adapter, the run
  cwd (repository root), the world cwd (integration worktree), a `prepareTaskEnvironment(taskKey)` port
  implemented by the runner, and the `onAskSettled` / `onAskFailed` callbacks.
- `prepareTaskEnvironment` is where per-task git isolation is enforced: it ensures the task's
  dependencies are integrated into the mission branch, creates the worktree from that branch, records
  the worker row, and returns `{ worktreePath, branch }`. The driver passes `worktreePath` as the DSH
  session `cwd`.
- Actor→task mapping is carried by the deterministic actor name (`task-<key>`) emitted by the
  generator, so no engine change is needed to route sessions.
- Because the engine creates an actor session lazily at that task's first dispatch, ordering is
  automatic: a dependent task's worktree can only be created after its dependencies were integrated.
- `world.run` executes with the driver's world cwd (the integration worktree); the runner persists
  every command result as a `validations` row as soon as the run settles.

## 4. Worker brief (the only context a worker receives)

Workers never see the mission log, other tasks, or the plan as a whole. The brief is built
deterministically and must fit these sections:

1. Mission objective (one paragraph).
2. This task: title, description, acceptance criteria, file hints.
3. Repository instructions: the contents of `AGENTS.md`/`CONTRIBUTING.md` when present (truncated to a
   configured cap) — never the whole repository.
4. Working rules: work only inside your worktree; run the task's validation commands; commit nothing
   yourself (the runner commits); when done, submit a result through the provided tool.
5. Result contract: the exact JSON schema for the typed result.

The result contract is submitted through a `submit_result` tool when the executor can attach one;
otherwise the runner parses a single fenced ```json block from the final message. Both paths are
validated against the same schema by `projects-core` (repair/nudge stays deterministic).

## 5. Task result schema (typed ask payload)

```json
{
  "status": "done" | "blocked",
  "summary": "one paragraph a human can read",
  "filesChanged": ["relative/path"],
  "acceptance": [{ "criterion": "…", "met": true, "evidence": "command or file" }],
  "validationCommands": ["npm test -- --runInBand"],
  "blockers": ["…"]
}
```

`filesChanged` is advisory only: the runner replaces it with git facts before persisting.

## 6. Validation command discovery (deterministic, in order)

1. Explicit per-project override in the mission configuration.
2. `package.json` scripts, in a fixed priority: `typecheck`, `lint`, `test`, `build` — only those that
   exist; run with the repository's package manager detected from the lockfile.
3. A `Makefile` target named `check`, `test` or `ci` when no package.json script matches.
4. CI configuration (`.github/workflows/*.yml`) when it names an unambiguous command for the default branch.
5. Otherwise: no automatic command, and the mission is `blocked` with the reason "no validation commands
   discovered" — never a silent pass.

Every executed command is persisted as a `validations` row with `command`, `exitCode`, `durationMs`,
`result`, and the `commitSha` it ran against. Mandatory = the discovered set; a mandatory failure is a
blocker.

## 7. Review protocol

- The reviewer runs in a separate session on a detached worktree checked out at the integrated commit.
- It must not modify code: after the session the runner asserts the reviewer worktree is clean
  (`git status --porcelain` empty) and that the reviewed commit is unchanged; a violation invalidates
  the review instead of producing a verdict.
- Output schema:

```json
{
  "verdict": "pass" | "fail",
  "findings": [
    { "severity": "blocking" | "advisory", "title": "…", "detail": "…",
      "file": "path", "line": 12, "requirement": "which objective/acceptance item" }
  ]
}
```

- `fail` → one remediation task per blocking finding, each depending on the reviewed tasks
  (deterministic keys `fix-<round>-<n>`), mission returns to `running`.
- Rounds are bounded by `maxReviewRounds`; exhaustion → `blocked`, never `completed`.

## 8. Completion gate inputs (all deterministic)

`tasks` (all required ones `done`), `reviews` (exactly one `pass` whose `reviewedCommit` equals the
current mission-branch head), `validations` (every mandatory command recorded as `pass` against that
same commit), dirty worktrees (none, or explicitly acknowledged by the user), and unresolved blocking
findings (none). `projects-core.evaluateCompletion` owns the decision; the runner only supplies facts.

## 9. Recovery on restart

| Observed | State | Action |
|---|---|---|
| Mission terminal | `completed`/`failed`/`cancelled` | nothing |
| Workflow run terminal, tasks unfinished | `recoverable` | resume is an explicit call (`resumeMission`), which re-enters the loop from persisted task states |
| Workflow run `running`, executor session alive | `running` | reattach to the session (executor `list`/`resume`), continue |
| Workflow run `running`, no live session | `interrupted` | mark `interrupted` in the event log; mission becomes `blocked` with reason; auto-resume only if `autoResume` is configured, and never more than once per mission |
| No run recorded but status non-terminal | `interrupted` | same as above |

A mission can never move to `completed` without re-running the gate after recovery.

## 10. Configuration (defaults; overridable per project)

| Key | Default | Notes |
|-----|---------|-------|
| `maxWorkers` | 3 | maps to the workflow engine's `Caps.maxConcurrency` |
| `maxTaskAttempts` | 2 | dispatch + integration attempts |
| `maxReviewRounds` | 2 | review → remediation cycles |
| `plannerModel` / `workerModel` / `reviewerModel` | project default | model ids are opaque strings from the executor |
| `tokenBudgetPerMission` | unset | exceeded ⇒ `blocked` |
| `worktreeRoot` | `<dataDir>/projects/<projectId>/<missionId>/worktrees` | outside every repository |
| `validationCommands` | discovered | explicit override wins |
| `autoResume` | false | see §8 |

## 11. M1 surface (headless)

- Service API: `createProject`, `listProjects`, `createMission`, `planMission`, `startMission`,
  `resumeMission`, `cancelMission`, `instructMission`, `getMissionStatus`, `getMissionResult`,
  `getMissionTasks`, `getMissionWorkers`, `getMissionEvents`, `getMissionDiff`, `getMissionValidations`,
  `getMissionReviews`.
- A demo harness `scripts/projects-demo.mts` (run with `pnpm tsx`) drives the full mission on a scratch
  repository and prints JSON status transitions, so the end-to-end proof needs no UI.
- The UI (M2) will call the same service through hooks; no rule in this package may assume a UI exists.

## 12. Failure modes to handle explicitly

| Failure | Behaviour |
|---|---|
| Executor binary missing / handshake fails | mission `failed` with the executor's stderr excerpt; no retry storm (max 1 retry) |
| Worker session exits mid-task | task attempt fails; retry until `maxTaskAttempts`; events record the reason |
| Worker makes no changes | task fails as "no changes produced" unless the task is validation-only |
| Worktree has uncommitted work at task end | runner commits it (it is the worker's product); if commit fails, task fails and the worktree is left intact |
| Integration conflict | `predictMerge` first; a real conflict fails the task with the conflicting paths as the finding |
| Validation command missing | `blocked` (never a pass) |
| Reviewer modifies files | review invalidated, mission `blocked` with the reason |
| Store write fails | mission `failed`; the runner stops touching the repository |
| Budget exceeded | `blocked` with the spent/limit pair recorded |

## 13. Invariants

1. Exactly one runner instance mutates a mission at a time (in-process registry keyed by mission id).
2. Every task status change is persisted before the next dispatch decision.
3. Git facts are read from the worktree, never inferred from model output.
4. The user's working tree is never written to: no command in M1 targets the project's checkout except
   read-only inspection.
5. Every mission event is appended once, with a monotonic `seq`.
6. No mission reaches `completed` unless the gate returns `complete: true` on facts read after the last
   repository change.

