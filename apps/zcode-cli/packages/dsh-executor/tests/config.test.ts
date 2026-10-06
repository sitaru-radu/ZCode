/**
 * Configuration, model selection, MCP descriptor validation and the typed-result helpers.
 *
 * These are the pure contracts the rest of the package (and the mission runner) is allowed to rely
 * on, so they are pinned without spawning anything.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  DSH_PERMISSION_MODE_ENV,
  buildChildArgs,
  buildChildEnv,
  resolveConfig,
} from '../src/config.js';
import { McpConfigError, toAcpMcpServers } from '../src/mcp/servers.js';
import {
  encodeModelValue,
  modelIdsFromOptions,
  parseModelValue,
  resolveModelValue,
} from '../src/models.js';
import { buildPermissionResponse, readPermissionRequest } from '../src/permissions.js';
import { createSubmitMcpServer, validateArguments } from '../src/mcp/submit-server.js';
import { fencedJsonBlocks, parseFencedJson } from '../src/submission.js';
import { isSubmitToolName, normalizeUpdate, truncateText } from '../src/updates.js';

test('config: defaults match the spec and the child argv carries the profile', () => {
  const config = resolveConfig();
  assert.equal(config.binary, 'dsh');
  assert.equal(config.profile, 'acp');
  assert.equal(config.requestTimeoutMs, 30_000);
  assert.equal(config.turnTimeoutMs, 15 * 60_000);
  assert.equal(config.permissionPolicy, 'deny-unapproved');
  assert.equal(config.submitServerName, 'submit');
  assert.equal(config.submitToolName, 'submit_result');
  assert.deepEqual(buildChildArgs(config), ['--profile', 'acp']);
  assert.deepEqual(buildChildArgs(resolveConfig({ profile: '', args: ['--flag'] })), ['--flag']);
  assert.deepEqual(buildChildArgs(resolveConfig({ args: ['--flag'] })), ['--profile', 'acp', '--flag']);
});

test('config: the child environment is built explicitly, never copied wholesale', () => {
  const parent = {
    PATH: '/usr/bin',
    HOME: '/home/worker',
    DEEPSEEK_API_KEY: 'sk-parent-secret-123456',
    RANDOM_AMBIENT_VAR: 'must-not-leak',
    DEBUG: '*',
  };
  const env = buildChildEnv(resolveConfig(), parent);
  assert.equal(env['PATH'], '/usr/bin');
  assert.equal(env['HOME'], '/home/worker');
  assert.equal('DEEPSEEK_API_KEY' in env, false, 'ambient secrets are never forwarded');
  assert.equal('RANDOM_AMBIENT_VAR' in env, false);
  assert.equal('DEBUG' in env, false);

  const configured = buildChildEnv(
    resolveConfig({ env: { DEEPSEEK_API_KEY: 'sk-child-123456', EXTRA: '1' }, permissionMode: 'danger-full-access' }),
    parent,
  );
  assert.equal(configured['DEEPSEEK_API_KEY'], 'sk-child-123456');
  assert.equal(configured['EXTRA'], '1');
  assert.equal(configured[DSH_PERMISSION_MODE_ENV], 'danger-full-access');
  assert.equal(configured['RANDOM_AMBIENT_VAR'], undefined);

  // An explicit env value wins over the permissionMode shortcut.
  const overridden = buildChildEnv(
    resolveConfig({ permissionMode: 'danger-full-access', env: { [DSH_PERMISSION_MODE_ENV]: 'workspace-write' } }),
    parent,
  );
  assert.equal(overridden[DSH_PERMISSION_MODE_ENV], 'workspace-write');
});

test('mcp: descriptors are normalized into the exact wire shape', () => {
  const [stdio, http] = toAcpMcpServers([
    { name: 'submit', command: '/abs/node', args: ['/abs/server.js'], env: { A: '1' } },
    { name: 'remote', type: 'http', url: 'https://example.invalid/mcp' },
  ]);
  assert.deepEqual(stdio, {
    name: 'submit',
    command: '/abs/node',
    args: ['/abs/server.js'],
    env: [{ name: 'A', value: '1' }],
  });
  assert.deepEqual(http, { name: 'remote', type: 'http', url: 'https://example.invalid/mcp', headers: [] });
  assert.equal('type' in (stdio ?? {}), false, 'stdio entries must not carry a type key');

  // Array env/headers pass through; a malformed entry is refused instead of being silently dropped.
  assert.deepEqual(
    toAcpMcpServers([{ name: 'a', command: '/abs/node', env: [{ name: 'K', value: 'V' }] }])[0],
    { name: 'a', command: '/abs/node', args: [], env: [{ name: 'K', value: 'V' }] },
  );
  assert.throws(() => toAcpMcpServers([{ name: 'a', command: 'node' }]), /absolute path/);
  assert.throws(() => toAcpMcpServers([{ name: 'bad name', command: '/abs/node' }]), McpConfigError);
  assert.throws(
    () => toAcpMcpServers([{ name: 'a', command: '/abs/node' }, { name: 'a', command: '/abs/node' }]),
    /duplicate normalized name/,
  );
  assert.throws(
    () => toAcpMcpServers([{ name: 's', type: 'sse', url: 'https://x' } as never]),
    /transport sse is not supported/,
  );
  assert.throws(
    () => toAcpMcpServers([{ name: 'a', command: '/abs/node', env: [{ name: 'K' } as never] }]),
    /must be \{name: string, value: string\}/,
  );
});

test('mcp: the submit descriptor spawns this node with the schema in the environment', () => {
  const descriptor = createSubmitMcpServer({
    inputSchema: { type: 'object', required: ['status'] },
    toolName: 'submit_result',
    entryPath: path.join('/abs', 'submit-server.js'),
    resultFile: path.join('/abs', 'results.ndjson'),
  }) as { name: string; command: string; args: string[]; env: Record<string, string> };
  assert.equal(descriptor.name, 'submit');
  assert.equal(descriptor.command, process.execPath);
  assert.deepEqual(descriptor.args, [path.join('/abs', 'submit-server.js')]);
  assert.equal(descriptor.env['DSH_SUBMIT_TOOL_NAME'], 'submit_result');
  assert.equal(descriptor.env['DSH_SUBMIT_RESULT_FILE'], path.join('/abs', 'results.ndjson'));
  assert.deepEqual(JSON.parse(descriptor.env['DSH_SUBMIT_SCHEMA'] ?? '{}'), {
    type: 'object',
    required: ['status'],
  });
});

test('models: opaque values, bare ids and the live catalogue', () => {
  const options = [
    {
      id: 'model',
      currentValue: '["deepseek-official","deepseek-v4-flash"]',
      options: [
        {
          group: 'deepseek-official',
          options: [
            { value: '["deepseek-official","deepseek-v4-flash"]', name: 'deepseek-v4-flash' },
            { value: '["deepseek-official","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro' },
          ],
        },
      ],
    },
  ];
  assert.deepEqual(parseModelValue('["p","m"]'), { provider: 'p', model: 'm' });
  assert.equal(parseModelValue('deepseek-v4-pro'), undefined);
  assert.equal(parseModelValue('["only-one"]'), undefined);
  assert.equal(parseModelValue('not json at all'), undefined);
  assert.equal(encodeModelValue('deepseek-official', 'deepseek-v4-pro'), '["deepseek-official","deepseek-v4-pro"]');

  assert.equal(resolveModelValue('deepseek-v4-pro', options), '["deepseek-official","deepseek-v4-pro"]');
  assert.equal(resolveModelValue('DeepSeek-V4-Pro', options), '["deepseek-official","deepseek-v4-pro"]');
  assert.equal(
    resolveModelValue('["deepseek-official","deepseek-v4-flash"]', options),
    '["deepseek-official","deepseek-v4-flash"]',
  );
  // A catalogue that no longer carries an entry must not turn into a client-side hard failure.
  assert.equal(resolveModelValue('mystery-model', options), 'mystery-model');
  assert.deepEqual(modelIdsFromOptions(options), [
    'deepseek-official/deepseek-v4-flash',
    'deepseek-official/deepseek-v4-pro',
  ]);
});

test('permissions: the policy decides, and a missing option cancels instead of stalling', () => {
  const options = [
    { optionId: 'allow-once', kind: 'allow_once' },
    { optionId: 'reject-once', kind: 'reject_once' },
  ];
  assert.deepEqual(buildPermissionResponse(options, 'deny-unapproved'), {
    outcome: { outcome: 'selected', optionId: 'reject-once' },
  });
  assert.deepEqual(buildPermissionResponse(options, 'allow-all'), {
    outcome: { outcome: 'selected', optionId: 'allow-once' },
  });
  assert.deepEqual(buildPermissionResponse([], 'deny-unapproved'), { outcome: { outcome: 'cancelled' } });
  assert.deepEqual(
    buildPermissionResponse([{ optionId: 'allow-always', kind: 'allow_always' }], 'deny-unapproved'),
    { outcome: { outcome: 'cancelled' } },
  );
  // Unknown kinds still resolve by prefix rather than hanging the agent.
  assert.deepEqual(
    buildPermissionResponse([{ optionId: 'allow-forever', kind: 'allow_forever' }], 'allow-all'),
    { outcome: { outcome: 'selected', optionId: 'allow-forever' } },
  );
  const request = readPermissionRequest({
    sessionId: 's',
    toolCall: { toolCallId: 'call-1' },
    options: [{ optionId: 'o', kind: 'allow_once', name: 'Allow' }, 'junk'],
  });
  assert.equal(request.sessionId, 's');
  assert.equal(request.toolCallId, 'call-1');
  assert.equal(request.options.length, 1);
  assert.deepEqual(readPermissionRequest(undefined), { options: [] });
});

test('submission: only the last valid fenced json block counts', () => {
  assert.deepEqual(fencedJsonBlocks('a\n```json\n{}\n```\nb'), ['{}']);
  assert.deepEqual(parseFencedJson('```json\n{"a":1}\n```'), { value: { a: 1 }, block: '{"a":1}' });
  assert.deepEqual(parseFencedJson('```json\nbroken\n```\n```json\n{"b":2}\n```')?.value, { b: 2 });
  assert.equal(parseFencedJson('```json\nbroken\n```'), undefined);
  assert.equal(parseFencedJson('no block here'), undefined);
  assert.equal(parseFencedJson('```JSON\n{"a":1}\n```'), undefined, 'the fence is lowercase json');
});

test('updates: unknown kinds become `other`, text is truncated, submit names are matched loosely', () => {
  const event = normalizeUpdate('s', { sessionUpdate: 'brand_new_kind', detail: 'x' }, 5);
  assert.equal(event.kind, 'other');
  assert.equal(event.at, 5);
  assert.deepEqual(event.payload, { sessionUpdate: 'brand_new_kind', detail: 'x' });
  assert.equal(normalizeUpdate('s', 'not an object').kind, 'other');
  assert.equal(normalizeUpdate('s', undefined).payload, undefined);

  const long = 'x'.repeat(20_050);
  const truncated = truncateText(long);
  assert.ok(truncated.length < long.length);
  assert.match(truncated, /\[truncated 50 chars\]/);
  assert.equal(truncateText('short'), 'short');

  assert.equal(isSubmitToolName('mcp__submit__submit_result', 'submit_result'), true);
  assert.equal(isSubmitToolName('mcp__pro_be_deadbeef__submit_result', 'submit_result'), true);
  assert.equal(isSubmitToolName('mcp__submit__other', 'submit_result'), false);
  assert.equal(isSubmitToolName('submit_result', 'submit_result'), false);
  assert.equal(isSubmitToolName('mcp__submit__submit_result', ''), false);
});

test('submit server: required-property validation is reported, not swallowed', () => {
  const schema = { type: 'object', required: ['status', 'answer'] };
  assert.equal(validateArguments(schema, { status: 'done', answer: 1 }), undefined);
  assert.equal(validateArguments(schema, { status: 'done' }), 'missing required property "answer"');
  assert.equal(validateArguments(schema, 'nope'), 'arguments must be a JSON object');
  assert.equal(validateArguments({ type: 'object' }, { anything: true }), undefined);
});
