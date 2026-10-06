/**
 * Per-task orchestration: worktree preparation, commit, integration and bookkeeping.
 *
 * Everything here is deterministic and git-driven. The worker's own claims about what it changed are
 * never trusted: files and commits come from the worktree.
 */
import { join } from 'node:path';

import type { Mission, Project, Task } from '@zcode/projects-core';
import type { ProjectsStore } from '@zcode/projects-store';

import { emitMissionEvent } from './mission-events.js';
import type {
  BeforeSubmitInfo,
  BeforeSubmitResult,
  SessionCreatedInfo,
  TaskEnvironment,
} from './workflow-driver.js';

/** Git operations the mission flow needs; implemented by an adapter over `@zcode/git-worktree`. */
export interface WorktreePort {
  ensureIntegrationWorktree(input: {
    repositoryPath: string;
    path: string;
    branch: string;
    baseRef: string;
  }): Promise<{ path: string; branch: string; head: string }>;
  createTaskWorktree(input: {
    repositoryPath: string;
    path: string;
    branch: string;
    baseRef: string;
  }): Promise<{ path: string; branch: string; baseRef: string; head: string }>;
  status(input: { worktreePath: string }): Promise<{ dirty: boolean; porcelainV2: string }>;
  commitAll(input: { worktreePath: string; message: string }): Promise<{ commit: string; filesChanged: string[] }>;
  changedFiles(input: { worktreePath: string; baseRef: string; branch?: string }): Promise<string[]>;
  predictMerge(input: {
    repositoryPath: string;
    into: string;
    from: string;
  }): Promise<{ clean: boolean; conflicts: string[] }>;
  mergeInto(input: {
    worktreePath: string;
    branch: string;
    message: string;
  }): Promise<{ ok: true; commit: string } | { ok: false; conflicts: string[] }>;
  head(input: { worktreePath: string }): Promise<string>;
  diffPatch(input: { worktreePath: string; base: string; path?: string }): Promise<string>;
}

export interface TaskFlowDeps {
  mission: Mission;
  project: Project;
  tasks: Task[];
  store: ProjectsStore;
  worktrees: WorktreePort;
  worktreeRoot: string;
  integration: { path: string; branch: string; head: string };
  model?: string;
  now: () => number;
  logger?: (message: string) => void;
}

export interface TaskFlow {
  prepareTaskEnvironment(actorName: string): Promise<TaskEnvironment>;
  onSessionCreated(info: SessionCreatedInfo): void;
  beforeSubmit(info: BeforeSubmitInfo): Promise<BeforeSubmitResult>;
  /** Current head of the mission branch; the gate compares review and validation commits against it. */
  integrationHead(): Promise<string>;
}

/** Derive the task from the actor name the generator emitted (`task-<key>`). */
export function taskKeyFromActorName(actorName: string): string {
  return actorName.startsWith('task-') ? actorName.slice('task-'.length) : actorName;
}

