/**
 * The `submit_result` MCP bridge: handshake conformance in-process, then the real spawned entry
 * point driven over stdio exactly the way DSH drives it (probe §6 inbound frames).
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  createSubmitServer,
  type SubmitCallReport,
} from '../src/mcp/submit-server.js';
import {
  SUBMIT_SERVER_PATH,
  TSX_LOADER_URL,
  isAlive,
  killRecordedFakes,
  makeTempDirs,
  readJsonLines,
  removeTempDirs,
  waitFor,
} from './helpers.js';

const INPUT_SCHEMA = {
  type: 'object',
  required: ['status'],
  properties: { status: { type: 'string' }, note: { type: 'string' } },
} as const;

function frame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Narrow a waited-for frame; the `waitFor` above has already asserted it arrived. */
function payload<T>(value: unknown): T {
  assert.ok(value !== undefined, 'expected a frame from the MCP server');
  return value as T;
}

function resultOf<T>(frameValue: Record<string, unknown> | undefined): T {
  return payload<{ result: T }>(frameValue).result;
}

test('submit server (in-process): handshake, tools/list, tools/call and the fallback trigger', () => {
  const calls: SubmitCallReport[] = [];
  const logs: string[] = [];
  const server = createSubmitServer({
    inputSchema: INPUT_SCHEMA,
    onCall: (report) => calls.push(report),
    onLog: (line) => logs.push(line),
  });

  const initialize = server.handleLine(
    frame({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'dsh-mcp-client', version: '0.0.1' },
      },
    }),
  );
  assert.equal(initialize.length, 1);
  const initResult = JSON.parse(initialize[0] ?? '{}') as { result?: Record<string, unknown> };
  assert.equal(initResult.result?.['protocolVersion'], '2025-11-25');
  assert.deepEqual(initResult.result?.['capabilities'], { tools: { listChanged: false } });
  assert.equal((initResult.result?.['serverInfo'] as { name: string } | undefined)?.name, 'dsh-executor-submit');

  // DSH probes with the draft method first; answering -32601 forces the legacy handshake.
  const discover = server.handleLine(
    frame({ jsonrpc: '2.0', id: 'server-discover-probe-1', method: 'server/discover', params: {} }),
  );
  const discoverFrame = JSON.parse(discover[0] ?? '{}') as { id: unknown; error?: { code: number } };
  assert.equal(discoverFrame.id, 'server-discover-probe-1', 'string ids must be echoed verbatim');
  assert.equal(discoverFrame.error?.code, -32601);

  assert.deepEqual(server.handleLine(frame({ jsonrpc: '2.0', method: 'notifications/initialized' })), []);

  const listed = JSON.parse(server.handleLine(frame({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))[0] ?? '{}') as {
    result?: { tools: { name: string; inputSchema: unknown }[] };
  };
  assert.equal(listed.result?.tools.length, 1);
  assert.equal(listed.result?.tools[0]?.name, 'submit_result');
  assert.deepEqual(listed.result?.tools[0]?.inputSchema, INPUT_SCHEMA);

  const accepted = JSON.parse(
    server.handleLine(
      frame({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'submit_result', arguments: { status: 'done', note: 'worker-42' } },
      }),
    )[0] ?? '{}',
  ) as { result?: { isError?: boolean; content: { text: string }[] } };
  assert.equal(accepted.result?.isError, false);
  assert.equal(accepted.result?.content[0]?.text, 'submit_result accepted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.ok, true);
  assert.deepEqual(calls[0]?.args, { status: 'done', note: 'worker-42' });

  const rejected = JSON.parse(
    server.handleLine(
      frame({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'submit_result', arguments: {} } }),
    )[0] ?? '{}',
  ) as { result?: { isError?: boolean; content: { text: string }[] } };
  assert.equal(rejected.result?.isError, true);
  assert.match(rejected.result?.content[0]?.text ?? '', /missing required property "status"/);
  assert.equal(calls[1]?.ok, false);
  assert.equal(calls[1]?.error, 'missing required property "status"');

  const unknownTool = JSON.parse(
    server.handleLine(
      frame({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'other', arguments: {} } }),
    )[0] ?? '{}',
  ) as { error?: { code: number } };
  assert.equal(unknownTool.error?.code, -32602);

  const unknownMethod = JSON.parse(
    server.handleLine(frame({ jsonrpc: '2.0', id: 5, method: 'resources/list' }))[0] ?? '{}',
  ) as { error?: { code: number } };
  assert.equal(unknownMethod.error?.code, -32601);

  const parseError = JSON.parse(server.handleLine('this is not json')[0] ?? '{}') as {
    id: unknown;
    error?: { code: number };
  };
  assert.equal(parseError.id, null);
  assert.equal(parseError.error?.code, -32700);

  assert.deepEqual(server.handleLine(''), []);
  assert.equal(server.callCount, 1, 'only accepted calls are counted');
  assert.ok(logs.some((line) => line.includes('server/discover')));
});

