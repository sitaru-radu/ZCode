# @zcode/dsh-executor — contract

Engine-agnostic executor adapter for DeepSeek Harness workers. One adapter instance owns **one**
long-lived child process (`dsh --profile acp`) and speaks ACP v1 (newline-delimited JSON-RPC 2.0)
over its stdio.

Nothing in this package imports `@zcode/dynamic-workflow`; the mission package binds
`DeepSeekHarnessAdapter` to its driver. Spec: `specs/projects/40-dsh-executor.md`. Wire evidence:
`reports/s3-s4-s5-dsh-acp.md` (probe S3/S4/S5, `dsh 0.2.0-rc.2`).

---

## 1. Public API

```ts
import { createDshExecutor } from '@zcode/dsh-executor';

const executor = createDshExecutor({
  binary: 'dsh',
  profile: 'acp',
  turnTimeoutMs: 15 * 60_000,
  permissionMode: 'danger-full-access', // opt-in: see §5
  env: { DEEPSEEK_API_KEY: key, DSH_HOME: '/var/lib/dsh-worker' },
});

await executor.start();
const { sessionId, configOptions } = await executor.createSession({ cwd: '/worktrees/task-1' });
const result = await executor.runTask(sessionId, 'do the thing');   // { stopReason, finalText, submission? }
await executor.destroySession(sessionId);
await executor.dispose();
```

`DeepSeekHarnessAdapter` (spec §3, frozen) is implemented by `DshExecutorAdapter`:

| Member | Behaviour |
|---|---|
| `start()` | spawn + `initialize`; rejects `ExecutorSpawnFailed` / `ExecutorHandshakeFailed`; idempotent while running |
| `createSession(spec)` | `session/new` with the absolute `cwd` and normalized `mcpServers`; applies `spec.model` / `spec.reasoningEffort` afterwards through `session/set_config_option` |
| `runTask` / `sendMessage` | `session/prompt`; resolves `{ stopReason, finalText, submission? }` when the turn ends |
| `streamEvents(sessionId)` | hot async iterable of `session/update` events for that session |
| `cancel(sessionId)` | `session/cancel` **notification** (no id); idempotent, never throws |
| `listSessions()` | `session/list` (`{}` params); remembers each `sessionId -> cwd` for `resumeSession` |
| `resumeSession(id, opts?)` | `session/resume` with `{ sessionId, cwd, mcpServers }`; cwd from `opts.cwd`, the session record, or the last `listSessions()` |
| `setModel(id, model, effort?)` | `session/set_config_option` for `model` and/or `reasoning_effort`; records a `config` event |
| `getStatus(id)` | `'unknown' \| 'idle' \| 'running' \| 'closed'` |
| `destroySession(id)` | `session/close`; idempotent |
| `dispose()` | closes open sessions, ends stdin (EOF ⇒ exit 0), escalates to SIGTERM/SIGKILL, idempotent |

Additive extensions on the concrete class (the frozen interface is unchanged):

`getState()`, `getExecutorPid()`, `getStderrExcerpt()`, `getExitReport()`, `getProtocolViolations()`,
`getAgentInfo()`, `getAgentCapabilities()`, `getSubmission(sessionId)`, `getStreamStats(sessionId)`,
`getConfigOptions(sessionId)`, `getSessionState(sessionId)`.

Other exported building blocks: `AcpClient` (transport), `createSubmitServer` /
`createSubmitMcpServer` / `submitServerEntryPath` (MCP bridge), `toAcpMcpServers` (descriptor
validation), `resolveModelValue` / `parseModelValue` / `encodeModelValue`, `parseFencedJson`,
`createRedactor`, `HotEventStream`, and the full error taxonomy.

### Events

`DshEvent.kind` ∈ `message | thought | tool_call | tool_result | config | usage | other`, mapped from
the confirmed discriminators `agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
`tool_call_update`, `config_option_update`, `usage_update`. Unknown discriminators become `other`
with a truncated payload — a new deployment cannot silently lose events. Text and payloads are
truncated (`MAX_EVENT_TEXT_CHARS = 20 000`, `MAX_PAYLOAD_CHARS = 4 000`).

`streamEvents` is **hot**: a subscriber that attaches mid-turn receives the following events of that
turn and nothing earlier; events published with no subscriber are dropped and counted
(`getStreamStats().dropped`); a subscriber that stops reading loses events to a bounded queue
(`stats.overflow`) instead of growing memory; `close()` (session closed/destroyed, executor exit)
ends every iterator.

### Typed results (spec §5)

1. **MCP `submit_result`** — attach the bridge with `createSubmitMcpServer({ inputSchema })` in
   `spec.mcpServers`. The adapter turns the tool call into a submission when the call's
   `tool_call_update` reports `status: "completed"`; a rejected bridge call (`isError`, status
   `failed`) is **not** a result. The payload is the tool's `rawInput`, i.e. exactly what the worker
   passed.
2. **Fenced JSON fallback** — if no bridge call completed, the last ```` ```json ```` block of the
   accumulated assistant text is parsed (`parseFencedJson`).

