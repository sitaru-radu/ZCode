/**
 * Prompt composition and result extraction for the DSH workflow driver.
 *
 * The driver is engine-facing; the wording of what a worker receives and how its answer is read
 * back lives here so the driver class stays small and the contract stays in one place.
 */
import type { AskMessage } from '@zcode/dynamic-workflow';
import type { DshEvent } from '@zcode/dsh-executor';

/** Prefix prepended to every ask so the actor keeps its role across repair turns. */
export function personaPrefix(persona: string | undefined): string {
  const trimmed = (persona ?? '').trim();
  return trimmed.length === 0 ? '' : `${trimmed}\n\n`;
}

/**
 * The message a worker receives for one ask.
 *
 * The engine has already wrapped the author's instructions with its own epilogue, so this only adds
 * the persona and — for typed asks — restates the result contract in the form the parser accepts.
 */
export function composeAskPrompt(message: AskMessage, persona: string | undefined, schemaHint: string): string {
  const parts = [personaPrefix(persona) + message.instructions];
  if (message.typed) {
    parts.push(
      'When the work is complete, reply with the result as a single fenced ```json block and nothing ' +
        'after it. The block must be valid JSON matching this shape:\n\n' +
        schemaHint,
    );
  }
  return parts.join('\n\n');
}

/** Human-readable contract used when the caller has no synthesized schema. */
export const DEFAULT_RESULT_SCHEMA_HINT = [
  '{',
  '  "status": "done" | "blocked",',
  '  "summary": "one paragraph a human can read",',
  '  "filesChanged": ["relative/path"],',
  '  "acceptance": [{ "criterion": "…", "met": true, "evidence": "command or file" }],',
  '  "validationCommands": ["npm test"],',
  '  "blockers": ["…"]',
  '}',
].join('\n');

/** Follow-up turn sent when the engine rejects a submission, carrying the violations verbatim. */
export function repairPrompt(violations: unknown): string {
  return (
    'Your previous result was rejected. Fix the payload and submit it again — no other work.\n\n' +
    'Violations:\n' +
    JSON.stringify(violations, null, 2) +
    '\n\nReply with the corrected result as a single fenced ```json block.'
  );
}

/** Follow-up turn sent when the engine nudges an ask whose turn ended without a submission. */
export function nudgePrompt(): string {
  return (
    'You ended your turn without returning the required result. If the work is complete, reply now with ' +
    'the result as a single fenced ```json block. If it is not complete, say what is blocking you in ' +
    'the same block with "status": "blocked".'
  );
}

const FENCED_JSON = /```json\s*\n([\s\S]*?)```/gi;

/**
 * Extract the typed payload from a settled turn.
 *
 * Preference order: the last fenced JSON block in the final text. An MCP `submit_result` event, when
 * a bridge is attached, is preferred by the caller before this function is consulted.
 */
export function extractResultPayload(finalText: string): unknown {
  let match: RegExpExecArray | null;
  let last: string | undefined;
  FENCED_JSON.lastIndex = 0;
  while ((match = FENCED_JSON.exec(finalText)) !== null) {
    last = match[1];
  }
  if (last === undefined) return undefined;
  try {
    return JSON.parse(last) as unknown;
  } catch {
    return undefined;
  }
}

/** Payload carried by an MCP `submit_result` tool call, when a bridge is attached to the session. */
export function payloadFromEvents(events: readonly DshEvent[], toolName = 'submit_result'): unknown {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.kind !== 'tool_call') continue;
    if (event.toolName === undefined || !event.toolName.endsWith(toolName)) continue;
    const payload = (event.payload as { arguments?: unknown } | undefined)?.arguments;
    if (payload !== undefined) return payload;
  }
  return undefined;
}

/** Accumulate assistant text from a sequence of events (used for `askTurnEnded`). */
export function textFromEvents(events: readonly DshEvent[]): string {
  const chunks: string[] = [];
  for (const event of events) {
    if (event.kind === 'message' && typeof event.text === 'string') chunks.push(event.text);
  }
  return chunks.join('');
}
