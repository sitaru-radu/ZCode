/**
 * Plan validation, plan-to-task materialization and review remediation — spec
 * `specs/projects/10-domain.md` §6 with invariants 2, 8 and 10.
 *
 * The planner model only proposes (decision D3); everything in this module is pure and
 * deterministic, so a plan can be validated, materialized and re-materialized after a crash with
 * exactly the same outcome.
 */
import { deriveId } from './ids.js';
import type { EpochMs, MissionId, MissionPlan, PlanTask, Review, ReviewFinding, Task, TaskId } from './types.js';

/** Plan task ceiling applied when the caller passes no `limits` (§8, `maxTasks`). */
const DEFAULT_MAX_TASKS = 12;

/** Codes reported by `validatePlan` (§6). */
export type PlanIssueCode =
  | 'no-tasks'
  | 'duplicate-key'
  | 'self-dependency'
  | 'unknown-dependency'
  | 'dependency-cycle'
  | 'empty-title'
  | 'too-many-tasks'
  | 'overlapping-files';

export interface PlanIssue {
  code: PlanIssueCode;
  message: string;
  taskKeys?: string[];
}

/**
 * Caller-supplied ceilings for `validatePlan`. Only the plan-scoped limit is read here; the other
 * limits of §8 (`maxWorkers`, `maxTaskAttempts`, `maxReviewRounds`) live in the mission runner.
 */
export interface PlanLimits {
  /** Maximum number of tasks a plan may contain (§8: default 12). */
  maxTasks?: number;
}

/**
 * Issue codes that are advisory: they are reported for the planner and the operator but never make
 * a plan invalid (invariant 8 — overlapping `filesHint` is a hint, not a dependency).
 */
export const ADVISORY_PLAN_ISSUE_CODES: readonly PlanIssueCode[] = ['overlapping-files'];

/**
 * Validate a proposed plan before it is persisted (§6). Issues are returned in the declaration
 * order of `PlanIssueCode` so the same plan always produces the same report; an empty array means
 * the plan is structurally usable.
 *
 * Blocking checks: `no-tasks`, `duplicate-key`, `self-dependency`, `unknown-dependency`,
 * `dependency-cycle`, `empty-title`, `too-many-tasks`. `overlapping-files` is advisory only.
 */
export function validatePlan(plan: Pick<MissionPlan, 'tasks'>, limits?: PlanLimits): PlanIssue[] {
  const tasks = plan.tasks;
  const maxTasks = limits?.maxTasks ?? DEFAULT_MAX_TASKS;
  const issues: PlanIssue[] = [];

  if (tasks.length === 0) {
    return [{ code: 'no-tasks', message: 'plan contains no tasks' }];
  }

  // First occurrence of a key wins for the dependency graph that the later checks use.
  const firstByKey = new Map<string, PlanTask>();
  const duplicateKeys: string[] = [];
  for (const task of tasks) {
    if (firstByKey.has(task.key)) {
      if (!duplicateKeys.includes(task.key)) {
        duplicateKeys.push(task.key);
      }
    } else {
      firstByKey.set(task.key, task);
    }
  }
  for (const key of duplicateKeys) {
    issues.push({ code: 'duplicate-key', message: `duplicate task key "${key}"`, taskKeys: [key] });
  }

  for (const task of tasks) {
    if (task.dependsOn.includes(task.key)) {
      issues.push({
        code: 'self-dependency',
        message: `task "${task.key}" depends on itself`,
        taskKeys: [task.key],
      });
    }
  }

  for (const task of tasks) {
    for (const dependency of uniqueStrings(task.dependsOn)) {
      if (!firstByKey.has(dependency)) {
        issues.push({
          code: 'unknown-dependency',
          message: `task "${task.key}" depends on unknown plan key "${dependency}"`,
          taskKeys: [task.key],
        });
      }
    }
  }

  for (const cycle of findDependencyCycles(tasks, firstByKey)) {
    const firstKey = cycle[0] ?? '';
    issues.push({
      code: 'dependency-cycle',
      message: `dependency cycle: ${cycle.join(' -> ')} -> ${firstKey}`,
      taskKeys: cycle,
    });
  }

  for (const task of tasks) {
    if (task.title.trim() === '') {
      issues.push({
        code: 'empty-title',
        message: `task "${task.key}" has an empty title`,
        taskKeys: [task.key],
      });
    }
  }

  if (tasks.length > maxTasks) {
    issues.push({
      code: 'too-many-tasks',
      message: `plan has ${tasks.length} tasks, the limit is ${maxTasks}`,
    });
  }

  for (const overlap of findFileOverlaps(tasks)) {
    issues.push({
      code: 'overlapping-files',
      message: `${overlap.keys.map((key) => `"${key}"`).join(', ')} declare the same file "${overlap.path}"`,
      taskKeys: overlap.keys,
    });
  }

  return issues;
}

