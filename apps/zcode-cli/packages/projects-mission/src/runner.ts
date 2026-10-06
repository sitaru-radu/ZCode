/**
 * The mission runner: the only component allowed to move mission state.
 *
 * One instance drives one mission at a time. Everything the model says is input; everything the
 * mission believes comes from the store, from git, or from a deterministic command's exit code.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { Mission, MissionPlan, PlanTask, Project, Review, ReviewFinding, Task, TaskStatus, Validation, Worker } from '@zcode/projects-core';
import { evaluateCompletion, materializeTasks } from '@zcode/projects-core';
import type { DeepSeekHarnessAdapter } from '@zcode/dsh-executor';
import type { ProjectsStore } from '@zcode/projects-store';
import type { MissionEventRecord } from './mission-events.js';
import { emitMissionEvent } from './mission-events.js';
import { planMission as planMissionUseCase } from './runner-plan.js';
import { executeMission, persistValidations, type MissionReport } from './runner-execute.js';
import type { DiscoveredCommand, MissionConfig } from './runner-config.js';
import { discoverValidationCommands, readRepositoryInstructions } from './runner-config.js';
import { buildReviewBrief, parseReviewVerdict, reviewerWorkspaceIsClean } from './runner-review.js';
import type { WorktreePort } from './runner-taskflow.js';
import { createWorldReader } from './world-read.js';
import { extractResultPayload } from './workflow-driver-prompt.js';
import { compilePlanToScript } from './compile-plan.js';

export interface MissionRunnerDeps {
  store: ProjectsStore;
  adapter: DeepSeekHarnessAdapter;
  worktrees: WorktreePort;
  config: MissionConfig;
  now?: () => number;
  logger?: (message: string) => void;
}

export interface MissionStatusView {
  mission: Mission;
  tasks: Task[];
  workers: Worker[];
  blockers: string[];
}

export interface MissionResultView {
  missionId: string;
  status: Mission['status'];
  summary: string;
  branch: string;
  commit: string;
  filesChanged: string[];
  validations: Validation[];
  reviews: Review[];
}

export class MissionRunner {
  private readonly now: () => number;
  private readonly active = new Set<string>();

  constructor(private readonly deps: MissionRunnerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  // ---------------------------------------------------------------- projects

  createProject(input: { name: string; repositoryPath: string; defaultBranch?: string }): Project {
    const project: Project = {
      id: `prj_${randomUUID()}`,
      name: input.name,
      repositoryPath: input.repositoryPath,
      defaultBranch: input.defaultBranch ?? 'main',
      status: 'active',
      createdAt: this.now(),
    };
    this.deps.store.createProject(project);
    return project;
  }

  listProjects(): Project[] {
    return this.deps.store.listProjects();
  }

  // ---------------------------------------------------------------- missions

  createMission(input: {
    projectId: string;
    objective: string;
    title?: string;
    source?: Mission['source'];
  }): Mission {
    const project = this.deps.store.getProject(input.projectId);
    if (project === undefined) throw new Error(`unknown project ${input.projectId}`);
    const mission: Mission = {
      id: `msn_${randomUUID()}`,
      projectId: input.projectId,
      title: input.title ?? deriveTitle(input.objective),
      objective: input.objective,
      source: input.source ?? { kind: 'text', text: input.objective },
      status: 'draft',
      phase: 'understand',
      createdAt: this.now(),
    };
    this.deps.store.createMission(mission);
    emitMissionEvent(this.deps.store, mission.id, 'mission.created', { projectId: mission.projectId, objective: mission.objective }, this.now());
    return mission;
  }

  async planMission(missionId: string): Promise<{ plan: MissionPlan; tasks: Task[] }> {
    const mission = this.requireMission(missionId);
    const project = this.requireProject(mission.projectId);
    const repositoryPath = project.repositoryPath;
    const [instructions, commands] = await Promise.all([
      readRepositoryInstructions({ repositoryPath }),
      discoverValidationCommands({
        repositoryPath,
        ...(this.deps.config.validationCommands.length === 0 ? {} : { overrides: this.deps.config.validationCommands }),
      }),
    ]);

    this.deps.store.updateMission(missionId, { status: 'planning', phase: 'plan' });
    const result = await planMissionUseCase({
      mission,
      repositoryPath,
      instructions,
      validationCommands: commands.map(formatCommand),
      adapter: this.deps.adapter,
      store: this.deps.store,
      ...(this.deps.config.plannerModel === undefined ? {} : { model: this.deps.config.plannerModel }),
      repairAttempts: 3,
      maxTasks: 12,
      now: this.now,
      ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }),
    });

    this.deps.store.updateMission(missionId, { status: 'ready', phase: 'execute', planVersion: result.plan.version });
    emitMissionEvent(this.deps.store, missionId, 'mission.planned', { planId: result.plan.id, version: result.plan.version, taskCount: result.tasks.length }, this.now());
    this.emitValidationCommands(missionId, commands);
    return result;
  }

  /** Run a mission to settlement: execute → review → (remediation) → gate. */
  async startMission(missionId: string): Promise<MissionStatusView> {
    if (this.active.has(missionId)) throw new Error(`mission ${missionId} is already running`);
    this.active.add(missionId);
    try {
      const mission = this.requireMission(missionId);
      const project = this.requireProject(mission.projectId);
      if (this.deps.store.getLatestPlan(missionId) === undefined) await this.planMission(missionId);

      this.deps.store.updateMission(missionId, { status: 'running', phase: 'execute', startedAt: mission.startedAt ?? this.now() });
      emitMissionEvent(this.deps.store, missionId, 'mission.started', { maxWorkers: this.deps.config.maxWorkers }, this.now());

      const instructions = await readRepositoryInstructions({ repositoryPath: project.repositoryPath });
      const commands = await discoverValidationCommands({
        repositoryPath: project.repositoryPath,
        ...(this.deps.config.validationCommands.length === 0 ? {} : { overrides: this.deps.config.validationCommands }),
      });

      let integrationHead = '';
      let report: MissionReport = { tasks: [], validations: [] };

      for (let round = 0; round <= this.deps.config.maxReviewRounds; round += 1) {
        const pending = this.deps.store.listTasks(missionId).filter((task) => !isSettled(task.status));
        if (pending.length > 0) {
          const plan = this.requirePlan(missionId);
          const generated = compilePlanToScript({
            plan: { ...plan, objective: mission.objective },
            repoInstructions: instructions.map((file) => `--- ${file.path} ---\n${file.text}`).join('\n\n'),
            validationCommands: commands.map((entry) => ({ cmd: entry.command, args: entry.args })),
          });
          const run = await executeMission({
            mission,
            project,
            plan,
            tasks: pending,
            scriptText: generated.script,
            repositoryPath: project.repositoryPath,
            store: this.deps.store,
            adapter: this.deps.adapter,
            worktrees: this.deps.worktrees,
            createWorld: ({ workspaceRoot, worldCwd }) => createWorldReader({ workspaceRoot, worldCwd }),
            config: {
              maxWorkers: this.deps.config.maxWorkers,
              worktreeRoot: this.worktreeRoot(project),
              ...(this.deps.config.workerModel === undefined ? {} : { workerModel: this.deps.config.workerModel }),
            },
            now: this.now,
            ...(this.deps.logger === undefined ? {} : { logger: this.deps.logger }),
          });
          integrationHead = run.integration.head;
          report = run.report;
          persistValidations(this.deps.store, mission, run.report.validations, integrationHead, this.now);
          this.deps.store.updateMission(missionId, { phase: 'review', runId: run.runId });
          emitMissionEvent(this.deps.store, missionId, 'mission.phase_changed', { from: 'execute', to: 'review' }, this.now());
        }

        const review = await this.runReview(mission, project, round, integrationHead, instructions);
        if (review.verdict === 'pass') break;
        if (round >= this.deps.config.maxReviewRounds) break;
        this.materializeRemediation(mission, round, review.findings);
      }

      return this.finish(mission, project, integrationHead, commands, report);
    } finally {
      this.active.delete(missionId);
    }
  }

  cancelMission(missionId: string, reason?: string): MissionStatusView {
    this.deps.store.updateMission(missionId, { status: 'cancelled', completedAt: this.now(), ...(reason === undefined ? {} : { blockReason: reason }) });
    emitMissionEvent(this.deps.store, missionId, 'mission.cancelled', reason === undefined ? {} : { reason }, this.now());
    return this.getStatus(missionId);
  }

  /** Record a human instruction; it is applied at the next planning boundary, never mid-turn. */
  instructMission(missionId: string, text: string): void {
    this.requireMission(missionId);
    emitMissionEvent(this.deps.store, missionId, 'mission.instructed', { text }, this.now());
  }

  // ---------------------------------------------------------------- reads

  getStatus(missionId: string): MissionStatusView {
    const mission = this.requireMission(missionId);
    const tasks = this.deps.store.listTasks(missionId);
    const workers = tasks.flatMap((task) => this.deps.store.listWorkersByTask(task.id));
    const blockers = mission.blockReason === undefined ? [] : [mission.blockReason];
    return { mission, tasks, workers, blockers };
  }

  getEvents(missionId: string, afterSeq?: number): MissionEventRecord[] {
    return this.deps.store.listEvents(missionId, afterSeq) as MissionEventRecord[];
  }

  getValidations(missionId: string): Validation[] {
    return this.deps.store.listValidations(missionId);
  }

  getReviews(missionId: string): Review[] {
    return this.deps.store.listReviews(missionId);
  }

  getResult(missionId: string): MissionResultView | undefined {
    const mission = this.requireMission(missionId);
    if (mission.status !== 'completed') return undefined;
    const tasks = this.deps.store.listTasks(missionId);
    return {
      missionId,
      status: mission.status,
      summary: mission.summary ?? '',
      branch: this.integrationBranch(missionId),
      commit: this.deps.store.listReviews(missionId).at(-1)?.reviewedCommit ?? '',
      filesChanged: tasks.flatMap((task) => task.result?.filesChanged ?? []),
      validations: this.deps.store.listValidations(missionId),
      reviews: this.deps.store.listReviews(missionId),
    };
  }

  // ---------------------------------------------------------------- internals

  private async runReview(
    mission: Mission,
    project: Project,
    round: number,
    commit: string,
    instructions: { path: string; text: string }[],
  ): Promise<Review> {
    const integrationPath = join(this.worktreeRoot(project), project.id, mission.id, 'integration');
    const tasks = this.deps.store.listTasks(mission.id).filter((task) => task.status === 'done');
    const diff = await this.deps.worktrees.diffPatch({ worktreePath: integrationPath, base: project.defaultBranch });
    const files = await this.deps.worktrees.changedFiles({ worktreePath: integrationPath, baseRef: project.defaultBranch });

    const diffLimit = 60_000;
    const truncated = diff.length > diffLimit;
    const brief = buildReviewBrief({
      mission,
      round,
      reviewedCommit: commit,
      tasks,
      facts: {
        branch: this.integrationBranch(mission.id),
        commit,
        changedFiles: files,
        diffStat: files.length + ' file(s) changed',
        diff: truncated ? diff.slice(0, diffLimit) : diff,
        diffTruncated: truncated,
        instructions,
      },
      maxDiffChars: diffLimit,
    });

    const session = await this.deps.adapter.createSession({
      cwd: integrationPath,
      ...(this.deps.config.reviewerModel === undefined ? {} : { model: this.deps.config.reviewerModel }),
    });
    emitMissionEvent(this.deps.store, mission.id, 'review.started', { round, commit, sessionId: session.sessionId }, this.now());

    let findings: ReviewFinding[] = [];
    let verdict: Review['verdict'] = 'fail';
    try {
      const outcome = await this.deps.adapter.runTask(session.sessionId, brief);
      const parsed = parseReviewVerdict(outcome.finalText);
      const payload = extractResultPayload(outcome.finalText);
      if ('error' in parsed && payload !== undefined) {
        this.deps.logger?.(`review round ${round}: unparsable verdict (${parsed.error})`);
      } else if (!('error' in parsed)) {
        verdict = parsed.verdict;
        findings = parsed.findings;
      }
    } finally {
      await this.deps.adapter.destroySession(session.sessionId).catch(() => undefined);
    }

    // The reviewer must not have touched anything; a dirty worktree invalidates the review.
    const status = await this.deps.worktrees.status({ worktreePath: integrationPath });
    if (!reviewerWorkspaceIsClean(status.porcelainV2)) {
      verdict = 'fail';
      findings = [
        { severity: 'blocking', title: 'Reviewer modified the workspace', detail: 'the review worktree was not clean after the review session' },
      ];
    }

    const review: Review = {
      id: `rev_${mission.id.slice(4)}_${round}`,
      missionId: mission.id,
      round,
      verdict,
      findings,
      reviewedCommit: commit,
      createdAt: this.now(),
    };
    this.deps.store.insertReview(review);
    if (verdict === 'pass') {
      emitMissionEvent(this.deps.store, mission.id, 'review.passed', { round, commit }, this.now());
    } else {
      emitMissionEvent(this.deps.store, mission.id, 'review.failed', {
        round,
        commit,
        blocking: findings.filter((f) => f.severity === 'blocking').length,
        advisory: findings.filter((f) => f.severity === 'advisory').length,
      }, this.now());
    }
    return review;
  }

  private materializeRemediation(mission: Mission, round: number, findings: ReviewFinding[]): void {
    const plan = this.requirePlan(mission.id);
    const blocking = findings.filter((finding) => finding.severity === 'blocking');
    if (blocking.length === 0) return;
    const revision = plan.version + 1;
    const remediation: PlanTask[] = blocking.map((finding, index) => ({
      key: `fix-${round}-${index + 1}`,
      title: `Fix: ${finding.title}`,
      description: finding.detail,
      dependsOn: [],
      ...(finding.file === undefined ? {} : { filesHint: [finding.file] }),
      acceptance: [finding.requirement ?? 'the blocking finding no longer applies'],
    }));
    const revised: MissionPlan = {
      ...plan,
      id: `pln_${mission.id.slice(4)}_v${revision}`,
      version: revision,
      tasks: [...plan.tasks, ...remediation],
      createdAt: this.now(),
    };
    const stored = this.deps.store.insertPlan(revised);
    this.deps.store.insertTasks(materializeTasks(mission.id, stored, this.now()));
    this.deps.store.updateMission(mission.id, { phase: 'execute', planVersion: revision });
    emitMissionEvent(this.deps.store, mission.id, 'plan.revised', { version: revision, taskCount: stored.tasks.length, reason: 'review remediation' }, this.now());
  }

  private finish(
    mission: Mission,
    project: Project,
    integrationHead: string,
    commands: DiscoveredCommand[],
    report: MissionReport,
  ): MissionStatusView {
    const fresh = this.requireMission(mission.id);
    const tasks = this.deps.store.listTasks(mission.id);
    const reviews = this.deps.store.listReviews(mission.id);
    const validations = this.deps.store.listValidations(mission.id, integrationHead);

    const evaluation = evaluateCompletion({
      mission: fresh,
      tasks,
      reviews,
      validations,
      dirtyWorktrees: [],
      maxReviewRounds: this.deps.config.maxReviewRounds,
    });

    if (evaluation.complete) {
      // Summary comes from store facts, never from the model's report shape.
      const summary = tasks.map((task) => `${task.planKey}: ${task.status}`).join('; ') || 'mission completed';
      this.deps.store.updateMission(mission.id, { status: 'completed', phase: 'complete', completedAt: this.now(), summary });
      emitMissionEvent(this.deps.store, mission.id, 'mission.completed', { summary, branch: this.integrationBranch(mission.id), commit: integrationHead }, this.now());
    } else {
      const reason = evaluation.blockers.map((blocker) => blocker.message).join('; ');
      this.deps.store.updateMission(mission.id, { status: 'blocked', blockReason: reason });
      emitMissionEvent(this.deps.store, mission.id, 'mission.blocked', { reason, blockers: evaluation.blockers }, this.now());
    }
    return this.getStatus(mission.id);
  }

  private emitValidationCommands(missionId: string, commands: DiscoveredCommand[]): void {
    if (commands.length === 0) return;
    emitMissionEvent(this.deps.store, missionId, 'tests.started', { commands: commands.map(formatCommand) }, this.now());
  }

  private worktreeRoot(project: Project): string {
    return this.deps.config.worktreeRoot ?? join(project.repositoryPath, '..', '.zcode-projects');
  }

  private integrationBranch(missionId: string): string {
    return `zcode/mission-${missionId.slice(4, 12)}/integration`;
  }

  private requireMission(missionId: string): Mission {
    const mission = this.deps.store.getMission(missionId);
    if (mission === undefined) throw new Error(`unknown mission ${missionId}`);
    return mission;
  }

  private requireProject(projectId: string): Project {
    const project = this.deps.store.getProject(projectId);
    if (project === undefined) throw new Error(`unknown project ${projectId}`);
    return project;
  }

  private requirePlan(missionId: string): MissionPlan {
    const plan = this.deps.store.getLatestPlan(missionId);
    if (plan === undefined) throw new Error(`mission ${missionId} has no plan`);
    return plan;
  }
}

function formatCommand(command: DiscoveredCommand): string {
  return [command.command, ...command.args].join(' ');
}

/** A task needs no further execution once it reached one of these states. */
function isSettled(status: TaskStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'blocked';
}

function deriveTitle(objective: string): string {
  const line = objective.trim().split('\n')[0] ?? 'mission';
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}