export function createTaskFlow(deps: TaskFlowDeps): TaskFlow {
  const { mission, project, store, worktrees } = deps;
  const byKey = new Map(deps.tasks.map((task) => [task.planKey, task]));
  const environments = new Map<string, TaskEnvironment>();

  const worktreePathFor = (task: Task, index: number): string =>
    join(deps.worktreeRoot, project.id, mission.id, `task-${index + 1}-${task.id}`);

  const branchFor = (index: number): string =>
    `zcode/mission-${mission.id.slice(4, 12)}/task-${index + 1}`;

  return {
    async prepareTaskEnvironment(actorName: string): Promise<TaskEnvironment> {
      const key = taskKeyFromActorName(actorName);
      const task = byKey.get(key);
      if (task === undefined) throw new Error(`no plan task for actor ${actorName}`);
      const index = deps.tasks.indexOf(task);
      const baseRef = await this.integrationHead();
      const worktreePath = worktreePathFor(task, index);
      const branch = branchFor(index);

      await worktrees.createTaskWorktree({
        repositoryPath: project.repositoryPath,
        path: worktreePath,
        branch,
        baseRef,
      });
      store.setTaskWorktree(task.id, worktreePath, branch);
      store.updateTaskStatus(task.id, 'running');
      emitMissionEvent(store, mission.id, 'worktree.created', { taskId: task.id, worktreePath, branch, baseRef }, deps.now());
      emitMissionEvent(store, mission.id, 'task.started', { taskId: task.id, workerId: `wkr_${task.id}`, worktreePath, branch }, deps.now());

      const environment: TaskEnvironment = { taskKey: key, worktreePath, branch, baseRef };
      environments.set(key, environment);
      deps.logger?.(`task ${key}: worktree ${worktreePath} on ${branch}`);
      return environment;
    },

    onSessionCreated(info: SessionCreatedInfo): void {
      const task = byKey.get(info.taskKey);
      if (task === undefined) return;
      store.insertWorker({
        id: `wkr_${task.id}`,
        taskId: task.id,
        sessionId: info.sessionId,
        state: 'running',
        worktreePath: info.worktreePath,
        ...(deps.model === undefined ? {} : { model: deps.model }),
        startedAt: deps.now(),
      });
      emitMissionEvent(
        store,
        mission.id,
        'worker.started',
        { workerId: `wkr_${task.id}`, taskId: task.id, sessionId: info.sessionId, ...(deps.model === undefined ? {} : { model: deps.model }) },
        deps.now(),
      );
    },

    async beforeSubmit(info: BeforeSubmitInfo): Promise<BeforeSubmitResult> {
      const task = byKey.get(info.taskKey);
      const environment = environments.get(info.taskKey);
      if (task === undefined || environment === undefined) {
        return { ok: false, reason: `unknown task for actor ${info.actorName}` };
      }

      let commit: { commit: string; filesChanged: string[] };
      try {
        const status = await worktrees.status({ worktreePath: environment.worktreePath });
        if (!status.dirty) {
          return { ok: false, reason: 'the worker produced no changes in its worktree' };
        }
        commit = await worktrees.commitAll({
          worktreePath: environment.worktreePath,
          message: `zcode(mission ${mission.id.slice(4, 12)}): ${task.title}`,
        });
      } catch (error) {
        return { ok: false, reason: `commit failed: ${String(error)}` };
      }

      store.setTaskResult(task.id, {
        summary: summarizePayload(info.payload),
        filesChanged: commit.filesChanged,
        commits: [commit.commit],
        branch: environment.branch,
      });
      store.updateTaskStatus(task.id, 'review');
      emitMissionEvent(store, mission.id, 'worktree.committed', { taskId: task.id, commit: commit.commit, filesChanged: commit.filesChanged }, deps.now());

      const prediction = await worktrees.predictMerge({
        repositoryPath: project.repositoryPath,
        into: deps.integration.branch,
        from: environment.branch,
      });
      if (!prediction.clean) {
        store.updateTaskStatus(task.id, 'failed');
        store.incrementTaskAttempts(task.id);
        emitMissionEvent(store, mission.id, 'task.failed', { taskId: task.id, attempts: task.attempts + 1, reason: 'integration conflict' }, deps.now());
        return { ok: false, reason: `integration conflict in ${prediction.conflicts.join(', ')}` };
      }

      const merged = await worktrees.mergeInto({
        worktreePath: deps.integration.path,
        branch: environment.branch,
        message: `integrate ${task.planKey}`,
      });
      if (!merged.ok) {
        store.updateTaskStatus(task.id, 'failed');
        emitMissionEvent(store, mission.id, 'task.failed', { taskId: task.id, attempts: task.attempts + 1, reason: 'merge failed' }, deps.now());
        return { ok: false, reason: `merge failed: ${merged.conflicts.join(', ')}` };
      }

      deps.integration.head = merged.commit;
      store.updateTaskStatus(task.id, 'done');
      emitMissionEvent(store, mission.id, 'worktree.integrated', { taskId: task.id, branch: environment.branch, into: deps.integration.branch, commit: merged.commit }, deps.now());
      emitMissionEvent(store, mission.id, 'task.completed', { taskId: task.id, commit: commit.commit, filesChanged: commit.filesChanged }, deps.now());
      deps.logger?.(`task ${info.taskKey}: committed ${commit.commit.slice(0, 8)} and integrated`);
      return { ok: true };
    },

    async integrationHead(): Promise<string> {
      const head = await worktrees.head({ worktreePath: deps.integration.path });
      deps.integration.head = head;
      return head;
    },
  };
}

/** One-line human summary taken from the worker payload; never used as a fact. */
function summarizePayload(payload: unknown): string {
  if (payload !== null && typeof payload === 'object') {
    const summary = (payload as { summary?: unknown }).summary;
    if (typeof summary === 'string' && summary.trim() !== '') return summary.trim();
  }
  return 'worker reported completion without a summary';
}

