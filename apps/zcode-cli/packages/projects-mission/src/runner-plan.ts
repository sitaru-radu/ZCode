/**
 * Mission planning: turn an objective into a validated, persisted plan.
 *
 * The planner is a model call, but nothing about the result is trusted: the payload is parsed
 * strictly, checked by the deterministic `validatePlan`, and repaired within a bounded budget. A plan
 * that cannot be made valid fails the mission instead of reaching the executor.
 */
import type { MissionPlan, PlanIssue, PlanTask, Mission, Task } from '@zcode/projects-core';
import { materializeTasks, validatePlan } from '@zcode/projects-core';
import type { DeepSeekHarnessAdapter } from '@zcode/dsh-executor';
import type { ProjectsStore } from '@zcode/projects-store';

import { extractResultPayload } from './workflow-driver-prompt.js';

/** Everything planning needs; the caller owns session lifetime. */
export interface PlanMissionInput {
  mission: Mission;
  repositoryPath: string;
  /** Repository instruction files (`AGENTS.md`, `CONTRIBUTING.md`, `README.md`), already truncated. */
  instructions: { path: string; text: string }[];
  /** Commands the runner discovered deterministically; the planner may reference them, never invent. */
  validationCommands: string[];
  adapter: DeepSeekHarnessAdapter;
  store: ProjectsStore;
  model?: string;
  repairAttempts: number;
  maxTasks: number;
  now: () => number;
  logger?: (message: string) => void;
}

export interface PlanMissionResult {
  plan: MissionPlan;
  tasks: Task[];
}

/** Raised when the planner cannot produce a valid plan within the repair budget. */
export class PlanInvalidError extends Error {
  constructor(
    message: string,
    readonly issues: PlanIssue[],
  ) {
    super(message);
    this.name = 'PlanInvalidError';
  }
}

const PLAN_CONTRACT = `{
  "summary": "one paragraph describing the change",
  "assumptions": ["things you assumed and could not verify"],
  "affectedAreas": ["src/routes"],
  "tasks": [
    {
      "key": "short-stable-key",
      "title": "imperative one-line title",
      "description": "what to do, precisely enough for another engineer",
      "dependsOn": ["other-task-key"],
      "filesHint": ["src/routes/health.mjs"],
      "acceptance": ["the exported route returns { status: 'ok' }"]
    }
  ],
  "validationPlan": ["npm test"],
  "risks": ["what could go wrong"]
}`;

/** Rules that keep plans small and parallelisable; they mirror the deterministic checks. */
const PLANNER_RULES = [
  'Split work only where it is genuinely independent. A small feature is ONE task.',
  'Two tasks must never be expected to edit the same file; use "filesHint" to make ownership explicit.',
  'Every task needs concrete acceptance criteria that a test could check.',
  'Dependencies must form a directed acyclic graph and may only reference keys defined in "tasks".',
  `Use at most ${'{maxTasks}'} tasks. Fewer is better.`,
  'Do not invent commands. Reference only the validation commands you were given.',
  'Reply with a single fenced ```json block containing exactly the contract shape and nothing else.',
].join('\n- ');

/** Build the planner prompt. Deterministic given its inputs. */
export function buildPlanPrompt(input: {
  mission: Mission;
  repositoryPath: string;
  instructions: { path: string; text: string }[];
  validationCommands: string[];
  maxTasks: number;
}): string {
  const sections: string[] = [];
  sections.push(
    'You are planning one autonomous development mission for a repository. You do not write code; ' +
      'you produce the plan another engineer (or agent) will execute.',
  );
  sections.push(`Objective:\n${input.mission.objective}`);
  sections.push(`Repository root: ${input.repositoryPath}`);
  if (input.instructions.length > 0) {
    const joined = input.instructions.map((file) => `--- ${file.path} ---\n${file.text}`).join('\n\n');
    sections.push(`Repository instructions (must be respected):\n${joined}`);
  }
  sections.push(
    input.validationCommands.length > 0
      ? `Validation commands available (use these exact strings):\n- ${input.validationCommands.join('\n- ')}`
      : 'No validation commands were discovered; say so in "validationPlan" and treat that as a risk.',
  );
  sections.push(`Rules:\n- ${PLANNER_RULES.replace('{maxTasks}', String(input.maxTasks))}`);
  sections.push(`Result contract:\n${PLAN_CONTRACT}`);
  return sections.join('\n\n');
}

