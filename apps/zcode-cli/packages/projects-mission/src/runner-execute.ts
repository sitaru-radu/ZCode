/**
 * Mission execution over the workflow engine.
 *
 * One workflow run per mission (decision D10). The run's script is generated from the plan, compiled
 * by the dynamic-workflow compiler, and driven by our DSH driver; the mission's own truth (tasks,
 * worktrees, integration head) is maintained by the runner through the task flow.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  InMemoryJournalStore,
  buildAskSpecs,
  collectDiagnostics,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  lowerWorkflow,
  synthesizeWorkflowSchemas,
  validate,
  type JsonSchema,
  type RunEvent,
  type ValidateFn,
} from '@zcode/dynamic-workflow';
import { runWorkflowScript } from '@zcode/dynamic-workflow-runtime';
import type { DeepSeekHarnessAdapter, DshMcpServer } from '@zcode/dsh-executor';
import type { Mission, MissionPlan, Project, Task } from '@zcode/projects-core';
import type { ProjectsStore } from '@zcode/projects-store';

import { emitMissionEvent } from './mission-events.js';
import { createTaskFlow, type WorktreePort } from './runner-taskflow.js';
import { createDshWorkflowDriver } from './workflow-driver.js';
import type { WorldReader } from './workflow-driver.js';

/** Validation outcome as reported by the generated script. */
export interface ScriptValidationResult {
  command: string;
  exitCode: number;
}

/** The value the generated script returns. */
export interface MissionReport {
  tasks: { task: string; status: string; summary: string; blockers?: string[] }[];
  validations: ScriptValidationResult[];
}

export interface CompileMissionScriptResult {
  scriptText: string;
  lowered: string;
  askSpecs: ReturnType<typeof buildAskSpecs>;
  commands: string[];
}

/** Raised when the generated script does not compile; the diagnostics are the message. */
export class ScriptCompileError extends Error {
  constructor(readonly diagnostics: unknown[]) {
    super(`generated mission script has ${diagnostics.length} diagnostic(s)`);
    this.name = 'ScriptCompileError';
  }
}

/** Compile a mission script with the engine's public helpers (the snippet-service pipeline). */
export function compileMissionScript(scriptText: string): CompileMissionScriptResult {
  const workflow = createWorkflowProgram(scriptText);
  const diagnostics = collectDiagnostics(workflow.program);
  if (diagnostics.length > 0) throw new ScriptCompileError(diagnostics);

  const table = collectSites(workflow);
  const worldRun = collectWorldRunCommands(workflow, table);
  if (worldRun.diagnostics.length > 0) throw new ScriptCompileError(worldRun.diagnostics);

  const synthesis = synthesizeWorkflowSchemas(scriptText);
  if (synthesis.diagnostics.length > 0) throw new ScriptCompileError(synthesis.diagnostics);

  const lowered = lowerWorkflow(workflow, table);
  const askSpecs = buildAskSpecs(table, synthesis.schemas);
  return { scriptText, lowered: lowered.code, askSpecs, commands: [...worldRun.commands] };
}

/** Refuse any `world.run` command the compiled script did not declare. */
export function guardWorldCommands(world: WorldReader, declared: readonly string[]): WorldReader {
  const allowed = new Set(declared);
   return {
    async executeWorldRead(op: string, args: unknown[]): Promise<unknown> {
      if (op === 'run') {
        // `world.run(cmd, argv, opts?)` arrives as the call's positional arguments.
        const [cmdRaw, argvRaw] = Array.isArray(args) ? args : [];
        const cmd = typeof cmdRaw === 'string' ? cmdRaw : '';
        const rest = Array.isArray(argvRaw) ? argvRaw.map((value) => String(value)) : [];
        const serialized = [cmd, ...rest].filter((part) => part !== '').join(' ');
        if (cmd === '' || !(allowed.has(cmd) || allowed.has(serialized))) {
          throw new Error(`world.run refused: "${serialized}" was not declared by this mission script`);
        }
      }
      return world.executeWorldRead(op, args);
    },
  };
}

