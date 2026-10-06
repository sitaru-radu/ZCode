/**
 * The worker brief (specs/projects/50-mission-runner.md §4) — the *only* context a worker
 * receives. It is built deterministically from the plan, one section per spec item:
 *
 *   1. mission objective, 2. this task, 3. repository instructions,
 *   4. working rules,     5. result contract.
 *
 * The brief becomes the single template literal passed to `ask(...)`; it is materialised here as
 * plain text and escaped once, by the emitter.
 */

import type { CompilePlanTask, ValidationCommand } from './compile-plan-types.js';
import { normalizePath, singleLine, splitCommandLine } from './compile-plan-text.js';

/** Runner-side material the brief folds in beyond the task itself. */
export interface BriefContext {
  /** Mission objective, one paragraph. */
  readonly objective: string;
  /** Already-truncated `AGENTS.md` / `CONTRIBUTING.md` contents, or undefined when absent. */
  readonly repoInstructions: string | undefined;
  /** Shell-form validation commands for this task. */
  readonly validationCommands: readonly string[];
  /** Extra runner-level working rules appended to the fixed ones. */
  readonly extraWorkingRules: readonly string[];
  /** Where the task's worktree lives, when the runner knows it. */
  readonly worktreeHint: string | undefined;
}

/** One `- item` line per entry, or a single explicit fallback when the list is empty. */
function bullets(items: readonly string[], fallback: string): string {
  if (items.length === 0) return `- ${fallback}`;
  return items.map((item) => `- ${item}`).join('\n');
}

/** The repository-instructions section, or an explicit "none" so the worker does not guess. */
function repoSection(instructions: string | undefined): string {
  const text = instructions === undefined ? '' : instructions.trim();
  return text.length > 0 ? text : '(No repository instructions were found for this repository.)';
}

/**
 * The dependency line: names only. The worker never receives another task's result — the brief
 * stays the only context it gets (runner spec §4) — so this says what ran first, not what it found.
 */
function dependenciesLine(task: CompilePlanTask): string {
  const keys = (task.dependsOn ?? []).map(singleLine).filter((key) => key.length > 0);
  if (keys.length === 0) return '(none: this task starts from the current mission branch)';
  return keys.join(', ') + ' (settled before this task was dispatched)';
}

/** The working rules (runner spec §4.4) plus any runner-level additions. */
function workingRules(context: BriefContext): string {
  const rules = [
    'Work only inside your own worktree; the repository checkout is read-only for you.',
    'Run the validation commands named for this task and report what they printed.',
    'Commit nothing yourself: the runner reads git, commits your work and integrates it.',
    'Do not touch files that belong to another task; keep the diff scoped to this task.',
    'When the work is done, submit the result through the provided tool, or end your final message with one fenced json block holding exactly the contract above.',
  ];
  if (context.worktreeHint !== undefined && context.worktreeHint.length > 0) {
    rules.push(`Your worktree is at ${normalizePath(context.worktreeHint)} (relative to the run).`);
  }
  for (const extra of context.extraWorkingRules) rules.push(extra);
  return rules.map((rule) => `- ${singleLine(rule)}`).join('\n');
}

/**
 * Build the brief for one task. Field order is the spec's order and nothing is trimmed beyond
 * whitespace normalisation of list items, so a plan change is visible as a diff in the script.
 */
export function buildWorkerBrief(task: CompilePlanTask, context: BriefContext): string {
  const description = task.description.trim();
  const fileHints = (task.filesHint ?? []).map(normalizePath);
  const acceptance = (task.acceptance ?? []).map(singleLine);
  const validation = context.validationCommands.map(singleLine);

  return [
    'You are one worker of a mission. You do not see the mission log, the other tasks or the',
    'plan; the brief below is everything you have. Do exactly this task and nothing else.',
    '',
    '## Mission objective',
    context.objective.trim(),
    '',
    '## This task',
    `Key: ${singleLine(task.key)}`,
    `Title: ${singleLine(task.title)}`,
    '',
    'Description:',
    description,
    '',
    'Acceptance criteria:',
    bullets(acceptance, '(none given: satisfy the description and say how you verified it)'),
    '',
    'File hints:',
    bullets(fileHints, '(no file hints: locate the relevant files yourself)'),
    '',
    'Dependencies:',
    dependenciesLine(task),
    '',
    '## Repository instructions',
    repoSection(context.repoInstructions),
    '',
    '## Working rules',
    workingRules(context),
    '',
    '## Validation commands for this task',
    bullets(validation, '(none given: report the checks you ran and their output)'),
    '',
    '## Result contract',
    'Submit, or end your final message with, exactly this JSON shape:',
    '{',
    '  "status": "done" | "blocked",',
    '  "summary": "one paragraph a human can read",',
    '  "filesChanged": ["relative/path"],',
    '  "acceptance": [{ "criterion": "the criterion", "met": true, "evidence": "command or file" }],',
    '  "validationCommands": ["the command you ran"],',
    '  "blockers": ["anything that stopped you; empty when status is done"]',
    '}',
  ].join('\n');
}

/** Shell-form task commands, from the runner's per-task map, order preserved. */
export function taskCommandsFor(
  map: Readonly<Record<string, readonly string[]>> | undefined,
  key: string,
): readonly string[] {
  const commands = map?.[key];
  if (commands === undefined) return [];
  return commands
    .map((command) => singleLine(command))
    .filter((command) => command.length > 0);
}

/** The literal `cmd` plus argv of a resolved validation command, as the worker sees it. */
export function describeCommand(command: ValidationCommand): string {
  const line = [command.cmd, ...(command.args ?? [])].join(' ');
  return splitCommandLine(line).join(' ');
}
