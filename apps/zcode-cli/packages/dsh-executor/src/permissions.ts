/**
 * Deterministic answers for `session/request_permission` (spec §4).
 *
 * The probe never saw this request fire in ~10 runs (gotcha 8.14), so it must never carry control
 * flow — but if it ever arrives the adapter answers it from configuration instead of leaving the
 * agent waiting:
 *  - `deny-unapproved` (default): select a reject option, or cancel when the agent offers none;
 *  - `allow-all`: select an allow option, or cancel when the agent offers none.
 *
 * The chosen option is returned so the adapter can record it as an event (spec §4).
 */

import type { DshPermissionPolicy } from './config.js';
import { isRecord } from './jsonrpc.js';

export interface PermissionChoice {
  readonly optionId?: string;
  readonly kind?: string;
  readonly name?: string;
}

export type PermissionOutcome =
  | { readonly outcome: { readonly outcome: 'selected'; readonly optionId: string } }
  | { readonly outcome: { readonly outcome: 'cancelled' } };

/** Preference order per policy: `*_once` before `*_always` (never persist a grant silently). */
const PREFERENCE: Readonly<Record<DshPermissionPolicy, readonly string[]>> = {
  'deny-unapproved': ['reject_once', 'reject_always'],
  'allow-all': ['allow_once', 'allow_always'],
};

const FALLBACK_PREFIX: Readonly<Record<DshPermissionPolicy, string>> = {
  'deny-unapproved': 'reject',
  'allow-all': 'allow',
};

export function selectPermissionOption(
  options: readonly PermissionChoice[],
  policy: DshPermissionPolicy,
): string | undefined {
  for (const kind of PREFERENCE[policy]) {
    const exact = options.find((option) => option.kind === kind && typeof option.optionId === 'string');
    if (exact?.optionId !== undefined) return exact.optionId;
  }
  for (const option of options) {
    if (typeof option.optionId !== 'string') continue;
    if (typeof option.kind === 'string' && option.kind.startsWith(FALLBACK_PREFIX[policy])) {
      return option.optionId;
    }
  }
  return undefined;
}

export function buildPermissionResponse(
  options: readonly PermissionChoice[],
  policy: DshPermissionPolicy,
): PermissionOutcome {
  const optionId = selectPermissionOption(options, policy);
  if (optionId === undefined) return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId } };
}

export interface PermissionRequestDetails {
  readonly sessionId?: string;
  readonly toolCallId?: string;
  readonly options: PermissionChoice[];
}

/** Read the parts of a `session/request_permission` params object the adapter needs. */
export function readPermissionRequest(params: unknown): PermissionRequestDetails {
  if (!isRecord(params)) return { options: [] };
  const rawOptions = Array.isArray(params['options']) ? params['options'] : [];
  const options: PermissionChoice[] = [];
  for (const entry of rawOptions) {
    if (!isRecord(entry)) continue;
    const optionId = entry['optionId'];
    const kind = entry['kind'];
    const name = entry['name'];
    options.push({
      optionId: typeof optionId === 'string' ? optionId : undefined,
      kind: typeof kind === 'string' ? kind : undefined,
      name: typeof name === 'string' ? name : undefined,
    });
  }
  const sessionId = params['sessionId'];
  const toolCall = params['toolCall'];
  const toolCallId = isRecord(toolCall) ? toolCall['toolCallId'] : undefined;
  return {
    sessionId: typeof sessionId === 'string' ? sessionId : undefined,
    toolCallId: typeof toolCallId === 'string' ? toolCallId : undefined,
    options,
  };
}
