/**
 * The typed failure taxonomy (spec §7): every class, its `kind`, the evidence it carries and the
 * classification of JSON-RPC errors. Secrets must never reach a message (spec §7, last paragraph).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DshExecutorError,
  ExecutorExited,
  ExecutorHandshakeFailed,
  ExecutorRequestFailed,
  ExecutorSpawnFailed,
  PromptTimeout,
  ProtocolViolation,
  RequestTimeout,
  RpcMethodNotFound,
  SessionCreateFailed,
  SessionNotFound,
  isDshExecutorError,
  isExecutorExited,
  isProtocolViolation,
  isSessionNotFound,
  requestFailedError,
} from '../src/errors.js';
import { createRedactor } from '../src/redact.js';

test('taxonomy: every error class carries a stable kind and extends the base error', () => {
  const cases: [DshExecutorError, string][] = [
    [new ExecutorSpawnFailed({ binary: 'dsh', args: ['--profile', 'acp'] }), 'spawn-failed'],
    [new ExecutorHandshakeFailed({ message: 'nope' }), 'handshake-failed'],
    [new ExecutorExited({ exitInfo: { code: 3, signal: null, at: 1 } }), 'executor-exited'],
    [new ExecutorRequestFailed({ method: 'session/list', code: -32602 }), 'request-failed'],
    [new SessionCreateFailed({ cwd: '/x', code: -32603 }), 'session-create-failed'],
    [new SessionNotFound({ sessionId: 's' }), 'session-not-found'],
    [new RequestTimeout({ method: 'session/list', timeoutMs: 10 }), 'request-timeout'],
    [new PromptTimeout({ sessionId: 's', timeoutMs: 10 }), 'prompt-timeout'],
    [new ProtocolViolation({ message: 'bad frame' }), 'protocol-violation'],
  ];
  for (const [error, kind] of cases) {
    assert.ok(error instanceof DshExecutorError, `${kind} must extend DshExecutorError`);
    assert.ok(error instanceof Error);
    assert.equal(error.kind, kind);
    assert.equal(error.name.length > 0, true);
    assert.equal(isDshExecutorError(error), true);
    assert.ok(error.message.length > 0);
    assert.equal(typeof error.detail, 'object');
  }
  assert.equal(isDshExecutorError(new Error('plain')), false);
});

test('taxonomy: specializations keep the base classes usable for catch clauses', () => {
  const create = new SessionCreateFailed({ cwd: '/x', code: -32602, serverMessage: 'bad cwd' });
  assert.ok(create instanceof ExecutorRequestFailed);
  assert.equal(create.method, 'session/new');
  assert.equal(create.cwd, '/x');
  assert.match(create.message, /bad cwd/);

  const notFound = new SessionNotFound({ sessionId: 'abc', method: 'session/resume' });
  assert.ok(notFound instanceof ExecutorRequestFailed);
  assert.equal(notFound.sessionId, 'abc');
  assert.equal(isSessionNotFound(notFound), true);
  assert.equal(isSessionNotFound(new Error('x')), false);

  const timeout = new PromptTimeout({ sessionId: 'abc', timeoutMs: 42 });
  assert.ok(timeout instanceof RequestTimeout);
  assert.equal(timeout.method, 'session/prompt');
  assert.match(timeout.message, /42ms/);

  const exited = new ExecutorExited({ exitInfo: { code: null, signal: 'SIGKILL', at: 1 } });
  assert.equal(isExecutorExited(exited), true);
  assert.equal(exited.exitInfo?.signal, 'SIGKILL');
  assert.match(exited.message, /SIGKILL/);

  const violation = new ProtocolViolation({ message: 'bad', fatal: false });
  assert.equal(isProtocolViolation(violation), true);
  assert.equal(violation.fatal, false);
  assert.equal(new ProtocolViolation({ message: 'bad' }).fatal, true);
});

test('taxonomy: request failures are classified from method, code and message', () => {
  const create = requestFailedError({
    method: 'session/new',
    rpc: { code: -32603, message: 'Internal error', data: { details: 'mcp-client(ghost): ...' } },
    serverMessage: 'Internal error',
    cwd: '/work',
  });
  assert.ok(create instanceof SessionCreateFailed);
  assert.equal((create as SessionCreateFailed).cwd, '/work');
  assert.deepEqual((create as SessionCreateFailed).data, { details: 'mcp-client(ghost): ...' });

  const missing = requestFailedError({
    method: 'session/resume',
    rpc: { code: -32602, message: 'Invalid params: session not found: 0123abcd-0000' },
    serverMessage: 'Invalid params: session not found: 0123abcd-0000',
    sessionId: '0123abcd-0000',
  });
  assert.ok(missing instanceof SessionNotFound);

  // `-32602` is also "unknown session config option", which is a configuration failure, not a
  // missing session: the classifier must not collapse the two.
  const config = requestFailedError({
    method: 'session/set_config_option',
    rpc: { code: -32602, message: 'Invalid params: unknown session config option: nope' },
    serverMessage: 'Invalid params: unknown session config option: nope',
    sessionId: 'abc',
  });
  assert.ok(config instanceof ExecutorRequestFailed);
  assert.equal(config.kind, 'request-failed');
  assert.equal(config.code, -32602);

  const unknown = requestFailedError({
    method: 'session/prompt',
    rpc: { code: -32602, message: 'Invalid params: empty prompt' },
    serverMessage: 'Invalid params: empty prompt',
  });
  assert.equal(unknown.kind, 'request-failed');
  assert.equal(new RpcMethodNotFound('x').name, 'RpcMethodNotFound');
});

test('taxonomy: redaction is applied by the caller before a message is built', () => {
  const secret = 'sk-live-abcdef123456';
  const redact = createRedactor([secret]);
  const violation = new ProtocolViolation({
    message: 'malformed frame from executor stdout (not JSON)',
    evidence: redact(`garbage ${secret}`),
    stderrExcerpt: redact(`stderr says token=${secret}`),
  });
  assert.ok(!violation.evidence?.includes(secret));
  assert.ok(!violation.stderrExcerpt.includes(secret));
  assert.ok(violation.detail['evidence'] !== undefined);
  assert.ok(!JSON.stringify(violation.detail).includes(secret));
});
