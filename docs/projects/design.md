# Projects (M1) — design

The design that is implemented on branch `projects/m1`. Every statement here is either a frozen
decision from `specs/projects/`, or a behaviour read from the implemented packages under
`apps/zcode-cli/packages/{projects-core,projects-store,git-worktree,dsh-executor,projects-mission}`.
Where the two disagree, the code is described and the difference is called out in
[§11](#11-known-limitations).

Companion documents: [architecture-discovery.md](./architecture-discovery.md) (what the fork is),
[runbook.md](./runbook.md) (how to run it), [roadmap.md](./roadmap.md) (what comes after M1).

---

## 1. Purpose and scope

A human states an objective. Deterministic infrastructure plans, schedules and gates the work.
DeepSeek Harness workers execute tasks in isolated git worktrees. ZCode stays the human workspace;
the mission layer owns missions, plans, tasks, workers, review, tests and merge readiness.

**In scope for M1** (`specs/projects/00-overview.md` §3): project registry; mission creation from
free text (plus a local spec file); persisted plan with tasks and dependencies; deterministic
readiness/capacity/retry; DSH workers in git worktrees; deterministic git facts
(status/diff/commit/integrate); independent review with a bounded remediation loop;
repository-defined validation commands with a completion gate; normalized mission events; restart
recovery; and an end-to-end proof on a scratch repository.

**Out of scope for M1, explicitly:** the Projects/Mission UI, live steering of a running worker,
GitHub issue ingestion, apply/merge to the user's branch, multi-project concurrency, distributed
workers, RBAC, cost dashboards, automatic deployment.

---

## 2. Architecture

```
  human / API
      │  objective (free text)  ·  start / cancel / instruct
      ▼
┌─ ZCode (the human workspace) ─────────────────────────────────────────────────────────────┐
│  TUI · desktop · web            existing workflow UI: WorkflowRunSidePane, WorkflowTimeline│
│  M1 does NOT appear here: no Projects view, no mission RPC, no service registration        │
└───────────────────────────────────────────┬───────────────────────────────────────────────┘
                                            │  M1 entry is programmatic only:
                                            │  MissionRunner (in-process) or scripts/demo.mts
                                            ▼
┌─ @zcode/projects-mission : MissionRunner ─────────────────────────────────────────────────┐
│  planMission → compilePlanToScript → startMission → executeMission → review → gate         │
│  owns: mission lifecycle, task graph state, worker rows, worktrees, git facts, events      │
│  ┌─ runner-taskflow  per-task worktree / commit / integrate                                │
│  ├─ runner-review    detached reviewer worktree at the integrated commit                   │
│  ├─ runner-recovery  reconcileMissions (restart classification)                             │
│  └─ workflow-driver  createDshWorkflowDriver  ← the Boundary-B binding                      │
└───────┬───────────────────────────┬──────────────────────────┬────────────────────────────┘
        │                           │                          │
        │ script + driver           │ store calls              │ worktree + git facts
        ▼                           ▼                          ▼
┌─ @zcode/dynamic-workflow-runtime ─┐ ┌─ projects-store ─┐ ┌─ git-worktree ──────────────┐
│  runWorkflowScript (harness)      │ │  projects.db     │ │  worktree/branch lifecycle  │
│   └─ @zcode/dynamic-workflow      │ │  8 tables +      │ │  status/diff/log (v2 -z)    │
│       WorkflowEngine + AskScheduler│ │  migrations      │ │  merge-tree pre-flight      │
│       (pure, deterministic,       │ │  ledger          │ │  merge --no-ff              │
│        journal-replayable)        │ └──────────────────┘ │  guarded removal            │
│       InMemoryJournalStore (M1)   │                      └─────────────────────────────┘
└───────────────┬───────────────────┘
                │ driver.startAsk / cancelAsk / executeWorldRead
                ▼
┌─ @zcode/dsh-executor : DeepSeekHarnessAdapter ────────────────────────────────────────────┐
│  one long-lived child: `dsh --profile acp`   NDJSON JSON-RPC over stdio                    │
│  session/new · session/prompt · session/update · session/cancel · session/set_config_option│
│  permission requests answered deterministically · stderr ring buffer · secret redaction    │
└───────────────┬───────────────────────────────────────────────────────────────────────────┘
                │ one ACP session per task, cwd = that task's worktree
                ▼
┌─ DSH ACP sessions (workers) ──────────────────────────────────────────────────────────────┐
│  worker turn: read the brief, edit files inside its own worktree, run its own commands     │
│  sandbox: workspace-write by default → writable root = the session cwd                     │
│           DSH_PERMISSION_MODE=danger-full-access when artifacts must land anywhere         │
└───────────────┬───────────────────────────────────────────────────────────────────────────┘
                │ the runner never trusts the worker about the filesystem
                ▼
┌─ per-task worktrees (outside the repository) ─────────────────────────────────────────────┐
│  <worktreeRoot>/<projectId>/<missionId>/integration          branch zcode/mission-<id8>/..│
│  <worktreeRoot>/<projectId>/<missionId>/task-<n>-<taskId>    branch .../task-<n>           │
│  one writer per worktree · per-repo mutex for the registry · per-integration mutex         │
└───────────────┬───────────────────────────────────────────────────────────────────────────┘
                │
                ▼
┌─ gates ───────────────────────────────────────────────────────────────────────────────────┐
│  review (pass/fail, bounded rounds) → validations (per commit) → evaluateCompletion         │
│  complete only when: every required task done · exactly one pass review at the current      │
│  mission-branch head · every mandatory validation pass at that same commit · no dirty       │
│  worktrees · no unresolved blocking findings                                                 │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

The ZCode workflow path that this layer *reuses* (engine, journal, caps, projections) is diagrammed
in [architecture-discovery.md §8](./architecture-discovery.md#8-the-run-path-as-one-diagram).

---

## 3. Package map

Dependency direction (`specs/projects/00-overview.md` §6):
`projects-mission` → {`projects-core`, `projects-store`, `git-worktree`, `dsh-executor`};
`dsh-executor` → `projects-core` (types only, declared as no workspace dependency today);
nothing imports `projects-mission`. No package imports `@zcode/dynamic-workflow` internals except
the single binding module inside `projects-mission`.

| Package | Path | Owns | Key modules in the tree |
|---|---|---|---|
| `@zcode/projects-core` | `apps/zcode-cli/packages/projects-core` | Domain types, state machines, deterministic decisions (readiness, capacity, retry, gates), plan validation, plan→script compilation | `types`, `ids`, `lifecycle`, `planning`, `scheduling`, `gates`, `index`. Pure: no filesystem, no network, no ambient clock; the only runtime dependency is `node:crypto` in `ids.ts` |
| `@zcode/projects-store` | `apps/zcode-cli/packages/projects-store` | `projects.db` schema + migrations + repositories; recovery queries | `schema`, `migrations`, `domain`, `rows`, `sql`, `json`, `errors`, `store-base` → `store-projects` → `store-plans` → `store-execution` → `store-evidence` → `store` |
| `@zcode/git-worktree` | `apps/zcode-cli/packages/git-worktree` | Worktree/branch lifecycle, deterministic git facts, integration, safe removal | `runner`, `mutex`, `status`, `diff`, `integration`, `worktree`, `removal`, `removal-report`, `errors`, `index`; ships **`CONTRACT.md`** as well as `README.md` |
| `@zcode/dsh-executor` | `apps/zcode-cli/packages/dsh-executor` | ACP client (`DeepSeekHarnessAdapter`); **no** workflow-engine imports | `acp-client`, `adapter`, `executor-core`, `session-state`, `updates`, `models`, `permissions`, `errors`, `redact`, `log-buffer`, `line-splitter`, `jsonrpc`, `events`, `config`, `types`, `submission`, `mcp/servers`, `mcp/submit-server`; tests include a scripted NDJSON **fake ACP server** and a credential-gated live test |
| `@zcode/projects-mission` | `apps/zcode-cli/packages/projects-mission` | Mission runner: plan → run → events → gates → result; restart reconciliation; **the workflow-driver binding** | `runner`, `runner-plan`, `runner-execute`, `runner-taskflow`, `runner-review`, `runner-recovery`, `runner-config`, `compile-plan` (+ `-brief`, `-emit`, `-text`, `-types`), `workflow-driver`, `workflow-driver-prompt`, `world-read` (+ `-files`, `-git`, `-spawn`, `-types`, `-errors`), `worktree-port`, `mission-events`, `index`; `scripts/demo.mts` behind `pnpm --filter @zcode/projects-mission demo` |

> **Snapshot caveat.** The tree was still being extended by concurrent work while this document was
> written. Module *names* above are the stable part; do not treat any file count as a contract. The
> observed inventory at the time of writing was `projects-core` 7 src / 9 tests, `projects-store`
> 14 / 8, `git-worktree` 10 / 8, `dsh-executor` 20 / 11, `projects-mission` 23 / 5.

Consequences of the map that matter:

- **`dsh-executor` is engine-agnostic.** It has an empty `dependencies` object; the workflow binding
  it feeds lives in `projects-mission/src/workflow-driver.ts` and is exported as
  `createDshWorkflowDriver(deps): DshDriverFactory`
  (`specs/projects/40-dsh-executor.md:11`, `specs/projects/00-overview.md:80`).
- **`git-worktree` is the only package that mutates git state.** The mission package's world reader
  (`world-read-git.ts`) also invokes git, but read-only by construction, from an allowlist of four
  subcommands with `-C <path>` and no shell string — deliberately, so the world reader does not
  depend on a sibling package's build order (`world-read.ts:12-14`).
- **`projects-core` is pure and therefore testable without IO**; `projects-store` is synchronous
  (`node:sqlite` `DatabaseSync`) with no async seam.

---

## 4. Decisions D1–D12

Frozen in `specs/projects/00-overview.md` §2. One-line rationale each.

| Id | Decision | Rationale |
|----|----------|-----------|
| D1 | Reuse `@zcode/dynamic-workflow` as the execution substrate; do not write a second durable engine | It already provides a pure deterministic state machine, journal + replay, a scheduler with concurrency caps, repair/nudge, and a run UI |
| D2 | DSH is reached only through `@zcode/dsh-executor` | One adapter hides every DSH-specific API, so a second executor stays possible |
| D3 | The coordinator is deterministic; the model only proposes | An LLM must never decide lifecycle transitions, readiness or completion |
| D4 | Worktrees live outside the repository, under the ZCode data dir | The user's working tree and workspace index stay untouched |
| D5 | Mission truth lives in our own SQLite file; execution truth stays in the workflow journal | Avoids touching core schema/migrations; two clearly-owned stores linked by `runId` |
| D6 | Tests run through Node's built-in test runner with `tsx` | The fork ships no test infrastructure (no vitest, no test scripts); `tsx` is already a workspace dependency |
| D7 | Upstream is followed by **merge** from `upstream/main`, not rebase | Upstream history is squashed; rebasing onto rewritten snapshots is not meaningful |
| D8 | New code lives in new packages under `apps/zcode-cli/packages/*` | `apps/zcode-cli` is a single `managed: false` module and the root workspace glob already covers the path |
| D9 | M1 refuses to merge anything into the user's branch automatically | Applying results is an explicit M2 action |
| D10 | **One workflow run per mission**; per-task isolation comes from the driver creating each actor's DSH session in that task's worktree, and run-level world operations execute in the **integration worktree** | The driver's `cwd` is single/run-level (`workflow-driver-types.ts:116`) and the runner already owns all git facts |
| D11 | **Zero-upstream-edit execution substrate**: `runWorkflowScript` driven by our own `WorkflowDriver`; journal in-memory for M1 | Proven precedent in-tree, no edits to files upstream rewrites; the one-line branch that reuses the ZCode run service stays available for M2 |
| D12 | Typed results are submitted **after a turn ends**, not through a mid-turn blocking tool: the driver parses the payload (MCP `submit_result` event or last fenced JSON block) and reports it to the engine; a `reject` verdict becomes a follow-up prompt | Removes the dependency on an unverified mid-turn blocking-tool mechanism while keeping the engine's repair/nudge budgets authoritative |

**Note on D2.** The implemented split is: adapter in `dsh-executor`, driver binding in
`projects-mission`. The D2 row still reads "ACP client + workflow driver" while
`00-overview.md:80` and `40-dsh-executor.md:11` say the binding lives in `projects-mission`;
`architecture-discovery.md` §10 C1 records this. The code follows the latter.

---

## 5. State machines

### 5.1 Mission

`specs/projects/10-domain.md` §2; transitions are guarded by `canTransitionMission`
(`apps/zcode-cli/packages/projects-core/src/lifecycle.ts`).

| From | To | Trigger (owner) |
|---|---|---|
| `draft` | `planning` | `planMission` accepted |
| `planning` | `ready` | plan validated and persisted (`projects-core`) |
| `planning` | `failed` | planner output invalid after the repair budget |
| `ready` | `running` | `startMission` (human or API) |
| `running` | `reviewing` | every required task `done` |
| `running` | `blocked` | required task failed with attempts exhausted, budget exceeded, or no progress |
| `running` | `failed` | fatal orchestration error (store or executor unavailable) |
| `reviewing` | `testing` | review `pass` |
| `reviewing` | `running` | review `fail` → remediation tasks materialized |
| `reviewing` | `blocked` | review rounds exhausted (`maxReviewRounds`) |
| `testing` | `completed` | completion gate passes |
| `testing` | `running` | mandatory validation `fail` → remediation task |
| `testing` | `blocked` | remediation rounds exhausted |
| `blocked` | `running` | explicit resume (never automatic) |
| any non-terminal | `cancelled` | `cancelMission` |

`phase` is **derived, never set independently**: `draft|planning → plan|understand`,
`ready|running → execute`, `reviewing → review`, `testing → test`, `completed → complete`.
Terminal statuses are `completed`, `failed`, `cancelled`; no transition leaves them.

### 5.2 Task

| From | To | Trigger |
|---|---|---|
| `pending` | `ready` | all `deps` are `done` (recomputed on every scheduling pass) |
| `pending` | `blocked` | a dependency is `failed`/`blocked` and cannot be retried |
| `ready` | `running` | worker dispatched |
| `running` | `review` | worker turn completed and its worktree committed |
| `running` | `ready` | retryable failure, `attempts < maxTaskAttempts` |
| `running` | `failed` | attempts exhausted or non-retryable failure |
| `review` | `done` | integration into the mission branch succeeded |
| `review` | `ready` | integration conflict → new attempt (counts as an attempt) |
| `review` | `failed` | conflict and attempts exhausted |

`done`, `failed`, `blocked` are terminal for scheduling purposes; `blocked` may return to `pending`
only when a failed dependency is re-opened by a new plan version — never silently.

### 5.3 Worker

`provisioning → running ↔ idle → completed | failed | cancelled`. A worker never returns from a
terminal state; a retry creates a **new** worker row so history is preserved.

---

## 6. Data model

### 6.1 `projects.db` (mission truth)

One migration, `0001_initial_schema`, creates eight tables plus the ledger
(`specs/projects/20-store.md` §2; declarations frozen in
`apps/zcode-cli/packages/projects-store/src/schema.ts`).

| Table | Columns |
|---|---|
| `projects` | `id` PK, `name`, `repository_path`, `default_branch`, `status`, `created_at` |
| `missions` | `id` PK, `project_id`, `title`, `objective`, `source_json`, `status`, `phase`, `run_id`, `plan_version`, `created_at`, `started_at`, `completed_at`, `summary`, `block_reason` |
| `mission_plans` | `id` PK, `mission_id`, `version`, `summary`, `assumptions_json`, `affected_areas_json`, `validation_plan_json`, `risks_json`, `tasks_json`, `created_at`, `UNIQUE(mission_id, version)` |
| `tasks` | `id` PK, `mission_id`, `plan_id`, `plan_key`, `plan_index`, `title`, `description`, `deps_json`, `required`, `files_hint_json`, `acceptance_json`, `status`, `worker_id`, `worktree_path`, `branch`, `attempts DEFAULT 0`, `result_json`, `last_error` |
| `workers` | `id` PK, `task_id`, `session_id`, `state`, `model`, `worktree_path`, `started_at`, `completed_at` |
| `mission_events` | `mission_id`, `seq`, `type`, `payload_json`, `run_seq`, `created_at`, `PRIMARY KEY(mission_id, seq)` |
| `validations` | `id` PK, `mission_id`, `task_id`, `phase`, `command`, `exit_code`, `duration_ms`, `result`, `log_ref`, `commit_sha`, `created_at` |
| `reviews` | `id` PK, `mission_id`, `round`, `verdict`, `findings_json`, `reviewed_commit`, `created_at` |
| `schema_migrations` | `id` PK, `checksum`, `applied_at` — the migration ledger |

Indexes exist for every real access path (`idx_missions_project_status`,
`idx_missions_status_created`, `idx_tasks_mission_status`, `idx_tasks_mission_plan`,
`idx_workers_task`, `idx_validations_mission_created`, `idx_validations_mission_commit`,
`idx_reviews_mission_round`). Connection setup on **every** open:
`journal_mode = WAL`, `synchronous = NORMAL`, `foreign_keys = ON`, `busy_timeout = 5000`.

Encoding rules that make round-tripping exact: JSON columns hold the exact domain shape; booleans
are `0`/`1`; optional fields are SQL `NULL` when absent and come back as **absent properties**, never
`undefined`; `undefined` is rejected as a bind value.

**This store knows nothing about the core schema** and never opens another database. It is linked to
execution truth only by `missions.run_id`.

### 6.2 Workflow journal (execution truth)

`dwf_run` / `dwf_actor` / `dwf_node` / `dwf_event` in
`~/.zcode/cli/db/db.sqlite` — schema, columns and durability mechanics are in
[architecture-discovery.md §7.5](./architecture-discovery.md#75-persistence). For M1 the mission
runner constructs an **`InMemoryJournalStore`** (`runner-execute.ts:143`), so this table set is not
written by a mission run today.

### 6.3 Domain types and identity

Domain types are owned by `projects-core` (`types.ts`) and imported type-only by `projects-store`.
IDs are deterministic where determinism matters:

- `newId(prefix)` = `${prefix}_${randomUUID()}` for user-facing entities (project, mission).
- `deriveId(prefix, ...parts)` = `${prefix}_${shortHash(parts.join('\u0000'))}`, where `shortHash` is
  the first 10 chars of base32(sha256) over the lowercase alphanumeric alphabet.
- **Task ids are derived from `(missionId, planVersion, planKey)`**, so re-materializing the same plan
  version is idempotent and crash recovery cannot create duplicate tasks.
- Worker ids derive from `(taskId, attempt)`; worktree path and branch derive from
  `(mission.id, task.id)` — never random.

---

## 7. Execution sequence

```
planMission(missionId)                                   [runner-plan + projects-core]
  read AGENTS.md / CONTRIBUTING.md / README.md (allowlist, byte-capped)
  discover validation commands (override → package.json scripts → Makefile → CI → none)
  planner DSH session in a one-off ACP session
     └─ parse payload → validatePlan (deterministic) → repair within budget (3) → persist plan version
  materializeTasks(missionId, plan)   ids derived from (missionId, version, planKey)
  mission: planning → ready

startMission(missionId)                                  [runner.ts]
  if no latest plan: planMission first
  mission: → running, phase execute
  loop round = 0 … maxReviewRounds:
     ├─ compilePlanToScript(pending tasks)            [compile-plan*]
     │    one `agent("task-<key>")` per task, await chains over the dependency graph,
     │    phase() markers, world.run for validation commands, final return = MissionReport
     ├─ executeMission(...)                           [runner-execute]
     │    ├─ ensure integration worktree at project.defaultBranch
     │    ├─ createTaskFlow(...)
     │    ├─ new InMemoryJournalStore()
     │    ├─ createDshWorkflowDriver({adapter, journal, world, prepareTaskEnvironment,
     │    │                            onSessionCreated, beforeSubmit, onAskFailed, onRunEvent, model})
     │    ├─ runWorkflowScript({scriptText, lowered, askSpecs, caps:{maxConcurrency:maxWorkers},
     │    │                      cwd: integration.path, makeDriver, runId, validate, name})
     │    └─ settlement → MissionReport + integration head
     │         per dispatched actor:
     │           prepareTaskEnvironment(task-<key>)   [runner-taskflow]
     │              ensure dependencies are integrated, create/reuse the task worktree
     │              off the integration branch, record the worker row
     │           DSH session cwd = that worktree, brief = objective + task + repo instructions
     │           on turn end → beforeSubmit:                       [runner-taskflow]
     │              git status: clean  → fail "the worker produced no changes in its worktree"
     │              else commit -A (runner identity, --no-verify) → filesChanged from git
     │              predictMerge(repo, integration, task branch)     [merge-tree, read-only]
     │                 conflict → task failed, attempts += 1
     │              mergeInto(integration, task branch, --no-ff)     [per-integration mutex]
     │                 failure → task failed; success → task done, integration head advances
     │    persistValidations(store, mission, report.validations, integrationHead)
     │    mission.phase → review, missions.run_id ← runId
     ├─ review: reviewer DSH session with cwd = the integration worktree   [runner-review]
     │    diff (integration worktree vs project.defaultBranch) + changed files + instructions
     │    → brief; verdict pass|fail with structured findings; session destroyed
     │    after the session: the integration worktree must be clean, else the review is
     │    replaced by a blocking finding and verdict = fail
     │    verdict pass → break
     │    verdict fail → materialize remediation tasks (keys fix-<round>-<n>)
     └─ exhausted rounds → blocked
  finish(...)                                            [runner.ts]
     evaluateCompletion({mission, tasks, reviews,
                         validations: listValidations(missionId, integrationHead),
                         dirtyWorktrees: [], maxReviewRounds})
     complete  → mission completed, persist summary; branch and commit come from the last review
     blockers  → mission blocked with the blocker codes
```

`filesChanged` reported by a worker is **advisory only**: the runner replaces it with git facts
before persisting (`10-domain.md` §1 `TaskResult`, runner spec §5).

---

## 8. Ownership rules

One owner per state (`specs/projects/00-overview.md` §7).

| State | Owner |
|---|---|
| Mission lifecycle, phase, task graph | `projects-core` (pure decisions) + `projects-store` (persistence) |
| Live mission execution process | `projects-mission` — exactly one runner instance mutates a mission at a time (in-process registry keyed by mission id) |
| Workflow run truth (nodes, journal, replay) | `@zcode/dynamic-workflow` engine and its journal |
| Worker session lifecycle | `dsh-executor` |
| Git facts (branches, commits, diffs, conflicts) | `git-worktree` — **never** inferred from model text |
| Validation results | `projects-mission` executing repository commands, persisted as rows |
| Completion decision | `projects-core.evaluateCompletion` — the runner only supplies facts |

Invariants the runner must uphold (`specs/projects/50-mission-runner.md` §13):

1. Exactly one runner instance mutates a mission at a time.
2. Every task status change is persisted **before** the next dispatch decision.
3. Git facts are read from the worktree, never inferred from model output.
4. The user's working tree is never written to: no M1 command targets the project's checkout except
   read-only inspection.
5. Every mission event is appended once, with a monotonic `seq` allocated by the store
   (`COALESCE(MAX(seq),0)+1` inside an immediate transaction; independent per mission; continues
   across restarts).
6. No mission reaches `completed` unless the gate returns `complete: true` on facts read after the
   last repository change.

---

## 9. Failure modes and how each is handled

From `specs/projects/50-mission-runner.md` §12 and `40-dsh-executor.md` §7, annotated with what the
code does today.

| Failure | Behaviour |
|---|---|
| Executor binary missing / handshake fails | mission `failed` with the executor's stderr excerpt; **no retry storm** (max 1 retry). Typed errors: `ExecutorSpawnFailed`, `ExecutorHandshakeFailed` |
| Worker session exits mid-task | the ACP adapter rejects all in-flight calls with `ExecutorExited`; task attempt fails, events record the reason |
| Worker makes no changes | task fails with `the worker produced no changes in its worktree` (`runner-taskflow.ts:147`) — never a silent success |
| Worktree has uncommitted work at task end | the runner commits it (it is the worker's product) with a pinned commit identity (`user.name=ZCode Missions`), `--no-verify` so repository hooks never run |
| Commit fails | task fails; the worktree is left intact so the work is recoverable |
| Integration conflict | predicted first with `merge-tree` (read-only, no worktree, no lock); a real conflict fails the task with the conflicting paths, increments attempts, and the branch survives |
| Merge failure that is not a conflict | task failed with the outcome; **attempts are not incremented on this path** (`runner-taskflow.ts:185`) — see [§11](#11-known-limitations) |
| Validation command missing | `blocked` with "no validation commands discovered" — never a silent pass |
| Mandatory validation fails | blocker; mission returns to `running` for a remediation task, or `blocked` when rounds are exhausted |
| Reviewer modifies files | **Today:** the reviewer runs with `cwd` = the integration worktree (`runner.ts:281-284`), so a modification is possible. The runner then asserts the worktree is clean and, when it is not, replaces the verdict with `fail` plus a blocking finding `Reviewer modified the workspace` (`runner.ts:311-320`) — the review is invalidated rather than trusted |
| Store write fails | mission `failed`; the runner stops touching the repository |
| Budget exceeded | `blocked` with the spent/limit pair recorded — **configured but not enforced today** |
| ACP request times out | `RequestTimeout` / `PromptTimeout`; the call is rejected (default 30 s request, 15 min turn); the child is never killed unless the caller asks |
| Malformed protocol frame | `ProtocolViolation`; the adapter stops and the mission fails with a redacted stderr excerpt |
| Restart with a mission non-terminal | `reconcileMissions` classifies it `running` / `recoverable` / `interrupted`; an `interrupted` mission is set to `blocked` with the reason — it is **never** silently completed |
| Tool reports success but nothing landed on the host | the runner asserts on the host: git status and the commit are read from the worktree, never from model text |

---

## 10. Security and sandbox posture

**Process boundary.** One adapter instance owns one long-lived `dsh --profile acp` child. Stdout
carries protocol frames only; stderr goes to a ring buffer and a log sink and is never mixed into the
protocol stream. The child environment is built explicitly (`PATH`, `HOME`, configured values); the
ambient environment is not forwarded wholesale. Every error message is filtered for `sk-`-like tokens
and the `DEEPSEEK_API_KEY` value before it is stored or logged.

**Permission requests.** `session/request_permission` is answered **deterministically** by the
adapter's configured policy (default: reject anything the runner did not pre-approve). A prompt in a
pre-approved worker is a misconfiguration and is recorded as an event, not used as a control surface.

**The sandbox gotcha that shapes the design.** Under the default `workspace-write` mode the writable
root is the `session/new` `cwd`, **not** the server process cwd — and writes outside it are
asymmetric: `/tmp/**` outside the session cwd returns `rc=0`, reads back inside the sandbox, and
**vanishes on the host**, while `/var/tmp`, `$HOME` and `/etc` fail loudly with `Read-only file
system`. Consequences the design must respect:

1. **A completed tool call is not proof of a side effect.** The runner therefore reads all git facts
   from the worktree and commits what is actually there.
2. **Worker `cwd` is the task worktree**, so anything a worker writes with a relative path is inside
   the sandbox root and persists.
3. **The fs `write` tool is not constrained the way `bash` is** — an out-of-workspace write with the
   fs tool really lands and emits no permission request. A `workspace-write` worker is therefore not
   confined to its cwd; plan for that rather than assuming confinement.
4. `DSH_PERMISSION_MODE=danger-full-access` makes out-of-workspace writes land for real and sets the
   approval policy to `never`. It is the correct setting when a worker must emit artifacts anywhere
   on the filesystem, and it is strictly weaker protection.

**Repository safety.**

- Worktrees live **outside** the repository. An in-repo worktree is not ignored, and `git add -A`
  stages it as an embedded repository (a gitlink) — that would corrupt the user's index. The
  `git-worktree` package refuses an in-repo target unless the caller explicitly overrides.
- Every git invocation is pinned: `-c core.hooksPath=/dev/null -c core.pager=cat`,
  `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=echo`, `GIT_CONFIG_NOSYSTEM=1`, `LC_ALL=C`, with
  `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`GIT_COMMON_DIR`/`GIT_OBJECT_DIRECTORY`/`GIT_NAMESPACE`/
  `GIT_PREFIX`/`GIT_CEILING_DIRECTORIES` scrubbed from the child environment. Agents never run
  repository hooks, and config is never written with `git config` (which inside a worktree writes the
  **shared** config).
- `-C <path>` only, never `--git-dir` — without `--work-tree` git silently treats the process cwd as
  the working tree.
- Every call has a timeout and kills the process group; a killed git can leave `index.lock`, whose
  recovery is deliberately manual because the package cannot prove no git process is alive.
- The ACP transport's shutdown signal is **EOF on stdin** (clean exit 0). `SIGKILL` leaves sessions
  persisted and resumable but skips teardown.

---

## 11. Known limitations

Honest list of what M1 does **not** do. Nothing here is a plan; the plan is
[roadmap.md](./roadmap.md).

1. **No UI, and no service/RPC registration.** M1 is headless. There is no Projects area, no mission
   RPC method, no `IProjectsService`, and no entry in the ZCode client. The only surface is
   `MissionRunner` in-process plus `scripts/demo.mts`.
2. **The run journal is in-memory.** `runner-execute.ts:143` constructs `InMemoryJournalStore`, so
   nodes, replay and per-node results do not survive the process. `missions.run_id` is persisted
   (`runner.ts:190`) but does not resolve to a durable journal row. Per D11 this is intentional for
   M1 and it is the single largest gap to close.
3. **No mid-flight resume.** There is no `resumeMission`. `reconcileMissions` classifies non-terminal
   missions and moves an `interrupted` one to `blocked`; `autoResume` is accepted by its input and by
   `MissionConfig` but nothing consumes it. Engine-side resume exists
   (`engine.ts:331-371`) and is simply not reachable from the mission layer yet.
4. **`tokenBudgetPerMission` is validated but not enforced** (`runner-config.ts:115-116`), so a
   mission cannot be stopped on spend today.
5. **Retry accounting is partial.** `incrementTaskAttempts` is called on the integration-conflict and
   merge-failure paths (`runner-taskflow.ts:173`, `:185`). `maxTaskAttempts` is therefore not a
   general dispatch-retry bound: a task that fails because the worker produced nothing, or because a
   commit failed, is marked `failed` without consuming an attempt.
6. **`getMissionDiff` does not exist on the runner.** The read surface is `getStatus` (mission +
   tasks + workers), `getEvents`, `getValidations`, `getReviews`, `getResult`. Reviewing a mission's
   full diff means reading the git worktree directly.
7. **One runner instance per mission, in-process only.** The guard is a `Set` on the runner instance
   (`runner.ts:55`). Two processes pointing at the same `projects.db` are not coordinated; the store's
   WAL and `BEGIN IMMEDIATE` protect row-level writes, not the mission loop.
8. **No multi-project concurrency, no distributed workers, no live steering.** All explicitly out of
   scope for M1.
9. **M1 never merges into the user's branch** (D9). It produces a mission branch; applying it is a
   human/M2 action. There is also no `apply` command in the app to do it: `IGitService` has no merge.
10. **A git-worktree's identity is unresolved.** Worktree paths must not reuse the parent
    repository's `workspaceIdentity` (task-index rows, checkpoint directories, runtime registries and
    controller addresses would all collide), and there is no precedent in the repository for the
    correct key. M1 sidesteps this by never registering a worktree as a ZCode workspace at all — the
    decision must be made before M2 wires worktrees into the app.
11. **The `git-worktree` mutex is in-process.** It does not coordinate another process, another
    machine, or a human running git by hand. What makes that safe is the measured rule that distinct
    worktrees own distinct index/HEAD files: **one writer per worktree** is a caller obligation.
12. **Branches are never deleted** to keep a removed-but-unmerged worktree recoverable. Worktree
    directories are also not force-removed; residue is reported, never deleted by force.
13. **Stale `index.lock` recovery is manual**, and `git gc`/`git prune` are deliberately not
    implemented (they need a global lock with no active workers — an operator action).
14. **Shallow clones degrade the mission repo**: `worktree add` works, but `merge-base` has nothing
    to walk, so three-dot diffs and `merge-tree` pre-flight degrade. No `--unshallow` support.
15. **The `submit_result` MCP bridge is implemented but not wired by the runner.** `dsh-executor`
    ships a stdio `submit_result` server; `MissionRunner` does not populate `mcpServers`, so the
    default submission path is the post-turn payload parse (D12). The MCP path is available to a
    caller that supplies the server.
16. **The ACP protocol facts are probe-verified, not mission-verified.** They come from the
    S3/S4/S5 probe against `dsh 0.2.0-rc.2`; `agentInfo.version` is hardcoded `"0.0.1"` so version
    gating is impossible, `session/list` hides live sessions, and the model catalogue shifts between
    calls. Do not cache any of it.
17. **Deviations from the frozen specs**, all recorded in
    [architecture-discovery.md §10](./architecture-discovery.md#10-contradictions-found): the run-level
    `cwd` (C2), the `worktreeRoot` default (C3), the runner surface (C4), the `projects.db` location
    (C9), and the unenforced budget/auto-resume (C10).
18. **The review does not use a detached worktree.** The spec (`50-mission-runner.md` §7) says the
    reviewer runs "on a detached worktree checked out at the integrated commit". The code runs the
    reviewer session with `cwd` = the **integration worktree** and diffs it against
    `project.defaultBranch` (`runner.ts:265-284`). The read-only guarantee is enforced
    *after the fact* by the cleanliness assertion, not by construction.
19. **The gate's dirty-worktree input is inert.** `finish()` calls `evaluateCompletion` with
    `dirtyWorktrees: []` (`runner.ts:386`), so the `dirty-worktrees` blocker code exists in
    `projects-core` but can never fire from a mission run.
20. **The runner never writes the `reviewing` or `testing` mission statuses.** `MissionStatus`
    declares them and `lifecycle.ts:25-27` allows the transitions, but the only status writes are
    `planning`, `ready`, `running`, `cancelled`, `completed` and `blocked`
    (`runner.ts:117/132/147/207/392/396`). Review and test are expressed as `phase` values on a
    `running` mission, so a UI that switches on status will not observe those two states.
21. **Remediation tasks carry no dependencies.** The spec says each remediation task depends on the
    reviewed tasks; `materializeRemediation` emits `dependsOn: []` (`runner.ts:347-354`). Because
    reviewed tasks are already `done`, the graph still schedules correctly, but the recorded
    dependency edge the spec asked for is absent.
