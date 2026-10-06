/**
 * Per-session state and the session registry.
 *
 * Two behaviours confirmed by the probe live here:
 *  - `session/new` answers only after that session's initial `session/update` notifications drain,
 *    so updates can arrive for a sessionId the adapter has not learned yet; they are buffered per
 *    session id (bounded) and replayed into the stream the moment the session is registered.
 *  - updates are serialized per session and the `session/prompt` response always arrives last, so
 *    the turn's final text is simply everything accumulated before settlement.
 */

import { HotEventStream } from './events.js';
import { SessionNotFound } from './errors.js';
import { parseFencedJson } from './submission.js';
import type { DshConfigOption, DshEvent, DshSessionStatus, DshSubmission, DshStreamStats } from './types.js';
import { configOptionsFromUpdate, normalizeUpdate, submitCallFromUpdate, toolCallIdOf, TOOL_STATUS_COMPLETED } from './updates.js';

/** Bounds for the pre-registration buffer; a chatty agent must not be able to grow it forever. */
export const MAX_BUFFERED_UPDATES_PER_SESSION = 200;
export const MAX_BUFFERED_UPDATES_TOTAL = 4_000;

export interface UpdateOptions {
  /** Tool name of the submit bridge; matched as `mcp__*__<submitToolName>`. */
  readonly submitToolName: string;
}

export interface SettledTurn {
  readonly finalText: string;
  readonly submission?: DshSubmission;
}

export class SessionState {
  readonly sessionId: string;
  readonly cwd: string;
  readonly events = new HotEventStream<DshEvent>();
  readonly createdAt: number;
  status: Exclude<DshSessionStatus, 'unknown'> = 'idle';
  /** True once the child process is gone: the session may be resumable, but not on this adapter. */
  stale = false;
  configOptions: readonly DshConfigOption[] | undefined;
  updatedAt: number;
  lastSubmission: DshSubmission | undefined;

  #turnText: string[] = [];
  #turnSubmission: DshSubmission | undefined;
  /** Submit-bridge calls seen in this turn but not yet confirmed by a `tool_call_update`. */
  readonly #submitCandidates = new Map<string, DshSubmission>();

  constructor(sessionId: string, cwd: string, configOptions?: readonly DshConfigOption[]) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.configOptions = configOptions;
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
  }

  get isRunning(): boolean {
    return this.status === 'running';
  }

  /** Normalize, publish and accumulate one raw `session/update`. */
  applyUpdate(update: unknown, submitToolName: string): DshEvent {
    const at = Date.now();
    const event = normalizeUpdate(this.sessionId, update, at);
    this.updatedAt = at;

    const configOptions = configOptionsFromUpdate(update);
    if (configOptions !== undefined) this.configOptions = configOptions;

    if (event.kind === 'message' && event.text !== undefined && this.isRunning) {
      this.#turnText.push(event.text);
    }
    if (this.isRunning) {
      const submit = submitCallFromUpdate(update, submitToolName);
      if (submit !== undefined) {
        const candidate: DshSubmission = {
          value: submit.value,
          source: 'mcp',
          toolName: submit.toolName,
          toolCallId: submit.toolCallId,
          at,
        };
        // Confirmed only by the matching `tool_call_update{status:"completed"}`: a rejected bridge
        // call (`isError`, status `failed`) must not be reported as the worker's typed result.
        this.#submitCandidates.set(submit.toolCallId ?? submit.toolName, candidate);
      }
      const confirmation = toolCallIdOf(update);
      if (confirmation !== undefined) {
        const candidate = this.#submitCandidates.get(confirmation.toolCallId);
        if (candidate !== undefined) {
          this.#submitCandidates.delete(confirmation.toolCallId);
          if (confirmation.status === TOOL_STATUS_COMPLETED) this.#turnSubmission = candidate;
        }
      }
    }
    this.events.publish(event);
    return event;
  }

  beginTurn(): void {
    this.status = 'running';
    this.#turnText = [];
    this.#turnSubmission = undefined;
    this.#submitCandidates.clear();
    this.updatedAt = Date.now();
  }

  /**
   * Close the turn and produce its result. Falls back to the last fenced ```json block of the
   * accumulated assistant text when the worker did not call the submit bridge (spec §5).
   */
  settleTurn(): SettledTurn {
    this.status = 'idle';
    this.updatedAt = Date.now();
    const finalText = this.#turnText.join('');
    this.#turnText = [];
    let submission = this.#turnSubmission;
    this.#turnSubmission = undefined;
    this.#submitCandidates.clear();
    if (submission === undefined) {
      const fenced = parseFencedJson(finalText);
      if (fenced !== undefined) {
        submission = { value: fenced.value, source: 'fenced-json', at: this.updatedAt };
      }
    }
    if (submission !== undefined) this.lastSubmission = submission;
    return submission === undefined ? { finalText } : { finalText, submission };
  }

  /** Stop the turn without producing a result (used when the prompt timed out). */
  abandonTurn(): void {
    this.status = 'idle';
    this.#turnText = [];
    this.#turnSubmission = undefined;
    this.#submitCandidates.clear();
    this.updatedAt = Date.now();
  }

  close(): void {
    this.status = 'closed';
    this.updatedAt = Date.now();
    this.events.close();
  }

  markStale(): void {
    if (this.status === 'closed') return;
    this.stale = true;
    this.events.close();
  }

  /** `getStatus` mapping: closed wins over stale (an explicitly closed session stays closed). */
  get reportedStatus(): DshSessionStatus {
    if (this.status === 'closed') return 'closed';
    if (this.stale) return 'unknown';
    return this.status;
  }

  get streamStats(): DshStreamStats {
    return this.events.stats;
  }
}

