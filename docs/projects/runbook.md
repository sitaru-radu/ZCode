# Projects (M1) — runbook

How to install, build, verify and run the M1 mission layer on the Linux VM. Every command below
exists in the repository's own `package.json` scripts; nothing here is invented. Where a step needs a
value only you can supply (paths, credentials), it is marked.

Companion documents: [design.md](./design.md) (what it is),
[architecture-discovery.md](./architecture-discovery.md) (what it builds on),
[roadmap.md](./roadmap.md) (what comes after M1).

---

## 1. Prerequisites

| Requirement | Value | How it was verified |
|---|---|---|
| Node.js | **24.x** (measured: `v24.20.0`) | root `package.json` `engines.node: ">=24.0.0"`; `apps/zcode-cli/package.json` `engines.node: "24.14.0"` (the same pin as `mise.toml:2`) produces a pnpm warning `Unsupported engine: wanted {"node":"24.14.0"} (current: {"node":"v24.20.0"})` on 24.20.0 — a **warning only**, and the accepted deviation |
| pnpm | **10.33.2** via **corepack** | root `package.json` `packageManager: "pnpm@10.33.2"` |
| `dsh` on `PATH` | **0.2.0-rc.2** | the adapter's default binary is `dsh` and its default profile is `acp` (`apps/zcode-cli/packages/dsh-executor/src/config.ts:83-84`) |
| DeepSeek credentials | `DEEPSEEK_API_KEY` (or whatever your `dsh` installation already stores) | see [§6.3](#63-credentials-and-the-child-environment) — the adapter does **not** forward the parent environment |
| git | any modern git (2.38+ for `merge-tree --write-tree`; measured on 2.47.3) | `prediction`/`merge-tree` pre-flight is used by the task flow |
| A target repository | a git repository with the branch named by `project.defaultBranch` (default `main`), with real validation commands | see [§6.4](#64-choosing-a-target-repository) |

Node on the VM is supplied by nvm, so the shell needs it first:

```bash
export PATH="$HOME/.config/nvm/versions/node/v24.20.0/bin:$PATH"
```

---

## 2. Install

From the repository root (`~/repos/zcode-projects`):

```bash
pnpm install --frozen-lockfile
```

The recorded baseline for this fork is 1863 packages in ~20.8 s. The root workspace glob already
includes `apps/zcode-cli/packages/*`, so the five Projects packages install with everything else —
there is no second install step.

---

## 3. Build the dependency dists, in order

Each package's `exports` map points at `./dist/index.js`, so a package's dependencies must be built
before a consumer can run. `@zcode/projects-mission` additionally needs the two upstream engine
packages built (they are already built in this checkout).

```bash
# 1. upstream engine prerequisites (no change needed; listed for a clean checkout)
pnpm --filter @zcode/dynamic-workflow build          # script: node scripts/generate-libs.mjs && tsc
pnpm --filter @zcode/dynamic-workflow-runtime build  # script: tsc

# 2. no workspace dependencies
pnpm --filter @zcode/projects-core build
pnpm --filter @zcode/git-worktree build
pnpm --filter @zcode/dsh-executor build

# 3. needs projects-core
pnpm --filter @zcode/projects-store build

# 4. needs projects-core, projects-store, git-worktree, dsh-executor,
#    dynamic-workflow, dynamic-workflow-runtime
pnpm --filter @zcode/projects-mission build
```

Declared dependency facts that fix this order (`apps/zcode-cli/packages/*/package.json`):
`projects-core` `dependencies: {}`; `projects-store` → `@zcode/projects-core`;
`git-worktree` `dependencies: {}`; `dsh-executor` `dependencies: {}`;
`projects-mission` → `@zcode/dsh-executor`, `@zcode/dynamic-workflow`,
`@zcode/dynamic-workflow-runtime`, `@zcode/git-worktree`, `@zcode/projects-core`,
`@zcode/projects-store`.

A whole-tree alternative exists and is slower:

```bash
pnpm --dir apps/zcode-cli build     # turbo run build over every package in apps/zcode-cli
```

`clean` exists per package if a dist needs rebuilding from scratch:

```bash
pnpm --filter @zcode/projects-mission clean
```

---

## 4. Verify each package

Every one of the five packages exposes the same four scripts
(`build`, `clean`, `typecheck`, `lint`, `test`; `projects-mission` adds `demo`):

```bash
pnpm --filter @zcode/<pkg> lint        # oxlint . --ignore-pattern dist
pnpm --filter @zcode/<pkg> typecheck   # tsc --noEmit -p tsconfig.tests.json
pnpm --filter @zcode/<pkg> test        # node --import tsx --test "tests/**/*.test.ts"
```

All five, in one pass:

```bash
for pkg in projects-core projects-store git-worktree dsh-executor projects-mission; do
  echo "== $pkg =="
  pnpm --filter "@zcode/$pkg" lint
  pnpm --filter "@zcode/$pkg" typecheck
  pnpm --filter "@zcode/$pkg" test
done
```

What each suite covers, so a red result points somewhere:

| Package | Test files (snapshot) | What fails loudly |
|---|---|---|
| `projects-core` | `api`, `fixtures`, `gates`, `ids`, `invariants`, `lifecycle`, `planning`, `remediation`, `scheduling` | pure domain invariants: readiness at dispatch, idempotent `materializeTasks`, gate blockers, transition legality |
| `projects-store` | `migrations`, `store`, `execution`, `evidence`, `recovery`, `persistence`, `smoke`, `fixtures` | ledger/checksum policy, round-trip fidelity, monotonic event `seq`, atomic batches, reopen behaviour, a real temp file plus a second connection |
| `git-worktree` | `worktree`, `facts`, `integration`, `removal-guard`, `concurrency`, `runner`, `smoke`, `helpers/scratch` | **real-git integration tests** on a scratch repository under the OS temp dir — they need `git` on `PATH` and they create and delete worktrees |
| `dsh-executor` | `adapter`, `transport`, `stream`, `client`, `config`, `errors`, `submit-server`, `smoke`, `live`, `fake-acp-server`, `helpers` | a scripted NDJSON fake ACP peer drives every success and failure path (handshake, session create, streamed updates, cancel, list/resume, close, crash mid-session, malformed frame) — **no model calls, no credentials** |
| `projects-mission` | `compile-plan`, `runner-config`, `runner-review`, `world-read`, `smoke` | plan→script compilation, config validation, review verdict parsing, world-read argument validation and path-escape rejection |

> Test file lists are a snapshot: the packages were still being extended while this runbook was
> written. Run the commands; do not rely on the list being complete.

Baseline commands that must stay green (repository rule, `specs/projects/00-overview.md` §9):

```bash
pnpm typecheck                       # tsc -b over packages/* (does not include apps/zcode-cli)
pnpm lint                            # oxlint at the root
pnpm architecture:check --changed    # architecture-policy.yaml
pnpm --dir apps/zcode-cli typecheck   # turbo run typecheck — this is what covers the five packages
pnpm --dir apps/zcode-cli lint        # turbo run lint
```

There is a **live smoke test** for the executor, skipped unless explicitly enabled — it is the only
test that drives a real `dsh --profile acp` and therefore needs credentials:

```bash
cd apps/zcode-cli/packages/dsh-executor
set -a && . ~/.dsh/env && set +a
DSH_EXECUTOR_LIVE=1 node --import tsx --test tests/live.test.ts
```

(The gate is `process.env['DSH_EXECUTOR_LIVE'] === '1'`, and the header of `tests/live.test.ts` gives
this exact invocation.) Note that the adapter still builds the child environment itself — see
[§5.5](#55-credentials-and-the-child-environment).

---

## 5. Run a mission

### 5.1 The demo harness (the only out-of-the-box path)

`apps/zcode-cli/packages/projects-mission/scripts/demo.mts` creates a project, states an objective,
plans, runs, reviews, validates, gates, and prints one JSON snapshot to stdout.

```bash
pnpm --filter @zcode/projects-mission demo -- \
  --repo /abs/path/to/target-repo \
  --data /abs/path/to/mission-data \
  --objective "Add a /health endpoint returning {\"status\":\"ok\"} plus tests" \
  --workers 3 \
  --model deepseek-v4-flash
```

Arguments the script actually parses (`scripts/demo.mts`):

| Flag | Required | Default | Meaning |
|---|---|---|---|
| `--repo` | yes | — | the target repository (never written to) |
| `--objective` | yes | — | the mission objective, free text |
| `--data` | no | `<repo>/../.zcode-projects` | where `projects.db` and `worktrees/` live |
| `--workers` | no | `3` | `maxWorkers` |
| `--model` | no | unset (project default) | sets `plannerModel`, `workerModel` and `reviewerModel` to the same opaque id |
| `--project` | no | `demo` | the project name |

Equivalent form if you want a bare `node --import tsx` (run it from the package directory so `tsx`
resolves):

```bash
cd apps/zcode-cli/packages/projects-mission
node --import tsx scripts/demo.mts --repo /abs/repo --data /abs/data --objective "…"
```

The script writes progress lines to **stderr** and the final snapshot to **stdout**, so
`> result.json` captures only the result. The snapshot contains: `missionId`, `status`, `phase`,
`blockReason`, per-task `key`/`status`/`attempts`/`files`/`commits`, `validations`, `reviews`,
`result`, the event-type list, and `elapsedSeconds`.

The demo calls: `createDshExecutor({ profile: 'acp' })` → `adapter.start()` →
`reconcileMissions(...)` → `runner.createProject` → `runner.createMission` → `runner.planMission` →
`runner.startMission` → print → `adapter.dispose()` and `store.close()`.

### 5.2 Programmatic use — the runner API

Everything is exported from `@zcode/projects-mission`
(`apps/zcode-cli/packages/projects-mission/src/index.ts`).

```ts
import { createDshExecutor } from '@zcode/dsh-executor';
import { ProjectsStore } from '@zcode/projects-store';
import {
  MissionRunner,
  createRunnerConfig,
  createWorktreePort,
  reconcileMissions,
} from '@zcode/projects-mission';

const store = new ProjectsStore({ file: '/abs/data/projects.db' });   // or ':memory:'
const adapter = createDshExecutor({ profile: 'acp' /* , env, permissionMode, … */ });
const config = createRunnerConfig({
  maxWorkers: 3,
  worktreeRoot: '/abs/data/worktrees',   // absolute, outside every repository
  plannerModel: 'deepseek-v4-flash',
  workerModel: 'deepseek-v4-flash',
  reviewerModel: 'deepseek-v4-pro',
});

const runner = new MissionRunner({
  store,
  adapter,
  worktrees: createWorktreePort(),
  config,
  logger: (m) => process.stderr.write(`[mission] ${m}\n`),
});

await adapter.start();

// restart safety: classify non-terminal missions before starting anything new
const reports = await reconcileMissions({ store, adapter, now: () => Date.now(), worktreeRoot: config.worktreeRoot });

const project = runner.createProject({ name: 'demo', repositoryPath: '/abs/repo' /* , defaultBranch: 'main' */ });
const mission = runner.createMission({ projectId: project.id, objective: 'Add a /health endpoint plus tests' });

await runner.planMission(mission.id);
await runner.startMission(mission.id);

runner.getStatus(mission.id);        // { mission, tasks, workers, blockers }
runner.getResult(mission.id);        // undefined unless status === 'completed'
runner.getEvents(mission.id, 0);     // monotonic seq
runner.getValidations(mission.id);   // every executed command with exitCode and commit_sha
runner.getReviews(mission.id);       // rounds with verdicts and findings

runner.instructMission(mission.id, 'prefer the existing router');   // recorded, does not steer a live run
runner.cancelMission(mission.id, 'operator stop');

await adapter.dispose();
store.close();
```

Full method surface of `MissionRunner` (`src/runner.ts`):

| Method | Notes |
|---|---|
| `createProject({name, repositoryPath, defaultBranch?})` | `defaultBranch` defaults to `main` |
| `listProjects()` | |
| `createMission({projectId, objective, title?, source?})` | `source` defaults to `{kind:'text', text: objective}`; status starts `draft` |
| `planMission(missionId)` | reads repository instructions, discovers validation commands, runs the planner session, validates and persists the plan, materializes tasks; leaves the mission `ready` |
| `startMission(missionId)` | plans first if there is no plan; runs execute → review → (remediation) → gate; refuses a **second** concurrent call for the same mission in this process |
| `cancelMission(missionId, reason?)` | sets `cancelled` |
| `instructMission(missionId, text)` | appends a `mission.instructed` event |
| `getStatus(missionId)` | `{mission, tasks, workers, blockers}` |
| `getEvents(missionId, afterSeq?)` | |
| `getValidations(missionId)` | |
| `getReviews(missionId)` | |
| `getResult(missionId)` | `undefined` unless completed; carries summary, branch, commit, files, validations, reviews |

Also exported: `reconcileMissions`, `createWorktreePort`, `compilePlanToScript`, `executeMission`,
`planMission`, `createDshWorkflowDriver`, `createWorldReader`, `buildReviewBrief`,
`parseReviewVerdict`, `reviewerWorkspaceIsClean`, `discoverValidationCommands`,
`readRepositoryInstructions`, `emitMissionEvent`, `missionValidate`, `extractResultPayload`, and the
relevant types.

### 5.3 Configuration

`createRunnerConfig(overrides)` validates and rejects nonsense rather than repairing it — non-positive
worker counts, negative attempt/round counters, empty model ids, malformed command overrides,
relative worktree roots, mandatory fields passed as `undefined`, and **unknown keys**
(typo protection).

| Key | Default | Meaning |
|---|---|---|
| `maxWorkers` | `3` | concurrent DSH workers; maps to the engine's `Caps.maxConcurrency` |
| `maxTaskAttempts` | `2` | dispatch + integration attempts per task |
| `maxReviewRounds` | `2` | review → remediation cycles before `blocked` |
| `plannerModel` / `workerModel` / `reviewerModel` | unset | opaque executor model ids; unset means the project default. Never invented by this layer |
| `tokenBudgetPerMission` | unset | validated, **not enforced** — see [§8](#8-known-limitations-of-this-milestone) |
| `worktreeRoot` | `<repositoryPath>/../.zcode-projects` | absolute path outside every repository |
| `validationCommands` | `[]` (discover) | explicit override; wins over discovery |
| `autoResume` | `false` | validated, **not consumed** — see [§8](#8-known-limitations-of-this-milestone) |

**Model ids** come from the executor's catalogue and are opaque. The three ids on this deployment,
with the exact ACP selector value each one needs, are:

| model id | display name | ACP `value` |
|---|---|---|
| `deepseek-v4-flash` | `deepseek-v4-flash` | `"[\"deepseek-official\",\"deepseek-v4-flash\"]"` (session default) |
| `deepseek-flash` | `DeepSeek-V41-Flash` | `"[\"deepseek-official\",\"deepseek-flash\"]"` |
| `deepseek-v4-pro` | `DeepSeek-V4-Pro` | `"[\"deepseek-official\",\"deepseek-v4-pro\"]"` |

Reasoning effort is `off | low | high | max`, default `high`. The catalogue **shifts between calls** —
read it from `session/new`'s `configOptions`, never from `dsh --dump-config` and never cached.

**Worktree root.** Must be absolute and outside every repository. Layout:
`<worktreeRoot>/<projectId>/<missionId>/integration` and
`<worktreeRoot>/<projectId>/<missionId>/task-<n>-<taskId>`. Branches:
`zcode/mission-<missionId[4:12]>/integration` and `zcode/mission-<missionId[4:12]>/task-<n>`.

**Validation commands.** Discovery order is: explicit `validationCommands` override; then
`package.json` scripts in the fixed priority `typecheck`, `lint`, `test`, `build` (only those that
exist, run with the package manager detected from `pnpm-lock.yaml` / `yarn.lock` / `package-lock.json`);
then a `Makefile` target named `check`, `test` or `ci`; then an unambiguous command from
`.github/workflows/*.yml`; otherwise **no command**, and the mission is `blocked` with
"no validation commands discovered" — never a silent pass.

**Repository instructions** are read from a closed allowlist at the repository root, in order:
`AGENTS.md`, `CONTRIBUTING.md`, `CONTRIBUTING`, `README.md`, each truncated to
`DEFAULT_INSTRUCTION_MAX_BYTES` (8000) with the truncation stated in the text.

### 5.4 Sandbox mode

The executor exports `DSH_PERMISSION_MODE` to the worker child. Default (unset) is the agent's own
default, which on this deployment is `workspace-write`.

```ts
const adapter = createDshExecutor({ profile: 'acp', permissionMode: 'danger-full-access' });
```

Read [architecture-discovery.md §5.5](./architecture-discovery.md#55-the-sandbox-gotcha--tool-success-is-not-proof-of-a-side-effect)
before changing it: under `workspace-write`, a worker's write to `/tmp` **outside its session cwd**
can report success, read back, and never reach the host. A mission's own commits are read from the
worktree, so this cannot silently pass a task — but it can waste a worker turn, and it will surprise
anyone who asks a worker to drop an artifact somewhere convenient.

### 5.5 Credentials and the child environment

**The adapter does not forward the parent environment.** `buildChildEnv`
(`apps/zcode-cli/packages/dsh-executor/src/config.ts:129-151`) constructs the child environment
explicitly: `PATH`, `HOME` (plus `SystemRoot`/`ComSpec`/`PATHEXT`/`TEMP`/`TMP` on Windows),
`DSH_PERMISSION_MODE` when configured, and the `env` bag from the executor config — nothing else.
Ambient secrets are deliberately **not** forwarded wholesale, and stderr excerpts are redacted
(`sk-…` patterns and `DEEPSEEK_API_KEY`) before they are stored or logged.

Consequences:

- If your `dsh` installation resolves credentials from its own store, nothing more is needed.
- If it expects `DEEPSEEK_API_KEY` in the environment, pass it explicitly:

  ```ts
  const adapter = createDshExecutor({
    profile: 'acp',
    env: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? '' },
  });
  ```

- `scripts/demo.mts` calls `createDshExecutor({ profile: 'acp' })` with no `env`, so it relies on
  whatever `dsh` resolves on its own. If the demo's very first worker turn fails at the handshake,
  this is the first thing to check.
- **Never** put a key on a command line or in a logged value: the repository rule is that credentials
  never appear in logs.

### 5.6 Choosing a target repository

The demo and the runner assume a real repository:

- it must be a git repository whose `project.defaultBranch` exists (`main` unless you override it);
- it should have real validation commands, or the mission blocks at the gate;
- **do not use a shallow clone** — `merge-base` has nothing to walk, so three-dot diffs and the
  `merge-tree` conflict pre-flight degrade;
- the user's own checkout is never written to: worktrees live under `<data>/worktrees`, and the only
  thing that advances is the mission branch.

A prepared scratch repository exists in the Phase-0 working set at `.work/e2e/health-demo` (a small
Node project with `AGENTS.md`, `package.json`, `src/` and `test/`). It is not part of the repository;
verify its contents yourself before pointing a mission at it.

---

## 6. Inspect a run

### 6.1 Through the runner

`getStatus` (mission + tasks + workers + blockers), `getEvents` (monotonic `seq`), `getValidations`
(command, exit code, duration, result, `commit_sha`), `getReviews` (round, verdict, findings,
`reviewed_commit`), `getResult` (only when completed).

### 6.2 Through `projects.db`

The store is the mission's truth and can be read while the runner writes (WAL,
`busy_timeout = 5000`). Read it with any SQLite client, or with the package's own synchronous API:

```ts
import { ProjectsStore } from '@zcode/projects-store';
const store = new ProjectsStore({ file: '/abs/data/projects.db' });
store.recoverableMissionIds();   // non-terminal missions, oldest first
store.listActiveMissions();
store.listEvents(missionId);
store.listValidations(missionId, commitSha);   // commit-scoped: what the gate looked at
store.listReviews(missionId);
store.close();
```

Tables: `projects`, `missions`, `mission_plans`, `tasks`, `workers`, `mission_events`,
`validations`, `reviews`, plus the `schema_migrations` ledger. Column list in
[design.md §6.1](./design.md#61-projectsdb-mission-truth).

### 6.3 Following progress while it runs

The runner emits normalized mission events with a monotonic `seq` — `mission.created`,
`mission.planned`, `mission.started`, `task.started`, `worktree.created`, `worktree.committed`,
`worktree.integrated`, `task.completed`, `task.failed`, `review.started`, `review.passed`,
`review.failed`, `plan.revised`, `mission.phase_changed`, `mission.recovered`, `mission.completed`,
`mission.blocked`, `mission.cancelled`, `mission.instructed`, `tests.started`. Tail them with
`runner.getEvents(missionId, afterSeq)` or by polling `mission_events`.

There is **no UI and no RPC** for this in M1 — see [§8](#8-known-limitations-of-this-milestone).

### 6.4 After a restart

```ts
await reconcileMissions({ store, adapter, now: () => Date.now(), worktreeRoot: config.worktreeRoot });
```

It classifies every non-terminal mission as `running`, `recoverable` or `interrupted`. An
`interrupted` mission (no live executor session for its worktree) is set to `blocked` with the reason
recorded and a `mission.recovered` event; nothing is ever silently completed. Recovery is not
automatic today — there is no `resumeMission`, so a blocked mission is re-started by calling
`startMission` again after inspecting it.

---

## 7. Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| `Cannot find module '@zcode/projects-core'` or a `dist` path | dependency dists not built, or built out of order | [§3](#3-build-the-dependency-dists-in-order) |
| First worker turn fails at the handshake | `dsh` not on the child's `PATH`, or credentials not visible to the child | [§5.5](#55-credentials-and-the-child-environment); the adapter's `ExecutorHandshakeFailed` carries a redacted stderr excerpt |
| Mission ends `blocked` with "no validation commands discovered" | the target repo has no `package.json` script in the priority list, no `Makefile` target, no CI command | [§5.3](#53-configuration) — pass `validationCommands` explicitly |
| Mission `blocked` after review rounds | `maxReviewRounds` exhausted | inspect `getReviews` findings; raise `maxReviewRounds` deliberately, do not delete the verdict |
| A task fails "the worker produced no changes in its worktree" | the worker wrote nothing the mission can see (possibly the `/tmp` sandbox trap) | [§5.4](#54-sandbox-mode) |
| A task fails with an integration conflict | two task branches touched the same lines | the conflicting paths are in the `task.failed` event payload; this consumes an attempt |
| `fatal: Unable to create '…/index.lock'` | two writers on one worktree, or a killed git left a stale lock | one writer per worktree is a caller obligation; stale-lock recovery is manual and only safe when no git process for that worktree is alive |
| `checksum_mismatch` opening the store | the migration ledger disagrees with the frozen DDL, or the file was swapped | released migrations are immutable; the store refuses to open rather than repair |
| Mission branch exists but the mission is `blocked` | the gate did not pass | `getReviews` + `getValidations`: the gate needs one `pass` review and every mandatory validation at the **same** commit as the mission-branch head |

---

## 8. Known limitations of this milestone

The honest list. Nothing here is a bug in the sense of "unfinished by accident" — most of it is
scope, and the rest is recorded in
[architecture-discovery.md §10](./architecture-discovery.md#10-contradictions-found).

1. **Headless only.** No Projects UI, no mission RPC, no `IProjectsService`, no sidebar entry. The
   only entry points are `MissionRunner` in-process and `scripts/demo.mts`.
2. **The workflow run journal is in-memory.** `runner-execute.ts:143` uses `InMemoryJournalStore`, so
   nodes, replay and per-node results do not survive the process. `missions.run_id` is written
   (`runner.ts:190`) but does not resolve to a durable journal row; mission truth in `projects.db` is
   the only thing that survives.
3. **No mid-flight resume.** No `resumeMission`. `reconcileMissions` classifies and blocks; it does
   not continue. `autoResume` is accepted by `reconcileMissions` and by `MissionConfig` but consumed
   by nothing.
4. **`tokenBudgetPerMission` is validated but not enforced.**
5. **Retry accounting is partial.** `incrementTaskAttempts` runs on the integration-conflict and
   merge-failure paths only (`runner-taskflow.ts:173`, `:185`), so a task that fails because the
   worker produced nothing, or because the commit failed, is marked `failed` without consuming an
   attempt.
6. **No mission diff read face.** There is no `getMissionDiff`; read the git worktree directly.
7. **One runner instance per mission, in-process only** — the guard is a `Set` on the instance.
8. **No multi-project concurrency, no distributed workers, no live steering, no cost dashboard.**
9. **M1 never merges into the user's branch** (D9), and there is no app command to do it either.
10. **The review runs in the integration worktree**, not in a detached worktree at the reviewed
    commit; read-only-ness is asserted after the session (`runner.ts:265-320`).
11. **The gate's dirty-worktree input is hardcoded empty** (`runner.ts:386`), so that blocker code
    cannot fire.
12. **The runner never writes `reviewing` or `testing`.** They are declared statuses with declared
    transitions; the implementation expresses review and test as `phase` values on a `running`
    mission.
13. **Branches are never deleted**, and worktree removal never escalates to `--force`; residue is
    reported rather than cleaned. Stale `index.lock` recovery and `git gc`/`git prune` are operator
    actions.
14. **Shallow clones degrade the mission repo** (no `--unshallow` support).
15. **The `submit_result` MCP bridge is implemented in `dsh-executor` but not wired by
    `MissionRunner`**, so the default submission path is the post-turn payload parse (decision D12).
16. **Executor protocol facts are probe-verified, not mission-verified**: `agentInfo.version` is
    hardcoded `"0.0.1"`, `session/list` hides live sessions, and the model catalogue shifts between
    calls. Do not cache any of it.
17. **Cross-platform caveat.** The measured git and sandbox facts are from Debian 13 / git 2.47.3.
    `git-worktree` handles Windows spawn paths explicitly, but M1 was only exercised on Linux.