`result.submission = { value, source: 'mcp' | 'fenced-json', toolName?, toolCallId?, at }`. When
neither mechanism yields a payload the turn simply has no `submission` — the runner must treat that
as a failed submission, never as success.

---

## 2. Confirmed protocol facts (probe S3/S4/S5 — implemented, not guessed)

1. `dsh --profile acp` speaks NDJSON JSON-RPC 2.0 on stdio; stdout is protocol-only, stderr is free
   text; EOF on stdin ⇒ clean exit code 0.
2. `session/cancel` is a **notification** (no `id`). The in-flight `session/prompt` **resolves** with
   `{"stopReason":"cancelled"}` — it does not reject and does not hang; no updates arrive after
   settlement.
3. `session/new` responds only **after** that session's initial `session/update` notifications drain.
   Updates can therefore arrive for a `sessionId` the adapter has not learned yet: they are buffered
   (bounded) and replayed into the stream the moment the session is registered.
4. MCP stdio servers are attached per session with this exact shape — no `type` key, `env` is an
   **array**, `command` must be absolute:
   `[{"name":"submit","command":"/abs/node","args":["/abs/server.js"],"env":[{"name":"K","value":"V"}]}]`.
   Malformed entries are **silently dropped** by the agent, which is why `toAcpMcpServers()` validates
   every entry locally (`env`/`headers` always sent, even when empty) and why server names must match
   `^[A-Za-z0-9_-]{1,32}$`. Tools are exposed as `mcp__<server>__<tool>`. Each attached server is
   spawned twice; any MCP startup failure fails the whole `session/new` with `-32603`.
5. `model` is an opaque **JSON-encoded string** (`"[\"deepseek-official\",\"deepseek-v4-pro\"]"`);
   `reasoning_effort` is a bare string (`off|low|high|max`, default `high`). The catalogue changes
   between calls — it is read from the latest `configOptions` and never cached.
6. `session/list` excludes sessions active on the current connection; `session/resume` requires a
   realpath-matching `cwd`; `additionalDirectories` is always rejected (one workspace per session).
7. `cwd` is honoured for relative paths, and the sandbox's writable root is the **`session/new` cwd**.
8. `promptCapabilities.image = false` on this deployment: prompts are sent as a single `text` block.
9. `session/request_permission` never fired in ~10 probe runs; it is answered deterministically from
   `permissionPolicy` (`deny-unapproved` ⇒ a `reject_*` option, `allow-all` ⇒ an `allow_*` option,
   `{outcome:{outcome:'cancelled'}}` when the agent offers none) and recorded as an `other` event. It
   never carries control flow.

---

## 3. Invariants

- **One child per adapter.** Sessions are concurrent on that one connection; `set_config_option`
  mutates one session only. `cancel`/`prompt` timeouts never kill the process.
- **Every failure is typed** (`errors.ts`) and carries redacted evidence: `kind`, `method`,
  JSON-RPC `code`, `data`, `stderrExcerpt`. Branch on `kind`/`instanceof`, never on message text —
  the single exception is `SessionNotFound` classification (see §4).
- **Secrets never reach a message, a log line or an error.** The child environment is built
  explicitly (`PATH`, `HOME`, Windows essentials, configured values only — never a copy of
  `process.env`), and stderr/evidence passes through a redactor that removes known secret values plus
  `sk-…`, `Bearer …`, `token=`/`api_key=` shapes.
- **A timeout rejects exactly one call.** `RequestTimeout` for control calls, `PromptTimeout` (a
  subclass) for turns; a `PromptTimeout` also sends `session/cancel` so the session cannot stay busy.
- **The child exit is a single event**: all in-flight calls reject with `ExecutorExited`, sessions
  become `unknown` (records are kept for submissions/stats), and `getExitReport()` says whether the
  end was `exit`, `protocol-violation` or `disposed`.
- **Framing policy**: a non-JSON line, a non-JSON-RPC frame or an oversized line on stdout is a
  fatal `ProtocolViolation` (stdout is protocol-only, so the stream cannot be trusted). A response
  for an unknown id is reported but **not** fatal — that is the normal outcome of a call that already
  timed out.
- **Dispose order**: close sessions → end stdin (EOF) → wait `disposeGraceMs` → SIGTERM → wait 1 s →
  SIGKILL. Idempotent; `start()` after `dispose()` rejects.

---

## 4. Known traps (read before using this from a runner)

