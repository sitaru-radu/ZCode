/**
 * Bounded, redacting line buffer for the child's stderr (spec §2).
 *
 * stderr is free text (probe fact 8.15), so it is kept out of the protocol stream: complete lines go
 * into a ring of `capacity` lines (oldest dropped first) and are forwarded to the configured log
 * sink. Every line is redacted before it is stored or forwarded, and long lines are truncated so a
 * pathological writer cannot pin memory.
 */

import { createRedactor, type Redactor } from './redact.js';

/** Longest stderr line kept verbatim; the tail is replaced by a marker. */
export const MAX_LINE_CHARS = 2000;
export const TRUNCATION_MARKER = '…[truncated]';

export interface LogRingOptions {
  readonly capacity?: number;
  readonly redact?: Redactor;
  readonly maxLineChars?: number;
  readonly sink?: (line: string) => void;
}

export class LogRing {
  readonly #lines: string[] = [];
  readonly #capacity: number;
  readonly #maxLineChars: number;
  readonly #redact: Redactor;
  readonly #sink: ((line: string) => void) | undefined;
  #partial = '';
  #droppedLines = 0;

  constructor(options: LogRingOptions = {}) {
    this.#capacity = Math.max(1, options.capacity ?? 200);
    this.#maxLineChars = Math.max(64, options.maxLineChars ?? MAX_LINE_CHARS);
    this.#redact = options.redact ?? createRedactor([]);
    this.#sink = options.sink;
  }

  /** Feed a raw chunk; returns the complete redacted lines it produced. */
  push(chunk: string): string[] {
    this.#partial += chunk;
    const parts = this.#partial.split('\n');
    this.#partial = parts.pop() ?? '';
    const lines: string[] = [];
    for (const part of parts) lines.push(this.#record(part));
    return lines;
  }

  /** Flush a trailing partial line (used on child exit, when no newline will follow). */
  flush(): string[] {
    if (this.#partial === '') return [];
    const line = this.#record(this.#partial);
    this.#partial = '';
    return [line];
  }

  /** Oldest-first snapshot of the retained lines. */
  lines(): readonly string[] {
    return [...this.#lines];
  }

  /** Redacted excerpt for error details: the last `maxLines` lines joined by newlines. */
  excerpt(maxLines = 20): string {
    return this.#lines.slice(-maxLines).join('\n');
  }

  get droppedLines(): number {
    return this.#droppedLines;
  }

  #record(line: string): string {
    const withoutCr = line.endsWith('\r') ? line.slice(0, -1) : line;
    const truncated =
      withoutCr.length > this.#maxLineChars
        ? `${withoutCr.slice(0, this.#maxLineChars)}${TRUNCATION_MARKER}`
        : withoutCr;
    const safe = this.#redact(truncated);
    if (safe.trim() !== '') {
      this.#lines.push(safe);
      if (this.#lines.length > this.#capacity) {
        this.#lines.shift();
        this.#droppedLines += 1;
      }
      this.#sink?.(safe);
    }
    return safe;
  }
}
