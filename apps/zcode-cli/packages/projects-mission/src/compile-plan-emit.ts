/**
 * The generated script's shape, one emitter per section. All of it is pure text: no IO, no clock,
 * no randomness, and every iteration is over a pre-sorted array, so identical input yields a
 * byte-identical script.
 *
 * Out here the emitted text is built as arrays of lines joined with "\n" rather than nested
 * template literals: the script contains backticks and `${` (inside the worker brief), and the
 * indentation has to stay readable in a diff.
 */

import type { BriefContext } from './compile-plan-brief.js';
import { buildWorkerBrief, describeCommand } from './compile-plan-brief.js';
import type { CompilePlanTask, ValidationCommand } from './compile-plan-types.js';
import {
  argsLiteral,
  commentText,
  escapeTemplateText,
  personaFor,
  stringLiteral,
} from './compile-plan-text.js';

/** Actor name for a task key: deterministic and unique, because the engine rejects duplicates. */
export function actorNameFor(key: string): string {
  return `task-${key}`;
}

/** The `const` name holding one task's awaited outcome. */
export function outcomeVariableFor(key: string): string {
  return `outcome_${safeName(key)}`;
}

/** The `let` name holding one task's ask node, which later waves await. */
export function askNodeVariableFor(key: string): string {
  return `node_${safeName(key)}`;
}

/**
 * The variable names one wave emits: the array of its ask nodes, and the array of their settled
 * results. Both are block-scoped to the wave, so repeated waves never collide.
 */
const WAVE_NODES = 'waveNodes';
const WAVE_SETTLED = 'waveSettled';

/** A key turned into an identifier body; keys are unique within a plan, so the result stays unique. */
function safeName(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9_$]/g, '_');
  return /^[A-Za-z_$]/.test(safe) ? safe : `k_${safe}`;
}

function indentLines(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? `${indent}${line}` : line))
    .join('\n');
}

/** The indentation of one wave body: the emitted block sits one level in from the script root. */
const INDENT = '  ';

/**
 * The argument of one `ask<T>(…)`: the worker brief as a single `String.raw` template literal,
 * indented to match the wave body it sits in.
 *
 * `String.raw` keeps backslashes in file hints verbatim, so only backticks and `${` need
 * escaping — the two sequences that would otherwise end the literal or open an interpolation.
 */
export function emitAskLiteral(task: CompilePlanTask, context: BriefContext): string {
  const brief = escapeTemplateText(buildWorkerBrief(task, context));
  return ['String.raw`', indentLines(brief, INDENT.repeat(3)), '`'].join('\n');
}

/** One task together with the brief context its ask must be built from. */
export interface WaveTask {
  readonly task: CompilePlanTask;
  readonly context: BriefContext;
}

/**
 * One dependency wave: every task in it is created *and dispatched* before any of them is awaited,
 * which is how independent tasks actually run concurrently — the engine's concurrency cap decides
 * how many of the dispatched asks run at once, not the script's statements.
 *
 * Each ask carries its own rejection handler as the second argument of `node.then(...)`, so one
 * failing task becomes one `status: "blocked"` outcome and never rejects the wave. Predecessors
 * are awaited first, in the order the plan lists them: a wave only starts once everything it
 * depends on has settled.
 */