1. **A completed tool call is not proof of a side effect.** Under the default `workspace-write`
   sandbox, a bash write to an absolute path outside the session cwd (notably `/tmp`) returns rc=0,
   reads back inside the sandbox, reports `tool_call_update{status:"completed"}` — and never exists on
   the host (private tmpfs). The runner must assert on the host filesystem itself, and the adapter
   never treats tool status as success. Two consequences:
   - start workers with `permissionMode: 'danger-full-access'` (exported as
     `DSH_PERMISSION_MODE=danger-full-access`) when the caller wants writes anywhere to really land —
     the approval policy then becomes `never`;
   - artifacts should be required under the session cwd otherwise.
2. **`session/list` hides live sessions.** A session created on this connection returns
   `{"sessions":[]}` and only reappears after the server dies or the session is closed. Track ids
   client-side; treat `session/list` as crash-recovery reconciliation.
3. **`resumeSession` needs the cwd** (realpath-compared). Pass `{ cwd }`, or call `listSessions()`
   first: this adapter remembers the ids it has seen and throws `SessionNotFound` when it knows no
   cwd, rather than guessing.
4. **`SessionNotFound` classification is textual** and deliberately narrow
   (`session not found`, `no such session`, `unknown session id`, `session does not exist`). JSON-RPC
   `-32602` also carries `unknown session config option: …`, which must stay a configuration error.
5. **`session.update` ids and turn scoping**: `finalText` accumulates only `agent_message_chunk`
   text of the current turn; updates that arrive after a turn settled are streamed but not added to
   any result.
6. **`spec.env` is not supported** (ACP has one child per connection, no per-session environment).
   It is reported as an `unsupported-session-env` event and a log line; use
   `DshExecutorConfig.env` / `DshExecutorConfig.permissionMode`.
7. **MCP bridges are spawned twice per session** and a flaky MCP server fails `session/new` with
   `-32603` — the bridge must be cheap and must never block on the agent.
8. **Framing caps**: a single frame larger than `maxLineChars` (default 8 MiB) is dropped and
   reported as a violation. Nothing in the probe came close; the cap exists so a runaway writer
   cannot exhaust memory.

---

## 5. Configuration

| Field | Default | Notes |
|---|---|---|
| `binary` | `dsh` (from `PATH`) | absolute path recommended in production |
| `profile` | `acp` | empty string ⇒ no `--profile` flag |
| `args` | `[]` | extra launcher args after `--profile <profile>` |
| `requestTimeoutMs` | `30_000` | control calls |
| `turnTimeoutMs` | `15 * 60_000` | `session/prompt` |
| `env` | `{}` | merged over the scrubbed parent environment |
| `permissionMode` | unset | `workspace-write` \| `danger-full-access`; sets `DSH_PERMISSION_MODE` |
| `permissionPolicy` | `deny-unapproved` | answers `session/request_permission` |
| `childCwd` | `process.cwd()` | working directory of the spawned child |
| `maxLineChars` | `8 MiB` | frame cap |
| `stderrBufferLines` | `200` | retained, redacted stderr lines |
| `submitServerName` / `submitToolName` | `submit` / `submit_result` | bridge identity |
| `secrets` | `[]` | extra literal values to redact |
| `disposeGraceMs` | `5_000` | clean-exit wait before SIGTERM |
| `logSink` | unset | receives redacted stderr lines and diagnostics |

`DshExecutorConfig.env` values named like secrets (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`)
are added to the redaction list automatically.

---

## 6. Tests

```
pnpm --filter @zcode/dsh-executor lint
pnpm --filter @zcode/dsh-executor typecheck
pnpm --filter @zcode/dsh-executor test
```

`tests/fake-acp-server.ts` is a scripted NDJSON peer that plays every path the probe confirmed —
handshake, session create with/without MCP, all update kinds, cancel-mid-prompt, list/resume across a
restart, `-32603` MCP failure, malformed and oversized frames, abrupt exit, permission requests,
unknown server→client requests — and records every frame to `<stateDir>/trace.ndjson`, so the tests
assert the *wire shape* (for example that `session/cancel` really has no `id`).

Live smoke test (skipped unless `DSH_EXECUTOR_LIVE=1`), which is the M1 acceptance:

```bash
cd apps/zcode-cli/packages/dsh-executor
set -a && . ~/.dsh/env && set +a
DSH_EXECUTOR_LIVE=1 node --import tsx --test tests/live.test.ts
```

It starts the real agent, creates a session in a fresh temp dir, asserts a file the worker wrote
**on the host**, cancels a second long prompt and asserts `stopReason === 'cancelled'`, then closes
the session and disposes. `DSH_HOME` is redirected into the temp dir (`DSH_LIVE_HOME` overrides), so
the user's own session store is untouched. Optional knobs: `DSH_BINARY`, `DSH_LIVE_PERMISSION_MODE`.
