/**
 * The DeepSeek Harness workflow driver.
 *
 * Bound to the engine through Boundary B: the engine owns every scheduling decision, this object
 * owns sessions. Each actor becomes one DSH session whose working directory is that task's git
 * worktree, prepared by the runner through `prepareTaskEnvironment`.
 *
 * Typed results are submitted after a turn settles (decision D12): the engine still owns the
 * accept/reject/nudge verdicts, so its repair and nudge budgets stay authoritative.
 */
import {
  WorkflowError,
  type ActorRef,
  type ActorSessionSeed,
  type AskMessage,
  type InstanceRef,
  type JournalStorePort,
  type PersonaSpec,
  type RunEvent,
  type SessionRef,
  type SubmitVerdict,
  type WorkflowDriver,
  type WorkflowReportSink,
} from '@zcode/dynamic-workflow';
import type { DeepSeekHarnessAdapter, DshEvent, DshMcpServer } from '@zcode/dsh-executor';

import {
  DEFAULT_RESULT_SCHEMA_HINT,
  composeAskPrompt,
  extractResultPayload,
  nudgePrompt,
  payloadFromEvents,
  repairPrompt,
  textFromEvents,
} from './workflow-driver-prompt.js';

/** Everything the driver needs from the runner; git and mission state never live in the driver. */
export interface TaskEnvironment {
  /** Plan key of the task this actor executes (the actor name is `task-<key>`). */
  taskKey: string;
  /** Absolute path of the worktree the session is rooted in. */
  worktreePath: string;
  /** Branch checked out in that worktree. */
  branch: string;
  /** Commit the worktree was created from. */
  baseRef: string;
}

/** Deterministic view of a worktree after a worker turn, produced by the runner. */
export interface ParseOutcome {
  /** The payload the worker submitted, or undefined when it produced none. */
  payload: unknown;
  /** Final assistant text of the turn, used when no payload was submitted. */
  finalText: string;
}

export interface AskSettledInfo {
  taskKey: string;
  actorName: string;
  sessionId: string;
  result: unknown;
}

export interface SessionCreatedInfo {
  taskKey: string;
  actorName: string;
  sessionId: string;
  worktreePath: string;
  branch: string;
}

/**
 * Runs after a turn produced a payload and before the engine is asked to accept it.
 *
 * This is where the runner commits the worktree and integrates the branch: a dependent task's
 * worktree must be created from a mission branch that already contains its dependencies, and the
 * engine dispatches the next ask as soon as it accepts this one.
 */
export interface BeforeSubmitInfo {
  taskKey: string;
  actorName: string;
  sessionId: string;
  worktreePath: string;
  branch: string;
  payload: unknown;
}

export type BeforeSubmitResult = { ok: true } | { ok: false; reason: string };

export interface AskFailedInfo {
  taskKey: string;
  actorName: string;
  sessionId: string;
  message: string;
}

export interface WorldReader {
  executeWorldRead(op: string, args: unknown[]): Promise<unknown>;
}

export interface DshDriverDeps {
  adapter: DeepSeekHarnessAdapter;
  journal: JournalStorePort;
  world: WorldReader;
  /** Resolves the worktree for an actor, creating it after its dependencies are integrated. */
  prepareTaskEnvironment(actorName: string): Promise<TaskEnvironment>;
  /** Called once the actor's DSH session exists, so the runner can record the worker row. */
  onSessionCreated?(info: SessionCreatedInfo): void;
  /** Commit and integrate the worker's product; returning `{ ok: false }` fails the task. */
  beforeSubmit?(info: BeforeSubmitInfo): Promise<BeforeSubmitResult>;
  /** Called when the engine accepts a task result; the runner commits and integrates here. */
  onAskSettled?(info: AskSettledInfo): void;
  /** Called when a turn fails at the transport or submission level. */
  onAskFailed?(info: AskFailedInfo): void;
  /** Raw executor events, for activity persistence and debugging. */
  onDshEvent?(event: DshEvent): void;
  /** Run events published by the engine (Boundary C). */
  onRunEvent?(event: RunEvent): void;
  model?: string;
  reasoningEffort?: string;
  mcpServers?: DshMcpServer[];
  logger?: (message: string) => void;
}

