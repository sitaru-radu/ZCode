/**
 * Typed-result extraction (spec §5).
 *
 * Mechanism 1 is the MCP `submit_result` bridge: the tool call arrives as a `session/update` whose
 * `rawInput` is exactly the JSON the worker passed, and the adapter turns it into a submission.
 * Mechanism 2 is the fenced-JSON fallback: the brief instructs the worker to end with one ```json
 * block, and the last such block of the final message is parsed.
 */

export interface FencedJson {
  readonly value: unknown;
  readonly block: string;
}

/** All fenced ```json blocks in `text`, in order. */
export function fencedJsonBlocks(text: string): string[] {
  const blocks: string[] = [];
  const pattern = /```json[ \t]*\r?\n([\s\S]*?)```/g;
  let match = pattern.exec(text);
  while (match !== null) {
    const body = match[1];
    if (body !== undefined) blocks.push(body.trim());
    match = pattern.exec(text);
  }
  return blocks;
}

/**
 * Parse the **last** fenced ```json block of `text` (spec §5, mechanism 2). Returns `undefined` when
 * there is no block, or the block is not valid JSON — a failed fallback is not an error, it simply
 * means the turn produced no typed result.
 */
export function parseFencedJson(text: string): FencedJson | undefined {
  const blocks = fencedJsonBlocks(text);
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block === undefined || block === '') continue;
    try {
      return { value: JSON.parse(block) as unknown, block };
    } catch {
      // Try the previous block: the worker may have shown an example before the real answer.
    }
  }
  return undefined;
}
