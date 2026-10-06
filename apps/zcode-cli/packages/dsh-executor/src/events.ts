/**
 * Hot event stream for `streamEvents` (spec §3).
 *
 * Semantics that the runner depends on:
 *  - it is hot: a subscriber that attaches mid-turn receives the following events of that turn;
 *  - events published while nobody is attached are dropped and counted (`stats.dropped`);
 *  - a subscriber that stops reading cannot grow memory without bound: its queue is capped and
 *    overflow is counted (`stats.overflow`);
 *  - `close()` ends every iterator, so `for await` terminates when a session is destroyed.
 */

import type { DshStreamStats } from './types.js';

/** Per-subscriber backlog cap. A subscriber that lags this far is losing events, not memory. */
export const DEFAULT_SUBSCRIBER_LIMIT = 1000;

type Resolver<T> = (result: IteratorResult<T>) => void;

class EventQueue<T> implements AsyncIterableIterator<T> {
  readonly #items: T[] = [];
  readonly #waiters: Resolver<T>[] = [];
  readonly #limit: number;
  readonly #onClose: () => void;
  #done = false;
  #overflow = 0;

  constructor(limit: number, onClose: () => void) {
    this.#limit = Math.max(1, limit);
    this.#onClose = onClose;
  }

  get overflow(): number {
    return this.#overflow;
  }

  push(item: T): void {
    if (this.#done) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: item, done: false });
      return;
    }
    this.#items.push(item);
    while (this.#items.length > this.#limit) {
      this.#items.shift();
      this.#overflow += 1;
    }
  }

  finish(): void {
    if (this.#done) return;
    this.#done = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined as never, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.#items.length > 0) {
      const item = this.#items.shift();
      if (item !== undefined) return Promise.resolve({ value: item, done: false });
    }
    if (this.#done) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise<IteratorResult<T>>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  return(): Promise<IteratorResult<T>> {
    const wasDone = this.#done;
    this.finish();
    if (!wasDone) this.#onClose();
    return Promise.resolve({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

export class HotEventStream<T> {
  readonly #queues = new Set<EventQueue<T>>();
  readonly #limit: number;
  #delivered = 0;
  #dropped = 0;
  #closed = false;

  constructor(limit: number = DEFAULT_SUBSCRIBER_LIMIT) {
    this.#limit = limit;
  }

  /** Publish to every attached subscriber, or count one drop when nobody is listening. */
  publish(item: T): void {
    if (this.#closed) return;
    if (this.#queues.size === 0) {
      this.#dropped += 1;
      return;
    }
    for (const queue of this.#queues) queue.push(item);
    this.#delivered += 1;
  }

  subscribe(): AsyncIterableIterator<T> {
    const queue = new EventQueue<T>(this.#limit, () => {
      this.#queues.delete(queue);
    });
    if (this.#closed) {
      queue.finish();
      return queue;
    }
    this.#queues.add(queue);
    return queue;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const queue of this.#queues) queue.finish();
    this.#queues.clear();
  }

  get closed(): boolean {
    return this.#closed;
  }

  get stats(): DshStreamStats {
    let overflow = 0;
    for (const queue of this.#queues) overflow += queue.overflow;
    return {
      delivered: this.#delivered,
      dropped: this.#dropped,
      overflow,
      subscribers: this.#queues.size,
    };
  }
}
