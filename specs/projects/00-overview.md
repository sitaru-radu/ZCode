# Projects — M1 overview

Status: draft (Phase 0). Owner: Projects module. Supersedes: nothing.

## 1. Purpose

Add a project-level mission layer to ZCode: a human states an objective, deterministic
infrastructure plans, schedules and gates the work, and DeepSeek Harness (DSH) workers execute
tasks in isolated git worktrees. ZCode stays the human workspace; the mission layer owns missions,
plans, tasks, workers, review, tests and merge readiness.

M1 delivers this **headless** (services + tests + demo script). The Projects/Mission UI is M2.

## 2. Guiding decisions (locked)

| Id | Decision | Rationale |
|----|----------|-----------|
| D1 | Reuse `@zcode/dynamic-workflow` as the execution substrate; do not write a second durable engine | It already provides a pure deterministic state machine, journal + replay, scheduler with concurrency caps, repair/nudge, and a run UI |
| D2 | DSH is reached only through `@zcode/dsh-executor` (the ACP adapter); the workflow-driver binding that consumes it lives in `@zcode/projects-mission` | Keeps every DSH-specific API behind one adapter with no engine imports, and keeps the engine coupling in the package that already depends on the engine |
| D3 | The coordinator is deterministic; the model only proposes | An LLM must never decide lifecycle transitions, readiness or completion |
| D4 | Worktrees live outside the repository, under the ZCode data dir | Keeps the user's working tree and workspace index untouched |
| D5 | Mission truth lives in our own SQLite file; execution truth stays in the workflow journal | Avoids touching core schema/migrations; two clearly-owned stores linked by `runId` |
| D6 | Tests run through Node's built-in test runner with `tsx` | Upstream ships no test infrastructure in this fork (no vitest, no test scripts); `tsx` is already a workspace dependency |
| D7 | Upstream is followed by **merge** from `upstream/main`, not rebase | Upstream history is squashed (`Initial commit`, `feat: open source`, `feat: update v3.14.3`); rebasing onto rewritten snapshots is not meaningful |
| D8 | New code lives in new packages under `apps/zcode-cli/packages/*` | `apps/zcode-cli` is a single legacy (`managed: false`) module in `architecture-policy.yaml`; the root workspace glob already includes `apps/zcode-cli/packages/*` |
| D9 | M1 refuses to merge anything into the user's branch automatically | Applying results is an explicit M2 action |
| D10 | **One workflow run per mission**; the run's `cwd` is the project repository root. Per-task isolation comes from the driver creating each actor's DSH session in that task's worktree; run-level `world.run`/`files.*`/`git.*` execute in the **integration worktree** | The driver's `cwd` is single/run-level (`workflow-driver-types.ts:116`), and the runner already owns all git facts (runner spec §1–§3) |
| D11 | **Zero-upstream-edit execution substrate**: `runWorkflowScript` from `@zcode/dynamic-workflow-runtime` driven by our own `WorkflowDriver` (`projects-mission/src/workflow-driver.ts`), journal = in-memory for M1 (mission truth lives in `projects.db`, D5) | Proven precedent in-tree (`dynamic-workflow-snippet-service.ts:129-149` + hand-written driver literal `:220-245`); no edits to files upstream rewrites. Optionally, M2 may add the one-line branch that reuses the ZCode run service if the UI needs run projections |
| D12 | Typed results are submitted **after a turn ends**, not through a mid-turn blocking tool: the driver parses the payload (MCP `submit_result` event or last fenced JSON block) and reports it to the engine; a `reject` verdict becomes a follow-up prompt (repair as a new turn) | Removes the dependency on an unverified mid-turn blocking-tool mechanism while keeping the engine's repair/nudge budgets authoritative |

## 3. Scope

In scope (M1): project registry, mission creation from free text (plus a local spec file when cheap),
persisted plan with tasks and dependencies, deterministic readiness/capacity/retry, DSH workers in
git worktrees, deterministic git facts (status/diff/commit/integrate), independent review with a
bounded remediation loop, repository-defined validation commands with a completion gate, normalized
mission events, restart recovery, and the end-to-end proof on a scratch repository.

Out of scope (M1, explicit): Projects/Mission UI, live steering of a running worker, GitHub issue
ingestion, apply/merge to the user's branch, multi-project concurrency, distributed workers, RBAC,
cost dashboards, automatic deployment.

## 4. Verified environment facts

Recorded by Phase 0 on the build host (netcup VM, Debian 13, 8 vCPU, 15 GiB RAM, 265 GiB free):

| Fact | Value |
|------|-------|
| Fork | `sitaru-radu/ZCode` (public fork of `zai-org/ZCode`), default branch `main` |
| Working branch | `projects/m1`, created from `main` at `29628c9 feat: update v3.14.3` |
| Repo clone on VM | `~/repos/zcode-projects` (51 MiB), remotes: `origin` = fork, `upstream` = `zai-org/ZCode` |
| Node | v24.20.0 via nvm (`mise.toml` pins 24.14.0; root `engines` requires `>=24.0.0`) — **deviation accepted, warning only** |
| pnpm | 10.33.2 (activated through corepack, matching `packageManager`) |
| Install | `pnpm install --frozen-lockfile` → 1863 packages, 20.8 s |
| Baseline typecheck | `pnpm typecheck` → exit 0 |
| Baseline lint | `pnpm lint` → exit 0, 70 pre-existing warnings, 0 errors |
| Baseline architecture | `pnpm architecture:check --changed` → `architecture: OK`, 0 violations |
| DSH on host | `dsh 0.2.0-rc.2`; `dsh-web.service` (systemd user) on 127.0.0.1:3080 must not be disturbed |

