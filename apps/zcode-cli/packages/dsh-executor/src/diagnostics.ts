/**
 * Client-side diagnostics: the stderr ring, the protocol-violation ledger and the redactor.
 *
 * Kept separate from the transport so `acp-client.ts` stays about framing and correlation, and so
 * error evidence (which is the only thing a human sees when a worker fails) has one owner.
 */

import { ProtocolViolation } from './errors.js';
import { LogRing } from './log-buffer.js';
import { createRedactor, type Redactor } from './redact.js';

const MAX_RECORDED_VIOLATIONS = 50;

export interface ClientDiagnosticsOptions {
  readonly secrets?: readonly string[];
  readonly logSink?: (line: string) => void;
  readonly stderrBufferLines?: number;
  readonly onProtocolViolation?: (violation: ProtocolViolation) => void;
  readonly onDiagnostic?: (message: string) => void;
}

export class ClientDiagnostics {
  readonly redact: Redactor;
  readonly ring: LogRing;
  readonly violations: ProtocolViolation[] = [];
  /** Responses that matched no in-flight request (normally a late answer to a timed-out call). */
  staleResponses = 0;

  readonly #onViolation: ((violation: ProtocolViolation) => void) | undefined;
  readonly #onDiagnostic: ((message: string) => void) | undefined;

  constructor(options: ClientDiagnosticsOptions) {
    this.redact = createRedactor(options.secrets ?? []);
    this.#onViolation = options.onProtocolViolation;
    this.#onDiagnostic = options.onDiagnostic;
    this.ring = new LogRing({
      capacity: options.stderrBufferLines,
      redact: this.redact,
      sink: options.logSink,
    });
  }

  get excerpt(): string {
    return this.ring.excerpt();
  }

  get lines(): readonly string[] {
    return this.ring.lines();
  }

  get droppedLines(): number {
    return this.ring.droppedLines;
  }

  pushStderr(chunk: string): void {
    this.ring.push(chunk);
  }

  flushStderr(): void {
    this.ring.flush();
  }

  /** Record one violation: bounded ledger, then the caller's hook. */
  note(violation: ProtocolViolation): void {
    if (this.violations.length >= MAX_RECORDED_VIOLATIONS) this.violations.shift();
    this.violations.push(violation);
    this.#onDiagnostic?.(violation.message);
    this.#onViolation?.(violation);
  }

  /** Diagnostics that are not violations (unknown notifications, hook failures, ...). */
  noteMessage(message: string): void {
    this.#onDiagnostic?.(message);
  }
}
