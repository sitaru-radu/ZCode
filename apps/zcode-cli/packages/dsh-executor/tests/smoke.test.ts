/** Public surface smoke test: the barrel must expose the frozen adapter factory and its types. */

import assert from 'node:assert/strict';
import test from 'node:test';

import * as api from '../src/index.js';

test('@zcode/dsh-executor exposes the public surface', () => {
  assert.equal(typeof api.createDshExecutor, 'function');
  assert.equal(typeof api.DshExecutorAdapter, 'function');
  assert.equal(typeof api.createSubmitServer, 'function');
  assert.equal(typeof api.createSubmitMcpServer, 'function');
  assert.equal(typeof api.resolveConfig, 'function');
  assert.equal(typeof api.buildChildEnv, 'function');
  assert.equal(typeof api.resolveModelValue, 'function');
  assert.equal(typeof api.parseFencedJson, 'function');
  assert.equal(typeof api.toAcpMcpServers, 'function');
  assert.equal(api.ACP_PROTOCOL_VERSION, 1);
  assert.equal(api.DSH_PERMISSION_MODE_ENV, 'DSH_PERMISSION_MODE');
});

test('@zcode/dsh-executor stays engine agnostic', async () => {
  const barrel = await import('../src/index.js');
  const exported = Object.keys(barrel);
  assert.ok(exported.length > 20);
  // The mission package imports this barrel; nothing here may import a workflow engine.
  assert.equal(exported.some((name) => name.toLowerCase().includes('workflow')), false);
});
