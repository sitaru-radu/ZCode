/**
 * Live smoke test — the M1 acceptance for this executor (spec §8).
 *
 * Skipped unless `DSH_EXECUTOR_LIVE=1`. It drives the real `dsh --profile acp`:
 *   start -> createSession(cwd = fresh temp dir) -> prompt writes a file inside that cwd
 *   -> assert the file on the host -> second long prompt -> cancel -> assert stopReason
 *   -> destroySession -> dispose.
 *
 * Run it with the API key sourced, never printed:
 *   set -a && . ~/.dsh/env && set +a && DSH_EXECUTOR_LIVE=1 node --import tsx --test tests/live.test.ts
 *
 * `DSH_HOME` is redirected into the temp dir so the user's real session store is untouched, and
 * `DSH_PERMISSION_MODE=danger-full-access` is available through `DSH_LIVE_PERMISSION_MODE` for
 * callers that need writes outside the session cwd to really land (probe 8.1).
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { createDshExecutor, type DshExecutorAdapter } from '../src/adapter.js';
import { DSH_PERMISSION_MODE_ENV, type DshPermissionMode } from '../src/config.js';
import { modelIdsFromOptions } from '../src/models.js';
import type { DshConfigOption, DshEvent } from '../src/types.js';
import { delay, isAlive, makeTempDirs, removeTempDirs, waitFor, type TempDirs } from './helpers.js';

const LIVE_ENABLED = process.env['DSH_EXECUTOR_LIVE'] === '1';
const FILE_NAME = 'live-ok.txt';
const FILE_CONTENT_HINT = 'ok';
const CANCEL_FILE_NAME = 'live-slow.txt';

interface LiveContext {
  readonly adapter: DshExecutorAdapter;
  readonly dirs: TempDirs;
  readonly sessionId: string;
  readonly events: DshEvent[];
  readonly stop: () => Promise<void>;
}

function liveEnv(dirs: TempDirs): Record<string, string> {
  const env: Record<string, string> = {
    // Isolated session store: the running dsh-web.service keeps its own DSH_HOME.
    DSH_HOME: process.env['DSH_LIVE_HOME'] ?? path.join(dirs.root, 'dsh-home'),
  };
  const apiKey = process.env['DEEPSEEK_API_KEY'];
  if (apiKey !== undefined && apiKey !== '') env['DEEPSEEK_API_KEY'] = apiKey;
  const permissionMode = process.env['DSH_LIVE_PERMISSION_MODE'] as DshPermissionMode | undefined;
  if (permissionMode !== undefined) env[DSH_PERMISSION_MODE_ENV] = permissionMode;
  return env;
}

async function startLive(t: TestContext): Promise<LiveContext> {
  const dirs = makeTempDirs('dsh-executor-live-');
  const logs: string[] = [];
  const adapter = createDshExecutor({
    binary: process.env['DSH_BINARY'] ?? 'dsh',
    profile: 'acp',
    childCwd: dirs.root,
    env: liveEnv(dirs),
    requestTimeoutMs: 60_000,
    turnTimeoutMs: 300_000,
    logSink: (line) => logs.push(line),
  });
  t.after(async () => {
    const pid = adapter.getExecutorPid();
    await adapter.dispose().catch(() => undefined);
    if (pid !== undefined && isAlive(pid)) process.kill(pid, 'SIGKILL');
    removeTempDirs(dirs);
    t.diagnostic(`redacted stderr lines kept: ${String(adapter.getStderrExcerpt().split('\n').length)}`);
  });

  await adapter.start();
  const events: DshEvent[] = [];
  const { sessionId, configOptions } = await adapter.createSession({ cwd: dirs.sessionDir });
  const iterator = adapter.streamEvents(sessionId)[Symbol.asyncIterator]();
  let stopped = false;
  const pump = (async () => {
    while (!stopped) {
      const next = await iterator.next();
      if (next.done === true) return;
      events.push(next.value);
    }
  })();
  t.diagnostic(`session ${sessionId} created in ${dirs.sessionDir}`);
  t.diagnostic(
    `model catalogue: ${modelIdsFromOptions(configOptions as readonly DshConfigOption[] | undefined).join(', ')}`,
  );
  return {
    adapter,
    dirs,
    sessionId,
    events,
    stop: async () => {
      stopped = true;
      await iterator.return?.(undefined);
      await pump;
    },
  };
}

test('live: real dsh writes a file in the session cwd, then a cancelled turn reports cancelled', { skip: !LIVE_ENABLED }, async (t) => {
  if (process.env['DEEPSEEK_API_KEY'] === undefined) {
    assert.fail('DEEPSEEK_API_KEY is not set: source ~/.dsh/env before running the live test');
  }
  const live = await startLive(t);
  const { adapter, dirs, sessionId, events } = live;
  assert.equal(adapter.getState(), 'ready');

  // ---- turn 1: a real side effect inside the session cwd, asserted on the host ---------------
  const first = await adapter.runTask(
    sessionId,
    `Create a file named ${FILE_NAME} in your current working directory whose contents are exactly ` +
      `the two characters: ${FILE_CONTENT_HINT} (no trailing newline). Use a tool to write it. ` +
      'Then reply with exactly DONE and nothing else.',
  );
  t.diagnostic(`turn 1 stopReason=${first.stopReason} finalText=${JSON.stringify(first.finalText.slice(0, 200))}`);
  assert.equal(first.stopReason, 'end_turn');
  const target = path.join(dirs.sessionDir, FILE_NAME);
  assert.ok(existsSync(target), `expected ${target} to exist on the host`);
  const raw = readFileSync(target, 'utf8');
  t.diagnostic(`host assertion: ${FILE_NAME} exists, bytes=${JSON.stringify(raw)}`);
  assert.equal(raw.trim(), FILE_CONTENT_HINT);

  const toolCalls = events.filter((event) => event.kind === 'tool_call');
  const messages = events.filter((event) => event.kind === 'message');
  t.diagnostic(
    `turn 1 streamed ${String(events.length)} events: ` +
      `${toolCalls.map((event) => event.toolName).join(', ')} | ` +
      `messages=${String(messages.length)} thoughts=${String(events.filter((event) => event.kind === 'thought').length)} ` +
      `usage=${String(events.filter((event) => event.kind === 'usage').length)}`,
  );
  assert.ok(toolCalls.length >= 1, 'the turn must stream at least one tool_call');
  assert.ok(messages.length >= 1, 'the turn must stream agent_message_chunk events');
  assert.equal(adapter.getStatus(sessionId), 'idle');

  // ---- turn 2: cancel mid-prompt, the prompt resolves with `cancelled` -----------------------
  const before = events.length;
  const pending = adapter.runTask(
    sessionId,
    `Write a file named ${CANCEL_FILE_NAME} in your current working directory containing exactly ` +
      '200 numbered lines (1 to 200). Use a separate bash tool call for every single line, one line ' +
      'per call. Do not batch them and do not use a loop.',
  );
  const settled = await Promise.race([
    (async () => {
      await waitFor(() => events.length > before, { timeoutMs: 90_000, label: 'first update of turn 2' });
      // A 200-line task with one tool call per line cannot finish in three seconds: the turn is
      // guaranteed to still be in flight when the cancel goes out.
      await delay(3_000);
      return 'cancel-now' as const;
    })(),
    pending.then(() => 'settled-early' as const),
  ]);
  assert.equal(settled, 'cancel-now', 'the second prompt was expected to still be running');
  assert.equal(adapter.getStatus(sessionId), 'running');
  await adapter.cancel(sessionId);
  const second = await pending;
  t.diagnostic(`turn 2 stopReason=${second.stopReason} text=${JSON.stringify(second.finalText.slice(0, 120))}`);
  assert.equal(second.stopReason, 'cancelled', 'session/cancel must settle the prompt as cancelled');

  const countAtSettlement = events.length;
  await delay(2_000);
  assert.equal(events.length, countAtSettlement, 'no updates may arrive after settlement');
  t.diagnostic(`turn 2: ${String(countAtSettlement - before)} events before settlement, 0 after`);
  assert.equal(adapter.getStatus(sessionId), 'idle');

  // ---- teardown -----------------------------------------------------------------------------
  await live.stop();
  await adapter.destroySession(sessionId);
  assert.equal(adapter.getStatus(sessionId), 'closed');
  const exitPid = adapter.getExecutorPid();
  await adapter.dispose();
  assert.equal(adapter.getExitReport()?.code, 0, 'EOF on stdin must shut the agent down cleanly');
  if (exitPid !== undefined) assert.equal(isAlive(exitPid), false, 'no agent process may survive');
  t.diagnostic(`violations recorded: ${String(adapter.getProtocolViolations().length)}`);
  t.diagnostic(`stderr excerpt (redacted): ${JSON.stringify(adapter.getStderrExcerpt().slice(0, 200))}`);
});
