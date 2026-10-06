/**
 * `compilePlanToScript` — the deterministic generator that turns a mission plan into the
 * workflow script executed by `@zcode/dynamic-workflow` (specs/projects/50-mission-runner.md §3).
 *
 * What it emits, in order:
 *
 *   1. `interface TaskOutcome` (runner spec §5) and `interface MissionReport`;
 *   2. `phase("execute")`, then one *dependency wave* at a time: every task whose dependencies are
 *      already settled is created and dispatched together, and only then awaited — so independent
 *      tasks really overlap under the engine's concurrency cap. Each ask keeps its own rejection
 *      handler, so one failing task fails its own node, never the run;
 *   3. `phase("test")`, then one `world.run` per detected validation command;
 *   4. a final `return` carrying the report.
 *
 * The function is pure: no IO, no clock, no randomness, no `node:*` imports. Ordering is fixed by
 * construction — waves and the tasks inside them are keyed by sorted task keys, dependencies and
 * validation commands keep the order they were given, and every literal is emitted through
 * {@link stringLiteral} — so the same input always produces the same bytes.
 */

import type { BriefContext } from './compile-plan-brief.js';
import { taskCommandsFor } from './compile-plan-brief.js';
import { actorNameFor, emitValidationBlock, emitWave } from './compile-plan-emit.js';
import { emitHeader, normalizePath, singleLine } from './compile-plan-text.js';
import type { CompilePlanInput, CompilePlanResult, CompilePlanTask } from './compile-plan-types.js';

export type {
  CompilePlanInput,
  CompilePlanPlan,
  CompilePlanResult,
  CompilePlanSource,
  CompilePlanTask,
  ValidationCommand,
} from './compile-plan-types.js';

/** A plan's tasks, normalised: the `readonly` view of whatever array the caller passed. */
type PlanTasks = readonly CompilePlanTask[];

/**
 * The emitted script's format version. Bump it whenever the generated shape changes: the tests
 * assert it so a stale `dist/` can never let them pass against yesterday's generator.
 */
export const COMPILE_PLAN_SCRIPT_FORMAT = 'wave-v2' as const;

/** One dependency layer: tasks that may all start as soon as the previous layers have settled. */
interface Wave {
  readonly number: number;
  readonly tasks: readonly CompilePlanTask[];
}

/**
 * Generate the workflow script for one mission plan.
 *
 * @param input the plan plus the runner-resolved material the worker brief needs.
 * @returns the script text and the task key → actor name map the driver routes sessions with.
 */
export function compilePlanToScript(input: CompilePlanInput): CompilePlanResult {
  const plan = input.plan;
  const objective = plan.objective.length > 0 ? plan.objective : '(no objective was recorded)';
  const waves = dependencyWaves(plan.tasks);
  const commands = input.validationCommands ?? [];
  const sections: string[] = [emitHeader(), '', 'phase("execute");'];

  for (const wave of waves) {
    sections.push('', `// wave ${wave.number} of ${waves.length}: ${wave.tasks.length} task(s) dispatch together`);
    sections.push(
      '',
      emitWave(
        wave.tasks.map((task) => ({ task, context: briefContextFor(input, task, objective) })),
      ),
    );
  }

  sections.push('', emitValidationBlock(commands), '');
  // Built from the emitted tasks in emission order, so the map is stable and complete.
  const siteMap = Object.fromEntries(
    waves.flatMap((wave) => wave.tasks).map((task) => [task.key, actorNameFor(task.key)] as const),
  );
  return { script: sections.join('\n'), siteMap };
}

/** The per-task brief context: everything the brief needs, all of it from `input`. */
function briefContextFor(
  input: CompilePlanInput,
  task: CompilePlanTask,
  objective: string,
): BriefContext {
  const repoInstructions =
    input.repoInstructions === undefined ? undefined : input.repoInstructions.trim();
  const worktreeHint =
    input.integrationWorktreeHint === undefined
      ? undefined
      : normalizePath(input.integrationWorktreeHint);
  return {
    objective,
    repoInstructions,
    validationCommands: taskCommandsFor(input.taskValidationCommands, task.key),
    extraWorkingRules: (input.extraWorkingRules ?? [])
      .map(singleLine)
      .filter((rule) => rule.length > 0),
    worktreeHint,
  };
}

/** A task's dependencies: de-duplicated, order preserved, self-reference and blanks dropped. */
function dependenciesOf(task: CompilePlanTask): readonly string[] {
  const own = task.key.trim();
  return (task.dependsOn ?? [])
    .map((key) => key.trim())
    .filter((key, index, all) => key.length > 0 && key !== own && all.indexOf(key) === index);
}

/**
 * Dependency waves, computed deterministically: a task's wave is one past the deepest wave among
 * its dependencies, so every task in a wave can be dispatched as soon as the previous waves have
 * settled. Inside a wave tasks are ordered by key, and unknown dependency keys are ignored —
 * `validatePlan` (projects-core) owns rejecting those, and the generator must still emit a script
 * for a plan that reached it.
 *
 * A cycle cannot occur in a validated plan; should one arrive, its tasks land in a final wave by
 * key order and still await their predecessors, so the script stays well formed.
 */
function dependencyWaves(tasks: PlanTasks): readonly Wave[] {
  const sorted = [...tasks].sort((left, right) => compare(left.key, right.key));
  const byKey = new Map<string, CompilePlanTask>(sorted.map((task) => [task.key, task]));
  const waveOf = new Map<string, number>();
  const waves: CompilePlanTask[][] = [];

  let remaining = sorted;
  while (remaining.length > 0) {
    const ready = remaining.filter((task) =>
      dependenciesOf(task)
        .filter((key) => byKey.has(key))
        .every((key) => waveOf.has(key)),
    );
    // Cyclic remainder: emit it in key order rather than looping forever.
    const layer = ready.length > 0 ? ready : remaining;
    for (const task of layer) waveOf.set(task.key, waves.length);
    waves.push(layer);
    remaining = remaining.filter((task) => !waveOf.has(task.key));
  }

  return waves.map((layer, index) => ({ number: index + 1, tasks: layer }));
}

/** Code-unit comparison: locale-independent, so the output cannot drift between environments. */
function compare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