export function emitWave(tasks: readonly WaveTask[]): string {
  // The wave body is its own block: every wave declares the same handful of names, and a block
  // keeps them from colliding with the next wave's. The node variables a later wave awaits are
  // declared here, at the script's top level, so a dependent can read them out of their own block.
  const lines: string[] = [
    ...tasks.map(({ task }) => `let ${askNodeVariableFor(task.key)}: Node<TaskOutcome>;`),
    '{',
  ];

  for (const { task } of tasks) {
    const predecessorNodes = dependenciesOf(task).map((key) => requireNode(key));
    if (predecessorNodes.length === 0) continue;
    lines.push(
      `  // ${commentText(task.key)} waits for ${predecessorNodes.length} dependency node(s) before its wave is dispatched.`,
    );
    for (const node of predecessorNodes) lines.push(`  await ${node};`);
  }
  if (lines.length > tasks.length + 1) lines.push('');

  lines.push(
    `  const ${WAVE_NODES} = [`,
    ...tasks.map(({ task, context }) => {
      const persona = stringLiteral(personaFor(task.title));
      return `    agent(${stringLiteral(actorNameFor(task.key))}, ${persona}).ask<TaskOutcome>(${emitAskLiteral(task, context)}),`;
    }),
    `  ];`,
    `  // Every node gets its rejection handler here, before the wave settles: a failing task becomes`,
    `  // one blocked outcome, never a rejected run.`,
    `  const ${WAVE_SETTLED} = await Promise.all(`,
    `    ${WAVE_NODES}.map((node) =>`,
    `      node.then(`,
    `        (value) => ({ ok: true, outcome: value, error: "" }),`,
    `        (error: unknown) => ({ ok: false, outcome: blockedOutcome(String(error)), error: String(error) }),`,
    `      ),`,
    `    ),`,
    `  );`,
  );

  tasks.forEach(({ task }, index) => {
    const node = askNodeVariableFor(task.key);
    const outcome = outcomeVariableFor(task.key);
    const settled = `settled_${safeName(task.key)}`;
    lines.push(
      `  ${node} = ${WAVE_NODES}[${index}];`,
      `  const ${settled} = ${WAVE_SETTLED}[${index}];`,
      `  if (${settled} === undefined) {`,
      `    // Unreachable: the array was just built with one entry per task. Declared anyway so no`,
      `    // outcome can silently go missing from the report.`,
      `    throw new Error(${stringLiteral(`task ${task.key} settled without an outcome`)});`,
      `  }`,
      `  const ${outcome}: TaskOutcome = ${settled}.ok ? ${settled}.outcome : blockedOutcome(${settled}.error);`,
      `  if (!${settled}.ok) log("task " + ${stringLiteral(task.key)} + " blocked: " + ${settled}.error);`,
      `  taskOutcomes.push(${outcome});`,
      ``,
    );
  });
  lines.push('}');
  return lines.join('\n');
}

/** Every dependency of a task in this wave was emitted in an earlier wave, so its node exists. */
function requireNode(key: string): string {
  return askNodeVariableFor(key);
}

/** A task's dependencies: de-duplicated, order preserved, self-reference and blanks dropped. */
function dependenciesOf(task: CompilePlanTask): readonly string[] {
  const own = task.key.trim();
  return (task.dependsOn ?? [])
    .map((key) => key.trim())
    .filter((key, index, all) => key.length > 0 && key !== own && all.indexOf(key) === index);
}

/** One `world.run` call per discovered command, with its literal argv and its exit code recorded. */
export function emitValidationBlock(commands: readonly ValidationCommand[]): string {
  const lines: string[] = ['phase("test");', ''];
  if (commands.length === 0) {
    lines.push(
      '// No validation command was discovered: the mission is blocked, never silently passed.',
      'log("no validation commands discovered; the completion gate must report this mission as blocked");',
      '',
    );
  }
  commands.forEach((command, index) => {
    const settled = `validationSettled_${index}`;
    const opts = command.timeoutMs === undefined ? '' : `, { timeoutMs: ${command.timeoutMs} }`;
    lines.push(
      `const ${settled} = await world.run(${stringLiteral(command.cmd)}, ${argsLiteral(command)}${opts})`,
      `  .then((result) => ({ ok: true as const, result: result }), (error: unknown) => ({ ok: false as const, error: error }));`,
      `recordValidation(${stringLiteral(describeCommand(command))}, exitCodeOf(${settled}));`,
      '',
    );
  });
  lines.push(
    'return { tasks: taskOutcomes, validations: validationOutcomes } satisfies MissionReport;',
  );
  return lines.join('\n');
}