## 5. Repository constraints that shape the design

| Constraint | Consequence |
|-----------|-------------|
| `architecture-policy.yaml` → single module `zcode-cli` (`roots: [apps/zcode-cli]`, `managed: false`) | New packages need no module registration; the layer rules of managed modules do not apply, so we self-impose domain/app/adapters separation |
| `global.maxFileLines: 400` | Every source file stays under 400 lines (upstream enforces this by splitting files) |
| Root workspace globs include `apps/zcode-cli/packages/*` | One root `pnpm install` covers new packages; no separate install step |
| `apps/zcode-cli` runs `turbo run typecheck` / `turbo run lint` | Each new package must expose `typecheck` and `lint` scripts to participate |
| No test runner, no test scripts, no vitest anywhere in the fork | We add our own: `node --import tsx --test "tests/**/*.test.ts"` per package |
| `AGENTS.md`: spec before behaviour; `pnpm typecheck` + `pnpm lint` mandatory; no secrets in logs | Specs live in `specs/projects/`; validation commands are part of the definition of done |
| `AGENTS.md`: UI → hooks only, `workspaceIdentity` vs `workspacePath`, `IPlatformService` | Applies from M2; worktree paths must never be registered as ordinary workspaces |

## 6. Package map

| Package | Path | Owns |
|---------|------|------|
| `@zcode/projects-core` | `apps/zcode-cli/packages/projects-core` | Domain types, state machines, deterministic decisions (readiness, capacity, retry, gates), plan validation, plan→script compilation |
| `@zcode/projects-store` | `apps/zcode-cli/packages/projects-store` | `projects.db` schema + migrations + repositories; recovery queries |
| `@zcode/git-worktree` | `apps/zcode-cli/packages/git-worktree` | Worktree/branch lifecycle, deterministic git facts, integration, safe removal |
| `@zcode/dsh-executor` | `apps/zcode-cli/packages/dsh-executor` | ACP client (`DeepSeekHarnessAdapter`); **no** workflow-engine imports |
| `@zcode/projects-mission` | `apps/zcode-cli/packages/projects-mission` | Mission runner: plan → run → events → gates → result; restart reconciliation; **the workflow-driver binding** (`src/workflow-driver.ts`) |

Dependency direction: `projects-mission` → {`projects-core`, `projects-store`, `git-worktree`,
`dsh-executor`}; `dsh-executor` → `projects-core` (types only); nothing imports `projects-mission`.
No package imports `@zcode/dynamic-workflow` internals except the single binding module inside
`projects-mission` that adapts the run entry point.

## 7. Ownership (one owner per state)

| State | Owner |
|-------|-------|
| Mission lifecycle, phase, task graph | `projects-core` (pure) + `projects-store` (persistence) |
| Live mission execution process | `projects-mission` (single active runner per mission) |
| Workflow run truth (nodes, journal, replay) | `@zcode/dynamic-workflow` engine + its SQLite journal |
| Worker session lifecycle | `dsh-executor` |
| Git facts (branches, commits, diffs, conflicts) | `git-worktree` — never inferred from model text |
| Validation results | `projects-mission` executing repository commands, persisted as rows |

## 8. Known-open items (Phase 0 spikes)

| Id | Question | Status |
|----|----------|--------|
| S1 | Does the facade expose journaled command execution (`world.run`)? | **Confirmed** — `facade/registry.ts` row `{ container: "world", member: "run", op: "run" }` |
| S2 | Is the workflow driver replaceable, and what is the exact insertion point? | In progress (report pending) |
| S3 | Does an ACP worker session accept a stdio MCP server (for a typed `submit_result` tool)? | In progress |
| S4 | Do DSH sessions survive an ACP server restart (`session/list`, `session/resume`)? | In progress |
| S5 | Which DSH models are selectable per session, and how is `cwd` honoured? | In progress |
| S6 | Can a second SQLite file with its own migrations be added safely? | **Confirmed** — pattern exists (`packages/services/src/session/tasksDatabase/{migrations,startup,schema-v1}.ts`, `node:sqlite` `DatabaseSync`, checksummed migrations) |
| S7 | Is there a non-model entry point to start a workflow run with an explicit `scriptText`? | In progress |

## 9. Definition of done for M1

Baseline commands stay green (`pnpm typecheck`, `pnpm lint`, `pnpm architecture:check --changed`,
plus `pnpm --dir apps/zcode-cli typecheck`), every module has specs and tests, and the end-to-end
proof (mission on a scratch repository: plan → ≥2 concurrent worktree workers → real tests →
independent review → completion gate → final result, with the user's working tree untouched and the
result surviving a restart) is executed and recorded with raw evidence.