/** The engine's schema validator, wired the way the in-tree snippet service wires it. */
export const missionValidate: ValidateFn = (schema, value) => validate(schema as JsonSchema, value);

export interface ExecuteMissionInput {
  mission: Mission;
  project: Project;
  plan: MissionPlan;
  tasks: Task[];
  /** Generated script text (see the plan compiler). */
  scriptText: string;
  repositoryPath: string;
  store: ProjectsStore;
  adapter: DeepSeekHarnessAdapter;
  worktrees: WorktreePort;
  /** Builds the world reader for the integration worktree. */
  createWorld: (input: { workspaceRoot: string; worldCwd: string }) => WorldReader;
  config: {
    maxWorkers: number;
    worktreeRoot: string;
    workerModel?: string;
    reasoningEffort?: string;
    mcpServers?: DshMcpServer[];
    runTimeoutMs?: number;
  };
  now: () => number;
  logger?: (message: string) => void;
  signal?: AbortSignal;
}

export interface ExecuteMissionResult {
  runId: string;
  report: MissionReport;
  integration: { path: string; branch: string; head: string };
  settlementStatus: string;
}

/** Run one mission to settlement. The caller owns review, validation persistence and the gate. */
export async function executeMission(input: ExecuteMissionInput): Promise<ExecuteMissionResult> {
  const { mission, project, config, store } = input;
  const shortId = mission.id.slice(4, 12);
  const integrationPath = join(config.worktreeRoot, project.id, mission.id, 'integration');
  const integrationBranch = `zcode/mission-${shortId}/integration`;

  const integration = await input.worktrees.ensureIntegrationWorktree({
    repositoryPath: input.repositoryPath,
    path: integrationPath,
    branch: integrationBranch,
    baseRef: project.defaultBranch,
  });

  const flow = createTaskFlow({
    mission,
    project,
    tasks: input.tasks,
    store,
    worktrees: input.worktrees,
    worktreeRoot: config.worktreeRoot,
    integration,
    ...(config.workerModel === undefined ? {} : { model: config.workerModel }),
    now: input.now,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });

  const journal = new InMemoryJournalStore();
  const runId = `msn_${mission.id.slice(4)}_${randomUUID().slice(0, 8)}`;
  const events: RunEvent[] = [];

  // Compiled before the driver exists: the declared command set is what makes `world.run` fail
  // closed (upstream keeps this gate in the workflow world-read port; the mission layer restores it
  // here so a script can never execute a command the user did not see at confirmation time).
  const compiled = compileMissionScript(input.scriptText);
  input.logger?.(`mission ${mission.id}: script compiled, ${compiled.commands.length} command(s) declared`);
  const world = guardWorldCommands(
    input.createWorld({ workspaceRoot: input.repositoryPath, worldCwd: integration.path }),
    compiled.commands,
  );

  const driverFactory = createDshWorkflowDriver({
    adapter: input.adapter,
    journal,
    world,
    prepareTaskEnvironment: (actorName) => flow.prepareTaskEnvironment(actorName),
    onSessionCreated: (info) => flow.onSessionCreated(info),
    beforeSubmit: (info) => flow.beforeSubmit(info),
    onAskFailed: (info) => {
      input.logger?.(`task ${info.taskKey} failed: ${info.message}`);
    },
    onRunEvent: (event) => {
      events.push(event);
    },
    ...(config.workerModel === undefined ? {} : { model: config.workerModel }),
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    ...(config.mcpServers === undefined ? {} : { mcpServers: config.mcpServers }),
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });

  const settlement = await runWorkflowScript({
    scriptText: input.scriptText,
    lowered: compiled.lowered,
    askSpecs: compiled.askSpecs,
    caps: { maxConcurrency: config.maxWorkers },
    // The harness writes its per-run entry file under `<cwd>/.zcode/workflow-runs/`, so the run is
    // rooted in the integration worktree: the user's own checkout must stay untouched (criterion 17).
    cwd: integration.path,
    makeDriver: driverFactory,
    runId,
    validate: missionValidate,
    name: mission.title,
    ...(config.runTimeoutMs === undefined ? {} : { timeoutMs: config.runTimeoutMs }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });

  const settlementStatus = readSettlementStatus(settlement);
  const report = extractMissionReport(settlement);
  const head = await flow.integrationHead();
  input.logger?.(
    `mission ${mission.id}: run ${runId} settled as ${settlementStatus}` +
      ` (artifact ${describeArtifact(settlement)}, ${report.tasks.length} task outcome(s), ${report.validations.length} validation(s))`,
  );

  return {
    runId,
    report,
    integration: { path: integration.path, branch: integrationBranch, head },
    settlementStatus,
  };
}

/** Read the settlement's status defensively: the shape belongs to the engine, not to us. */
export function readSettlementStatus(settlement: unknown): string {
  if (settlement !== null && typeof settlement === 'object') {
    const value = (settlement as { status?: unknown }).status;
    if (typeof value === 'string') return value;
  }
  return 'unknown';
}

/**
 * The script's return value is the mission report. A completed run hands it back as
 * `{ status: 'completed', artifact }`, and the value crosses the sandbox boundary, so it may arrive
 * either as an object or as a JSON string. Both shapes are accepted; the first one that carries a
 * `tasks` array wins.
 */
export function extractMissionReport(settlement: unknown): MissionReport {
  const empty: MissionReport = { tasks: [], validations: [] };
  if (settlement === null || typeof settlement !== 'object') return empty;

  const raw: unknown[] = [
    (settlement as { artifact?: unknown }).artifact,
    (settlement as { result?: unknown }).result,
    (settlement as { value?: unknown }).value,
  ];

  const candidates: unknown[] = [];
  for (const value of raw) {
    candidates.push(value);
    if (typeof value === 'string') candidates.push(parseJsonObject(value));
  }
  candidates.push(settlement);

  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object') continue;
    if (!Array.isArray((candidate as { tasks?: unknown }).tasks)) continue;
    const report = candidate as { tasks: MissionReport['tasks']; validations?: ScriptValidationResult[] };
    return { tasks: report.tasks, validations: Array.isArray(report.validations) ? report.validations : [] };
  }
  return empty;
}

