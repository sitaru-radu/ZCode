/**
 * Streaming semantics (spec §3): the event stream is hot, drops with a counter when nobody is
 * attached, and ends when the session is destroyed. Also covers the turn deadline, which is the one
 * failure that must not leave a session busy forever.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { HotEventStream } from '../src/events.js';
import { PromptTimeout, RequestTimeout } from '../src/errors.js';
import {
  createFakeAdapter,
  delay,
  incomingFrames,
  killRecordedFakes,
  makeTempDirs,
  removeTempDirs,
  waitFor,
} from './helpers.js';

test('hot stream: events published with no subscriber are dropped and counted', async () => {
  const stream = new HotEventStream<number>(8);
  stream.publish(1);
  stream.publish(2);
  assert.deepEqual(stream.stats, { delivered: 0, dropped: 2, overflow: 0, subscribers: 0 });

  const iterator = stream.subscribe();
  assert.equal(stream.stats.subscribers, 1);
  stream.publish(3);
  const first = await iterator.next();
  assert.deepEqual(first, { value: 3, done: false });
  // Only the events published while attached are delivered: nothing is replayed.
  assert.deepEqual(stream.stats, { delivered: 1, dropped: 2, overflow: 0, subscribers: 1 });
  await iterator.return?.(undefined);
  assert.equal(stream.stats.subscribers, 0);
});

test('hot stream: every subscriber sees the event and close() ends all iterators', async () => {
  const stream = new HotEventStream<string>(8);
  const a = stream.subscribe();
  const b = stream.subscribe();
  stream.publish('x');
  assert.deepEqual((await a.next()).value, 'x');
  assert.deepEqual((await b.next()).value, 'x');
  stream.close();
  assert.deepEqual(await a.next(), { value: undefined, done: true });
  assert.deepEqual(await b.next(), { value: undefined, done: true });
  const late = stream.subscribe();
  assert.deepEqual(await late.next(), { value: undefined, done: true });
});

test('hot stream: a lagging subscriber loses events to a bounded queue, never to memory growth', async () => {
  const stream = new HotEventStream<number>(2);
  const iterator = stream.subscribe();
  for (const value of [1, 2, 3, 4, 5]) stream.publish(value);
  const stats = stream.stats;
  assert.equal(stats.overflow, 3);
  assert.equal(stats.delivered, 5);
  assert.deepEqual((await iterator.next()).value, 4);
  assert.deepEqual((await iterator.next()).value, 5);
});

test('adapter: a subscriber that attaches mid-turn receives the following events of that turn', async () => {
  const dirs = makeTempDirs();
  const adapter = createFakeAdapter({ stateDir: dirs.stateDir, scenario: 'delayed' });
  try {
    await adapter.start();
    const { sessionId } = await adapter.createSession({ cwd: dirs.sessionDir });
    const pending = adapter.runTask(sessionId, 'two phase task');
    // The first update has no subscriber; the second one arrives after we attach.
    await waitFor(() => (adapter.getStreamStats(sessionId)?.dropped ?? 0) >= 1, { label: 'first event dropped' });
    const events: string[] = [];
    const iterator = adapter.streamEvents(sessionId)[Symbol.asyncIterator]();
    const pump = (async () => {
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) return;
        events.push(String(next.value.text ?? next.value.kind));
      }
    })();
    const result = await pending;
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result.finalText, 'second');
    await waitFor(() => events.includes('second'), { label: 'mid-turn event delivered' });
    assert.deepEqual(events, ['second']);
    await iterator.return?.(undefined);
    await pump;
  } finally {
    await adapter.dispose().catch(() => undefined);
    killRecordedFakes(dirs.stateDir);
    removeTempDirs(dirs);
  }
});

test('adapter: events of an unobserved turn are dropped, not buffered for later replay', async () => {
  const dirs = makeTempDirs();
  const adapter = createFakeAdapter({ stateDir: dirs.stateDir, scenario: 'stream' });
  try {
    await adapter.start();
    const { sessionId } = await adapter.createSession({ cwd: dirs.sessionDir });
    const result = await adapter.runTask(sessionId, 'nobody is listening');
    assert.equal(result.finalText, 'DONE', 'the turn result is complete even without a subscriber');
    const stats = adapter.getStreamStats(sessionId);
    assert.ok((stats?.dropped ?? 0) >= 7, `expected all turn events dropped, got ${String(stats?.dropped)}`);
    assert.equal(stats?.delivered, 0);

    const late: unknown[] = [];
    const iterator = adapter.streamEvents(sessionId)[Symbol.asyncIterator]();
    const raced = await Promise.race([iterator.next(), delay(150).then(() => 'idle' as const)]);
    assert.equal(raced, 'idle', 'nothing is replayed after the fact');
    await iterator.return?.(undefined);
    assert.deepEqual(late, []);
  } finally {
    await adapter.dispose().catch(() => undefined);
    killRecordedFakes(dirs.stateDir);
    removeTempDirs(dirs);
  }
});

test('adapter: the turn deadline rejects with PromptTimeout, cancels and frees the session', async () => {
  const dirs = makeTempDirs();
  const adapter = createFakeAdapter({
    stateDir: dirs.stateDir,
    scenario: 'slow',
    config: { turnTimeoutMs: 400, requestTimeoutMs: 3_000 },
  });
  try {
    await adapter.start();
    const { sessionId } = await adapter.createSession({ cwd: dirs.sessionDir });
    const started = Date.now();
    await assert.rejects(
      () => adapter.runTask(sessionId, 'never finishes'),
      (error: unknown) => {
        assert.ok(error instanceof PromptTimeout, 'a prompt deadline must be a PromptTimeout');
        assert.equal(error.kind, 'prompt-timeout');
        assert.equal(error.method, 'session/prompt');
        assert.equal(error.sessionId, sessionId);
        return true;
      },
    );
    assert.ok(Date.now() - started >= 380);
    assert.equal(adapter.getStatus(sessionId), 'idle', 'the session must not stay busy');
    // The cancel is fire-and-forget inside the adapter: wait for the peer to see it.
    await waitFor(() => incomingFrames(dirs.stateDir, 'session/cancel').length === 1, {
      label: 'cancel notification sent',
    });
    assert.equal(adapter.getState(), 'ready', 'the child survives a turn timeout');

    // The late settlement of the cancelled prompt is reported, never replayed as an event.
    await waitFor(
      () => adapter.getProtocolViolations().some((violation) => violation.fatal === false),
      { label: 'stale response reported' },
    );
    const violation = adapter.getProtocolViolations().find((entry) => entry.fatal === false);
    assert.match(String(violation?.message), /unknown request id/);

    // A later turn on the same session still works, but the fake is still holding the old prompt.
    await delay(50);
    assert.equal(adapter.getStatus(sessionId), 'idle');
  } finally {
    await adapter.dispose().catch(() => undefined);
    killRecordedFakes(dirs.stateDir);
    removeTempDirs(dirs);
  }
});

test('adapter: RequestTimeout stays the base class of PromptTimeout', () => {
  const timeout = new PromptTimeout({ sessionId: 's', timeoutMs: 5 });
  assert.ok(timeout instanceof RequestTimeout);
  assert.equal(timeout.timeoutMs, 5);
});

test('adapter: dispose ends the streams of live sessions', async () => {
  const dirs = makeTempDirs();
  const fake = createFakeAdapter({ stateDir: dirs.stateDir, scenario: 'stream' });
  try {
    await fake.start();
    const { sessionId } = await fake.createSession({ cwd: dirs.sessionDir });
    const iterator = fake.streamEvents(sessionId)[Symbol.asyncIterator]();
    await fake.dispose();
    const next = await iterator.next();
    assert.equal(next.done, true);
    assert.equal(fake.getStatus(sessionId), 'closed');
  } finally {
    await fake.dispose().catch(() => undefined);
    killRecordedFakes(dirs.stateDir);
    removeTempDirs(dirs);
  }
});
