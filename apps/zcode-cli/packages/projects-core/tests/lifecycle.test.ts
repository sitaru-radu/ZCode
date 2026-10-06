/**
 * §2 mission state machine, §3 task state machine and the derived mission phase.
 *
 * The transition tests compare the *complete* 10x10 (mission) and 7x7 (task) matrices against the
 * tables of the spec, so an accepted transition that the spec does not list fails just as loudly as
 * a missing one — invariant 6 and 7 are covered here in full.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canTransitionMission,
  canTransitionTask,
  isTerminalMission,
  missionPhaseFor,
  type MissionPhase,
  type MissionStatus,
  type TaskStatus,
} from '../src/index.js';

const MISSION_STATUSES: readonly MissionStatus[] = [
  'draft',
  'planning',
  'ready',
  'running',
  'blocked',
  'reviewing',
  'testing',
  'completed',
  'failed',
  'cancelled',
];

const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'ready', 'running', 'review', 'done', 'failed', 'blocked'];

/** §2 mission state machine (the "any non-terminal -> cancelled" row is expanded). */
const ALLOWED_MISSION: Readonly<Record<MissionStatus, readonly MissionStatus[]>> = {
  draft: ['planning', 'cancelled'],
  planning: ['ready', 'failed', 'cancelled'],
  ready: ['running', 'cancelled'],
  running: ['reviewing', 'blocked', 'failed', 'cancelled'],
  blocked: ['running', 'cancelled'],
  reviewing: ['testing', 'running', 'blocked', 'cancelled'],
  testing: ['completed', 'running', 'blocked', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

/** §3 task state machine; `blocked -> pending` is the guarded re-open of a new plan version. */
const ALLOWED_TASK: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['ready', 'blocked'],
  ready: ['running'],
  running: ['review', 'ready', 'failed'],
  review: ['done', 'ready', 'failed'],
  done: [],
  failed: [],
  blocked: ['pending'],
};

function pairsOf<T extends string>(
  values: readonly T[],
  allowed: Readonly<Record<T, readonly T[]>>,
): string[] {
  const pairs: string[] = [];
  for (const from of values) {
    for (const to of allowed[from]) {
      pairs.push(`${from}->${to}`);
    }
  }
  return pairs.sort();
}

test('missionPhaseFor derives a phase for every status of §2', () => {
  const expected: Record<MissionStatus, MissionPhase> = {
    draft: 'understand',
    planning: 'plan',
    ready: 'execute',
    running: 'execute',
    blocked: 'execute',
    reviewing: 'review',
    testing: 'test',
    completed: 'complete',
    failed: 'complete',
    cancelled: 'complete',
  };
  for (const status of MISSION_STATUSES) {
    assert.equal(missionPhaseFor(status), expected[status], status);
  }
});

test('isTerminalMission is true for exactly completed, failed and cancelled', () => {
  const terminal = MISSION_STATUSES.filter((status) => isTerminalMission(status));
  assert.deepEqual(terminal, ['completed', 'failed', 'cancelled']);
});

test('canTransitionMission accepts exactly the transitions of §2', () => {
  const accepted: string[] = [];
  for (const from of MISSION_STATUSES) {
    for (const to of MISSION_STATUSES) {
      if (canTransitionMission(from, to)) {
        accepted.push(`${from}->${to}`);
      }
    }
  }
  assert.deepEqual(accepted.sort(), pairsOf(MISSION_STATUSES, ALLOWED_MISSION));
  assert.equal(accepted.length, 21);
});

test('canTransitionMission rejects specific transitions outside §2', () => {
  const rejected: [MissionStatus, MissionStatus][] = [
    ['draft', 'ready'],
    ['draft', 'running'],
    ['draft', 'completed'],
    ['planning', 'running'],
    ['planning', 'blocked'],
    ['ready', 'ready'],
    ['ready', 'blocked'],
    ['ready', 'reviewing'],
    ['running', 'ready'],
    ['running', 'testing'],
    ['running', 'completed'],
    ['blocked', 'ready'],
    ['blocked', 'reviewing'],
    ['blocked', 'blocked'],
    ['reviewing', 'completed'],
    ['reviewing', 'failed'],
    ['testing', 'reviewing'],
    ['testing', 'failed'],
  ];
  for (const [from, to] of rejected) {
    assert.equal(canTransitionMission(from, to), false, `${from}->${to} must be rejected`);
  }
});

test('terminal mission statuses never transition anywhere (invariant 7)', () => {
  for (const from of ['completed', 'failed', 'cancelled'] as const) {
    assert.equal(isTerminalMission(from), true);
    for (const to of MISSION_STATUSES) {
      assert.equal(canTransitionMission(from, to), false, `${from}->${to}`);
    }
  }
});

test('canTransitionMission rejects self-transitions for every status', () => {
  for (const status of MISSION_STATUSES) {
    assert.equal(canTransitionMission(status, status), false, status);
  }
});

test('canTransitionTask accepts exactly the transitions of §3', () => {
  const accepted: string[] = [];
  for (const from of TASK_STATUSES) {
    for (const to of TASK_STATUSES) {
      if (canTransitionTask(from, to)) {
        accepted.push(`${from}->${to}`);
      }
    }
  }
  assert.deepEqual(accepted.sort(), pairsOf(TASK_STATUSES, ALLOWED_TASK));
  assert.equal(accepted.length, 10);
});

test('canTransitionTask rejects specific transitions outside §3', () => {
  const rejected: [TaskStatus, TaskStatus][] = [
    ['pending', 'running'],
    ['pending', 'done'],
    ['pending', 'failed'],
    ['ready', 'review'],
    ['ready', 'done'],
    ['ready', 'failed'],
    ['ready', 'blocked'],
    ['running', 'done'],
    ['running', 'blocked'],
    ['running', 'pending'],
    ['review', 'running'],
    ['review', 'blocked'],
    ['done', 'ready'],
    ['done', 'pending'],
    ['failed', 'ready'],
    ['failed', 'pending'],
    ['blocked', 'ready'],
    ['blocked', 'failed'],
  ];
  for (const [from, to] of rejected) {
    assert.equal(canTransitionTask(from, to), false, `${from}->${to} must be rejected`);
  }
});

test('canTransitionTask rejects self-transitions and closed terminal states', () => {
  for (const status of TASK_STATUSES) {
    assert.equal(canTransitionTask(status, status), false, status);
  }
  for (const to of TASK_STATUSES) {
    assert.equal(canTransitionTask('done', to), false, `done->${to}`);
    assert.equal(canTransitionTask('failed', to), false, `failed->${to}`);
  }
  // `blocked` is terminal for scheduling but may be re-opened explicitly by a new plan version.
  assert.deepEqual(TASK_STATUSES.filter((to) => canTransitionTask('blocked', to)), ['pending']);
});
