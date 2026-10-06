# Architecture discovery — what this fork actually is

Read-only investigation of `sitaru-radu/ZCode` (fork of `zai-org/ZCode`) on branch `projects/m1`.
Everything below is a fact read from source or measured on the host; nothing is inferred from
docs, naming or intent. Items that could not be resolved are in [§9](#9-unknowns--not-verified)
rather than guessed.

**Sources.** This document assembles five Phase-0 reports and the frozen specs. They are held
outside the repository in the working set:

| Source | What it covers |
|---|---|
| `discovery-a-workflow.md` | the durable multi-agent workflow run path, end to end |
| `discovery-b-services-ui.md` | services / persistence / RPC / UI seams and the git capability inventory |
| `s2-driver-seam.md` | the workflow-driver port (Boundary B) and the chosen integration seam |
| `s3-s4-s5-dsh-acp.md` | the DeepSeek Harness ACP protocol probe (MCP bridge, resume, models, sandbox) |
| `git-worktree-spike.md` | measured git worktree semantics (git 2.47.3, Debian 13) |
| `specs/projects/*.md` | the frozen M1 specs (`00-overview`, `10-domain`, `20-store`, `40-dsh-executor`, `50-mission-runner`) |

**Provenance caveat.** The reports were written at two different HEADs: `discovery-a` and
`discovery-b` at `29628c9 feat: update v3.14.3`, `s2-driver-seam.md` at `c2a2193 feat(projects):
scaffold Projects packages and Phase 0 specs`. Line numbers in the reports are from those trees.
Where a report and the implemented code disagree, [§10](#10-contradictions-found) records it.

**Path convention.** Code paths are repository-relative, e.g.
`apps/zcode-cli/packages/dynamic-workflow/src/engine/engine.ts:140`. Where a report uses
package-relative shorthand (`bootstrap/src/app/...`), the package root is
`apps/zcode-cli/packages/`.

---

## 1. The shape of the repository

- **The fork's own scaffold commit (`c2a2193`) is 100 % additive:** 37 files added, 823 insertions,
  **0** deletions or edits to upstream files, and it does not touch `bootstrap` or `dynamic-workflow`
  at all (`s2-driver-seam.md` §0). The Projects packages have grown well past that commit since; the
  statement is about the commit, not about the tree as it stands now.
- Upstream history is squashed (4 commits total). The locked decision is **merge** from
  `upstream/main`, not rebase (`specs/projects/00-overview.md` D7).
- `architecture-policy.yaml` declares one module, `zcode-cli` (`roots: [apps/zcode-cli]`,
  `managed: false`), so new packages need no module registration and no layer rules apply to them.
- The root workspace glob already includes `apps/zcode-cli/packages/*`, so one root
  `pnpm install` covers new packages (`specs/projects/00-overview.md` §5).
- `apps/zcode-cli` runs `turbo run typecheck` / `turbo run lint`; each new package must expose
  `typecheck` and `lint` scripts to participate (all five do).

---

## 2. ZCode's existing workflow run path — 8 steps

Each step names the file that owns it. The full ASCII map is in [§8](#8-the-run-path-as-one-diagram).

| # | Step | Key file |
|---|---|---|
| 1 | **Model tool call.** `CreateWorkflow` entry, input XOR validation, skill gate, approval prompt, then `port.submit` | `apps/zcode-cli/packages/core/src/tool/handlers/create-workflow.ts:314` (entry), `:63` (handler), `:141-183` (`submit`); normalization in `core/src/tool/handlers/create-workflow-source.ts:121` (the only disk read) |
| 2 | **Run creation.** `submitDynamicWorkflowRun` mints `runId = "dwfrun-<uuid>"`, compiles the script **exactly once**, inserts the registry entry before launch, then launches fire-and-forget | `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-submit.ts:79` (`submit`), `:274` (`startNewRun`), `:556` (`compileOnce`), `:622` (`mintRunId`) |
| 3 | **Launch assembly.** Seat gate, journal sequence capture, `emit → onRunEvent`, and the production driver construction — **the single construction site** | `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-launch.ts:139` (function), `:163` (seat gate), `:191` (`createAgentRuntimeWorkflowDriver`) |
| 4 | **Engine construction.** `runWorkflowScript` builds the sink proxy, calls `makeDriver(sink)`, then `new WorkflowEngine(...)`; this is the moment the `dwf_run` row is written | `apps/zcode-cli/packages/dynamic-workflow-runtime/src/harness.ts:192` (function), `:214` (`makeDriver`), `:215` (engine); row INSERT at `dynamic-workflow/src/engine/engine.ts:310` |
| 5 | **Sandbox child.** Entry file written under `<cwd>/.zcode/workflow-runs/<runId>.mjs`, then spawned into a `vm` realm that sees only ES intrinsics + `__host` | `dynamic-workflow-runtime/src/child-entry-file.ts:60`, `:261` (spawn in `harness.ts`), `child-source.ts:16`, protocol `protocol.ts:158` |
| 6 | **Engine loop.** Deterministic state machine; per-actor FIFO admission, journal replay, concurrency gate, repair/nudge | `dynamic-workflow/src/engine/engine.ts:140`, `engine/scheduler.ts:43` (`AskScheduler`), `:116` (`admitAsk`), `:182` (`admitLive`), `:398` (caps gate), `engine/scheduler-submit.ts:35/:42/:103` (accept/reject/nudge) |
| 7 | **Drivers downward (Boundary B).** Sessions, asks, world reads, artifacts, escalations | `bootstrap/src/app/workflow-driver.ts:592` (factory), `:112` (class), `:203` `createActorSession`, `:318` `startAsk`, `:369` `respondToSubmit`, `:461` `executeWorldRead`, `:474` `executeArtifactPublish` |
| 8 | **Journal, projections, UI.** Every engine event is appended to the journal *and* emitted with the same object reference; projections reduce it into the UI | `adapters/src/storage/session-store/repositories/dwf-journal.ts:75` (store), `:386` (`appendEvent`); `bootstrap/src/app/dynamic-workflow-run-launch.ts:193-220` → `dynamic-workflow-run-progress-sink.ts:43` → `bootstrap/src/zcode-protocol-v4/product-projection.ts:4325`; UI `packages/ui/src/app-shell/WorkflowRunSidePane.tsx:441` |

Non-model entry points into the same substrate (relevant because a mission runner is not a model turn):

- `DynamicWorkflowRunPort.submit` accepts arbitrary `scriptText`; only two callers exist today
  (`core/src/tool/handlers/create-workflow.ts:141`, `core/src/runtime/methods/dynamic-workflow-run-start.ts:174`).
  The run service is **not exported** from `bootstrap/src/index.ts`, so reusing it costs one
  upstream edit (`s2-driver-seam.md` §6).
- `runWorkflowScript` from `dynamic-workflow-runtime/src/harness.ts:192` is a public export and
  needs **zero** upstream edits. The in-tree precedent is the snippet service
  (`bootstrap/src/app/dynamic-workflow-snippet-service.ts:129-149`), which calls it with its own
  hand-written driver literal (`:220-245`) and an in-memory journal (`:242`).

---

## 3. Engine, journal and caps facts

**The engine is pure by contract.** `dynamic-workflow/src/engine/engine.ts:1-19` states the core does
**no I/O, no clock, no randomness**; everything that varies is either journaled or pinned by
"per-site ordinal + per-actor FIFO `actorSeq`".

- **Identity.** An instance is `siteId@ordinal`; an actor is creation-site × ordinal. The single
  ordinal mint is `engine.ts:685-691`, which also stamps the instance's birth phase.
- **Replay.** Every host call first consults `(siteId, ordinal)`; a hit short-circuits with a
  defensive `inputHash` check that **fails the whole run** on mismatch
  (`engine/scheduler.ts:128-135`, `engine-artifacts.ts:104-110`).
- **Single event funnel.** `record()` (`engine.ts:705-715`) appends to the journal and calls
  `driver.emit(stamped)` with the *same object by reference*; the bootstrap's sequence capture
  verifies ordering by reference equality (`dynamic-workflow-run-launch.ts:182-189`).
- **Settlement.** `engine/engine-settlement.ts` — `settleCompleted:22`, `settleStopped:41` (four
  reasons plus `supersededBy` in one write), `settleFailed:66`, shared `finishRun:81-91`
  (`updateRunStatus` + `run-settled` + `driver.dispose()` once, first-wins).
- **Durability at admission.** `admitLive` writes `putNode(status:"running")` at admission time
  (`scheduler.ts:213-223`), so a crash mid-execution is resumable.
- **Repair / nudge budgets** are per ask node: `REPAIR_ATTEMPTS = 3`
  (`engine/types.ts:941`) and `NUDGE_ATTEMPTS = 1` (`:944`), initialised in `admitLive`
  (`scheduler.ts:205-206`). Exhausting them fails **the ask**, not the run
  (`scheduler.ts:503`) — the script may `try/catch`.
- **`Caps` is one field** (`{ maxConcurrency: number }`, `engine/types.ts:119-121`) and is enforced
  at **three deliberately distinct points**: ask dispatch (`scheduler.ts:398`, read live through a
  getter at `engine.ts:279-284`), model-request seats for already-running asks
  (`workflow-seat-gate.ts:69`, created at `dynamic-workflow-run-launch.ts:163`), and a
  process-level provider governor (`workflow-concurrency-governor.ts`, wired at
  `bootstrap/src/app/create-app.ts:589`). Effective concurrency = `min(run caps, shared live cap)`.
- **Ceiling.** `resolveWorkflowConcurrencyCeiling()` = `max(1, min(16, availableParallelism() − 2))`
  (`bootstrap/src/app/workflow-concurrency-ceiling.ts:21-28`).
- **Retune.** `setMaxConcurrency` (`engine.ts:579-591`) replaces the caps object, calls
  `journal.updateRunCaps`, records `run-caps-changed`, and on a **raise** calls
  `scheduler.pumpAll()`. Lowering never recalls in-flight asks.
- **`JournalStorePort`** (`engine/types.ts:878-912`) has two implementations: `InMemoryJournalStore`
  (`engine/journal-memory.ts:31`, `structuredClone` on every boundary, SQL-identical sequence and
  cursor semantics pinned by a shared contract test) and `SqliteDwfJournalStore`
  (`adapters/src/storage/session-store/repositories/dwf-journal.ts:75`, constructed by
  `createDwfJournalStore(db)` at `:434`). Production never falls back to in-memory: a missing
  journal store logs a visible degradation instead (`bootstrap/src/app/dynamic-workflow-run-journal.ts:38-56`).

---

## 4. The driver port (Boundary B) and why it is the seam

**The port.** `WorkflowDriver` (`dynamic-workflow/src/engine/types.ts:285-328`) has **9 members**,
2 of them optional (`executeArtifactPublish?` `:317`, `dispose?` `:327`):
`createActorSession`, `startAsk`, `respondToSubmit`, `cancelAsk`, `executeWorldRead`,
`executeArtifactPublish?`, `journal`, `emit`, `dispose?`.

**Why it is the seam — four measured reasons:**

1. **Exactly one production construction site:** `dynamic-workflow-run-launch.ts:191`. A second
   implementation can be dropped in without a driver-selection branch anywhere.
2. **An in-tree precedent for a hand-written literal:** `dynamic-workflow-snippet-service.ts:220-245`
   already builds a minimal driver object outside the run service. The port is small enough to
   re-implement directly.
3. **The ZCode coupling is concentrated, not spread.** The only ZCode-specific dep is
   `runtimeFactory: ActorRuntimeFactory` (`workflow-driver-types.ts:149`), which must return a
   `@zcode/core` `AgentRuntime` (664 lines, ~91 members; the driver stack touches only 7 of them).
   Everything else — `journal`, `emit`, `fileSystemPort`, `executionPort`, `cwd`, `logger`,
   `clock` — is generic. Tool registration for `submit_result`/`escalate` lives in `@zcode/core`
   (`core/src/runtime/helpers/runtime-tools.ts:57-65`), so a non-ZCode runtime must register its
   own equivalent.
4. **The lowest-conflict option.** The alternative seam (a driver-selection branch at
   `dynamic-workflow-run-launch.ts:191`) edits files upstream actively rewrites — `workflow-driver.ts`
   is split against a 400-line lint gate (`:4-6`) and gets re-split routinely, so every re-split
   conflicts. A standalone driver in a new package never conflicts.

**The seam we chose** (`s2-driver-seam.md` §7 recommendation, option **c1**):
implement `WorkflowDriver` in a new module and drive `runWorkflowScript` directly. Zero upstream
edits; compile with the public helpers of `@zcode/dynamic-workflow`
(`dynamic-workflow/src/index.ts:26/35/37/141/165`); durable journal via `createDwfJournalStore(db)`
(`dwf-journal.ts:434`) or `InMemoryJournalStore` (`dynamic-workflow/src/index.ts:172`).

**Where the binding lives** is fixed by the specs, and the implementation follows:
`apps/zcode-cli/packages/projects-mission/src/workflow-driver.ts`, not `dsh-executor`
(`specs/projects/40-dsh-executor.md:11`, `specs/projects/00-overview.md:80`, `:84-85`).

**Method-by-method mapping onto the ACP adapter** (`40-dsh-executor.md` §3, `s2-driver-seam.md` §7.1):

| `WorkflowDriver` member | Adapter / ACP call |
|---|---|
| `createActorSession(actor, persona, seed?)` | `createSession(spec)` → `session/new` with the task's worktree as `cwd` |
| `startAsk(session, instance, message)` | `sendMessage(sessionId, text)` → `session/prompt` |
| `respondToSubmit(instance, verdict)` | no direct ACP call; `reject`/`nudge` become follow-up prompts |
| `cancelAsk(instance)` | `cancel(sessionId)` → `session/cancel` (notification) |
| `executeWorldRead(op, args)` | pure local (`files.*`, `git.*`, `world.run`) |
| `executeArtifactPublish?(request)` | pure local |
| `journal` / `emit` | pass-through from deps |
| `dispose?()` | `destroySession` per session, then `dispose()` |

**The design question the seam forced.** `AgentRuntimeWorkflowDriverDeps.cwd` is a **single
run-level** value (`workflow-driver-types.ts:116`) and it is what every `executeWorldRead` path
resolves against. But one git worktree per task means a different `cwd` per worker. Options were
(a) one workflow run per task, or (b) keep one run and let the runner own all git facts. The frozen
decision D10 picked a variant of (b); [§10](#10-contradictions-found) records how the implementation
resolves the run-level `cwd`.

---

## 5. DeepSeek Harness ACP facts

Measured against `dsh 0.2.0-rc.2`, Node v24.20.0, transport `dsh --profile acp` (ACP v1 over
NDJSON JSON-RPC on stdio). Evidence is raw wire traffic plus host-side filesystem assertions.

### 5.1 Protocol surface

```
initialize            = "initialize"
authenticate          = "authenticate"
session/new           = "session/new"
session/list          = "session/list"
session/resume        = "session/resume"
session/close         = "session/close"
session/prompt        = "session/prompt"
session/cancel        = "session/cancel"                    (NOTIFICATION, no id)
session/set_config_option = "session/set_config_option"
session/update        = "session/update"                    (server -> client NOTIFICATION)
session/request_permission = "session/request_permission"    (server -> client REQUEST)
PROTOCOL_VERSION      = 1
```

- `session/new` params: `{cwd, mcpServers, additionalDirectories}`. `cwd` is **required and must be
  absolute**. `additionalDirectories` is always rejected (`-32602 … is not supported`) — one
  workspace per session.
- `session/prompt` params: `{sessionId, prompt:[{type:"text", text}]}`. Accepted block types are
  `text`, `resource_link`, and `image` only when advertised. Result:
  `{stopReason}` (`completed→end_turn`, `interrupted→cancelled`, `aborted/blocked/error→end_turn`).
- `session/update` discriminators observed: `agent_thought_chunk`, `agent_message_chunk`,
  `tool_call`, `tool_call_update`, `usage_update`, plus a documented `config_option_update`.
  `kind` is always the literal `"other"` and `title` carries the raw tool name.
- SSE is not supported (`mcpCapabilities` advertises `http` only). `promptCapabilities.image` is
  `false` in this deployment (no durable attachment store mounted), so inline images are rejected.
- **Stdout carries protocol traffic only**; `initialize` reports `agentInfo.version` `"0.0.1"`
  regardless of the real DSH version — do not gate capabilities on it.
- `EOF` on the client's stdin is the clean shutdown signal (`exitOnStdinEnd`); the server exits 0.
  `SIGKILL` leaves sessions persisted and resumable but skips teardown and leaves `session.lock`
  files behind.

### 5.2 Result submission through MCP — works end to end (S3)

A stdio MCP server passed in `session/new` is accepted, spawned, its tools registered, and the
model's call reaches the server with the exact JSON arguments and the configured `env`/`cwd`.

Working shape (verbatim from the probe):

```json
[{"name":"probe",
  "command":"/home/radu/.config/nvm/versions/node/v24.20.0/bin/node",
  "args":["/tmp/acp-probe/mcp-server.js"],
  "env":[{"name":"PROBE_TAG","value":"zcode"}]}]
```

Shape rules that matter:

- stdio entries have **no `type` field** — the discriminator is its absence.
- `command` must be an **absolute path**; `args` is `string[]`; `env` is an **array of
  `{name, value}`**, not a map.
- **Malformed entries are silently dropped**, not rejected: an entry missing `env` (stdio) or
  `headers` (http) is discarded and `session/new` returns a normal `sessionId` with **zero** MCP
  servers attached. Always send the complete shape and verify attachment out of band.
- **Each attached server is spawned twice** (unattached probe transport + attached client). With
  `failOnStartupError: true`, an MCP startup failure fails the whole `session/new` with `-32603`.
- DSH probes the draft `server/discover` method (protocol `2026-07-28`) first and falls back to
  legacy `initialize` (`2025-11-25`) when the server answers `{}`. A `submit_result` bridge must
  tolerate either handshake.
- Tool names become `mcp__<serverName>__<rawName>`, with server names sanitised and hashed when
  they do not match `^[A-Za-z0-9_-]{1,32}$`. The model must be told the *mangled* name. MCP
  resources and prompts have no DSH consumer — tools only.

### 5.3 Resume across restart — works, with one sharp edge (S4)

After `SIGKILL` of the ACP server, a fresh server lists the session (`session/list`) and
`session/resume` restores **full conversational memory** of the earlier turn, emitting no replay of
historical updates.

**The sharp edge:** `session/list` **never reports a session that is active on the same
connection** — it returns `{"sessions":[]}` even while that session is live, and the session
reappears only after it is closed or the server dies. `session/list` is a crash-recovery /
reconciliation primitive, not a "list running workers" call; track `sessionId`s client-side.
`session/resume` also rejects when the session is already active, and requires the `cwd` to match
the persisted one (compared by `realpath` where possible).

### 5.4 Models and cwd (S5)

The authoritative catalogue comes from `session/new → configOptions`, never from `--dump-config`
(which shows the deployment default `deepseek-official/deepseek-flash`, while new sessions actually
get `deepseek-official/deepseek-v4-flash`).

| provider | model id | display name | ACP `value` |
|---|---|---|---|
| `deepseek-official` | `deepseek-v4-flash` | `deepseek-v4-flash` | `"[\"deepseek-official\",\"deepseek-v4-flash\"]"` (default) |
| `deepseek-official` | `deepseek-flash` | `DeepSeek-V41-Flash` | `"[\"deepseek-official\",\"deepseek-flash\"]"` |
| `deepseek-official` | `deepseek-v4-pro` | `DeepSeek-V4-Pro` | `"[\"deepseek-official\",\"deepseek-v4-pro\"]"` |

`reasoning_effort` ∈ `off|low|high|max`, default `high`, and its selector value is a **plain
string**. The `model` value is an opaque **JSON-encoded string**, not `provider/model`. The
catalogue **shifts between calls** (after a switch, a previously advertised entry disappeared), so
never cache it and handle a `currentValue` that is no longer in `options`. Config changes are
per-session; two sessions run concurrently on one connection.

`cwd` from `session/new` **is** honoured as the agent's base directory for relative paths, and it is
also the sandbox root (see §5.5).

### 5.5 The sandbox gotcha — tool success is not proof of a side effect

Under the default `workspace-write` mode, **the effective writable root is the `session/new` cwd,
not the server process cwd** (proven by running the server with a process cwd different from the
session cwd). Path behaviour inside the `bash` tool:

| Path | Behaviour |
|---|---|
| under the **session cwd** | real, read-write, persists on the host |
| `/tmp/**` outside the session cwd | **private tmpfs**: writes return `rc=0` and read back *inside* the sandbox, but **vanish** — silently |
| `/var/tmp`, `$HOME`, `/etc`, rest of `/` | `Read-only file system`, `rc=1`, surfaced as `[sandbox: file access denied under workspace-write mode]` |

The asymmetry is the trap: `/tmp` is the natural scratch location and it is exactly the silent one.
`tool_call_update{status:"completed"}` is therefore **not** proof of an artifact — assert on the
host, require artifacts under the session cwd, or run workers with
`DSH_PERMISSION_MODE=danger-full-access` (which makes out-of-workspace writes land for real and
sets the approval policy to `never`).

Two further facts an implementer must not assume away:

- **The fs `write` tool is not sandboxed the same way as bash.** A `write` to an absolute path
  outside the workspace **really landed** and **no `session/request_permission` was emitted**. So a
  `workspace-write` worker is not confined to its cwd via the fs tools.
- **`session/request_permission` never fired in ~10 probe runs**, even with `approval.policy: "ask"`.
  Implement the handler (`allow_once` / `reject_once`), but do not rely on it as a control surface.
  In this build the *filesystem* is the control surface.

---

## 6. Git facts (measured, git 2.47.3)

- **A worktree outside the repository tree leaves the source repo byte-for-byte untouched**, and
  `git -C <main> status --porcelain` stays empty.
- **Separate worktrees are index-safe:** 5 workers × 30 concurrent commits → **0** `index.lock`
  errors. **Same-worktree writers are not:** 3 writers in one worktree → **43** failures out of 120
  commits (`fatal: Unable to create '<repo>/.git/worktrees/<id>/index.lock': File exists.`), plus a
  distinct ref-level failure (`cannot lock ref 'HEAD'`). Rule: **one writer per worktree**.
- **A worktree inside the repo is not ignored** — it shows as `?? inside-wt/`, `check-ignore`
  exits 1, and `git add -A` emits `warning: adding embedded git repository`, i.e. an agent running
  `git add .` would stage the whole worktree as a gitlink. Worktrees must live outside the repo.
- **Conflicts:** `git merge` exits `1` and writes the conflict report to **stdout** (stderr is
  empty). The correct predicate is `MERGE_HEAD exists AND git ls-files -u is non-empty`; a dirty
  `status` is ambiguous (a legitimate `merge --no-commit` looks dirty) and a clean `status` says
  nothing about unmerged commits.
- **Pre-flight without touching anything:** `git merge-tree --write-tree --name-only <A> <B>` exits
  `0` (clean, stdout is the tree OID) or `1` (conflict: tree OID, conflicting paths, then human
  `CONFLICT (…)` lines — all on stdout). Read-only, no worktree, no lock.
- **Integration:** `--no-ff --no-edit -m "<taskId>: <subject>"` gives one auditable merge commit per
  task, so `git log --first-parent` on the mission branch is a clean task ledger. Dependency order
  determines which branch becomes "ours" in a conflict, so integrate exactly in dependency order.
- **`--git-dir` is a footgun.** Run without `--work-tree`, git treats the **process cwd** as the
  working tree; the spike produced a bogus "every file deleted" status over an unrelated directory
  at exit 0. Use `-C <path>` exclusively.
- **Status parsing:** use `--porcelain=v2 --branch -z`. v1 C-quotes paths with spaces and renders
  renames ambiguously in line mode. `status` exits `0` even on a dirty tree — never use its exit
  code as a cleanliness test.
- **Diff:** three-dot (`base...ref`) is the "what did this worker change" form (it diffs against the
  merge base and stays correct after the base moves); two-dot is only for "commits ahead".
- **Removal:** `worktree remove` refuses a dirty worktree with exit `128`, but **silently removes a
  clean worktree that has unmerged commits (exit 0)**. Uncommitted *work* is protected; unmerged
  *commits* are not. The branch survives, which is the only safety net — so branch cleanup must be a
  separate, deliberate step and `--force` must never be automatic.
- **Locks needed:** a global per-repo mutex for `worktree add/remove/prune/lock/unlock/move`, a
  per-integration-worktree mutex for `merge`/`merge --abort`, and a timeout on every call (a killed
  git can leave `index.lock`). Read-only facts need no lock.
- **Shallow clones** can create worktrees but `merge-base` has nothing to walk, so three-dot diffs
  and `merge-tree` degrade. Do not use a shallow clone as the mission repo.
- **`git config` inside a worktree writes the SHARED repo config** unless
  `extensions.worktreeConfig` is on. Pin config per invocation with `-c key=value` instead.

---

## 7. Services, RPC, UI and persistence facts

### 7.1 Services and RPC

- A service is three primitives: a `ServiceDescriptor<T>` (`{channelName}`), the channel name from
  the central `ServiceChannels` table (`packages/shared/src/channels.ts:75-152`), and the
  server-side `ServiceCollection` (`packages/services/src/collection.ts:9-42`).
- **There is no DI container and no decorators.** The style is `createXService(options?)` with the
  real adapter as a default (`packages/services/src/git/gitService.ts:170-175`). The single
  composition root is `createLocalServices()` (`packages/services/src/node.ts:1285`), whose
  registration chain runs ~165 lines from `node.ts:2434`.
- **Adding a method to an existing service requires no registration at all.** `ProxyChannel`
  reflects the service object at runtime (`packages/rpc/src/proxy-channel.ts:46-97`): a property
  named `on*` becomes an event, `onDynamic*` a dynamic event, and **any other function an RPC
  method**. Adding a *new* service is the case that needs the five-file edit (channels, descriptor
  + browser-safe export, implementation + registration, client proxy, accessor).
- Hazard: a method must not be named `onSomething` — it would be classified as an event.
- Two protocols coexist: the legacy `packages/shared/src/zcode-protocol/index.ts` (scheduled for
  deletion per its own header `:7-18`) and the current
  `packages/shared/src/zcode-protocol-v4/` (54 files). v4 commands are declared by one entry in
  `commandPayloadSchemas` (`commandPayloadSchemas` map at
  `packages/shared/src/zcode-protocol-v4/command.ts:44`); the union is derived from the object.
- Run-projection read faces on the wire: `workflowRunEvents`, `workflowRuns`,
  `workflowRunArtifacts`, `workflowRunArtifactData`, `workflowRunArtifactRead`,
  `workflowRunWorkspace`, `workflowRunNodeResult`
  (`bootstrap/src/zcode-protocol-v4/v4-gateway.ts:1609-1776`), with commands
  `cancelBackgroundWork`, `resumeWorkflowRun`, `amendWorkflowRunSettings`.

### 7.2 UI seams for a new top-level area

- **There is no router.** The top-level area switch is a hardcoded string union:
  `WorkspaceMainView = "chat" | "automations" | "plugin-store"`
  (`packages/ui/src/app-shell/types.ts:120`), held in `App.tsx:826` and rendered by a **ternary
  chain** in `packages/ui/src/app-shell/WorkspaceShellLayout.tsx:1747/1800/1824`.
- Sidebar entries are **hardcoded JSX** rows (`packages/ui/src/WorkspaceSidebar.tsx:1319-1348`).
- The shell is deliberately **not unmounted** when another area opens; a new area must live inside
  it rather than replace it (`packages/ui/src/root/RootWorkspaceContent.tsx:107-123`).
- The hooks rule (components reach services through `packages/ui/src/hooks/`, never directly) is a
  **convention backed by review, not CI**: `architecture-policy.yaml:43-45` marks `ui` as
  `managed: false` and `:65` sets `managedOnly: true`.
- Typography is a repository-wide mandatory constraint (`text-ui-*` only), colour is semantic
  tokens only, radius is hierarchical (`DESIGN.md:9-15`, `:167-176`, `:289-341`).
- i18n is two flat maps with no codegen and no fallback extraction
  (`packages/ui/src/i18n/locales/en-US.ts`, `zh-CN.ts`).
- Naming hazard: `gitWorktreeReviewSourceId` / `gitWorktreeChangeSummary` mean *working tree*, not
  git worktree (`packages/shared/src/git.ts:7`). A new worktree feature must not extend those names.

### 7.3 Git capabilities in the app

Implemented in `packages/services/src/git/`: status/dirty/ahead-behind, diff, ignored paths, branch
list/switch/create-and-switch, commit graph, branch comparison, stage/unstage/discard, commit, push,
identity, and checkpoints.

**Missing for worktree lifecycle** (all confirmed absent, not partial): create worktree, list
worktrees, remove/prune worktree, **merge / integrate a branch**, rebase. Conflict *reporting*
exists; conflict *resolution* does not. Worktree *detection* is partial and implemented
(`GitWorkspaceRepositoryKind = "not-repository" | "main-tree" | "linked-worktree"`,
`packages/shared/src/git.ts:131`).

Independently corroborated: the workflow runtime throws
`workflow agent isolation 'worktree' is not implemented yet.`
(`apps/zcode-cli/packages/bootstrap/src/app/script-workflow-runtime.ts:282-283`) even though the
contract already declares the option (`contracts/src/workflow/script.ts:42`).

**Consequence:** worktree-backed projects is net-new service work, not wiring.

### 7.4 Workspace identity

`AGENTS.md:70-73` fixes the rule: `workspaceIdentity` is for identity isolation;
`workspacePath` is for file operations, command cwd, git and path display. The identity key is
uniformly `workspaceIdentity?.trim() || workspacePath`, and it is enforced by a **repeated idiom,
not one shared function** — it appears in the task index (`taskIndexRepo.ts:195`), checkpoint
manifests (`gitCheckpointStore.ts:36-42` via `getWorkspaceHash`, `paths.ts:196-201`), session
snapshot dirs, agent-runtime teardown, window/task controller addresses, draft registries, host task
trackers, proxy subscriptions and activity tracking.

If two worktree **paths** mapped to the **same identity**, every one of those structures would
collide (shared task lists, shared checkpoint directories, merged runtimes, cross-worktree drafts).
Correctly path-keyed things that must stay path-keyed: git cwd, file operations, command cwd, path
display, checkpoint scope inside the repo, auto-refresh watch paths.

### 7.5 Persistence

**Driver.** Node's built-in `node:sqlite` `DatabaseSync` everywhere — no `better-sqlite3` in the
tree. Three import spellings exist and the difference is deliberate: bundlers rewrite
`node:sqlite` and must be defeated (services repos use
`require("node:sqlite") as typeof import("node:sqlite")`, the tasks DB uses
`createRequire(import.meta.url)("node:sqlite")`, the CLI session store uses a bare `import`).
Version tracking is by a **ledger table inside the DB**, never `PRAGMA user_version` (zero matches
tree-wide).

**App-owned databases — exactly two:**

| # | Path | Opened by | Stores |
|---|---|---|---|
| 1 | `~/.zcode/v2/tasks-index.sqlite` | `TaskIndexRepo` (`packages/services/src/session/taskIndexRepo.ts:524`), `OffPeakTaskRepo`, `AutomationRepo` | task list/pin/archive/grouped view, automations + runs, off-peak tasks; ledger `tasks_schema_migration` |
| 2 | `~/.zcode/cli/db/db.sqlite` | `SqliteSessionStore` (`apps/zcode-cli/packages/adapters/src/storage/session-store/sqlite-session-store.ts:248`) | sessions, messages, parts, todos, usage, inputs, script-workflow runs, **the DWF journal**, local settings; ledger `schema_migration` |

**DWF journal tables** (all in `db.sqlite`, migration `0019_dwf_journal`, DDL at
`adapters/src/storage/session-store/migrations.ts:831-910`):

| Table | Key columns |
|---|---|
| `dwf_run` | `id` PK (`dwfrun-<uuid>`), `parent_session_id`, `cwd`, `name`, `script_text`, `script_hash`, `args_json`, `tool_call_id`, `resumed_from`, `caps_max_concurrency` NOT NULL, `spent_tokens`, `status` CHECK in `('pending','running','completed','failed','cancelled')`, `result_json`, `failure_json`, `time_created`, `time_updated`; index `dwf_run_cwd_idx(cwd, time_updated)` |
| `dwf_actor` | `id` autoincrement, `run_id` → `dwf_run(id)` ON DELETE CASCADE, `site_id`, `ordinal`, `name`, `persona_json`, `resolved_model`, `session_id`, timestamps; **`unique(run_id, site_id, ordinal)`** |
| `dwf_node` | `id` autoincrement, `run_id` → cascade, `site_id`, `ordinal`, `kind` CHECK in `('ask','world-read','world-run','report','artifact')`, `actor_site_id`/`actor_ordinal`/`actor_seq`, `input_hash` NOT NULL, `input_json`, `status` CHECK in `('running','completed','failed')`, `result_json`, `error_json`, `stats_json`, `message_boundary`, `artifact_id`; **`unique(run_id, site_id, ordinal)`** |
| `dwf_event` | `id` autoincrement, `run_id` → cascade, `sequence`, `type`, `payload_json`, `time_created`; **`unique(run_id, sequence)`**; expression index `dwf_event_artifact_idx(run_id, json_extract(payload_json,'$.artifactId'), sequence)` |

There are **no other `dwf_*` tables**. Physical ↔ logical status mapping is a codec, not a
migration (`encodeRunSettlement` / `decodeRunSettlement`, `dwf-journal-codecs.ts:77-122`).

Durability mechanics: `foreign_keys = on` on every open; WAL is mandatory for a file-backed DB
(refusal is an error, not a silent fallback) — `migration-runner.ts:139-148`. `appendEvent`
allocates `sequence` as `coalesce((select max(sequence)+1 …), 0)` **inside the same INSERT** because
multiple agent processes share one WAL file (`dwf-journal.ts:386-410`). The dwf journal itself opens
no transactions — the port has no transactional surface.

**Adding a third database is possible but has no generic helper.** `runTasksDatabaseMigrations` and
`runSqliteSessionMigrations` share only the error types in `@zcode/shared`; each is hard-wired to
its own frozen migration list. The design is nevertheless additive: every DB is keyed by an absolute
path, the ledger lives inside the file, and nothing enumerates "the set of app databases". The
read-only storage-catalog scanner classifies files by regex
(`packages/services/src/storage/domain/storageCatalog.ts:55-58`), so a new file under `~/.zcode/v2/`
is picked up automatically while a new subdirectory needs a pattern added.

---

## 8. The run path as one diagram

Reproduced from `discovery-a-workflow.md` §8. Paths inside the diagram use the report's
package-relative shorthand; every package root is `apps/zcode-cli/packages/`.

```
MODEL
  │  tool call: CreateWorkflow{script | saved | path, name?, args?, max_concurrency?, subagent_model?}
  ▼
┌─ core/tool/handlers/create-workflow.ts ────────────────────────────────────────────────┐
│ entry :314   validateInput :333 (XOR, args⇔path)   resolveInput :338 (skill gate +      │
│              create-workflow-source.ts:121 = the one disk read)                         │
│ prepareApproval :302 → confirmation dialog (alwaysAsk)                                  │
│ handler :63 → analyzeScript :77 (single-slot memo) → port.submit :141                   │
└────────────────────────────────────────────┬────────────────────────────────────────────┘
                                             ▼ DynamicWorkflowRunPort.submit
┌─ bootstrap/src/app/dynamic-workflow-run-service.ts:297 ────────────────────────────────┐
│ submit :372 → dynamic-workflow-run-submit.ts:79  → startNewRun :274                     │
│   mintRunId :638 "dwfrun-<uuid>" · caps() :281 clampRunConcurrency                     │
│   compileOnce :556 = ONE ts.Program → sites + askSchemas + askSpecs +                  │
│                      actorSubmitProfiles + lowerWorkflow + sha256 scriptHash :630       │
│   registry entry :323 (before launch) → launch (fire-and-forget) :355                  │
└────────────────────────────────────────────┬────────────────────────────────────────────┘
                                             ▼
┌─ bootstrap/src/app/dynamic-workflow-run-launch.ts:139 ─────────────────────────────────┐
│ seatGate {limit: caps.maxConcurrency} :163   sequenceCapture :189   emit→onRunEvent :193│
│ createAgentRuntimeWorkflowDriver :191  (workflow-driver.ts:592)                         │
│ actorRuntimeFactory :257 (child AgentRuntime per actor; model policy; session persist)  │
└────────────────────────────────────────────┬────────────────────────────────────────────┘
                                             ▼ runWorkflowScript (dynamic-workflow-runtime/src/harness.ts:192)
┌─ ENGINE + SANDBOX ─────────────────────────────────────────────────────────────────────┐
│ new WorkflowEngine :215 ──► journal.createRun ──► dwf_run INSERT   engine.ts:310       │
│   run-started :372 · run-launched :375 (anchor/phaseNames/model/scriptPath)             │
│ sink proxy :198 ⇄ driver  ◄── Boundary B                                                │
│ spawn child :261  entry file <cwd>/.zcode/workflow-runs/<runId>.mjs (child-entry-file:60)│
│   vm realm (child-source:16) + __host shims :163 + frozen args :159                     │
│   NDJSON: create-actor | request | event | complete   (protocol.ts:158)                 │
│ bridge :325 single-writer finalize ; abort → engine.stop(reason) :367                   │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ engine.ts:140  WorkflowEngine (no I/O, no clock, no randomness)                         │
│   ask :456 ─► AskScheduler.admitAsk (scheduler.ts:116)                                  │
│        journal hit? ─ yes ─► inputHash check :131 → cached settle (replay gate :355)    │
│                       └ no ─► pendingLive → actorSeq :165 → admitLive :182              │
│              admitLive: putNode(running) :213 (admission-time durability)                │
│              pumpActor :394  ── caps.maxConcurrency gate :398 ──► activeAsks            │
│              dispatch :405 → ensureSession :447 → driver.startAsk :444                  │
│   typed ask: submit_result → REPAIR_ATTEMPTS=3 (scheduler-submit.ts:39)                 │
│              turn ended  → NUDGE_ATTEMPTS=1  (scheduler-submit.ts:101)                  │
│   setMaxConcurrency :579 → replace caps + journal.updateRunCaps + run-caps-changed      │
│                            + pumpAll() on raise :589                                    │
│   settlement: engine-settlement.ts — completed :22 / stopped :41 / errored :66          │
│               finishRun :81 = updateRunStatus + run-settled + driver.dispose()          │
└──────────┬──────────────────────────────────────────────────────┬──────────────────────┘
           │ every event                                          │ artifact.* bytes
           ▼                                                      ▼
┌─ JOURNAL (SQLite, one file) ──────────────┐   ┌─ TOOL-ARTIFACT STORE (files) ──────────┐
│ ~/.zcode/cli/db/db.sqlite                 │   │ ~/.zcode/cli/artifacts/<sess>/<file>   │
│ opened at sqlite-session-store.ts:248     │   │ NodeToolArtifactStore  storage/index:41│
│ workflowJournalStore() :996               │   │ uri zcode-artifact://<sess>/<id>  :82  │
│ SqliteDwfJournalStore  dwf-journal.ts:75  │   │ write  workflow-artifact-publish.ts:417│
│  dwf_run :831  dwf_actor :858             │   │ read   dynamic-workflow-run-artifact-  │
│  dwf_node :874  dwf_event :899            │   │        read.ts:56 (journal row → uri)  │
└──────────┬────────────────────────────────┘   └────────────────────────────────────────┘
           │ appendEvent / emit (same object)
           ▼
┌─ PROJECTIONS ──────────────────────────────────────────────────────────────────────────┐
│ run-launch.ts:193 onRunEvent → progress-sink.ts:43 (session identity gate)              │
│   → SessionEventType.DynamicWorkflowRunProgress  contracts/session.events.ts:143        │
│   → product-projection.ts:4325 → reduceWorkflowRunsState (shared reducer:116)           │
│   → diffWorkflowRunsState → state.updated deltas (key-level increments)                 │
│   → sessions-index-projection.ts:46 deriveSessionWorkflowActivity (sidebar)             │
│   → TUI mirror tui/src/app-workflow-mirror.ts:67 (same reducer)                         │
│ cold start: replayProgressForSession → dynamic-workflow-run-replay.ts:43                │
└──────────┬─────────────────────────────────────────────────────────────────────────────┘
           ▼ v4 gateway (v4-gateway.ts) + commands (interaction-background.ts)
┌─ UI ───────────────────────────────────────────────────────────────────────────────────┐
│ WorkflowTimeline.tsx:114 (stations=phases, pills=agents) · WorkflowAgentPill.tsx:104    │
│ get-workflow-run-situation.tsx:47/:140 · get-workflow-run-roster.tsx:47                 │
│ WorkflowRunSidePane.tsx:441  Stop :212 / Resume :242 / Artifacts :419 / Settings :233   │
│ hooks: useWorkflowRunArtifacts:182 · ArtifactBytes:81 · Workspace:40 · Summaries:46      │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

Shell composition for a new top-level UI area (`discovery-b-services-ui.md` §4.1):

```
desktop: packages/desktop/src/renderer/src/main.tsx:326-351   appRoot?.render(...)
web:     packages/web/src/main.tsx                            root.render(...)
  └─ packages/ui/src/Root.tsx:1-1089             orchestration: tabs, remote workspaces, providers
       └─ packages/ui/src/root/RootShell.tsx:6-17     <div className="relative h-dvh"> + dialog hosts
            └─ packages/ui/src/root/RootWorkspaceContent.tsx:99-179
                 ├─ ServiceProvider (per-workspace accessor)   :132
                 ├─ ScopedErrorBoundary scope="workspace-app"  :133-138
                 ├─ StableWorkspaceApp = memo(App)             :12, :139
                 └─ WorkspaceSettingsLayer (overlay)           :188-202
                      └─ packages/ui/src/App.tsx               :826  holds `workspaceMainView`
                           └─ app-shell/WorkspaceShellLayout.tsx:1510-1900
                                ├─ sidebar  :1542-1608  <WorkspaceSidebar/>
                                ├─ main     :1746-1899  ternary on workspaceMainView
                                └─ terminal :1902+
```

---

## 9. Unknowns / not verified

Carried forward from the reports' own unknowns sections; none of these was resolved by writing this
document, and none should be treated as a fact.

**From `discovery-a-workflow.md` §11**

1. **No environment-variable override for the session DB path** was found; the only override is the
   config key `storage.sessionDbPath`. Whether an env layer feeds that key was not traced.
2. **Exact on-disk location for a packaged desktop run** — `prepareSessionStorage` was not read.
3. **No `GetWorkflowRunRoster` RPC or tool exists.** Roster schemas live in
   `contracts/src/tools/get-workflow-run-roster.ts` but are part of the `GetWorkflowRun` output.
4. **`dynamic-workflow/src/engine/run-terminal.ts` semantics** were not read.
5. **`imported-cache.ts` matching algorithm details** (amend/resume cache) were read only through
   call sites.
6. **The `world-read` / `world-run` node lifecycle** is confirmed at the schema and executor-seam
   level; `engine-world.ts` was not read line by line.
7. **`provider`-stop classification** (`workflow-driver-model-failure.ts`) was not read; the
   documented shape is not the classifier's rules.
8. **Two `AgentRuntime` instances in one process resuming the same `runId`** is unasserted; no
   cross-process resume lock was found.
9. **`EvalWorkflowSnippet`'s reduced facade `.d.ts`** contents were not read.
10. **DB growth / retention** — no `DELETE FROM dwf_*` or retention policy was found; not proven
    absent.

**From `discovery-b-services-ui.md` §8**

11. **New table in `tasks-index.sqlite` vs a new DB file** — both are supported; no repository
    guidance prefers one.
12. **The intended identity key for a worktree** — no precedent exists in the repository.
13. **Whether `mise run dev`'s `ZCODE_DATA_BASE_DIR` isolation covers `db.sqlite`** — unresolved
    (`getDefaultSessionDbPath()` uses raw `homedir()`).
14. **The desktop startup ordering of `db.sqlite` vs `tasks-index.sqlite` migrations** was not read.
15. **Whether `packages/ui` has machine enforcement of the hooks rule** — inferred from
    configuration only; the checker script was not read.
16. **Any SQLite database opened outside `packages/` and `apps/`** (CUA helper, bundled SEA binary).
17. **Mobile layout behaviour of a new main-view area** — not statically verifiable;
    `isMobileViewport` is currently hardcoded `false`.
18. **Where a Projects spec belongs** — no top-level `docs/` or `spec/` convention was found; `docs/`
    exists and was empty.
19. **`packages/services/src/session/contract.ts`** was not read.

**From `s2-driver-seam.md` §8** (spike questions, still open at the seam level)

20. Whether an ACP session's `submit_result` can be resolved asynchronously **mid-turn** — the
    MCP round trip works (§5.2), but the engine's parked-deferred / stop-turn mechanism has no
    verified ACP equivalent. The fork's D12 decision removes the dependency.
21. **Journal durability choice** for the standalone driver — should the dwf journal share
    `projects.db`, the ZCode session store, or stay in-memory?
22. **Escalation** — with no main agent in a headless run, the driver must either omit the escalate
    port or route questions to the runner.
23. **Does the generated script need `world.run`?** If not, `declaredRunCommands` stays empty and
    that fail-closed surface is inert.

**New in this document**

24. **This document was written before the first live mission run.** A mission has since been executed end to end on the fixture repository; the raw results, including the two-worker concurrency evidence and the failing-validation gate, are in `docs/projects/m1-evidence.md`. The demo path
    (`…/projects-mission/scripts/demo.mts`) and the package tests are the only executed evidence;
    the ACP facts in §5 come from the S3/S4/S5 probe, not from a mission run.
25. **`tokenBudgetPerMission` is validated but not enforced** — see §10.
26. **`autoResume` is validated and accepted by `reconcileMissions` but nothing consumes it** — see
    §10.
27. **The `submit_result` MCP server shipped in `dsh-executor` is not started by the mission
    runner.** `DshDriverDeps.mcpServers` is an optional pass-through
    (`projects-mission/src/workflow-driver.ts:121`) and the runner surfaces `mcpServers` only on
    `ExecuteMissionInput`'s config bag (`runner-execute.ts:101/162`), which `MissionRunner` does not
    populate. The default path is therefore the post-turn payload parse (D12).

---

## 10. Contradictions found

Recorded because they affect what an implementer should trust. In each case the **code** was
followed.

| # | Contradiction | Resolution taken |
|---|---|---|
| C1 | `specs/projects/00-overview.md` D2 (`:19`) says `@zcode/dsh-executor` owns "ACP client + **workflow driver**", while `00-overview.md:80` and `specs/projects/40-dsh-executor.md:11` say the binding lives in `@zcode/projects-mission`. `s2-driver-seam.md` §7.1 flagged the same conflict. | Followed the specific spec and the code: the driver is `apps/zcode-cli/packages/projects-mission/src/workflow-driver.ts`; `dsh-executor` has no workflow import. The overview's D2 row is still stale. |
| C2 | `specs/projects/00-overview.md` D10 says the run's `cwd` is the project repository root. The implementation passes `cwd: integration.path` to `runWorkflowScript` (`projects-mission/src/runner-execute.ts:172-175`) while the world reader keeps `workspaceRoot = repositoryPath` and `worldCwd = integration.path` (`:154`). | Followed the code. The harness `cwd` (which decides where the child entry file is written) is the integration worktree; the repository root survives only as the world reader's `workspaceRoot`. |
| C3 | `specs/projects/50-mission-runner.md` §10 gives the `worktreeRoot` default as `<dataDir>/projects/<projectId>/<missionId>/worktrees`. The code defaults to `<repositoryPath>/../.zcode-projects` (`projects-mission/src/runner.ts:408`) with layout `<root>/<projectId>/<missionId>/integration` and `…/task-<n>-<taskId>`. | Followed the code. |
| C4 | `specs/projects/50-mission-runner.md` §11 lists a runner surface including `resumeMission`, `getMissionTasks`, `getMissionWorkers`, `getMissionDiff` and a demo at `scripts/projects-demo.mts`. The code exposes `getStatus` (mission + tasks + workers in one view) and has **no** `resumeMission` or `getMissionDiff`; the demo is `apps/zcode-cli/packages/projects-mission/scripts/demo.mts` behind `pnpm --filter @zcode/projects-mission demo`. | Followed the code. |
| C5 | **Apparent** contradiction, resolved. `specs/projects/00-overview.md` §5 says `global.maxFileLines: 400` and "every source file stays under 400 lines", while raw file lengths look much larger (`projects-mission/src/runner-review.ts` 693 lines, `runner-config.ts` 552, `runner.ts` 449, `tests/runner-review.test.ts` 850). | Resolved by reading the enforcement, not the claim: `.oxlintrc.json:6` is `"max-lines": ["error", { "max": 400, "skipBlankLines": true, "skipComments": true }]` and is **off** for test/spec files (`:11-20`). Raw `wc -l` is therefore not evidence. Confirmed: `pnpm --filter @zcode/projects-mission lint` → 0 warnings, 0 errors on 30 files. No violation exists; `architecture-policy.yaml` `global.maxFileLines: 400` is a separate architecture-check budget. |
| C6 | `apps/zcode-cli/packages/git-worktree/CONTRACT.md` §5 records that `worktree add` in git 2.47.3 prints `HEAD is now at …` on **stdout** and `Preparing worktree …` on **stderr**, "the report shows both on stderr", and that the tests assert the observed split. | Followed the code/measurement: treat stderr as diagnostics and the exit code as the only failure signal. |
| C7 | `git-worktree/README.md` and `CONTRACT.md` state "**no other package shells out to git**". `apps/zcode-cli/packages/projects-mission/src/world-read-git.ts` invokes git directly (read-only allowlist, `-C <path>`, pinned env), deliberately, so the world reader does not depend on a sibling package's build order (`world-read.ts:12-14`). | Followed the code: `git-worktree` owns the *mutating* worktree/branch/integration lifecycle; the world reader has its own read-only git path. |
| C8 | `apps/zcode-cli/packages/dsh-executor/src/index.ts` says "See CONTRACT.md for the confirmed protocol facts, the invariants and the known traps", but **no `CONTRACT.md` exists** in that package (only `git-worktree` has one). | Followed the code: the protocol facts are in the `README.md`/source and in `specs/projects/40-dsh-executor.md` §10. |
| C9 | `specs/projects/20-store.md` §1 fixes the database location as `<zcode data dir>/projects.db`. `ProjectsStore` takes `{ file }` and hardcodes nothing; tests use `':memory:'`, the demo uses `<data>/projects.db`. | Followed the code. The location is a caller decision today; wiring it to the app data dir is M2 work. |
| C10 | `specs/projects/50-mission-runner.md` §10/§12 require `tokenBudgetPerMission` to block a mission and a bounded auto-resume. `tokenBudgetPerMission` is only validated (`runner-config.ts:115-116`) and never read again; `autoResume` is validated (`:119`) and accepted by `reconcileMissions` (`runner-recovery.ts:30`) but never consumed. | Followed the code: both are configuration placeholders, not implemented behaviour. Listed in [§9](#9-unknowns--not-verified) and in the roadmap. |
| C11 | `specs/projects/50-mission-runner.md` §7 says the reviewer runs "on a detached worktree checked out at the integrated commit". The code runs the reviewer session with `cwd` = the **integration worktree** and diffs against `project.defaultBranch` (`projects-mission/src/runner.ts:265-284`); read-only-ness is asserted after the session, not by construction. | Followed the code. The cleanliness assertion (`runner.ts:311-320`) turns a modification into a blocking finding plus `verdict: 'fail'`, which is the closest implemented equivalent of "the review is invalidated". |
| C12 | `specs/projects/50-mission-runner.md` §8 lists "dirty worktrees" as a completion-gate input. `finish()` passes `dirtyWorktrees: []` literally (`projects-mission/src/runner.ts:386`), so the `dirty-worktrees` blocker code in `projects-core` can never fire. | Followed the code. |
| C13 | `specs/projects/10-domain.md` §2 defines `reviewing` and `testing` mission statuses with transitions. The runner never writes either: its only status writes are `planning`, `ready`, `running`, `cancelled`, `completed`, `blocked` (`projects-mission/src/runner.ts:117/132/147/207/392/396`); review and test appear only as `phase` values. | Followed the code. Any consumer that switches on `MissionStatus` (`reconcileMissions` classifies by status; the store's recovery queries filter by status) will never see `reviewing`/`testing`. |
| C14 | `specs/projects/50-mission-runner.md` §7 says each remediation task depends on the reviewed tasks. `materializeRemediation` emits `dependsOn: []` (`projects-mission/src/runner.ts:347-354`). | Followed the code. Scheduling still works because the reviewed tasks are already `done`; the recorded dependency edge is missing. |

---

## 11. What this means for the Projects layer

1. **Do not write a scheduler, a journal or a state machine.** `WorkflowEngine` + `AskScheduler` +
   `JournalStorePort` already provide deterministic replay, per-actor FIFO ordering, the
   repair/nudge budgets and first-wins settlement. Reuse is locked decision D1.
2. **Take the driver port, not the run service.** `WorkflowDriver` has one construction site and an
   in-tree hand-written precedent; the run service is not exported from `bootstrap/src/index.ts`,
   so reusing it costs an upstream edit that the zero-upstream-edit decision (D11) forbids.
3. **Mission truth and execution truth are two stores linked by `runId`** (D5). Missions, plans,
   tasks, workers, events, validations and reviews belong in `projects.db`; nodes, replays and
   usage belong in the workflow journal. Never mirror one into the other.
4. **A per-task worktree needs a per-task `cwd` on the worker side only.** The driver's `cwd` is
   run-level (`workflow-driver-types.ts:116`), so the runner must own every git fact itself, and the
   script must not issue worktree-relative world reads. This is what D10 assumed and what the task
   flow implements.
5. **Worktrees must live outside the repository.** An in-repo worktree is not ignored and
   `git add -A` stages it as an embedded repository; the measured consequence is index corruption
   of the user's checkout, which invariant 4 of the runner spec forbids.
6. **One writer per worktree, one integration at a time.** The worktree registry and `refs/heads/`
   need a per-repo mutex; merges into the integration branch need a per-integration mutex. The
   in-process mutex does not coordinate other processes — the *one writer per worktree* rule is what
   makes that safe.
7. **Conflicts are a first-class deterministic input, not an error string.** Predict with
   `merge-tree` before integrating, integrate in dependency order with `--no-ff`, and treat a
   conflict as `MERGE_HEAD && ls-files -u`, never as a non-empty `status` or an stderr match.
8. **Never trust a worker's report about the filesystem.** Under `workspace-write`, `/tmp` writes
   can return success and vanish; tool completion is not a side effect. Read git facts from the
   worktree, and treat the model's `filesChanged` as advisory (runner spec §5).
9. **The Projects UI is a main-view area, not a side pane.** `WorkspaceMainView` is a hardcoded
   string union rendered by a ternary chain; the closest fresh template is `plugin-store`. Expect
   ~9 new files and ~18 unavoidable modifications, of which the collateral conditions (header and
   terminal panel) are functional, not cosmetic.
10. **Worktree lifecycle in the app is net-new service work.** `IGitService` has no worktree or
    merge method at all, and the workflow runtime's `worktree` isolation option is declared in the
    type system but throws when used.
11. **A worktree is a different working tree of the same repository, so it must be a distinct
    identity**, not a reused one — otherwise task-index rows, checkpoint directories, runtime
    registries and controller addresses all collide. There is no precedent to copy; this decision
    must be made before M2 code is written.
12. **The gate is the only thing allowed to say "done".** `evaluateCompletion` requires one passing
    review and every mandatory validation recorded against the *same* commit as the mission branch
    head; nothing else — no model text, no task status alone — may complete a mission.
