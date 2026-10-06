/**
 * In-process async mutexes.
 *
 * Boundary (stated explicitly, because it is a correctness property and not an implementation
 * detail): this package serializes *its own* git calls inside one Node process. It does not
 * coordinate with other processes, other machines or a human running git by hand. What makes that
 * acceptable is the spike's measurement: separate worktrees own separate `index` and `HEAD` files,
 * so cross-worktree writers never collide (0 `index.lock` failures in 150 concurrent commits),
 * while writers in the SAME worktree collide often (43 failures in 120 commits). Hence the two
 * rules this module enforces in-process:
 *
 * 1. Registry mutations (`worktree add/remove/prune/lock/unlock/move`) take a per-repository mutex,
 *    because they touch the shared `.git/worktrees/` registry and `refs/heads/`.
 * 2. Integrations (`merge`, `merge --abort`) take a per-integration-worktree mutex, so task branches
 *    are integrated in dependency order and never concurrently into one worktree.
 *
 * The mutex is NOT reentrant: a task that is already inside `withRepoLock` must not call a function
 * that locks again (that would deadlock). Functions that lock accept `{ lock: false }` for exactly
 * that composition case; see CONTRACT.md.
 */

import path from 'node:path';

export class AsyncMutex {
  #tail: Promise<void> = Promise.resolve();

  /** Queue `task` behind everything already queued. Failures are isolated to their own caller. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task, task);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Resolves when the queue is empty. Used by tests and by graceful shutdown. */
  async idle(): Promise<void> {
    await this.#tail;
  }
}

export class KeyedMutex {
  readonly #mutexes = new Map<string, AsyncMutex>();

  /** One mutex per (resolved) key. Keys are paths; they are normalized with `path.resolve`. */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const normalized = path.resolve(key);
    let mutex = this.#mutexes.get(normalized);
    if (mutex === undefined) {
      mutex = new AsyncMutex();
      this.#mutexes.set(normalized, mutex);
    }
    return mutex.run(task);
  }

  /** Waits for every key currently queued. Used by tests and by graceful shutdown. */
  async idle(): Promise<void> {
    await Promise.all([...this.#mutexes.values()].map((mutex) => mutex.idle()));
  }

  get size(): number {
    return this.#mutexes.size;
  }
}

/** Serializes registry mutations per repository (shared `.git/worktrees/` and `refs/heads/`). */
export const repoMutex = new KeyedMutex();

/** Serializes integrations per worktree (one integration worktree is written by one task at a time). */
export const integrationMutex = new KeyedMutex();

export function withRepoLock<T>(repoPath: string, task: () => Promise<T>): Promise<T> {
  return repoMutex.run(repoPath, task);
}

export function withIntegrationLock<T>(worktreePath: string, task: () => Promise<T>): Promise<T> {
  return integrationMutex.run(worktreePath, task);
}

/** Await both queues draining; a test/shutdown helper, never used on a hot path. */
export async function awaitMutexesIdle(): Promise<void> {
  await Promise.all([repoMutex.idle(), integrationMutex.idle()]);
}

/**
 * Apply `task` under the given lock unless the caller already holds it.
 * `lock: false` is only for composing several mutations into one critical section.
 */
export function maybeLock<T>(
  lock: boolean | undefined,
  kind: 'repo' | 'integration',
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  if (lock === false) return task();
  return kind === 'repo' ? withRepoLock(key, task) : withIntegrationLock(key, task);
}