/** Parse a planner reply into a `MissionPlan` candidate, or report why it cannot be parsed. */
export function parsePlanPayload(
  payload: unknown,
  identity: { missionId: string; version: number; now: number },
): { plan: MissionPlan } | { error: string } {
  if (payload === null || typeof payload !== 'object') return { error: 'planner reply is not an object' };
  const raw = payload as Record<string, unknown>;
  const tasksRaw = raw.tasks;
  if (!Array.isArray(tasksRaw)) return { error: 'planner reply has no "tasks" array' };

  const tasks: PlanTask[] = [];
  for (const [index, entry] of tasksRaw.entries()) {
    if (entry === null || typeof entry !== 'object') return { error: `task #${index} is not an object` };
    const task = entry as Record<string, unknown>;
    const key = typeof task.key === 'string' ? task.key.trim() : '';
    const title = typeof task.title === 'string' ? task.title.trim() : '';
    const description = typeof task.description === 'string' ? task.description.trim() : '';
    if (key === '') return { error: `task #${index} has no key` };
    if (title === '') return { error: `task ${key} has no title` };
    if (description === '') return { error: `task ${key} has no description` };
    const dependsOn = asStringArray(task.dependsOn);
    const filesHint = asStringArray(task.filesHint);
    const acceptance = asStringArray(task.acceptance);
    tasks.push({
      key,
      title,
      description,
      dependsOn,
      ...(filesHint.length === 0 ? {} : { filesHint }),
      ...(acceptance.length === 0 ? {} : { acceptance }),
    });
  }

  return {
    plan: {
      id: `pln_pending_${identity.version}`,
      missionId: identity.missionId,
      version: identity.version,
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      assumptions: asStringArray(raw.assumptions),
      affectedAreas: asStringArray(raw.affectedAreas),
      tasks,
      validationPlan: asStringArray(raw.validationPlan),
      risks: asStringArray(raw.risks),
      createdAt: identity.now,
    },
  };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
}

/**
 * Plan one mission: prompt the model, validate deterministically, repair within budget, then persist
 * the accepted plan together with its materialised tasks.
 */
export async function planMission(input: PlanMissionInput): Promise<PlanMissionResult> {
  const previous = input.store.getLatestPlan(input.mission.id);
  const version = (previous?.version ?? 0) + 1;
  const session = await input.adapter.createSession({
    cwd: input.repositoryPath,
    ...(input.model === undefined ? {} : { model: input.model }),
  });

  try {
    let prompt = buildPlanPrompt({
      mission: input.mission,
      repositoryPath: input.repositoryPath,
      instructions: input.instructions,
      validationCommands: input.validationCommands,
      maxTasks: input.maxTasks,
    });

    let lastIssues: PlanIssue[] = [];
    for (let attempt = 0; attempt <= input.repairAttempts; attempt += 1) {
      const outcome = await input.adapter.runTask(session.sessionId, prompt);
      const payload = extractResultPayload(outcome.finalText);
      if (payload === undefined) {
        lastIssues = [{ code: 'no-tasks', message: 'planner reply contained no JSON block' }];
      } else {
        const parsed = parsePlanPayload(payload, { missionId: input.mission.id, version, now: input.now() });
        if ('error' in parsed) {
          lastIssues = [{ code: 'no-tasks', message: parsed.error }];
        } else {
          lastIssues = validatePlan(parsed.plan, { maxTasks: input.maxTasks });
          if (lastIssues.length === 0) {
            const stored = input.store.insertPlan(parsed.plan);
            const tasks = materializeTasks(input.mission.id, stored, input.now());
            input.store.insertTasks(tasks);
            input.logger?.(`plan v${version} accepted with ${tasks.length} task(s)`);
            return { plan: stored, tasks };
          }
        }
      }
      input.logger?.(`plan attempt ${attempt + 1} rejected: ${lastIssues.map((i) => i.code).join(', ')}`);
      prompt = buildPlanPrompt({
        mission: input.mission,
        repositoryPath: input.repositoryPath,
        instructions: input.instructions,
        validationCommands: input.validationCommands,
        maxTasks: input.maxTasks,
      })
        .concat('\n\nYour previous reply was rejected. Violations:\n')
        .concat(JSON.stringify(lastIssues, null, 2))
        .concat('\n\nReply again with a single fenced ```json block that fixes every violation.');
    }

    throw new PlanInvalidError(
      `planner produced no valid plan after ${input.repairAttempts + 1} attempt(s)`,
      lastIssues,
    );
  } finally {
    await input.adapter.destroySession(session.sessionId).catch(() => undefined);
  }
}

/** All fenced JSON blocks in order; used to recover a payload when the last block is malformed. */
export function collectJsonBlocks(text: string): string[] {
  const blocks: string[] = [];
  const pattern = /```json\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[1] !== undefined) blocks.push(match[1]);
  }
  return blocks;
}