test('submit server (spawned): full MCP conversation on stdio, sink file, clean EOF exit', async () => {
  const dirs = makeTempDirs();
  const schemaFile = path.join(dirs.root, 'schema.json');
  const resultFile = path.join(dirs.root, 'results.ndjson');
  writeFileSync(schemaFile, JSON.stringify(INPUT_SCHEMA));

  const child: ChildProcess = spawn(
    process.execPath,
    ['--import', TSX_LOADER_URL, SUBMIT_SERVER_PATH],
    {
      cwd: dirs.root,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: dirs.homeDir,
        DSH_SUBMIT_SCHEMA_FILE: schemaFile,
        DSH_SUBMIT_TOOL_NAME: 'submit_result',
        DSH_SUBMIT_RESULT_FILE: resultFile,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const received: Record<string, unknown>[] = [];
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
    let index = stdout.indexOf('\n');
    while (index !== -1) {
      const line = stdout.slice(0, index);
      stdout = stdout.slice(index + 1);
      if (line.trim() !== '') received.push(JSON.parse(line) as Record<string, unknown>);
      index = stdout.indexOf('\n');
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exit = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => {
      resolve(code);
    });
  });

  try {
    const send = (value: unknown): void => {
      child.stdin?.write(frame(value));
    };
    const responseFor = (id: number | string): Record<string, unknown> | undefined =>
      received.find((entry) => entry['id'] === id);

    send({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'dsh-mcp-client' } },
    });
    await waitFor(() => responseFor(0) !== undefined, { label: 'initialize response' });
    assert.equal(resultOf<{ protocolVersion: string }>(responseFor(0)).protocolVersion, '2025-11-25');

    send({ jsonrpc: '2.0', id: 'server-discover-probe-1', method: 'server/discover', params: {} });
    await waitFor(() => responseFor('server-discover-probe-1') !== undefined, { label: 'discover response' });
    assert.equal(
      payload<{ error: { code: number } }>(responseFor('server-discover-probe-1')).error.code,
      -32601,
    );

    const beforeNotification = received.length;
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    await waitFor(() => responseFor(1) !== undefined, { label: 'tools/list response' });
    assert.equal(received.length, beforeNotification + 1, 'notifications are never answered');
    const tools = resultOf<{ tools: { name: string }[] }>(responseFor(1)).tools;
    assert.deepEqual(tools.map((tool) => tool.name), ['submit_result']);

    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'submit_result', arguments: { status: 'done', note: 'worker-42' } },
    });
    await waitFor(() => responseFor(2) !== undefined, { label: 'tools/call response' });
    const callResult = resultOf<{ isError: boolean; content: { text: string }[] }>(responseFor(2));
    assert.equal(callResult.isError, false);
    assert.deepEqual(
      readJsonLines(resultFile).map((entry) => entry['args']),
      [{ status: 'done', note: 'worker-42' }],
    );
    assert.equal(readJsonLines(resultFile)[0]?.['ok'], true);

    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'submit_result', arguments: { note: 'missing status' } },
    });
    await waitFor(() => responseFor(3) !== undefined, { label: 'rejected call response' });
    assert.equal(resultOf<{ isError: boolean }>(responseFor(3)).isError, true);
    assert.equal(readJsonLines(resultFile)[1]?.['ok'], false);

    // EOF on stdin is the shutdown signal: the bridge must exit cleanly, like the agent does.
    child.stdin?.end();
    const code = await exit;
    assert.equal(code, 0, `submit server must exit 0 on stdin EOF (stderr: ${stderr})`);
    assert.equal(existsSync(resultFile), true);
  } finally {
    if (isAlive(child.pid ?? 0)) child.kill('SIGKILL');
    killRecordedFakes(dirs.stateDir);
    removeTempDirs(dirs);
  }
});
