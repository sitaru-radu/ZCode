# Projects — roadmap (post-MVP)

Improvements that are **not** in M1. Each item states what it changes, why it is worth doing, and a
rough size. Nothing here is committed work; the ordering inside a group is a suggestion.

**Sizes:** **S** ≈ a focused day or two · **M** ≈ one to two weeks · **L** ≈ multi-week or needs
several pieces to land together.

Sources for each candidate are the Phase-0 reports' own *unknowns / deferred / out of scope*
sections, the frozen specs' explicit M2 carve-outs, and behaviour verified absent in the implemented
code (see [design.md §11](./design.md#11-known-limitations) and
[architecture-discovery.md §9](./architecture-discovery.md#9-unknowns--not-verified)).

---

## A. Durability and resume

The single largest gap: mission truth survives a restart, execution truth does not.

| # | Item | Rationale | Size |
|---|---|---|---|
| A1 | **Durable run journal** — construct `SqliteDwfJournalStore` instead of `InMemoryJournalStore` (`projects-mission/src/runner-execute.ts:143`), against a store the mission layer owns | Nodes, replay and per-node results currently vanish with the process; `missions.run_id` is written but points nowhere. The SQLite implementation and its race-hardened schema already exist | M |
| A2 | **Decide where the durable journal lives** — `projects.db`, a dedicated `projects-journal.db`, or the ZCode session store | D5 separates mission truth from execution truth; sharing `db.sqlite` would couple the mission layer to the CLI session store's lifecycle, and a shared file couples it to `projects.db`'s ledger. This is the open question recorded as spike unknown 21 | S (decision) + S (implementation) |
| A3 | **Resume a run mid-flight** — reach the engine's existing resume branch (`engine.ts:331-371`) from the mission layer | Recovery today classifies and blocks; a mission interrupted with 7 of 9 tasks done must redo all of them. Requires A1 plus `session/resume` semantics | L |
| A4 | **`resumeMission` on the runner**, replacing the implicit "call `startMission` again" | The runner surface has no resume entry point; recovery and resume are separate concepts and should stay separate | M |
| A5 | **Make `autoResume` real** (bounded, never automatic-and-unbounded) | The key is validated and accepted by `reconcileMissions` but consumed by nothing (`runner-config.ts:119`, `runner-recovery.ts:30`); the spec already bounds it to once per mission | S |
| A6 | **Enforce `tokenBudgetPerMission`** | Validated but never read after `createRunnerConfig`; a mission cannot be stopped on spend today. The engine already tracks `spent_tokens` per run | S |

---

## B. The Projects / Mission UI

Net-new UI work. The exact seams are enumerated in `discovery-b-services-ui.md` §7 and reproduced
here so the estimate is not a guess.

| # | Item | Rationale | Size |
|---|---|---|---|
| B1 | **`IProjectsService` end to end** — channel name (`packages/shared/src/channels.ts`), descriptor + browser-safe export (`packages/services/src/projects/`), implementation, registration in `createLocalServices()` (`packages/services/src/node.ts:2434`), client proxy (`packages/client/src/remoteServiceAccess.ts`), accessor field (`packages/services/src/accessor.ts`) | There is no RPC path from any ZCode surface to a mission today; this is the five-file pattern every service follows | M |
| B2 | **Projects as a main-view area (Option A)** — extend `WorkspaceMainView` (`packages/ui/src/app-shell/types.ts:120`), add a branch to the ternary chain (`WorkspaceShellLayout.tsx:1747/1800`), the collateral conditions at `:1495`/`:1902`, prop threading, and one sidebar button (`WorkspaceSidebar.tsx:1348`) | Mirrors the `plugin-store` precedent — the most recently added area and therefore the freshest template; the side-pane union (~19 members, each with presentation/search/overview registrations) is the more expensive seam | M |
| B3 | **Mission screen: timeline, roster, gates** — `ProjectsMain`, `MissionScreen`, a pure `missionModel`, a `useProjectsService` hook and a Zustand store | The mission domain already produces everything a timeline needs (monotonic events, task states, reviews, commit-scoped validations); this is presentation, not new state | M |
| B4 | **Reuse the workflow-runs projection pattern** — one bounded payload → `reduceWorkflowRunsState` → key-level deltas (`packages/shared/src/zcode-protocol-v4/workflow-runs-reducer.ts:116`) | Reusing the shared reducer buys cold replay, eviction and O(N) delta cost instead of inventing a second event schema | M |
| B5 | **i18n keys for the new area** — `projects.*` in both flat locale maps | There is no codegen and no fallback extraction; a missing key renders as the raw id | S |
| B6 | **Surface DSH runs in the ZCode run UI** — the additive seam option (c2): a `createWorkflowDriver?` dep plus one expression at `dynamic-workflow-run-launch.ts:191` | The zero-upstream-edit decision (D11) deliberately gave up the run service's registry, cancel, notifications and `onRunEvent` projection; this is how a mission run gets them back, at the cost of edits in files upstream rewrites | M |
| B7 | **Live steering of a running worker** | Explicitly out of scope for M1; needs a mid-turn interaction channel that the ACP probe did not verify | L |

---

## C. Worktrees and workspace identity

| # | Item | Rationale | Size |
|---|---|---|---|
| C1 | **Decide the worktree identity key** | A worktree is a different working tree of the same repository; reusing the parent's `workspaceIdentity` collides task-index rows, checkpoint directories, runtime registries, controller addresses, draft registries and activity tracking (`discovery-b-services-ui.md` §6.3). There is no precedent to copy, and this must be settled before worktrees are registered as workspaces | S (decision) |
| C2 | **Enforce that decision** wherever `workspaceIdentity?.trim() \|\| workspacePath` is spelled out | The rule is a repeated idiom in ~10 helpers plus inline sites, not one function — enforcement needs a single helper or an explicit per-site audit | M |
| C3 | **Worktree lifecycle in the app's git service** — add worktree methods to `IGitService` or a new `IWorktreeService`, plus a `gitCliWorktreeRepo` | `IGitService` has no worktree method at all, and the workflow runtime's `worktree` isolation option is declared in the type system but throws when used; a UI that manages worktrees has nothing to call | L |
| C4 | **Merge / integrate in the app's git service** — the first merge implementation in the codebase, including conflict representation | `git merge` is absent from the git package entirely; conflict *reporting* exists, resolution does not | L |
| C5 | **Stale `index.lock` recovery** | Deliberately manual in `git-worktree` because the package cannot prove no git process is alive; a supervised-worker registry would make it provable | S |
| C6 | **Shallow-clone support** (`--unshallow` / deepening before creating worktrees) | `worktree add` works in a shallow clone but `merge-base` has nothing to walk, so three-dot diffs and the `merge-tree` pre-flight degrade | S |
| C7 | **Per-worktree git config** via `extensions.worktreeConfig` | Today config is pinned per invocation because `git config` inside a worktree writes the **shared** repo config; opt-in scoping is the cleaner long-term answer | S |

---

## D. Ingestion and delivery

| # | Item | Rationale | Size |
|---|---|---|---|
| D1 | **GitHub issue ingestion** — implement `MissionSource` kind `githubIssue` | The union member already exists in the domain (`10-domain.md` §1) and is unimplemented; the planner prompt takes an objective string, so this is a fetch + normalize + provenance step | M |
| D2 | **Apply-to-branch** — merge the mission branch into the user's branch behind an explicit confirmation | D9 defers exactly this: M1 refuses to touch the user's branch, and there is no command in the app to do it either. Depends on C4 | M |
| D3 | **PR creation** from a completed mission | Natural follow-on to D2, and the mission already has a clean branch plus per-task merge commits for a reviewable body | M |
| D4 | **Mission deliverables as artifacts** — write the report/diff through `ToolArtifactStorePort` (`zcode-artifact://<session>/<id>`) | Reuses a store that already has a chunked read RPC and a UI viewer, instead of inventing a second output channel | M |
| D5 | **Stream worker output into mission events** | The executor exposes a hot event stream and the driver has an `onDshEvent` hook; the runner does not subscribe today, so a mission shows task-level transitions but not what a worker is doing | M |

---

## E. Observability and cost

| # | Item | Rationale | Size |
|---|---|---|---|
| E1 | **Cost dashboard per mission and per project** | The engine already persists `dwf_run.spent_tokens` and emits `usage_update`; nothing reads it for a human. Depends on A1 to have durable spend | M |
| E2 | **`getMissionDiff` and a full read surface on the runner** (`getMissionTasks` / `getMissionWorkers` as separate calls, diff by commit range) | `getStatus` returns tasks and workers inline and there is no diff read face; a UI needs both without reading git directly | S |
| E3 | **Surface the gate's real inputs** — populate `dirtyWorktrees` instead of the hardcoded `[]` (`runner.ts:386`) | The blocker code exists in `projects-core` and can never fire; a user cannot see *why* a worktree would block completion | S |
| E4 | **Record `reviewing` / `testing` mission statuses** | They are declared with transitions but never written, so any consumer switching on `MissionStatus` (recovery queries included) never observes those phases | S |
| E5 | **Journal retention** | No `DELETE FROM dwf_*` or retention policy was found; runs appear to live forever. A1 makes this load-bearing rather than theoretical | M |

---

## F. Scale and operations

| # | Item | Rationale | Size |
|---|---|---|---|
| F1 | **Multi-project concurrency** — a process-level scheduler with a global worker budget | M1 runs one mission at a time per runner instance; `maxWorkers` is per run, and the provider governor is the only cross-run limit | M |
| F2 | **Cross-process mission locking** | The guard is an in-process `Set`; two processes on one `projects.db` are uncoordinated. The store's WAL and `BEGIN IMMEDIATE` protect rows, not the mission loop | S |
| F3 | **Distributed workers** — more than one executor host | Explicitly out of scope for M1; the ACP transport is stdio-only, so this needs a transport decision first | L |
| F4 | **RBAC and per-user mission permissions** | Explicitly out of scope for M1; relevant only once a mission can be started by more than one human | L |
| F5 | **Automatic deployment of a completed mission** | Explicitly out of scope for M1; depends on D2 | L |

---

## G. Correctness debt worth clearing early

Small, cheap items that remove known sharp edges.

| # | Item | Rationale | Size |
|---|---|---|---|
| G1 | **Generalise retry accounting** — consume `maxTaskAttempts` on every task failure path, not only the integration paths | `incrementTaskAttempts` runs on conflict/merge failure only, so a worker that produces nothing fails without consuming an attempt | S |
| G2 | **Reviewer isolation** — run the reviewer in a detached worktree checked out at the reviewed commit | Today it runs in the integration worktree and read-only-ness is asserted after the fact; a detached checkout makes the guarantee structural | S |
| G3 | **Remediation dependence** — give `fix-<round>-<n>` tasks their declared dependency on the reviewed tasks | The edge is part of the spec's graph contract and is currently emitted as `dependsOn: []` | S |
| G4 | **Wire the MCP `submit_result` bridge** | `dsh-executor` ships the stdio server and the driver accepts `mcpServers`, but `MissionRunner` never supplies one, so the typed path is unreachable from a mission | S |
| G5 | **Settle the stale spec text** — `00-overview.md` D2 (driver ownership), D10 (run `cwd`), `50-mission-runner.md` §10 (worktree root) and §11 (runner surface) | Four frozen-spec statements contradict the implemented code; leaving them makes every future reader re-derive the truth. Either the spec or the code should move | S |
| G6 | **`dsh-executor/CONTRACT.md`** — write the file the package's own `index.ts` already points at, or drop the reference | `git-worktree` has one and it is the reason its invariants are trustworthy; the executor's protocol traps deserve the same treatment | S |
