/**
 * `session/update` normalization (spec §3 `DshEvent`).
 *
 * Confirmed discriminators (probe §3): `agent_thought_chunk`, `agent_message_chunk`, `tool_call`,
 * `tool_call_update`, `usage_update`, `config_option_update`. Unknown kinds are surfaced as `other`
 * with their raw payload rather than dropped, so a new deployment cannot silently lose events.
 * Everything is truncated: a mission log must not inherit an unbounded tool output.
 */

import { isRecord } from './jsonrpc.js';
import type { DshConfigOption, DshEvent, DshEventKind } from './types.js';

export const UPDATE_THOUGHT_CHUNK = 'agent_thought_chunk';
export const UPDATE_MESSAGE_CHUNK = 'agent_message_chunk';
export const UPDATE_TOOL_CALL = 'tool_call';
export const UPDATE_TOOL_CALL_UPDATE = 'tool_call_update';
export const UPDATE_USAGE = 'usage_update';
export const UPDATE_CONFIG_OPTION = 'config_option_update';

/** Cap for message/thought text kept in an event. */
export const MAX_EVENT_TEXT_CHARS = 20_000;
/** Cap for the normalized payload copy of a raw update. */
export const MAX_PAYLOAD_CHARS = 4_000;

export function truncateText(text: string, max: number = MAX_EVENT_TEXT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[truncated ${String(text.length - max)} chars]`;
}

/** Deep copy with a size cap. Oversized values become `{truncated, chars, preview}`. */
export function normalizePayload(value: unknown, maxChars: number = MAX_PAYLOAD_CHARS): unknown {
  if (value === undefined) return undefined;
  let json: string;
  try {
    json = JSON.stringify(value) ?? 'null';
  } catch (error) {
    return { unserializable: true, reason: error instanceof Error ? error.message : 'unknown' };
  }
  if (json.length <= maxChars) {
    try {
      return JSON.parse(json) as unknown;
    } catch {
      return { unserializable: true, reason: 'round-trip failed' };
    }
  }
  return { truncated: true, chars: json.length, preview: json.slice(0, maxChars) };
}

/** `{type:"text",text}` content block (message and thought chunks). */
export function extractContentText(content: unknown): string | undefined {
  if (!isRecord(content)) return undefined;
  const text = content['text'];
  return typeof text === 'string' ? text : undefined;
}

/** `tool_call_update.content` is `[{type:"content",content:{type:"text",text}}]`. */
export function extractToolResultText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const entry of content) {
    if (!isRecord(entry)) continue;
    const direct = entry['text'];
    if (typeof direct === 'string') {
      parts.push(direct);
      continue;
    }
    const nested = extractContentText(entry['content']);
    if (nested !== undefined) parts.push(nested);
  }
  return parts.length === 0 ? undefined : parts.join('');
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Normalize one `session/update` payload into a `DshEvent`. */
export function normalizeUpdate(sessionId: string, update: unknown, at: number = Date.now()): DshEvent {
  if (!isRecord(update)) {
    return {
      sessionId,
      kind: 'other',
      payload: normalizePayload(update),
      at,
    };
  }
  const discriminator = textOf(update['sessionUpdate']) ?? 'unknown';
  const toolCallId = textOf(update['toolCallId']);
  const base = { sessionId, at } as const;

  switch (discriminator) {
    case UPDATE_MESSAGE_CHUNK:
    case UPDATE_THOUGHT_CHUNK: {
      const kind: DshEventKind = discriminator === UPDATE_MESSAGE_CHUNK ? 'message' : 'thought';
      const text = extractContentText(update['content']);
      return {
        ...base,
        kind,
        text: text === undefined ? undefined : truncateText(text),
        payload: normalizePayload(update),
      };
    }
    case UPDATE_TOOL_CALL:
      return {
        ...base,
        kind: 'tool_call',
        toolName: textOf(update['title']),
        toolCallId,
        payload: normalizePayload(update),
      };
    case UPDATE_TOOL_CALL_UPDATE:
      return {
        ...base,
        kind: 'tool_result',
        toolCallId,
        payload: normalizePayload(update),
      };
    case UPDATE_USAGE:
      return { ...base, kind: 'usage', payload: normalizePayload(update) };
    case UPDATE_CONFIG_OPTION: {
      const configOptions = update['configOptions'];
      return {
        ...base,
        kind: 'config',
        payload: normalizePayload(Array.isArray(configOptions) ? configOptions : update),
      };
    }
    default:
      return { ...base, kind: 'other', payload: normalizePayload(update) };
  }
}

/** Status of a `tool_call_update` (`completed` | `failed` | ...). */
export const TOOL_STATUS_COMPLETED = 'completed';

/**
 * Correlate a `tool_call_update` with its call. Used to confirm that a submit-bridge call really
 * completed: under this transport a `tool_call` alone is just the model reaching for the tool.
 */
export function toolCallIdOf(update: unknown): { toolCallId: string; status?: string } | undefined {
  if (!isRecord(update)) return undefined;
  if (update['sessionUpdate'] !== UPDATE_TOOL_CALL_UPDATE) return undefined;
  const toolCallId = update['toolCallId'];
  if (typeof toolCallId !== 'string') return undefined;
  const status = update['status'];
  return typeof status === 'string' ? { toolCallId, status } : { toolCallId };
}

/** `configOptions` carried by `config_option_update`. */
export function configOptionsFromUpdate(update: unknown): readonly DshConfigOption[] | undefined {
  if (!isRecord(update)) return undefined;
  const options = update['configOptions'];
  if (!Array.isArray(options)) return undefined;
  return options.filter(isRecord).map((entry) => entry as unknown as DshConfigOption);
}

/**
 * Does this tool title address the configured submit bridge?
 *
 * DSH exposes MCP tools as `mcp__<server>__<tool>` and rewrites server names that do not match
 * `^[A-Za-z0-9_-]{1,32}$` (probe 8.9), so the server half is matched loosely and the tool half
 * exactly. Nothing else may be treated as a typed result.
 */
export function isSubmitToolName(toolName: string, submitToolName: string): boolean {
  if (submitToolName === '') return false;
  const escaped = submitToolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^mcp__[A-Za-z0-9_-]{1,32}__${escaped}$`).test(toolName);
}

/** Extract a submission candidate from a `tool_call` update for the submit bridge. */
export function submitCallFromUpdate(
  update: unknown,
  submitToolName: string,
): { toolName: string; toolCallId?: string; value: unknown } | undefined {
  if (!isRecord(update)) return undefined;
  if (textOf(update['sessionUpdate']) !== UPDATE_TOOL_CALL) return undefined;
  const title = textOf(update['title']);
  if (title === undefined || !isSubmitToolName(title, submitToolName)) return undefined;
  if (!('rawInput' in update)) return undefined;
  const toolCallId = textOf(update['toolCallId']);
  return { toolName: title, toolCallId, value: update['rawInput'] };
}
