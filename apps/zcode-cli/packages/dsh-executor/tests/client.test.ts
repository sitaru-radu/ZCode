/**
 * Process-level transport tests: request/response correlation, deadlines, malformed and oversized
 * frames, child exit, bounded/redacted stderr and the shutdown escalation ladder.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { AcpClient, type AcpClientOptions } from '../src/acp-client.js';
import { buildChildEnv, resolveConfig, type DshExecutorConfig } from '../src/config.js';
import { ExecutorExited, ExecutorSpawnFailed, ProtocolViolation, RequestTimeout } from '../src/errors.js';
import {
  fakeAdapterConfig,
  killRecordedFakes,
  makeTempDirs,
  readJsonLines,
  removeTempDirs,
  waitFor,
  type TempDirs,
} from './helpers.js';

function clientOptions(dirs: TempDirs, scenario: string, config: DshExecutorConfig = {}): AcpClientOptions {
  const resolved = resolveConfig(
    fakeAdapterConfig({
      stateDir: dirs.stateDir,
      scenario,
      config: { requestTimeoutMs: 2_000, disposeGraceMs: 1_000, ...config },
    }),
  );
  return {
    binary: resolved.binary,
    args: [...resolved.args],
    env: buildChildEnv(resolved, process.env),
    cwd: resolved.childCwd,
    requestTimeoutMs: resolved.requestTimeoutMs,
    maxLineChars: resolved.maxLineChars,
    stderrBufferLines: resolved.stderrBufferLines,
    logSink: resolved.logSink,
    secrets: resolved.secrets,
    disposeGraceMs: resolved.disposeGraceMs,
  };
}

async function withClient<T>(
  scenario: string,
  fn: (context: { client: AcpClient; dirs: TempDirs }) => Promise<T>,
  config: DshExecutorConfig = {},
  hooks: Pick<AcpClientOptions, 'onServerRequest' | 'onNotification'> = {},
): Promise<T> {
  const dirs = makeTempDirs();
  const client = new AcpClient({ ...clientOptions(dirs, scenario, config), ...hooks });
  try {
    await client.start();
    return await fn({ client, dirs });
  } finally {
    await client.dispose().catch(() => undefined);
    killRecordedFakes(dirs.stateDir);
    removeTempDirs(dirs);
  }
}

test('client: correlates concurrent requests by id and reports the child pid', async () => {
  await withClient('stream', async ({ client, dirs }) => {
    assert.equal(client.isRunning, true);
    assert.equal(typeof client.childPid, 'number');
    const initialized = await client.request<{ protocolVersion: number }>('initialize', {
      protocolVersion: 1,
    });
    assert.equal(initialized.protocolVersion, 1);
    const created = await client.request<{ sessionId: string }>('session/new', {
      cwd: dirs.sessionDir,
      mcpServers: [],
    });
    const [first, second] = await Promise.all([
      client.request<{ sessions: unknown[] }>('session/list', {}),
      client.request<{ sessions: unknown[] }>('session/list', {}),
    ]);
    assert.ok(Array.isArray(first.sessions));
    assert.deepEqual(second.sessions, first.sessions);
    assert.equal(client.exitInfo, undefined);
    assert.ok(created.sessionId.length > 0);
  });
});

test('client: a deadline rejects only that call and leaves the child alive', async () => {
  await withClient('mute', async ({ client, dirs }) => {
    await client.request('initialize', { protocolVersion: 1 });
    const started = Date.now();
    await assert.rejects(
      () => client.request('session/list', {}, { timeoutMs: 150 }),
      (error: unknown) => {
        assert.ok(error instanceof RequestTimeout);
        assert.equal(error.kind, 'request-timeout');
        assert.equal(error.method, 'session/list');
        assert.equal(error.timeoutMs, 150);
        return true;
      },
    );
    assert.ok(Date.now() - started >= 140);
    assert.equal(client.isRunning, true, 'a timeout must not kill the child');
    assert.equal(client.staleResponseCount, 0);
    assert.ok(dirs.sessionDir.length > 0);
  });
});

test('client: a malformed frame is a fatal ProtocolViolation for every in-flight call', async () => {
  await withClient('malformed', async ({ client, dirs }) => {
    await client.request('initialize', { protocolVersion: 1 });
    const created = await client.request<{ sessionId: string }>('session/new', {
      cwd: dirs.sessionDir,
      mcpServers: [],
    });
    await assert.rejects(
      () =>
        client.request('session/prompt', {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'go' }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolViolation);
        assert.equal(error.kind, 'protocol-violation');
        assert.equal(error.fatal, true);
        assert.match(error.message, /malformed frame/);
        return true;
      },
    );
    assert.equal(client.fatalViolation?.fatal, true);
    assert.equal(client.isRunning, false);
    await assert.rejects(() => client.request('session/list', {}), ProtocolViolation);
    assert.equal(client.violations.length, 1);
  });
});

test('client: an oversized frame is dropped, reported and treated as a violation', async () => {
  await withClient(
    'oversized',
    async ({ client, dirs }) => {
      await client.request('initialize', { protocolVersion: 1 });
      const created = await client.request<{ sessionId: string }>('session/new', {
        cwd: dirs.sessionDir,
        mcpServers: [],
      });
      await assert.rejects(
        () =>
          client.request('session/prompt', {
            sessionId: created.sessionId,
            prompt: [{ type: 'text', text: 'go' }],
          }),
        (error: unknown) => {
          assert.ok(error instanceof ProtocolViolation);
          assert.match(error.message, /oversized frame/);
          return true;
        },
      );
      assert.equal(client.isRunning, false);
    },
    { maxLineChars: 4_096 },
  );
});

test('client: an abrupt exit rejects in-flight and later calls with ExecutorExited', async () => {
  await withClient('abrupt-exit', async ({ client, dirs }) => {
    await client.request('initialize', { protocolVersion: 1 });
    const created = await client.request<{ sessionId: string }>('session/new', {
      cwd: dirs.sessionDir,
      mcpServers: [],
    });
    await assert.rejects(
      () =>
        client.request('session/prompt', {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'go' }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof ExecutorExited);
        assert.equal(error.kind, 'executor-exited');
        assert.equal(error.exitInfo?.code, 7);
        return true;
      },
    );
    await waitFor(() => client.exitInfo !== undefined, { label: 'exit info' });
    assert.equal(client.exitInfo?.code, 7);
    assert.equal(client.isRunning, false);
    await assert.rejects(() => client.request('session/list', {}), ExecutorExited);
  });
});

test('client: spawning a missing binary fails with ExecutorSpawnFailed', async () => {
  const dirs = makeTempDirs();
  const missing = path.join(dirs.root, 'nope-binary');
  const client = new AcpClient(clientOptions(dirs, 'stream', { binary: missing }));
  try {
    await assert.rejects(
      () => client.start(),
      (error: unknown) => {
        assert.ok(error instanceof ExecutorSpawnFailed);
        assert.equal(error.kind, 'spawn-failed');
        assert.equal(error.binary, missing);
        assert.equal(error.args.length > 0, true);
        return true;
      },
    );
    await assert.rejects(() => client.request('initialize', {}), ExecutorExited);
  } finally {
    await client.dispose();
    killRecordedFakes(dirs.stateDir);
    removeTempDirs(dirs);
  }
});

test('client: stderr is bounded, redacted and forwarded to the sink', async () => {
  const forwarded: string[] = [];
  const literal = 'literal-secret-value';
  await withClient(
    'stream',
    async ({ client }) => {
      await waitFor(() => forwarded.length >= 6, { label: 'stderr captured' });
      const excerpt = client.stderrExcerpt;
      assert.ok(excerpt.includes('always-visible'), excerpt);
      assert.ok(!excerpt.includes('sk-live-abcdef123456'), 'shape rule must hide the token');
      assert.ok(!excerpt.includes(literal), 'literal secret must be hidden');
      assert.ok(excerpt.includes('sk-[redacted]'), excerpt);
      assert.equal(client.stderrLines.length, 2, 'ring keeps only the configured capacity');
      assert.equal(client.stderrDroppedLines, forwarded.length - 2, 'the rest is counted as dropped');
      assert.ok(forwarded.every((line) => !line.includes(literal)));
      assert.ok(forwarded.some((line) => line.includes('always-visible')));
    },
    {
      stderrBufferLines: 2,
      secrets: [literal],
      logSink: (line) => forwarded.push(line),
      env: {
        FAKE_STDERR: `always-visible token=sk-live-abcdef123456 literal=${literal}`,
        FAKE_STDERR_REPEAT: '5',
      },
    },
  );
});

test('client: dispose escalates to SIGTERM and then SIGKILL for a child that ignores EOF', async () => {
  const dirs = makeTempDirs();
  const client = new AcpClient(clientOptions(dirs, 'stubborn', { disposeGraceMs: 150 }));
  try {
    await client.start();
    assert.equal(client.isRunning, true);
    // Wait until the peer has really booted: `spawn` only means the OS created the process, and a
    // signal sent before the child installs its handlers would kill it with the default action.
    await waitFor(() => client.stderrLines.some((line) => line.includes('fake-acp-server ready')), {
      label: 'fake peer booted',
    });
    const startedAt = Date.now();
    await client.dispose();
    const elapsed = Date.now() - startedAt;
    await waitFor(() => client.exitInfo !== undefined, { label: 'child exit' });
    assert.equal(
      client.exitInfo?.signal,
      'SIGKILL',
      `exit=${JSON.stringify(client.exitInfo)} stderr=${JSON.stringify(client.stderrLines)}`,
    );
    assert.ok(elapsed >= 1_100, `escalation must wait the grace period (took ${String(elapsed)}ms)`);
  } finally {
    await client.dispose().catch(() => undefined);
    killRecordedFakes(dirs.stateDir);
    removeTempDirs(dirs);
  }
});

test('client: a server->client request is answered by the hook', async () => {
  const seen: string[] = [];
  await withClient(
    'unknown-request',
    async ({ client, dirs }) => {
      await client.request('initialize', { protocolVersion: 1 });
      const created = await client.request<{ sessionId: string }>('session/new', {
        cwd: dirs.sessionDir,
        mcpServers: [],
      });
      await client.request('session/prompt', {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'go' }],
      });
      await waitFor(() => readRecorded(dirs).length > 0, { label: 'hook answer recorded' });
      assert.deepEqual(seen, ['fs/read_text_file']);
      assert.deepEqual(readRecorded(dirs)[0]?.['result'], { content: 'stub from hook' });
    },
    {},
    {
      onServerRequest: (method) => {
        seen.push(method);
        return { content: 'stub from hook' };
      },
    },
  );
});

test('client: a hook that throws sends -32603, and an unimplemented method -32601', async () => {
  await withClient(
    'unknown-request',
    async ({ client, dirs }) => {
      await client.request('initialize', { protocolVersion: 1 });
      const created = await client.request<{ sessionId: string }>('session/new', {
        cwd: dirs.sessionDir,
        mcpServers: [],
      });
      const result = await client.request<{ stopReason: string }>('session/prompt', {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'go' }],
      });
      assert.equal(result.stopReason, 'end_turn');
      const error = readRecorded(dirs)[0]?.['error'] as { code: number } | undefined;
      assert.equal(error?.code, -32603);
    },
    {},
    {
      onServerRequest: () => {
        throw new Error('hook exploded');
      },
    },
  );

  // No hook at all: the client answers -32601 and the turn still completes.
  await withClient('unknown-request', async ({ client, dirs }) => {
    await client.request('initialize', { protocolVersion: 1 });
    const created = await client.request<{ sessionId: string }>('session/new', {
      cwd: dirs.sessionDir,
      mcpServers: [],
    });
    const result = await client.request<{ stopReason: string }>('session/prompt', {
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'go' }],
    });
    assert.equal(result.stopReason, 'end_turn');
    const error = readRecorded(dirs)[0]?.['error'] as { code: number } | undefined;
    assert.equal(error?.code, -32601);
  });
});

function readRecorded(dirs: TempDirs): Record<string, unknown>[] {
  return readJsonLines(path.join(dirs.stateDir, 'unknown-request.json'));
}
