/**
 * Deterministic scheduling decisions — spec `specs/projects/10-domain.md` §6.
 *
 * No model input reaches these functions (decision D3): readiness, blocking and dispatch capacity
 * are computed from task rows only. Every list is sorted by `(planIndex, id)`, where `planIndex` is
 * the position of the task in the array it was materialized from — the same input therefore always
 * yields the same output order (invariant 9).
 */
import type { Task, TaskId, TaskStatus } from './types.js';

/** Task statuses that end a task's scheduling life (§3). */
function isSchedulingTerminal(status: TaskStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'blocked';
}

/** Statuses the scheduler may still dispatch. */
function isDispatchable(status: TaskStatus): boolean {
  return status === 'pending' || status === 'ready';
}

interface OrderedTask {
  task: Task;
  index: number;
}

function compareStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** Stable `(planIndex, id)` ordering (invariant 9). */
function sortByPlanOrder(entries: OrderedTask[]): Task[] {
  return entries
    .slice()
    .sort((left, right) => left.index - right.index || compareStrings(left.task.id, right.task.id))
    .map((entry) => entry.task);
}

/**
 * Tasks that may be dispatched now: status `pending` or `ready` (a retry returns to `ready`, §3)
 * and every dependency already `done`. Sorted by `(planIndex, id)`.
 *
 * Readiness is enforced here rather than trusted from the model: a task whose dependency is not
 * `done` is never reported, whatever its stored status claims (invariant 1).
 */
export function readyTasks(tasks: Task[]): Task[] {
  const doneIds = new Set<TaskId>();
  for (const task of tasks) {
    if (task.status === 'done') {
      doneIds.add(task.id);
    }
  }

  const ready: OrderedTask[] = [];
  tasks.forEach((task, index) => {
    if (!isDispatchable(task.status)) {
      return;
    }
    if (task.deps.every((depId) => doneIds.has(depId))) {
      ready.push({ task, index });
    }
  });
  return sortByPlanOrder(ready);
}

/**
 * Tasks that can never run because a dependency is `failed` or `blocked`, transitively (§3:
 * `pending -> blocked` when a dependency "cannot be retried"). Only tasks still in `pending` or
 * `ready` are reported — a task already stored as `blocked` needs no second decision.
 *
 * A dependency id that is absent from the array cannot be proven `done`, so it is treated as
 * unsatisfiable; that surfaces an inconsistent task list as `blocked` instead of stalling silently.
 */
export function blockedTasks(tasks: Task[]): Task[] {
  const byId = new Map<TaskId, Task>();
  for (const task of tasks) {
    if (!byId.has(task.id)) {
      byId.set(task.id, task);
    }
  }

  const memo = new Map<TaskId, boolean>();
  const visiting = new Set<TaskId>();

  const isDoomed = (task: Task): boolean => {
    const cached = memo.get(task.id);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(task.id)) {
      // Dependency cycle: it is a plan validation error, not something a failure can resolve.
      return false;
    }

    visiting.add(task.id);
    let doomed = false;
    for (const depId of task.deps) {
      const dep = byId.get(depId);
      if (dep === undefined) {
        doomed = true;
        break;
      }
      if (dep.status === 'done') {
        continue; // A satisfied dependency is satisfied regardless of its own history.
      }
      if (dep.status === 'failed' || dep.status === 'blocked') {
        doomed = true;
        break;
      }
      if (isDoomed(dep)) {
        doomed = true;
        break;
      }
    }
    visiting.delete(task.id);
    memo.set(task.id, doomed);
    return doomed;
  };

  const blocked: OrderedTask[] = [];
  tasks.forEach((task, index) => {
    if (isDispatchable(task.status) && isDoomed(task)) {
      blocked.push({ task, index });
    }
  });
  return sortByPlanOrder(blocked);
}

/**
 * The next dispatch batch: at most `maxWorkers` minus the tasks currently `running`, taken from
 * `readyTasks` in stable order. Fewer than the cap (including none) is returned when the graph or
 * the capacity does not allow more; `maxWorkers` is truncated and clamped to zero.
 */
export function selectDispatch(tasks: Task[], maxWorkers: number): Task[] {
  const limit = Math.max(0, Math.trunc(Number.isFinite(maxWorkers) ? maxWorkers : 0));
  let running = 0;
  for (const task of tasks) {
    if (task.status === 'running') {
      running += 1;
    }
  }

  const capacity = Math.max(0, limit - running);
  if (capacity === 0) {
    return [];
  }
  return readyTasks(tasks).slice(0, capacity);
}

/**
 * True when the mission can still advance by itself (§2, `running -> blocked` on "no progress"):
 * a task is `running`, or a task is ready to be dispatched, or every task has reached a terminal
 * scheduling status — in which case nothing is left to start and the mission moves on to the
 * review/test phases instead of being declared stuck. It is false exactly when work remains that
 * nothing can start, and also for an empty task list (nothing to do is not progress).
 */
export function hasProgress(tasks: Task[]): boolean {
  if (tasks.length === 0) {
    return false;
  }
  if (tasks.some((task) => task.status === 'running')) {
    return true;
  }
  if (readyTasks(tasks).length > 0) {
    return true;
  }
  return tasks.every((task) => isSchedulingTerminal(task.status));
}
