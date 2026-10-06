/**
 * JSON-RPC 2.0 frame vocabulary (spec §2).
 *
 * Confirmed shapes (probe §3): requests carry a numeric `id`, notifications never do, and the agent
 * sends exactly two methods back: `session/update` (notification) and `session/request_permission`
 * (request). Anything else is classified, never guessed at.
 */

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message?: string;
  readonly data?: unknown;
}

export type IncomingFrame =
  | { readonly type: 'response'; readonly id: number; readonly result: unknown }
  | { readonly type: 'error'; readonly id: number; readonly error: JsonRpcErrorObject }
  | { readonly type: 'request'; readonly id: number; readonly method: string; readonly params: unknown }
  | { readonly type: 'notification'; readonly method: string; readonly params: unknown }
  | { readonly type: 'invalid'; readonly reason: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRpcError(value: unknown): value is JsonRpcErrorObject {
  return isRecord(value) && typeof value.code === 'number';
}

/** Structural classification of one decoded line. Never throws. */
export function classifyFrame(value: unknown): IncomingFrame {
  if (!isRecord(value)) return { type: 'invalid', reason: 'frame is not a JSON object' };
  const id = value['id'];
  const method = value['method'];
  if (typeof method === 'string') {
    if (typeof id === 'number') {
      return { type: 'request', id, method, params: value['params'] };
    }
    return { type: 'notification', method, params: value['params'] };
  }
  if (typeof id === 'number') {
    if (isRpcError(value['error'])) {
      return { type: 'error', id, error: value['error'] };
    }
    if ('result' in value) {
      return { type: 'response', id, result: value['result'] };
    }
    return { type: 'invalid', reason: 'response has neither result nor error' };
  }
  return { type: 'invalid', reason: 'frame has no method and no numeric id' };
}

export function encodeRequest(id: number, method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

export function encodeNotification(method: string, params: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`;
}

/**
 * Response id is `number | string`: this adapter only ever sends numeric ids, but DSH's draft MCP
 * probe (`server/discover`) uses a string id, so the submit bridge must echo whatever it received.
 */
export function encodeResult(id: number | string, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`;
}

export function encodeError(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
): string {
  const error: JsonRpcErrorObject = data === undefined ? { code, message } : { code, message, data };
  return `${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`;
}

/** Standard codes used by the client side of the bridge. */
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INTERNAL_ERROR = -32603;
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_PARAMS = -32602;