/** Describe the settlement's payload shape without dumping it (diagnostics only). */
function describeArtifact(settlement: unknown): string {
  if (settlement === null || typeof settlement !== 'object') return 'absent';
  const artifact = (settlement as { artifact?: unknown }).artifact;
  if (artifact === undefined) return 'absent';
  if (typeof artifact === 'string') return `json-string(${artifact.length} chars)`;
  return `object(${Object.keys(artifact as Record<string, unknown>).join(',')})`;
}

/** Parse a JSON object, returning undefined for anything that is not one. */
function parseJsonObject(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Persist the script's validation outcomes as mission rows (the gate reads these). */
export function persistValidations(
  store: ProjectsStore,
  mission: Mission,
  results: ScriptValidationResult[],
  commitSha: string,
  now: () => number,
): void {
  for (const result of results) {
    store.insertValidation(
      {
        id: `val_${mission.id.slice(4)}_${commitSha.slice(0, 8)}_${result.command.replace(/\W+/g, '-')}`,
        missionId: mission.id,
        phase: 'test',
        command: result.command,
        exitCode: result.exitCode,
        durationMs: 0,
        result: result.exitCode === 0 ? 'pass' : 'fail',
      },
      { commitSha, createdAt: now() },
    );
  }
  emitMissionEvent(
    store,
    mission.id,
    results.every((r) => r.exitCode === 0) ? 'tests.passed' : 'tests.failed',
    results.every((r) => r.exitCode === 0)
      ? { commands: results.map((r) => r.command), durationMs: 0 }
      : { failures: results.filter((r) => r.exitCode !== 0).map((r) => ({ command: r.command, exitCode: r.exitCode })) },
    now(),
  );
}



