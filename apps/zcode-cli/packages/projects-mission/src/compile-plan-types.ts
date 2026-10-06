/**
 * Public contract of the mission script generator, plus the structural views of the domain
 * model it consumes.
 *
 * The domain types are owned by `@zcode/projects-core` (specs/projects/10-domain.md §1) and are
 * imported, never redefined. `MissionPlan` carries no objective — the domain puts it on `Mission`
 * — while the worker brief opens with one (runner spec §4.1), so the plan this generator reads is
 * "the plan, plus its mission objective". The types below say exactly that, and accept both a
 * whole `MissionPlan & { objective }` and just the two fields a caller has at hand.
 *
 * The import is type-only on purpose: the generator is a pure function with no runtime
 * dependencies, and nothing of `projects-core` may be needed to call it.
 */

import type { MissionPlan, PlanTask } from '@zcode/projects-core';

/** One plan task, read-only: the generator never mutates its input. */
export type CompilePlanTask = Readonly<PlanTask>;

/** The objective and the tasks: everything the worker brief and the graph order need. */
export interface CompilePlanPlan {
  /** Mission objective, one paragraph: brief section 1. */
  objective: string;
  /** The plan's tasks. Mutable and readonly arrays are both accepted. */
  tasks: readonly CompilePlanTask[];
}

/** A plan joined with its mission objective, as in `{ ...plan, objective: mission.objective }`. */
export type CompilePlanSource = MissionPlan & CompilePlanPlan;

/**
 * One executable validation command.
 *
 * `cmd` and `args` are resolved by the runner (specs/projects/50-mission-runner.md §6) and are
 * copied into the script as literals: `world.run` requires a compile-time string literal command,
 * because the run's command set is shown to the user when the run is confirmed.
 */
export interface ValidationCommand {
  /** Executable name; must be resolvable on the runner host. */
  readonly cmd: string;
  /** Fixed argv. Never a shell string: no pipes, redirection or expansion. */
  readonly args?: readonly string[];
  /** Per-call timeout override for `world.run`; omitted means the facade default. */
  readonly timeoutMs?: number;
}

/**
 * Deterministic inputs of {@link compilePlanToScript}.
 *
 * Every field is a plain value: no clock, no ids, no randomness. The same input therefore yields
 * a byte-identical script.
 */
export interface CompilePlanInput {
  /** The plan's tasks joined with the mission objective, e.g. `{ ...plan, objective }`. */
  readonly plan: CompilePlanSource | CompilePlanPlan;
  /**
   * Repository instructions from `AGENTS.md` / `CONTRIBUTING.md`, already truncated by the runner
   * to its configured cap (runner spec §4.3). Never the whole repository.
   */
  readonly repoInstructions?: string;
  /** Shell-form validation commands per task key, echoed into that task's brief. */
  readonly taskValidationCommands?: Readonly<Record<string, readonly string[]>>;
  /** Commands executed after all tasks, each as one `world.run` call. */
  readonly validationCommands?: readonly ValidationCommand[];
  /** Extra working rules appended to every brief (runner-level policy). */
  readonly extraWorkingRules?: readonly string[];
  /** Where the integration worktree lives; informational only, echoed in the brief. */
  readonly integrationWorktreeHint?: string;
}

/** What {@link compilePlanToScript} returns. */
export interface CompilePlanResult {
  /** The workflow script, ready for `@zcode/dynamic-workflow`'s compiler. */
  readonly script: string;
  /** Task key → emitted actor name, so the driver can resolve an actor back to its task. */
  readonly siteMap: Readonly<Record<string, string>>;
}