/**
 * Compile an accepted plan version into task rows (§5, §6).
 *
 * Task ids are derived from `(missionId, planVersion, planKey)`, so calling this again for the same
 * plan version recreates byte-identical rows instead of duplicate tasks (invariant 2). Unknown
 * dependency keys are dropped: `validatePlan` rejects them first, and an id that cannot exist must
 * never silently satisfy readiness.
 *
 * `now` is part of the frozen signature; `Task` itself carries no timestamp, so the value is
 * validated here and persisted by the store together with the plan version.
 */
export function materializeTasks(missionId: MissionId, plan: MissionPlan, now: EpochMs): Task[] {
  if (!Number.isFinite(now)) {
    throw new RangeError('materializeTasks: now must be a finite epoch in milliseconds');
  }

  const keySet = new Set(plan.tasks.map((planTask) => planTask.key));
  const seenIds = new Set<TaskId>();
  const tasks: Task[] = [];

  for (const planTask of plan.tasks) {
    const id = taskIdFor(missionId, plan.version, planTask.key);
    if (seenIds.has(id)) {
      continue; // Duplicate plan keys are invalid; keeping the first row preserves the 1:1 mapping.
    }
    seenIds.add(id);
    tasks.push({
      id,
      missionId,
      planId: plan.id,
      planKey: planTask.key,
      title: planTask.title,
      description: planTask.description,
      deps: uniqueStrings(planTask.dependsOn)
        .filter((key) => key !== planTask.key && keySet.has(key))
        .map((key) => taskIdFor(missionId, plan.version, key)),
      required: planTask.required !== false,
      filesHint: [...(planTask.filesHint ?? [])],
      acceptance: [...(planTask.acceptance ?? [])],
      status: 'pending',
      attempts: 0,
    });
  }

  return tasks;
}

/**
 * Remediation plan tasks for a failed review round (§3 `review -> running`, invariant 10).
 *
 * At most one task per `blocking` finding, in finding order, with the deterministic key
 * `fix-<round>-<n>` (`n` counting blocking findings only, 1-based). Each remediation task depends on
 * every task of the reviewed plan, because the fix must land after the reviewed work is integrated;
 * a key that already exists in the plan gets a deterministic `-2`, `-3`, ... suffix so task ids can
 * never collide. A review with `verdict: 'pass'` produces no remediation.
 *
 * `missionId` is part of the frozen signature; remediation keys are plan-scoped (§10), so the
 * mission id is accepted for ownership bookkeeping and is not needed to derive them.
 */
export function remediationTasksFor(review: Review, plan: MissionPlan, missionId: MissionId): PlanTask[] {
  void missionId;

  if (review.verdict === 'pass') {
    return [];
  }

  const takenKeys = new Set(plan.tasks.map((task) => task.key));
  const reviewedTaskKeys = uniqueStrings(plan.tasks.map((task) => task.key));
  const tasks: PlanTask[] = [];
  let blockingIndex = 0;

  for (const finding of review.findings) {
    if (finding.severity !== 'blocking') {
      continue;
    }
    blockingIndex += 1;
    const key = uniqueKey(`fix-${review.round}-${blockingIndex}`, takenKeys);
    takenKeys.add(key);
    tasks.push({
      key,
      title: remediationTitle(finding),
      description: remediationDescription(finding),
      dependsOn: [...reviewedTaskKeys],
      filesHint: finding.file === undefined ? [] : [finding.file],
      acceptance: remediationAcceptance(finding),
      required: true,
    });
  }

  return tasks;
}

