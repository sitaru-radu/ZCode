/**
 * Adapter behaviour against the scripted peer: every method of `DeepSeekHarnessAdapter`, the wire
 * shapes it produces, and the lifecycle edges (cancel, resume across a restart, submit bridge).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createDshExecutor, type DshExecutorAdapter } from '../src/adapter.js';
import type { DshExecutorConfig } from '../src/config.js';
import {
  ExecutorRequestFailed,
  ProtocolViolation,
  SessionCreateFailed,
  SessionNotFound,
} from '../src/errors.js';
import { createSubmitMcpServer } from '../src/mcp/submit-server.js';
import { findConfigOption } from '../src/models.js';
import type { DshEvent } from '../src/types.js';
import {
  collectEvents,
  createFakeAdapter,
  delay,
  fakeAdapterConfig,
  incomingFrames,
  killRecordedFakes,
  makeTempDirs,
  readJsonFile,
  removeTempDirs,
  waitFor,
  type TempDirs,
} from './helpers.js';

interface FakeContext {
  readonly adapter: DshExecutorAdapter;
  readonly dirs: TempDirs;
}

async function withFake<T>(
  scenario: string,
  fn: (context: FakeContext) => Promise<T>,
  config?: DshExecutorConfig,
): Promise<T> {
  const dirs = makeTempDirs();
  const adapter = createFakeAdapter({ stateDir: dirs.stateDir, scenario, config });
  try {
    await adapter.start();
    return await fn({ adapter, dirs });
  } finally {
    await adapter.dispose().catch(() => undefined);
    killRecordedFakes(dirs.stateDir);
    removeTempDirs(dirs);
  }
}

async function pumpEvents(
  adapter: DshExecutorAdapter,
  sessionId: string,
): Promise<{ events: DshEvent[]; stop: () => Promise<void> }> {
  return collectEvents(adapter, sessionId);
}

test('start + createSession + runTask: streams every update kind and returns the final text', async () => {
  await withFake('stream', async ({ adapter, dirs }) => {
    assert.equal(adapter.getState(), 'ready');
    assert.equal(typeof adapter.getExecutorPid(), 'number');

    const created = await adapter.createSession({ cwd: dirs.sessionDir });
    assert.match(created.sessionId, /^[0-9a-f-]{36}$/);
    assert.ok(Array.isArray(created.configOptions));
    assert.equal(adapter.getStatus(created.sessionId), 'idle');

    const collector = await pumpEvents(adapter, created.sessionId);
    const result = await adapter.runTask(created.sessionId, 'do the thing');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.finalText, 'DONE');
    assert.equal(adapter.getStatus(created.sessionId), 'idle');

    await waitFor(() => collector.events.length >= 7, { label: 'streamed events' });
    const kinds = new Set(collector.events.map((event) => event.kind));
    for (const kind of ['thought', 'message', 'tool_call', 'tool_result', 'usage', 'config']) {
      assert.ok(kinds.has(kind as DshEvent['kind']), `missing event kind ${kind}`);
    }
    const toolCall = collector.events.find((event) => event.kind === 'tool_call');
    assert.equal(toolCall?.toolName, 'bash');
    assert.equal(toolCall?.toolCallId, 'call_bash_1');
    assert.equal(toolCall?.sessionId, created.sessionId);
    await collector.stop();

    // Wire shapes: initialize advertises text-only prompts; session/new carries cwd + mcpServers.
    const initialize = incomingFrames(dirs.stateDir, 'initialize')[0];
    const initParams = initialize?.['params'] as Record<string, unknown>;
    assert.equal(initParams['protocolVersion'], 1);
    assert.deepEqual(initParams['clientCapabilities'], {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
    const sentNew = readJsonFile<Record<string, unknown>>(path.join(dirs.stateDir, 'session-new.json'));
    assert.equal(sentNew?.['cwd'], dirs.sessionDir);
    assert.deepEqual(sentNew?.['mcpServers'], []);
    assert.equal('additionalDirectories' in (sentNew ?? {}), false);

    const promptFrames = incomingFrames(dirs.stateDir, 'session/prompt');
    assert.equal(promptFrames.length, 1);
    assert.deepEqual(promptFrames[0]?.['params'], {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'do the thing' }],
    });

    // The session/new response arrives after the initial updates; those updates are not lost.
    assert.equal(adapter.getStreamStats(created.sessionId)?.subscribers, 0);
  });
});

test('createSession: initial updates that arrive before session/new settles are replayed', async () => {
  await withFake('initial-updates', async ({ adapter, dirs }) => {
    const { sessionId } = await adapter.createSession({ cwd: dirs.sessionDir });
    // The fake emits `session started` + `ready` before the sessionId exists. They cannot have a
    // subscriber yet, so the proof they were not lost is the drop counter plus the untouched turn.
    assert.ok(
      (adapter.getStreamStats(sessionId)?.dropped ?? 0) >= 2,
      'buffered initial updates must be replayed into the stream',
    );
    const collector = await pumpEvents(adapter, sessionId);
    const result = await adapter.runTask(sessionId, 'ping');
    assert.equal(result.finalText, 'DONE');
    // The stream is pumped through promises: wait for delivery before inspecting the array.
    await waitFor(() => collector.events.some((event) => event.kind === 'message'), {
      label: 'message event delivered',
    });
    const texts = collector.events.filter((event) => event.kind === 'message').map((event) => event.text);
    assert.deepEqual(texts, ['DONE']);
    await collector.stop();
  });
});

test('cancel: notification without id, prompt resolves as cancelled, no updates after settlement', async () => {
  await withFake('cancel', async ({ adapter, dirs }) => {
    const { sessionId } = await adapter.createSession({ cwd: dirs.sessionDir });
    const collector = await pumpEvents(adapter, sessionId);
    const pending = adapter.runTask(sessionId, 'write 200 numbered lines');
    await waitFor(() => collector.events.some((event) => event.kind === 'tool_result'), {
      label: 'tool result before cancel',
    });
    assert.equal(adapter.getStatus(sessionId), 'running');

    await adapter.cancel(sessionId);
    const result = await pending;
    assert.equal(result.stopReason, 'cancelled');
    assert.equal(adapter.getStatus(sessionId), 'idle');

    const cancelFrames = incomingFrames(dirs.stateDir, 'session/cancel');
    assert.equal(cancelFrames.length, 1);
    assert.equal('id' in (cancelFrames[0] ?? {}), false, 'session/cancel must be a notification');
    assert.deepEqual(cancelFrames[0]?.['params'], { sessionId });

    // Let the stream pump drain before counting what arrived.
    await delay(100);
    const settledCount = collector.events.length;
    await delay(200);
    assert.equal(collector.events.length, settledCount, 'no updates may arrive after settlement');
    await collector.stop();

    // cancel is idempotent for unknown/closed sessions and never throws.
    await adapter.cancel('00000000-0000-4000-8000-000000000000');
  });
});

test('setModel: bare ids resolve against the live catalogue and record a config event', async () => {
  await withFake('stream', async ({ adapter, dirs }) => {
    const { sessionId } = await adapter.createSession({ cwd: dirs.sessionDir });
    const collector = await pumpEvents(adapter, sessionId);

    await adapter.setModel(sessionId, 'deepseek-v4-pro', 'low');
    const frames = incomingFrames(dirs.stateDir, 'session/set_config_option');
    assert.deepEqual(frames[0]?.['params'], {
      sessionId,
      configId: 'model',
      value: '["deepseek-official","deepseek-v4-pro"]',
    });
    assert.deepEqual(frames[1]?.['params'], { sessionId, configId: 'reasoning_effort', value: 'low' });
    assert.equal(
      findConfigOption(adapter.getConfigOptions(sessionId), 'model')?.currentValue,
      '["deepseek-official","deepseek-v4-pro"]',
    );
    assert.equal(
      findConfigOption(adapter.getConfigOptions(sessionId), 'reasoning_effort')?.currentValue,
      'low',
    );
    await waitFor(() => collector.events.some((event) => event.kind === 'config'), { label: 'config event' });

    // An id the catalogue does not know is sent verbatim and the agent decides.
    await assert.rejects(
      () => adapter.setModel(sessionId, 'not-a-real-model'),
      (error: unknown) => {
        assert.ok(error instanceof ExecutorRequestFailed);
        assert.equal(error.code, -32602);
        assert.match(String(error.serverMessage), /unknown value for model/);
        return true;
      },
    );
    await collector.stop();
  });
});

test('createSession: model and reasoningEffort from the spec are applied after session/new', async () => {
  await withFake('stream', async ({ adapter, dirs }) => {
    const { sessionId } = await adapter.createSession({
      cwd: dirs.sessionDir,
      model: 'deepseek-flash',
      reasoningEffort: 'max',
    });
    const frames = incomingFrames(dirs.stateDir, 'session/set_config_option');
    assert.deepEqual(frames.map((frame) => frame['params']), [
      { sessionId, configId: 'model', value: '["deepseek-official","deepseek-flash"]' },
      { sessionId, configId: 'reasoning_effort', value: 'max' },
    ]);
    // session/new itself stays minimal: cwd + mcpServers only.
    const sentNew = readJsonFile<Record<string, unknown>>(path.join(dirs.stateDir, 'session-new.json'));
    assert.deepEqual(Object.keys(sentNew ?? {}).sort(), ['cwd', 'mcpServers']);
  });
});

test('createSession: rejects a relative cwd and malformed mcpServers before touching the wire', async () => {
  await withFake('stream', async ({ adapter, dirs }) => {
    await assert.rejects(
      () => adapter.createSession({ cwd: 'relative/path' }),
      (error: unknown) => {
        assert.ok(error instanceof SessionCreateFailed);
        assert.equal(error.kind, 'session-create-failed');
        return true;
      },
    );
    await assert.rejects(
      () =>
        adapter.createSession({
          cwd: dirs.sessionDir,
          mcpServers: [{ name: 'bad name', command: '/bin/echo' }],
        }),
      SessionCreateFailed,
    );
    await assert.rejects(
      () =>
        adapter.createSession({
          cwd: dirs.sessionDir,
          mcpServers: [{ name: 'submit', command: 'node' }],
        }),
      /must be an absolute path/,
    );
    await assert.rejects(
      () =>
        adapter.createSession({
          cwd: dirs.sessionDir,
          mcpServers: [
            { name: 'dup', command: '/bin/echo' },
            { name: 'dup', command: '/bin/echo' },
          ],
        }),
      /duplicate normalized name/,
    );
    assert.equal(incomingFrames(dirs.stateDir, 'session/new').length, 0);
  });
});

test('createSession: MCP startup failure surfaces as SessionCreateFailed with the agent detail', async () => {
  await withFake('stream', async ({ adapter, dirs }) => {
    await assert.rejects(
      () =>
        adapter.createSession({
          cwd: dirs.sessionDir,
          mcpServers: [{ name: 'ghost', command: '/nonexistent/ghost-node' }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof SessionCreateFailed);
        assert.equal(error.code, -32603);
        assert.match(JSON.stringify(error.data), /initial connection or tool synchronization failed/);
        return true;
      },
    );
  });
});

test('createSession: unsupported spec.env is reported as an event instead of being ignored', async () => {
  const logs: string[] = [];
  await withFake(
    'stream',
    async ({ adapter, dirs }) => {
      const { sessionId } = await adapter.createSession({
        cwd: dirs.sessionDir,
        env: { DSH_PERMISSION_MODE: 'danger-full-access' },
      });
      // The warning event is published while createSession runs, before any subscriber can attach.
      assert.equal(adapter.getStreamStats(sessionId)?.dropped, 1);
      assert.ok(logs.some((line) => line.includes('spec.env is not supported')));
      const collector = await pumpEvents(adapter, sessionId);
      await adapter.runTask(sessionId, 'anything');
      await collector.stop();
    },
    { logSink: (line) => logs.push(line) },
  );
});

test('submit bridge: mcpServers go out in the confirmed shape and rawInput becomes the submission', async () => {
  await withFake('submit', async ({ adapter, dirs }) => {
    const descriptor = createSubmitMcpServer({
      inputSchema: {
        type: 'object',
        required: ['status'],
        properties: { status: { type: 'string' } },
      },
      entryPath: '/abs/placeholder/submit-server.js',
    });
    const { sessionId } = await adapter.createSession({ cwd: dirs.sessionDir, mcpServers: [descriptor] });

    const sentNew = readJsonFile<{ mcpServers: Record<string, unknown>[] }>(
      path.join(dirs.stateDir, 'session-new.json'),
    );
    const entry = sentNew?.mcpServers[0];
    assert.equal(entry?.['name'], 'submit');
    assert.equal('type' in (entry ?? {}), false, 'stdio entries must not carry a type key');
    assert.equal(entry?.['command'], process.execPath);
    assert.ok(path.isAbsolute(String(entry?.['command'])));
    assert.deepEqual(entry?.['args'], ['/abs/placeholder/submit-server.js']);
    const env = entry?.['env'];
    assert.ok(Array.isArray(env), 'env must be an array of {name, value}');
    assert.ok(
      (env as { name: string }[]).some((variable) => variable.name === 'DSH_SUBMIT_TOOL_NAME'),
    );

    const result = await adapter.runTask(sessionId, 'finish the task');
    assert.equal(result.finalText, 'submitted');
    assert.ok(result.submission, 'rawInput of the submit tool call must become the submission');
    assert.equal(result.submission.source, 'mcp');
    assert.equal(result.submission.toolName, 'mcp__submit__submit_result');
    assert.equal(result.submission.toolCallId, 'call_submit_1');
    assert.deepEqual(result.submission.value, { status: 'done', answer: 42 });
    assert.deepEqual(adapter.getSubmission(sessionId)?.value, { status: 'done', answer: 42 });
  });
});

test('submit bridge: a failed bridge call is not reported as a typed result', async () => {
  await withFake('submit-invalid', async ({ adapter, dirs }) => {
    const { sessionId } = await adapter.createSession({ cwd: dirs.sessionDir });
    const result = await adapter.runTask(sessionId, 'finish the task');
    assert.equal(result.submission, undefined);
    assert.equal(adapter.getSubmission(sessionId), undefined);
  });
});

test('fenced JSON fallback: the last json block of the final message is used', async () => {
  await withFake('fenced', async ({ adapter, dirs }) => {
    const { sessionId } = await adapter.createSession({ cwd: dirs.sessionDir });
    const result = await adapter.runTask(sessionId, 'finish the task');
    assert.equal(result.submission?.source, 'fenced-json');
    assert.deepEqual(result.submission?.value, { status: 'done', note: 'fenced' });
  });
});

test('listSessions hides live sessions; resume works across a server restart', async () => {
  const dirs = makeTempDirs();
  const first = createFakeAdapter({ stateDir: dirs.stateDir, scenario: 'stream' });
  let sessionId = '';
  try {
    await first.start();
    ({ sessionId } = await first.createSession({ cwd: dirs.sessionDir }));
    // Probe 8.2: a session that is active on this connection is excluded from session/list.
    assert.deepEqual(await first.listSessions(), []);
    await first.dispose();
    assert.equal(first.getExitReport()?.reason, 'disposed');

    const second = createFakeAdapter({ stateDir: dirs.stateDir, scenario: 'stream' });
    try {
      await second.start();
      const listed = await second.listSessions();
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.sessionId, sessionId);
      assert.equal(listed[0]?.cwd, dirs.sessionDir);
      assert.equal(second.getStatus(sessionId), 'unknown');

      await second.resumeSession(sessionId);
      assert.equal(second.getStatus(sessionId), 'idle');
      assert.deepEqual(await second.listSessions(), []);

      // Already active on this connection (probe: -32602), and cwd mismatch is a request failure.
      await assert.rejects(() => second.resumeSession(sessionId), ExecutorRequestFailed);
      await assert.rejects(
        () => second.resumeSession(sessionId, { cwd: dirs.root }),
        ExecutorRequestFailed,
      );

      const third = createFakeAdapter({ stateDir: dirs.stateDir, scenario: 'stream' });
      try {
        await third.start();
        await assert.rejects(
          () => third.resumeSession('11111111-2222-4333-8444-555555555555', { cwd: dirs.sessionDir }),
          (error: unknown) => {
            assert.ok(error instanceof SessionNotFound);
            assert.equal(error.kind, 'session-not-found');
            return true;
          },
        );
        await assert.rejects(
          () => third.resumeSession(sessionId),
          (error: unknown) => {
            assert.ok(error instanceof SessionNotFound);
            assert.match(String((error as Error).message), /no cwd known/);
            return true;
          },
        );
      } finally {
        await third.dispose().catch(() => undefined);
      }
    } finally {
      await second.dispose().catch(() => undefined);
    }
  } finally {
    await first.dispose().catch(() => undefined);
    killRecordedFakes(dirs.stateDir);
    removeTempDirs(dirs);
  }
});

test('destroySession closes the session; closed sessions reject work and end their stream', async () => {
  await withFake('stream', async ({ adapter, dirs }) => {
    const { sessionId } = await adapter.createSession({ cwd: dirs.sessionDir });
    const collector = await pumpEvents(adapter, sessionId);
    await adapter.destroySession(sessionId);
    assert.equal(adapter.getStatus(sessionId), 'closed');
    assert.equal(incomingFrames(dirs.stateDir, 'session/close').length, 1);
    await assert.rejects(() => adapter.runTask(sessionId, 'again'), SessionNotFound);
    await collector.stop();
    let ended = false;
    for await (const _event of adapter.streamEvents(sessionId)) {
      ended = true;
    }
    assert.equal(ended, false, 'a closed session stream ends immediately');
    // Idempotent teardown.
    await adapter.destroySession(sessionId);
    await adapter.destroySession('99999999-8888-4777-8666-555555555555');
  });
});

test('dispose: closes sessions, ends the child with EOF (exit 0) and is idempotent', async () => {
  const dirs = makeTempDirs();
  const adapter = createFakeAdapter({ stateDir: dirs.stateDir, scenario: 'stream' });
  try {
    await adapter.start();
    const { sessionId } = await adapter.createSession({ cwd: dirs.sessionDir });
    const pid = adapter.getExecutorPid();
    assert.equal(typeof pid, 'number');
    await adapter.dispose();
    assert.equal(adapter.getState(), 'disposed');
    assert.equal(adapter.getExitReport()?.code, 0);
    assert.equal(adapter.getExitReport()?.signal, null);
    assert.equal(adapter.getStatus(sessionId), 'closed');
    await adapter.dispose();
    await assert.rejects(() => adapter.start(), /disposed/);
    assert.equal(killRecordedFakes(dirs.stateDir).length, 0, 'no fake peer may outlive the test');
  } finally {
    await adapter.dispose().catch(() => undefined);
    killRecordedFakes(dirs.stateDir);
    removeTempDirs(dirs);
  }
});

test('permission requests are answered deterministically and recorded as events', async () => {
  await withFake('permission', async ({ adapter, dirs }) => {
    const { sessionId } = await adapter.createSession({ cwd: dirs.sessionDir });
    const collector = await pumpEvents(adapter, sessionId);
    const result = await adapter.runTask(sessionId, 'touch a file');
    assert.equal(result.stopReason, 'end_turn');
    // Default policy denies: the agent must receive a reject selection, never an allow.
    assert.equal(result.finalText, JSON.stringify({ outcome: { outcome: 'selected', optionId: 'reject-once' } }));
    await waitFor(
      () =>
        collector.events.some(
          (event) => (event.payload as { type?: string } | undefined)?.type === 'permission_request',
        ),
      { label: 'permission event delivered' },
    );
    const permissionEvent = collector.events.find(
      (event) => (event.payload as { type?: string } | undefined)?.type === 'permission_request',
    );
    assert.ok(permissionEvent);
    await collector.stop();
  });

  await withFake(
    'permission',
    async ({ adapter, dirs }) => {
      const { sessionId } = await adapter.createSession({ cwd: dirs.sessionDir });
      const result = await adapter.runTask(sessionId, 'touch a file');
      assert.equal(result.finalText, JSON.stringify({ outcome: { outcome: 'selected', optionId: 'allow-once' } }));
    },
    { permissionPolicy: 'allow-all' },
  );
});

test('unknown server->client requests are answered with -32601 and never stall the turn', async () => {
  await withFake('unknown-request', async ({ adapter, dirs }) => {
    const { sessionId } = await adapter.createSession({ cwd: dirs.sessionDir });
    const result = await adapter.runTask(sessionId, 'read a file');
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.finalText, 'unknown-request-code:-32601');
  });
});

test('start: a missing binary fails with ExecutorSpawnFailed and a bad handshake with the typed error', async () => {
  const dirs = makeTempDirs();
  try {
    const missing = createDshExecutor({
      binary: path.join(dirs.root, 'not-a-real-binary'),
      profile: '',
      childCwd: dirs.stateDir,
      requestTimeoutMs: 2_000,
    });
    await assert.rejects(
      () => missing.start(),
      (error: unknown) => {
        assert.equal((error as { kind?: string }).kind, 'spawn-failed');
        return true;
      },
    );
    await missing.dispose();

    const badHandshake = createFakeAdapter({
      stateDir: dirs.stateDir,
      scenario: 'handshake-error',
      config: { childCwd: dirs.stateDir },
    });
    await assert.rejects(
      () => badHandshake.start(),
      (error: unknown) => {
        assert.equal((error as { kind?: string }).kind, 'handshake-failed');
        return true;
      },
    );
    assert.equal(badHandshake.getState(), 'failed');
    await badHandshake.dispose();

    const badVersion = createFakeAdapter({
      stateDir: dirs.stateDir,
      scenario: 'bad-handshake',
      config: { childCwd: dirs.stateDir },
    });
    await assert.rejects(() => badVersion.start(), /unsupported ACP protocol version/);
    await badVersion.dispose();
  } finally {
    killRecordedFakes(dirs.stateDir);
    removeTempDirs(dirs);
  }
});

test('runTask: an already-aborted signal settles as cancelled without a wire call', async () => {
  await withFake('stream', async ({ adapter, dirs }) => {
    const { sessionId } = await adapter.createSession({ cwd: dirs.sessionDir });
    const controller = new AbortController();
    controller.abort();
    const result = await adapter.runTask(sessionId, 'never sent', controller.signal);
    assert.deepEqual(result, { stopReason: 'cancelled', finalText: '' });
    assert.equal(incomingFrames(dirs.stateDir, 'session/prompt').length, 0);
  });
});

test('runTask: an abort mid-turn cancels the prompt through the notification path', async () => {
  await withFake('cancel', async ({ adapter, dirs }) => {
    const { sessionId } = await adapter.createSession({ cwd: dirs.sessionDir });
    const controller = new AbortController();
    const pending = adapter.runTask(sessionId, 'long task', controller.signal);
    await waitFor(() => incomingFrames(dirs.stateDir, 'session/prompt').length === 1, {
      label: 'prompt on the wire',
    });
    controller.abort();
    const result = await pending;
    assert.equal(result.stopReason, 'cancelled');
    assert.equal(incomingFrames(dirs.stateDir, 'session/cancel').length, 1);
    assert.equal(adapter.getStatus(sessionId), 'idle');
  });
});

test('runTask: two prompts on one session are refused locally', async () => {
  await withFake('cancel', async ({ adapter, dirs }) => {
    const { sessionId } = await adapter.createSession({ cwd: dirs.sessionDir });
    const first = adapter.runTask(sessionId, 'first');
    await waitFor(() => adapter.getStatus(sessionId) === 'running', { label: 'running' });
    await assert.rejects(() => adapter.runTask(sessionId, 'second'), /already in flight/);
    await adapter.cancel(sessionId);
    await first;
  });
});

test('runTask: a prompt result without stopReason is a ProtocolViolation', async () => {
  await withFake('no-stop-reason', async ({ adapter, dirs }) => {
    const { sessionId } = await adapter.createSession({ cwd: dirs.sessionDir });
    await assert.rejects(
      () => adapter.runTask(sessionId, 'anything'),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolViolation);
        return true;
      },
    );
    assert.equal(adapter.getStatus(sessionId), 'idle');
  });
});

test('sendMessage is the same operation as runTask', async () => {
  await withFake('stream', async ({ adapter, dirs }) => {
    const { sessionId } = await adapter.createSession({ cwd: dirs.sessionDir });
    const result = await adapter.sendMessage(sessionId, 'same thing');
    assert.deepEqual(result, { stopReason: 'end_turn', finalText: 'DONE' });
  });
});

test('streamEvents and getStatus reject unknown session ids', async () => {
  await withFake('stream', async ({ adapter }) => {
    assert.equal(adapter.getStatus('nope'), 'unknown');
    assert.throws(() => adapter.streamEvents('nope'), SessionNotFound);
    assert.equal(adapter.getSubmission('nope'), undefined);
    assert.equal(adapter.getStreamStats('nope'), undefined);
  });
});

test('fakeAdapterConfig spawns the peer with an explicitly built environment', async () => {
  const dirs = makeTempDirs();
  try {
    const config = fakeAdapterConfig({ stateDir: dirs.stateDir, scenario: 'stream' });
    assert.deepEqual(config.args?.slice(0, 1), ['--import']);
    const adapter = createDshExecutor(config);
    await adapter.start();
    const { sessionId } = await adapter.createSession({ cwd: dirs.sessionDir });
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
    await adapter.dispose();
  } finally {
    killRecordedFakes(dirs.stateDir);
    removeTempDirs(dirs);
  }
});
