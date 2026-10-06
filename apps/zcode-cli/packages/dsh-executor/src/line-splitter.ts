/**
 * NDJSON line framing (spec §2).
 *
 * The agent writes exactly one complete JSON object per line (probe fact 8.15). This splitter
 * tolerates chunks that end in the middle of a line and lines that never end: once the pending line
 * grows past `maxLineChars` the splitter drops everything up to the next newline and reports one
 * oversized line, keeping the stream in sync instead of buffering without bound.
 */

export interface SplitResult {
  /** Complete, non-empty lines (without the trailing newline). */
  readonly lines: string[];
  /** Number of lines discarded because they exceeded the cap. */
  readonly oversized: number;
}

export const DEFAULT_MAX_LINE_CHARS = 8 * 1024 * 1024;

export class LineSplitter {
  readonly #maxLineChars: number;
  #buffer = '';
  #skipping = false;

  constructor(maxLineChars: number = DEFAULT_MAX_LINE_CHARS) {
    this.#maxLineChars = Math.max(1024, maxLineChars);
  }

  push(chunk: string): SplitResult {
    const lines: string[] = [];
    let oversized = 0;
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf('\n', cursor);
      if (newline === -1) {
        if (!this.#skipping) {
          this.#buffer += chunk.slice(cursor);
          if (this.#buffer.length > this.#maxLineChars) {
            this.#buffer = '';
            this.#skipping = true;
            oversized += 1;
          }
        }
        break;
      }
      const piece = chunk.slice(cursor, newline);
      cursor = newline + 1;
      if (this.#skipping) {
        // The oversized line ends here; resume normal framing on the next chunk.
        this.#skipping = false;
        continue;
      }
      const line = this.#buffer + piece;
      this.#buffer = '';
      if (line.length > this.#maxLineChars) {
        oversized += 1;
        continue;
      }
      if (line !== '') lines.push(line);
    }
    return { lines, oversized };
  }

  /** Whatever is still buffered (incomplete line). Only used for diagnostics on shutdown. */
  pending(): string {
    return this.#buffer;
  }

  get skipping(): boolean {
    return this.#skipping;
  }
}
