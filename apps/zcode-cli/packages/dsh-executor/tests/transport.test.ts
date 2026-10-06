/**
 * Unit tests for the framing, log and redaction primitives that the transport is built from.
 * These run without any child process: they pin the behaviour that the harder-to-debug integration
 * paths depend on (partial chunks, oversized lines, bounded stderr, secret filtering).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyFrame, encodeError, encodeNotification, encodeRequest, encodeResult, isRecord } from '../src/jsonrpc.js';
import { LineSplitter } from '../src/line-splitter.js';
import { LogRing, TRUNCATION_MARKER } from '../src/log-buffer.js';
import { REDACTED, createRedactor, secretValuesFromEnv } from '../src/redact.js';

test('framing: encodes NDJSON requests, notifications and results', () => {
  assert.equal(
    encodeRequest(1, 'session/new', { cwd: '/x' }),
    '{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/x"}}\n',
  );
  assert.equal(
    encodeNotification('session/cancel', { sessionId: 's' }),
    '{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s"}}\n',
  );
  assert.equal(encodeResult(2, {}), '{"jsonrpc":"2.0","id":2,"result":{}}\n');
  assert.equal(
    encodeError(3, -32601, 'Method not found: x'),
    '{"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"Method not found: x"}}\n',
  );
});

test('framing: classifies responses, requests, notifications and invalid frames', () => {
  assert.deepEqual(classifyFrame({ jsonrpc: '2.0', id: 4, result: { ok: true } }), {
    type: 'response',
    id: 4,
    result: { ok: true },
  });
  assert.deepEqual(classifyFrame({ jsonrpc: '2.0', id: 5, error: { code: -32602, message: 'bad' } }), {
    type: 'error',
    id: 5,
    error: { code: -32602, message: 'bad' },
  });
  assert.deepEqual(classifyFrame({ jsonrpc: '2.0', method: 'session/update', params: { a: 1 } }), {
    type: 'notification',
    method: 'session/update',
    params: { a: 1 },
  });
  assert.deepEqual(classifyFrame({ jsonrpc: '2.0', id: 9, method: 'session/request_permission' }), {
    type: 'request',
    id: 9,
    method: 'session/request_permission',
    params: undefined,
  });
  assert.equal(classifyFrame([1, 2]).type, 'invalid');
  assert.equal(classifyFrame({ jsonrpc: '2.0', id: 1 }).type, 'invalid');
  assert.equal(classifyFrame({ jsonrpc: '2.0' }).type, 'invalid');
  assert.equal(isRecord({}), true);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord([]), false);
});

test('line splitter: tolerates partial chunks and keeps every complete line', () => {
  const splitter = new LineSplitter(1_024);
  assert.deepEqual(splitter.push('{"a":'), { lines: [], oversized: 0 });
  assert.deepEqual(splitter.push('1}\n{"b":2}\n'), {
    lines: ['{"a":1}', '{"b":2}'],
    oversized: 0,
  });
  assert.equal(splitter.pending(), '');
  // An empty line is framing noise, not an empty frame.
  assert.deepEqual(splitter.push('\n\n'), { lines: [], oversized: 0 });
  assert.deepEqual(splitter.push('tail'), { lines: [], oversized: 0 });
  assert.equal(splitter.pending(), 'tail');
});

test('line splitter: drops an oversized line, reports it and resynchronises on the next newline', () => {
  const splitter = new LineSplitter(1_024);
  const first = splitter.push(`${'x'.repeat(2_000)}`);
  assert.equal(first.oversized, 1);
  assert.equal(splitter.skipping, true);
  // The rest of the oversized line is discarded without a second report.
  assert.deepEqual(splitter.push('xxxx'), { lines: [], oversized: 0 });
  // The newline ends it; the following frame is delivered normally.
  assert.deepEqual(splitter.push('\n{"ok":true}\n'), { lines: ['{"ok":true}'], oversized: 0 });
  assert.equal(splitter.skipping, false);
});

test('log ring: bounded, truncating and redacting before anything is stored or forwarded', () => {
  const forwarded: string[] = [];
  const secret = 'sk-live-abcdef123456';
  const ring = new LogRing({
    capacity: 3,
    redact: createRedactor([secret]),
    sink: (line) => forwarded.push(line),
  });
  ring.push(`boot token=${secret}\n`);
  ring.push(`${'y'.repeat(3_000)}\n`);
  for (let index = 0; index < 5; index += 1) ring.push(`line-${String(index)}\n`);
  ring.push('tail with no newline');

  assert.equal(ring.droppedLines, 4);
  assert.equal(ring.lines().length, 3);
  assert.equal(ring.lines().at(-1), 'line-4');
  assert.equal(forwarded.length, 7, 'every complete line reaches the sink');
  assert.ok(forwarded[0]?.includes(REDACTED));
  assert.ok(!forwarded[0]?.includes(secret));
  assert.ok(forwarded[1]?.endsWith(TRUNCATION_MARKER));
  assert.equal(ring.excerpt(2), 'line-3\nline-4');
  assert.deepEqual(ring.flush(), ['tail with no newline']);
  assert.equal(ring.excerpt(1), 'tail with no newline');
});

test('redaction: shape rules catch tokens that were never named', () => {
  const redact = createRedactor([]);
  assert.equal(redact('key sk-abcdef123456 here'), `key sk-${REDACTED} here`);
  assert.equal(redact('Authorization: Bearer abcdef123456'), `Authorization: Bearer ${REDACTED}`);
  assert.equal(redact('DEEPSEEK_API_KEY=abcdef123456'), `DEEPSEEK_API_KEY=${REDACTED}`);
  assert.equal(redact('apiKey: "abcdef123456"'), `apiKey: "${REDACTED}"`);
  assert.equal(redact('--token abcdef123456'), `--token ${REDACTED}`);
  assert.equal(redact('nothing to hide'), 'nothing to hide');
  // A later rule must not swallow an earlier rule's marker and re-flag it.
  assert.equal(redact('token=sk-abcdef123456'), `token=sk-${REDACTED}`);
  assert.equal(redact('literal value assigned'), 'literal value assigned');
});

test('redaction: literal secrets win over built-in patterns and short values are ignored', () => {
  const redact = createRedactor(['hunter2-not-a-token', 'short']);
  assert.equal(redact('value=hunter2-not-a-token'), `value=${REDACTED}`);
  assert.equal(redact('value=short'), 'value=short');
  assert.equal(redact(''), '');
});

test('redaction: environment secrets are discovered by variable name', () => {
  assert.deepEqual(
    secretValuesFromEnv({
      DEEPSEEK_API_KEY: 'sk-env-value-123456',
      PROXY_TOKEN: 'proxy-token-123456',
      PATH: '/usr/bin',
      HOME: '/home/x',
      SHORT_KEY: 'tiny',
    }).sort(),
    ['proxy-token-123456', 'sk-env-value-123456'],
  );
});