/** Task id derivation of §5: derived from `(missionId, planVersion, planKey)`. */
function taskIdFor(missionId: MissionId, planVersion: number, planKey: string): TaskId {
  return deriveId('tsk', missionId, String(planVersion), planKey);
}

function remediationTitle(finding: ReviewFinding): string {
  const suffix = finding.line === undefined ? '' : `:${finding.line}`;
  const location = finding.file === undefined ? '' : ` (${finding.file}${suffix})`;
  return `Fix${location}: ${finding.title}`;
}

function remediationDescription(finding: ReviewFinding): string {
  const parts = [finding.detail.trim()].filter((part) => part !== '');
  if (finding.requirement !== undefined && finding.requirement.trim() !== '') {
    parts.push(`Requirement: ${finding.requirement.trim()}`);
  }
  return parts.join('\n');
}

function remediationAcceptance(finding: ReviewFinding): string[] {
  const acceptance = [`the blocking finding "${finding.title}" no longer reproduces`];
  if (finding.requirement !== undefined && finding.requirement.trim() !== '') {
    acceptance.push(`requirement still satisfied: ${finding.requirement.trim()}`);
  }
  return acceptance;
}

function uniqueKey(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) {
    return base;
  }
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function uniqueStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!out.includes(value)) {
      out.push(value);
    }
  }
  return out;
}

/** Normalize a `filesHint` entry: trimmed, forward slashes, no leading `./`. */
function normalizePath(value: string): string {
  let path = value.trim().replace(/\\/g, '/');
  while (path.startsWith('./')) {
    path = path.slice(2);
  }
  return path === '.' ? '' : path;
}

interface FileOverlap {
  path: string;
  keys: string[];
}

/** Paths declared by more than one task, in order of first appearance (advisory, invariant 8). */
function findFileOverlaps(tasks: PlanTask[]): FileOverlap[] {
  const byPath = new Map<string, string[]>();
  for (const task of tasks) {
    for (const rawPath of uniqueStrings(task.filesHint ?? [])) {
      const path = normalizePath(rawPath);
      if (path === '') {
        continue;
      }
      const owners = byPath.get(path);
      if (owners === undefined) {
        byPath.set(path, [task.key]);
      } else if (!owners.includes(task.key)) {
        owners.push(task.key);
      }
    }
  }

  const overlaps: FileOverlap[] = [];
  for (const [path, keys] of byPath) {
    if (keys.length > 1) {
      overlaps.push({ path, keys });
    }
  }
  return overlaps;
}

/**
 * One cycle per group of keys that depend on each other, in plan order. Self-dependencies are
 * reported separately as `self-dependency` and are skipped here.
 */
function findDependencyCycles(tasks: PlanTask[], byKey: Map<string, PlanTask>): string[][] {
  const roots: string[] = [];
  for (const task of tasks) {
    if (byKey.get(task.key) === task && !roots.includes(task.key)) {
      roots.push(task.key);
    }
  }

  const state = new Map<string, 'open' | 'closed'>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const signatures = new Set<string>();

  const visit = (key: string): void => {
    state.set(key, 'open');
    stack.push(key);
    const task = byKey.get(key);
    for (const dependency of uniqueStrings(task?.dependsOn ?? [])) {
      if (dependency === key || !byKey.has(dependency)) {
        continue;
      }
      const dependencyState = state.get(dependency);
      if (dependencyState === 'open') {
        const cycle = stack.slice(stack.indexOf(dependency));
        const signature = cycle.slice().sort().join('\u0000');
        if (!signatures.has(signature)) {
          signatures.add(signature);
          cycles.push(cycle);
        }
      } else if (dependencyState === undefined) {
        visit(dependency);
      }
    }
    stack.pop();
    state.set(key, 'closed');
  };

  for (const key of roots) {
    if (state.get(key) === undefined) {
      visit(key);
    }
  }
  return cycles;
}
