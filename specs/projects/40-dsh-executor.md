# Projects — DSH executor adapter

Status: draft (Phase 0); wire details pending spikes S3/S4/S5, marked inline as **[confirm]**.
Package: `@zcode/dsh-executor`. Engine-agnostic: this package never imports `@zcode/dynamic-workflow`.

## 1. Boundary

Everything DeepSeek-Harness-specific lives here: process launch, protocol framing, session
lifecycle, model selection, cancellation, resume. Callers see `DeepSeekHarnessAdapter` only, so a
second executor (Codex, another harness) can be added later by implementing the same interface.

Not in scope: mission/task semantics, git, persistence, workflow-driver types (the binding lives in
`@zcode/projects-mission`), UI.

## 2. Transport

- One adapter instance owns **one** long-lived child process: `dsh --profile acp` (binary, profile and
  extra args are configuration). Stdout carries protocol frames only; stderr is captured into a ring
  buffer and forwarded to a log sink (never mixed into the protocol stream).
- Framing: newline-delimited JSON-RPC 2.0 (one JSON object per line, no embedded newlines).
- Requests carry monotonic ids; responses and notifications are dispatched by id / method.
- Every request has a timeout (default 30 s, per-call override). A timeout rejects that call; it never
  kills the process unless the caller asks.
- On child exit: all in-flight calls reject with `ExecutorExited`, and the adapter reports a typed
  state so the runner can decide between `recoverable` and `interrupted` (runner spec §9).

## 2bis. Where the workflow binding lives

This package carries **no** workflow-engine imports. The `WorkflowDriver` implementation that consumes
this adapter lives in `@zcode/projects-mission` (`src/workflow-driver.ts`, exported as
`createDshWorkflowDriver(deps): DriverFactory`) and is handed to `runWorkflowScript`. Decision D11 in
the overview spec records why (zero upstream edits, in-tree precedent).

## 3. Adapter interface (frozen)

```ts
export interface DshSessionSpec {
  cwd: string;                     // absolute; the worker's worktree
  model?: string;                  // opaque id from the executor's catalogue
  reasoningEffort?: string;
  mcpServers?: DshMcpServer[];     // stdio or http entries (used for the submit_result bridge)
  env?: Record<string, string>;    // extra env for the child process of this session, if supported
}

export interface DshEvent {
  sessionId: string;
  kind: 'message' | 'thought' | 'tool_call' | 'tool_result' | 'config' | 'usage' | 'other';
  text?: string;                   // message/thought
  toolName?: string;               // tool_call/tool_result
  toolCallId?: string;
  payload?: unknown;               // normalized, truncated
  at: number;                      // epoch ms
}

export interface DeepSeekHarnessAdapter {
  start(): Promise<void>;                              // spawn + initialize handshake
  createSession(spec: DshSessionSpec): Promise<{ sessionId: string; configOptions?: unknown }>;
  runTask(sessionId: string, prompt: string, signal?: AbortSignal): Promise<{ stopReason: string; finalText: string }>;
  sendMessage(sessionId: string, text: string, signal?: AbortSignal): Promise<{ stopReason: string; finalText: string }>;
  streamEvents(sessionId: string): AsyncIterable<DshEvent>;
  cancel(sessionId: string): Promise<void>;
  listSessions(): Promise<{ sessionId: string; cwd?: string; updatedAt?: number }[]>;
  resumeSession(sessionId: string): Promise<void>;
  setModel(sessionId: string, model: string, reasoningEffort?: string): Promise<void>;
  getStatus(sessionId: string): 'unknown' | 'idle' | 'running' | 'closed';
  destroySession(sessionId: string): Promise<void>;
  dispose(): Promise<void>;                            // close sessions and kill the child
}
```

`runTask` and `sendMessage` are the same operation; both settle when the turn ends and return the
accumulated assistant text. `streamEvents` is a hot stream: a subscriber that attaches after a turn
started still receives subsequent events of that turn; events are dropped (with a counter) if no
subscriber is attached, because the runner persists only mission-level events.

## 4. Lifecycle mapping (ACP)

| Adapter call | ACP request **[confirm names/params in S3/S4]** |
|---|---|
| `start` | spawn `dsh --profile acp`, then `initialize` |
| `createSession` | `session/new` with the absolute `cwd` (+ `mcpServers`, model options) |
| `runTask` / `sendMessage` | `session/prompt` |
| `streamEvents` | `session/update` notifications for that session |
| `cancel` | `session/cancel` (fallback `$/cancel_request`) |
| `listSessions` | `session/list` |
| `resumeSession` | `session/resume` |
| `setModel` | `session/set_config_option` |
| `destroySession` | `session/close` |
| `dispose` | close all sessions, then terminate the child |

Permission requests (`session/request_permission`) are answered **deterministically** by the adapter:
the configured policy decides (default: reject anything the runner did not pre-approve; workers run
with a pre-approved tool policy, so a permission prompt indicates a misconfiguration and is recorded
as an event).

## 5. Result submission bridge

Workers must return a typed result. Two mechanisms, in order of preference:

1. **MCP `submit_result`** — the adapter (or the runner) starts a tiny MCP stdio server and passes it in
   `session/new`; the tool receives the payload and the adapter surfaces it as a `submit_result`
   event. Preferred because it is explicit and schema-checkable. **[confirm: stdio MCP accepted, exact
   `mcpServers` shape — S3]**
2. **Fenced JSON fallback** — the brief instructs the worker to end with a single ```json block; the
   adapter parses the last such block from the final message.

If neither yields a payload, the turn is reported as a failed submission and the runner treats it as a
task failure (bounded retries), never as success.

## 6. Model selection

- The catalogue is whatever `initialize`/config options advertise; ids are opaque.
- Selection precedence: session spec → project config → executor default. Never hardcoded in code paths
  outside configuration defaults.
- Changing a model mid-session is allowed between turns (`setModel`), and the adapter records a
  `config` event so the runner can persist which model produced a task result.

## 7. Failure taxonomy (typed)

| Error | Cause | Runner behaviour |
|---|---|---|
| `ExecutorSpawnFailed` | binary missing / not executable | mission `failed`, no retry storm (max 1 retry) |
| `ExecutorHandshakeFailed` | protocol error during `initialize` | same |
| `ExecutorExited` | child died | in-flight calls fail; recovery decides |
| `SessionCreateFailed` | invalid cwd, rejected MCP config | task fails with the executor's message |
| `PromptTimeout` | no settlement within the configured deadline | `cancel` then task attempt fails |
| `SessionNotFound` | session id unknown to the server | treated as `interrupted` |
| `ProtocolViolation` | malformed frame / unexpected id | adapter stops, mission `failed` with stderr excerpt |

Secrets never appear in error messages: stderr excerpts are filtered for `sk-`-like tokens and the
`DEEPSEEK_API_KEY` value before being stored.

## 8. Testing

- **Fake ACP server**: a scripted NDJSON peer (a Node script) driving every success and failure path:
  handshake, session create, prompt with streamed updates, cancel, list/resume, close, crash
  mid-session, malformed frame. Deterministic, no model calls, runs in CI.
- **Live smoke** (skipped unless `DSH_EXECUTOR_LIVE=1`): start the real `dsh --profile acp`, create a
  session in a temp dir, ask for a trivial file write, assert the file exists, close. This is the M1
  "start session → send task → receive events → cancel → receive result" validation required by the
  mission (Phase 2).

## 9. Configuration

```ts
export interface DshExecutorConfig {
  binary: string;                  // default: 'dsh' from PATH
  profile: string;                 // default: 'acp'
  args?: string[];                 // extra launcher args
  requestTimeoutMs?: number;       // default 30_000
  turnTimeoutMs?: number;          // default 15 * 60_000
  env?: Record<string, string>;    // merged over the scrubbed parent env
  logSink?: (line: string) => void;
  permissionPolicy?: 'deny-unapproved' | 'allow-all';
}
```

The child environment is built explicitly: `PATH`, `HOME`, plus configured values only. Ambient
secrets are never forwarded wholesale.

## 10. Confirmed protocol facts (spike S3/S4/S5, probe evidence)

1. Stdio NDJSON JSON-RPC; stdout is protocol-only; EOF on stdin ⇒ clean exit 0.
2. `session/cancel` is a **notification**; the in-flight `session/prompt` resolves with
   `{ stopReason: "cancelled" }` and no updates arrive after settlement.
3. `session/new` responds only after that session's initial `session/update` notifications drain.
   Update kinds: `agent_thought_chunk`, `agent_message_chunk`, `tool_call`, `tool_call_update`,
   `usage_update`, `config_option_update`.
4. MCP stdio shape that works (no `type` key, `env` is an **array**, `command` must be absolute):
   `[{"name":"submit","command":"/abs/node","args":["/abs/server.js"],"env":[{"name":"K","value":"V"}]}]`.
   Malformed entries are silently dropped ⇒ verify attachment out of band. Each server is spawned
   twice; an MCP startup failure fails the whole `session/new` (`-32603`). Tool names become
   `mcp__<name>__<tool>`; use `^[A-Za-z0-9_-]{1,32}$` server names.
5. Models on this deployment: provider `deepseek-official` with `deepseek-v4-flash` (default),
   `deepseek-flash`, `deepseek-v4-pro`; `reasoning_effort` ∈ `off|low|high|max` (default `high`).
   `model` is an opaque **JSON-encoded string**; the catalogue shifts between calls — never cache it.
6. `session/list` excludes sessions active on the current connection; `session/resume` requires a
   realpath-matching `cwd`; `additionalDirectories` is always rejected (one workspace per session).
7. `cwd` is honoured and the sandbox's writable root is the **`session/new` cwd**.
8. **A completed tool call is not proof of a side effect**: under `workspace-write`, writes outside
   the session cwd can report success and never reach the host. The runner therefore asserts on the
   host, and the adapter exposes an env knob (`DSH_PERMISSION_MODE`) for callers that need strict
   persistence semantics.
9. `session/request_permission` did not fire in the probe even with policy `ask`; it is answered
   deterministically if it ever arrives, and never carries control flow.