export class SessionRegistry {
  readonly #sessions = new Map<string, SessionState>();
  readonly #buffered = new Map<string, unknown[]>();
  readonly #submitToolName: string;
  #bufferedTotal = 0;

  constructor(options: UpdateOptions) {
    this.#submitToolName = options.submitToolName;
  }

  register(sessionId: string, cwd: string, configOptions?: readonly DshConfigOption[]): SessionState {
    const state = this.#sessions.get(sessionId) ?? new SessionState(sessionId, cwd, configOptions);
    this.#sessions.set(sessionId, state);
    if (configOptions !== undefined) state.configOptions = configOptions;
    const pending = this.#buffered.get(sessionId);
    if (pending !== undefined) {
      this.#buffered.delete(sessionId);
      this.#bufferedTotal -= pending.length;
      for (const update of pending) state.applyUpdate(update, this.#submitToolName);
    }
    return state;
  }

  get(sessionId: string): SessionState | undefined {
    return this.#sessions.get(sessionId);
  }

  require(sessionId: string): SessionState {
    const state = this.#sessions.get(sessionId);
    if (state === undefined) throw new SessionNotFound({ sessionId, method: 'session/state' });
    return state;
  }

  /** Route one update: known session -> stream, unknown session -> bounded buffer. */
  update(sessionId: string, update: unknown): DshEvent | undefined {
    const state = this.#sessions.get(sessionId);
    if (state !== undefined) return state.applyUpdate(update, this.#submitToolName);
    const pending = this.#buffered.get(sessionId) ?? [];
    if (pending.length < MAX_BUFFERED_UPDATES_PER_SESSION && this.#bufferedTotal < MAX_BUFFERED_UPDATES_TOTAL) {
      pending.push(update);
      this.#buffered.set(sessionId, pending);
      this.#bufferedTotal += 1;
    }
    return undefined;
  }

  list(): SessionState[] {
    return [...this.#sessions.values()];
  }

  get bufferedUpdateCount(): number {
    return this.#bufferedTotal;
  }

  /** The child is gone: keep the records (submissions, stats) but stop calling them live. */
  markStale(): void {
    for (const state of this.#sessions.values()) state.markStale();
  }

  closeAll(): void {
    for (const state of this.#sessions.values()) {
      if (state.status !== 'closed') state.close();
    }
  }

  clear(): void {
    this.#sessions.clear();
    this.#buffered.clear();
    this.#bufferedTotal = 0;
  }
}
