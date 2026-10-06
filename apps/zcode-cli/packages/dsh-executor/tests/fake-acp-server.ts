/**
 * Scripted ACP peer for tests — a tiny stand-in for `dsh --profile acp`.
 *
 * It speaks newline-delimited JSON-RPC 2.0 on stdio and plays the wire shapes captured by the
 * probe: handshake, session create with/without MCP, streamed updates of every confirmed kind,
 * cancel-mid-prompt (notification in, `stopReason: "cancelled"` out), list/resume across a restart,
 * `-32603` MCP failure, malformed and oversized frames, abrupt exit, permission requests and
 * unknown server->client requests.
 *
 * Every received and sent frame is appended to `<stateDir>/trace.ndjson` so tests can assert the
 * exact wire shape (for example: `session/cancel` really is a notification with no `id`).
 *
 * Not a product artifact: tests only. Exempt from the 400-line source gate.
 *
 * env: FAKE_SCENARIO (default `stream`), FAKE_STATE_DIR (required), FAKE_SESSION_ID (optional).
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const scenario = process.env.FAKE_SCENARIO ?? 'stream';
const stateDir = process.env.FAKE_STATE_DIR ?? '';
if (stateDir === '') {
  process.stderr.write('fake-acp-server: FAKE_STATE_DIR is required\n');
  process.exit(2);
}
mkdirSync(stateDir, { recursive: true });
const tracePath = path.join(stateDir, 'trace.ndjson');
const statePath = path.join(stateDir, 'state.json');

interface ConfigChoice {
  value?: string;
  name?: string;
  group?: string;
  options?: ConfigChoice[];
}
interface ConfigOption {
  id: string;
  name: string;
  category: string;
  type: string;
  currentValue: string;
  options: ConfigChoice[];
}
interface FakeSession {
  sessionId: string;
  cwd: string;
  closed: boolean;
  configOptions: ConfigOption[];
}

interface PersistedState {
  sessions: FakeSession[];
}

function loadState(): PersistedState {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8')) as PersistedState;
  } catch {
    return { sessions: [] };
  }
}

const persisted = loadState();
const active = new Set<string>();
let promptInFlight: { id: number; sessionId: string } | undefined;
let lastCancel: { sessionId?: string; hadId: boolean } | undefined;
let updatesAfterSettlement = 0;
let settled = false;

const MODEL_OPTION: ConfigOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: '["deepseek-official","deepseek-v4-flash"]',
  options: [
    {
      group: 'deepseek-official',
      name: 'DeepSeek',
      options: [
        { value: '["deepseek-official","deepseek-v4-flash"]', name: 'deepseek-v4-flash' },
        { value: '["deepseek-official","deepseek-flash"]', name: 'DeepSeek-V41-Flash' },
        { value: '["deepseek-official","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro' },
      ],
    },
  ],
};

const REASONING_OPTION: ConfigOption = {
  id: 'reasoning_effort',
  name: 'Reasoning effort',
  category: 'thought_level',
  type: 'select',
  currentValue: 'high',
  options: [
    { value: 'off', name: 'Off' },
    { value: 'low', name: 'Low' },
    { value: 'high', name: 'High' },
    { value: 'max', name: 'Max' },
  ],
};

function defaultConfigOptions(): ConfigOption[] {
  return [structuredClone(MODEL_OPTION), structuredClone(REASONING_OPTION)];
}

function persist(): void {
  writeFileSync(statePath, JSON.stringify({ sessions: persisted.sessions }, null, 2));
}

function trace(dir: 'in' | 'out', frame: unknown): void {
  appendFileSync(tracePath, `${JSON.stringify({ dir, at: Date.now(), frame })}\n`);
}

function send(frame: unknown): void {
  trace('out', frame);
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function sendRaw(text: string): void {
  trace('out', { raw: text.slice(0, 120) });
  process.stdout.write(text);
}

function result(id: number, value: unknown): void {
  send({ jsonrpc: '2.0', id, result: value });
}

function error(id: number, code: number, message: string, data?: unknown): void {
  send(data === undefined ? { jsonrpc: '2.0', id, error: { code, message } } : { jsonrpc: '2.0', id, error: { code, message, data } });
}

function update(sessionId: string, payload: Record<string, unknown>): void {
  if (settled) updatesAfterSettlement += 1;
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: payload } });
}

const thought = (sid: string, text: string): void =>
  update(sid, { sessionUpdate: 'agent_thought_chunk', messageId: 'msg-thought', content: { type: 'text', text } });
const message = (sid: string, text: string): void =>
  update(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'msg-text', content: { type: 'text', text } });
const toolCall = (sid: string, toolCallId: string, title: string, rawInput: unknown): void =>
  update(sid, { sessionUpdate: 'tool_call', toolCallId, title, kind: 'other', status: 'in_progress', rawInput });
const toolDone = (sid: string, toolCallId: string, text: string, status = 'completed'): void =>
  update(sid, {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status,
    content: [{ type: 'content', content: { type: 'text', text } }],
  });
const usage = (sid: string, used: number, size = 1_000_000): void =>
  update(sid, { sessionUpdate: 'usage_update', used, size });

function findSession(sessionId: unknown): FakeSession | undefined {
  return persisted.sessions.find((session) => session.sessionId === sessionId);
}

function samePath(a: string, b: string): boolean {
  const canonical = (value: string): string => {
    try {
      return realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  return canonical(a) === canonical(b);
}

function mcpStartupFailure(params: Record<string, unknown>): string | undefined {
  const servers = Array.isArray(params['mcpServers']) ? params['mcpServers'] : [];
  for (const entry of servers) {
    if (typeof entry !== 'object' || entry === null) continue;
    const command = (entry as Record<string, unknown>)['command'];
    const name = (entry as Record<string, unknown>)['name'];
    if (typeof command === 'string' && command.includes('ghost')) {
      return `mcp-client(${typeof name === 'string' ? name : 'unknown'}): initial connection or tool synchronization failed`;
    }
  }
  return undefined;
}

/** Play one prompt. Returns true when the turn settles immediately. */
function playTurn(id: number, sid: string, params: Record<string, unknown>): void {
  const promptBlocks = Array.isArray(params['prompt']) ? params['prompt'] : [];
  for (const block of promptBlocks) {
    const type = typeof block === 'object' && block !== null ? (block as Record<string, unknown>)['type'] : undefined;
    if (type === 'image') {
      error(id, -32602, 'inline image prompts were not advertised by this connection');
      return;
    }
    if (type === 'audio' || type === 'resource') {
      error(id, -32602, `Invalid params: unsupported prompt block type: ${String(type)}`);
      return;
    }
  }
  const first = promptBlocks[0];
  const text = typeof first === 'object' && first !== null ? (first as Record<string, unknown>)['text'] : undefined;
  if (typeof text !== 'string' || text.trim() === '') {
    error(id, -32602, 'Invalid params: empty prompt');
    return;
  }

  if (scenario === 'malformed') {
    promptInFlight = { id, sessionId: sid };
    sendRaw('this is not json at all\n');
    return;
  }
  if (scenario === 'oversized') {
    promptInFlight = { id, sessionId: sid };
    sendRaw(`${'x'.repeat(200_000)}\n`);
    return;
  }
  if (scenario === 'abrupt-exit') {
    process.stderr.write('fake-acp-server: exiting abruptly\n');
    process.exit(7);
  }
  if (scenario === 'slow') {
    promptInFlight = { id, sessionId: sid };
    thought(sid, 'working slowly');
    return;
  }
  if (scenario === 'delayed') {
    // One update immediately, the rest after a pause: a subscriber can attach in between.
    promptInFlight = { id, sessionId: sid };
    thought(sid, 'first');
    setTimeout(() => {
      if (promptInFlight?.id !== id) return;
      message(sid, 'second');
      settled = true;
      result(id, { stopReason: 'end_turn' });
      promptInFlight = undefined;
    }, 400);
    return;
  }
  if (scenario === 'cancel') {
    promptInFlight = { id, sessionId: sid };
    thought(sid, 'planning a long task');
    toolCall(sid, 'call_cancel_1', 'bash', { command: 'printf "" > slow.txt' });
    toolDone(sid, 'call_cancel_1', 'initialized | lines: 0\n');
    return;
  }
  if (scenario === 'permission') {
    promptInFlight = { id, sessionId: sid };
    send({
      jsonrpc: '2.0',
      id: 9001,
      method: 'session/request_permission',
      params: {
        sessionId: sid,
        toolCall: { toolCallId: 'call_perm_1' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
    return;
  }
  if (scenario === 'unknown-request') {
    promptInFlight = { id, sessionId: sid };
    send({ jsonrpc: '2.0', id: 9002, method: 'fs/read_text_file', params: { path: '/etc/hosts' } });
    return;
  }
  if (scenario === 'no-stop-reason') {
    result(id, {});
    return;
  }

  // Streaming scenarios: the prompt response always arrives after the last update (probe 8.7).
  thought(sid, 'thinking about the task');
  usage(sid, 5691);
  if (scenario === 'submit') {
    toolCall(sid, 'call_submit_1', 'mcp__submit__submit_result', { status: 'done', answer: 42 });
    toolDone(sid, 'call_submit_1', 'submit_result accepted');
  } else if (scenario === 'submit-invalid') {
    toolCall(sid, 'call_submit_2', 'mcp__submit__submit_result', { status: 'nope' });
    toolDone(sid, 'call_submit_2', 'submit_result rejected: missing required property "answer"', 'failed');
  } else {
    toolCall(sid, 'call_bash_1', 'bash', { command: 'printf ok > hello.txt', workdir: sid });
    toolDone(sid, 'call_bash_1', '2 hello.txt\n');
  }
  update(sid, { sessionUpdate: 'config_option_update', configOptions: defaultConfigOptions() });
  if (scenario === 'submit') {
    message(sid, 'submitted');
  } else if (scenario === 'fenced') {
    message(sid, 'result follows\n```json\n{"status":"done","note":"fenced"}\n```\n');
  } else if (scenario === 'submit-invalid') {
    message(sid, 'could not submit');
  } else {
    message(sid, 'DONE');
  }
  usage(sid, 5866);
  settled = true;
  result(id, { stopReason: 'end_turn' });
}

function handleInitialize(id: number): void {
  if (scenario === 'handshake-error') {
    error(id, -32603, 'Internal error: initialize failed');
    return;
  }
  result(id, {
    protocolVersion: scenario === 'bad-handshake' ? 2 : 1,
    agentInfo: { name: 'fake-deepseek-harness-acp', version: '0.0.1' },
    agentCapabilities: {
      mcpCapabilities: { http: true },
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      sessionCapabilities: { close: {}, list: {}, resume: {} },
    },
    authMethods: [],
  });
}

function handleSessionNew(id: number, params: Record<string, unknown>): void {
  writeFileSync(path.join(stateDir, 'session-new.json'), JSON.stringify(params, null, 2));
  const cwd = params['cwd'];
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    error(id, -32602, 'Invalid params: cwd must be an absolute path');
    return;
  }
  if (Array.isArray(params['additionalDirectories']) && params['additionalDirectories'].length > 0) {
    error(id, -32602, 'Invalid params: additionalDirectories is not supported');
    return;
  }
  const failure = mcpStartupFailure(params);
  if (failure !== undefined) {
    error(id, -32603, 'Internal error', { details: failure });
    return;
  }
  const session: FakeSession = {
    sessionId: process.env.FAKE_SESSION_ID ?? randomUUID(),
    cwd,
    closed: false,
    configOptions: defaultConfigOptions(),
  };
  persisted.sessions.push(session);
  persist();
  active.add(session.sessionId);
  if (scenario === 'initial-updates') {
    // Probe fact 3: the response only arrives after the initial updates drained.
    thought(session.sessionId, 'session started');
    message(session.sessionId, 'ready');
  }
  result(id, { sessionId: session.sessionId, configOptions: session.configOptions });
}

function handleSessionPrompt(id: number, params: Record<string, unknown>): void {
  const session = findSession(params['sessionId']);
  if (session === undefined) {
    error(id, -32602, `Invalid params: session not found: ${String(params['sessionId'])}`);
    return;
  }
  if (promptInFlight !== undefined) {
    error(id, -32602, 'Invalid params: a prompt is already in flight for this session');
    return;
  }
  settled = false;
  playTurn(id, session.sessionId, params);
}

function handleCancel(params: Record<string, unknown>, hadId: boolean): void {
  lastCancel = { sessionId: typeof params['sessionId'] === 'string' ? params['sessionId'] : undefined, hadId };
  appendFileSync(path.join(stateDir, 'cancel.json'), `${JSON.stringify({ ...lastCancel, at: Date.now() })}\n`);
  if (promptInFlight !== undefined) {
    const pending = promptInFlight;
    promptInFlight = undefined;
    settled = true;
    result(pending.id, { stopReason: 'cancelled' });
    appendFileSync(
      path.join(stateDir, 'cancel.json'),
      `${JSON.stringify({ settledPromptId: pending.id, updatesAfterSettlement })}\n`,
    );
  }
}

function handlePermissionResponse(frame: Record<string, unknown>): void {
  const outcome = frame['result'];
  const answer = JSON.stringify(outcome ?? frame['error'] ?? null);
  appendFileSync(path.join(stateDir, 'permission.json'), `${answer}\n`);
  const sid = findSession((promptInFlight?.sessionId ?? ''))?.sessionId;
  if (sid !== undefined && promptInFlight !== undefined) {
    toolCall(sid, 'call_perm_2', 'bash', { command: 'echo allowed' });
    toolDone(sid, 'call_perm_2', answer);
    message(sid, answer);
    settled = true;
    result(promptInFlight.id, { stopReason: 'end_turn' });
    promptInFlight = undefined;
  }
}

function handleUnknownResponse(frame: Record<string, unknown>): void {
  appendFileSync(path.join(stateDir, 'unknown-request.json'), `${JSON.stringify(frame)}\n`);
  const sid = findSession(promptInFlight?.sessionId ?? '')?.sessionId;
  if (sid !== undefined && promptInFlight !== undefined) {
    const errorObject = frame['error'] as Record<string, unknown> | undefined;
    message(sid, `unknown-request-code:${String(errorObject?.['code'] ?? 'none')}`);
    settled = true;
    result(promptInFlight.id, { stopReason: 'end_turn' });
    promptInFlight = undefined;
  }
}

function handleRequest(frame: Record<string, unknown>): void {
  const id = frame['id'] as number;
  const method = frame['method'] as string;
  const params = (frame['params'] ?? {}) as Record<string, unknown>;
  // `mute`: everything except the handshake and session creation is left unanswered, which is how
  // the request-timeout path is exercised.
  if (scenario === 'mute' && method !== 'initialize' && method !== 'session/new') return;
  switch (method) {
    case 'initialize':
      handleInitialize(id);
      return;
    case 'session/new':
      handleSessionNew(id, params);
      return;
    case 'session/prompt':
      handleSessionPrompt(id, params);
      return;
    case 'session/list': {
      const cwdFilter = params['cwd'];
      const rows = [...persisted.sessions]
        .reverse()
        .filter((session) => !active.has(session.sessionId))
        .filter((session) => typeof cwdFilter !== 'string' || samePath(session.cwd, cwdFilter))
        .map((session) => ({ sessionId: session.sessionId, cwd: session.cwd }));
      result(id, { sessions: rows });
      return;
    }
    case 'session/resume': {
      const session = findSession(params['sessionId']);
      if (session === undefined) {
        error(id, -32602, `Invalid params: session not found: ${String(params['sessionId'])}`);
        return;
      }
      if (active.has(session.sessionId)) {
        error(id, -32602, 'Invalid params: session is already active on this connection');
        return;
      }
      const cwd = params['cwd'];
      if (typeof cwd !== 'string' || !samePath(session.cwd, cwd)) {
        error(id, -32602, 'Invalid params: session cwd does not match');
        return;
      }
      active.add(session.sessionId);
      result(id, { configOptions: session.configOptions });
      return;
    }
    case 'session/close': {
      const session = findSession(params['sessionId']);
      if (session === undefined) {
        error(id, -32602, `Invalid params: session not found: ${String(params['sessionId'])}`);
        return;
      }
      session.closed = true;
      active.delete(session.sessionId);
      persist();
      result(id, {});
      return;
    }
    case 'session/set_config_option': {
      const session = findSession(params['sessionId']);
      if (session === undefined) {
        error(id, -32602, `Invalid params: session not found: ${String(params['sessionId'])}`);
        return;
      }
      const configId = params['configId'];
      const value = params['value'];
      if (typeof value !== 'string') {
        error(id, -32602, `Invalid params: ${String(configId)} requires a select value`);
        return;
      }
      const option = session.configOptions.find((entry) => entry.id === configId);
      if (option === undefined) {
        error(id, -32602, `Invalid params: unknown session config option: ${String(configId)}`);
        return;
      }
      const values: string[] = [];
      const walk = (choices: ConfigChoice[]): void => {
        for (const choice of choices) {
          if (typeof choice.value === 'string') values.push(choice.value);
          if (Array.isArray(choice.options)) walk(choice.options);
        }
      };
      walk(option.options);
      if (!values.includes(value)) {
        error(id, -32602, `Invalid params: unknown value for ${String(configId)}: ${value}`);
        return;
      }
      option.currentValue = value;
      persist();
      result(id, { configOptions: session.configOptions });
      return;
    }
    default:
      error(id, -32601, `Method not found: ${method}`);
  }
}

function handleFrame(frame: Record<string, unknown>): void {
  const method = frame['method'];
  if (typeof method === 'string') {
    if (typeof frame['id'] === 'number') {
      handleRequest(frame);
    } else if (method === 'session/cancel') {
      handleCancel((frame['params'] ?? {}) as Record<string, unknown>, false);
    }
    return;
  }
  // A response to a server->client request made by this script.
  if (frame['id'] === 9001) handlePermissionResponse(frame);
  else if (frame['id'] === 9002) handleUnknownResponse(frame);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim() !== '') {
      try {
        const decoded = JSON.parse(line) as Record<string, unknown>;
        trace('in', decoded);
        handleFrame(decoded);
      } catch {
        trace('in', { unparsable: line.slice(0, 100) });
      }
    }
    index = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => {
  // EOF on stdin is the clean shutdown signal (probe 8.13); `stubborn` deliberately ignores it so
  // the client's SIGTERM/SIGKILL escalation can be tested.
  if (scenario === 'stubborn') return;
  process.exit(0);
});

const noisyStderr = process.env.FAKE_STDERR;
if (noisyStderr !== undefined && noisyStderr !== '') {
  const repeat = Number(process.env.FAKE_STDERR_REPEAT ?? '1');
  for (let index = 0; index < Math.max(1, repeat); index += 1) {
    process.stderr.write(`${noisyStderr}\n`);
  }
}

if (scenario === 'stubborn') {
  process.on('SIGTERM', () => {
    process.stderr.write('fake-acp-server: ignoring SIGTERM\n');
  });
  setInterval(() => undefined, 1_000);
}

writeFileSync(path.join(stateDir, 'fake.pid'), String(process.pid));
appendFileSync(
  path.join(stateDir, 'fake-starts.ndjson'),
  `${JSON.stringify({ pid: process.pid, scenario, at: Date.now() })}\n`,
);
process.stderr.write(`fake-acp-server ready (scenario=${scenario})\n`);
