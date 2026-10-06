/**
 * The frozen public surface of spec §6 must exist exactly as specified: this test locks the
 * runtime exports of the barrel and checks the shape of every function.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as core from '../src/index.js';

const EXPECTED_RUNTIME_EXPORTS = [
  'ADVISORY_PLAN_ISSUE_CODES',
  'blockedTasks',
  'canTransitionMission',
  'canTransitionTask',
  'deriveId',
  'evaluateCompletion',
  'hasProgress',
  'isTerminalMission',
  'materializeTasks',
  'missionPhaseFor',
  'newId',
  'readyTasks',
  'remediationTasksFor',
  'selectDispatch',
  'shortHash',
  'validatePlan',
].sort();

/** Declared arity required by §6; rest parameters do not count, optional ones still do. */
const EXPECTED_ARITIES: [string, number][] = [
  ['missionPhaseFor', 1],
  ['isTerminalMission', 1],
  ['canTransitionMission', 2],
  ['canTransitionTask', 2],
  ['validatePlan', 2], // (plan, limits?)
  ['materializeTasks', 3],
  ['readyTasks', 1],
  ['blockedTasks', 1],
  ['selectDispatch', 2],
  ['hasProgress', 1],
  ['evaluateCompletion', 1],
  ['remediationTasksFor', 3],
  ['newId', 1],
  ['deriveId', 1], // rest parameter
  ['shortHash', 1],
];

test('barrel exports exactly the frozen §6 surface plus the §5 id helpers', () => {
  assert.deepEqual(Object.keys(core).sort(), EXPECTED_RUNTIME_EXPORTS);
});

test('every exported function of §6 exists with its specified arity', () => {
  const runtime = core as unknown as Record<string, unknown>;
  for (const [name, arity] of EXPECTED_ARITIES) {
    const fn = runtime[name];
    assert.equal(typeof fn, 'function', `${name} must be exported as a function`);
    assert.equal((fn as (...args: unknown[]) => unknown).length, arity, `${name} arity`);
  }
});

test('the advisory issue code list exposes only the advisory codes of §7.8', () => {
  assert.deepEqual([...core.ADVISORY_PLAN_ISSUE_CODES], ['overlapping-files']);
});

test('the barrel is a namespace of named exports only', () => {
  assert.equal(Object.hasOwn(core, 'default'), false);
  assert.equal(core.newId('prj').startsWith('prj_'), true);
});