/** Structurally identical to the runtime's `DriverFactory`; kept local so this file stays independent. */
export type DshDriverFactory = (sink: WorkflowReportSink) => WorkflowDriver;

interface InFlightAsk {
  instance: InstanceRef;
  events: DshEvent[];
  accepted: boolean;
  submitted: unknown;
  controller: AbortController;
}

interface SessionState {
  sessionId: string;
  actorName: string;
  taskKey: string;
  persona: string | undefined;
  worktreePath: string;
  branch: string;
  inFlight?: InFlightAsk;
}

function instanceKey(instance: InstanceRef): string {
  return `${instance.siteId}@${instance.ordinal}`;
}

function toWorkflowError(error: unknown): WorkflowError {
  if (error instanceof WorkflowError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new WorkflowError('DriverError', message);
}

/** Build a `DriverFactory` for the engine harness. */
export function createDshWorkflowDriver(deps: DshDriverDeps): DshDriverFactory {
  return (sink: WorkflowReportSink): WorkflowDriver => new DshWorkflowDriver(deps, sink);
}

export class DshWorkflowDriver implements WorkflowDriver {
  readonly journal: JournalStorePort;

  private readonly sessions = new Map<string, SessionState>();
  private readonly byInstance = new Map<string, SessionState>();
  private disposed = false;

  constructor(
    private readonly deps: DshDriverDeps,
    private readonly sink: WorkflowReportSink,
  ) {
    this.journal = deps.journal;
  }

  async createActorSession(actor: ActorRef, persona: PersonaSpec, _seed?: ActorSessionSeed): Promise<SessionRef> {
    const actorName = persona.name ?? `agent-${actor.siteId}-${actor.ordinal}`;
    const environment = await this.deps.prepareTaskEnvironment(actorName);
    const created = await this.deps.adapter.createSession({
      cwd: environment.worktreePath,
      ...(this.deps.model === undefined ? {} : { model: this.deps.model }),
      ...(this.deps.reasoningEffort === undefined ? {} : { reasoningEffort: this.deps.reasoningEffort }),
      ...(this.deps.mcpServers === undefined ? {} : { mcpServers: this.deps.mcpServers }),
    });

    const state: SessionState = {
      sessionId: created.sessionId,
      actorName,
      taskKey: environment.taskKey,
      persona: persona.system,
      worktreePath: environment.worktreePath,
      branch: environment.branch,
    };
    this.sessions.set(state.sessionId, state);
    this.log(`actor ${actorName} -> session ${state.sessionId} in ${environment.worktreePath}`);
    this.deps.onSessionCreated?.({
      taskKey: state.taskKey,
      actorName,
      sessionId: state.sessionId,
      worktreePath: state.worktreePath,
      branch: state.branch,
    });
    this.consumeEvents(state);
    return { id: state.sessionId };
  }

  startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage): void {
    const state = this.sessions.get(session.id);
    if (state === undefined) {
      this.sink.askFailed(instance, new WorkflowError('DriverError', `unknown session ${session.id}`));
      return;
    }

    const inFlight: InFlightAsk = {
      instance,
      events: [],
      accepted: false,
      submitted: undefined,
      controller: new AbortController(),
    };
    state.inFlight = inFlight;
    this.byInstance.set(instanceKey(instance), state);

    const schemaHint = message.typed ? renderSchemaHint(message.schema) : DEFAULT_RESULT_SCHEMA_HINT;
    const prompt = composeAskPrompt(message, state.persona, schemaHint);
    void this.drive(state, inFlight, prompt);
  }

  respondToSubmit(instance: InstanceRef, verdict: SubmitVerdict): void {
    const key = instanceKey(instance);
    const state = this.byInstance.get(key);
    const inFlight = state?.inFlight;
    if (state === undefined || inFlight === undefined) return;

    if (verdict.kind === 'accept') {
      inFlight.accepted = true;
      this.byInstance.delete(key);
      this.log(`actor ${state.actorName} result accepted`);
      this.deps.onAskSettled?.({
        taskKey: state.taskKey,
        actorName: state.actorName,
        sessionId: state.sessionId,
        result: inFlight.submitted,
      });
      return;
    }

    const prompt = verdict.kind === 'reject' ? repairPrompt(verdict.violations) : nudgePrompt();
    this.log(`actor ${state.actorName} -> ${verdict.kind}`);
    void this.drive(state, inFlight, prompt);
  }

  cancelAsk(instance: InstanceRef): void {
    const key = instanceKey(instance);
    const state = this.byInstance.get(key);
    if (state === undefined) return;
    state.inFlight?.controller.abort();
    void this.deps.adapter.cancel(state.sessionId).catch(() => undefined);
    this.byInstance.delete(key);
  }

  executeWorldRead(op: string, args: unknown[]): Promise<unknown> {
    return this.deps.world.executeWorldRead(op, args);
  }

  emit(event: RunEvent): void {
    this.deps.onRunEvent?.(event);
  }

  /** Stop consuming events; the runner owns executor disposal. */
  dispose(): void {
    this.disposed = true;
    for (const state of this.sessions.values()) {
      state.inFlight?.controller.abort();
    }
    this.sessions.clear();
    this.byInstance.clear();
  }

  private async drive(state: SessionState, inFlight: InFlightAsk, prompt: string): Promise<void> {
    try {
      this.sink.askExecuting(inFlight.instance);
      const outcome = await this.deps.adapter.runTask(state.sessionId, prompt, inFlight.controller.signal);
      if (inFlight.accepted || this.disposed) return;

      const payload = payloadFromEvents(inFlight.events) ?? extractResultPayload(outcome.finalText);
      if (payload === undefined) {
        this.sink.askTurnEnded(inFlight.instance, outcome.finalText || textFromEvents(inFlight.events));
        return;
      }

      // Commit and integrate before the engine accepts: dependents branch off the mission branch.
      if (this.deps.beforeSubmit !== undefined) {
        const verdict = await this.deps.beforeSubmit({
          taskKey: state.taskKey,
          actorName: state.actorName,
          sessionId: state.sessionId,
          worktreePath: state.worktreePath,
          branch: state.branch,
          payload,
        });
        if (!verdict.ok) {
          const failure = new WorkflowError('DriverError', verdict.reason);
          this.deps.onAskFailed?.({
            taskKey: state.taskKey,
            actorName: state.actorName,
            sessionId: state.sessionId,
            message: verdict.reason,
          });
          this.sink.askFailed(inFlight.instance, failure);
          return;
        }
      }

      inFlight.submitted = payload;
      this.sink.askSubmitAttempted(inFlight.instance, payload);
    } catch (error) {
      if (inFlight.accepted || this.disposed || inFlight.controller.signal.aborted) return;
      const workflowError = toWorkflowError(error);
      this.log(`actor ${state.actorName} failed: ${workflowError.message}`);
      this.deps.onAskFailed?.({
        taskKey: state.taskKey,
        actorName: state.actorName,
        sessionId: state.sessionId,
        message: workflowError.message,
      });
      this.sink.askFailed(inFlight.instance, workflowError);
    }
  }

  private consumeEvents(state: SessionState): void {
    const iterate = async (): Promise<void> => {
      for await (const event of this.deps.adapter.streamEvents(state.sessionId)) {
        state.inFlight?.events.push(event);
        this.deps.onDshEvent?.(event);
      }
    };
    void iterate().catch((error: unknown) => {
      this.log(`event stream for ${state.sessionId} ended: ${String(error)}`);
    });
  }

  private log(message: string): void {
    this.deps.logger?.(`[dsh-driver] ${message}`);
  }
}

/** Render a synthesized JSON schema compactly for the prompt; truncated because prompts are not dumps. */
function renderSchemaHint(schema: unknown): string {
  if (schema === undefined) return DEFAULT_RESULT_SCHEMA_HINT;
  try {
    const text = JSON.stringify(schema);
    return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
  } catch {
    return DEFAULT_RESULT_SCHEMA_HINT;
  }
}
