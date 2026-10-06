/**
 * Model selection helpers (spec §6, probe gotcha 8.4/8.5).
 *
 * `session/set_config_option` expects the model as an **opaque JSON-encoded string**, e.g.
 * `"[\"deepseek-official\",\"deepseek-v4-pro\"]"`. Callers may pass either that exact value or a
 * bare id (`deepseek-v4-pro`); a bare id is resolved against the latest `configOptions` the agent
 * advertised. The catalogue shifts between calls, so it is read from the live session state every
 * time and never cached by this module.
 */

import type { DshConfigOption, DshConfigOptionChoice } from './types.js';

export const MODEL_CONFIG_ID = 'model';
export const REASONING_EFFORT_CONFIG_ID = 'reasoning_effort';
export const REASONING_EFFORT_VALUES: readonly string[] = ['off', 'low', 'high', 'max'];

export interface ParsedModelValue {
  readonly provider: string;
  readonly model: string;
}

/** Parse the opaque value into `[provider, model]`; `undefined` when it is not that shape. */
export function parseModelValue(value: string): ParsedModelValue | undefined {
  if (!value.trimStart().startsWith('[')) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length < 2) return undefined;
    const [provider, model] = parsed;
    if (typeof provider !== 'string' || typeof model !== 'string') return undefined;
    return { provider, model };
  } catch {
    return undefined;
  }
}

/** Build the opaque value from its parts (used by tests and by callers that only know the pair). */
export function encodeModelValue(provider: string, model: string): string {
  return JSON.stringify([provider, model]);
}

function flattenChoices(choices: readonly DshConfigOptionChoice[] | undefined): DshConfigOptionChoice[] {
  const flat: DshConfigOptionChoice[] = [];
  for (const choice of choices ?? []) {
    flat.push(choice);
    if (Array.isArray(choice.options)) flat.push(...flattenChoices(choice.options));
  }
  return flat;
}

export function findConfigOption(
  configOptions: readonly DshConfigOption[] | undefined,
  id: string,
): DshConfigOption | undefined {
  return (configOptions ?? []).find((option) => option.id === id);
}

/** Every model id/display name/value the agent currently advertises (for diagnostics and errors). */
export function modelIdsFromOptions(configOptions: readonly DshConfigOption[] | undefined): string[] {
  const ids: string[] = [];
  for (const choice of flattenChoices(findConfigOption(configOptions, MODEL_CONFIG_ID)?.options)) {
    if (typeof choice.value === 'string') {
      const parsed = parseModelValue(choice.value);
      ids.push(parsed === undefined ? choice.value : `${parsed.provider}/${parsed.model}`);
    } else if (typeof choice.name === 'string') {
      ids.push(choice.name);
    }
  }
  return ids;
}

/**
 * Turn a caller-supplied model into the value the protocol wants.
 *
 * An already-encoded value (leading `[`) is passed through verbatim: it came from the catalogue and
 * may carry a provider this adapter knows nothing about. A bare id is matched against the current
 * catalogue by value, parsed model id, or display name. When nothing matches, the string is sent
 * verbatim and the agent decides — a stale catalogue must not turn into a hard client-side failure
 * (probe 8.5 shows entries disappearing between calls).
 */
export function resolveModelValue(
  requested: string,
  configOptions: readonly DshConfigOption[] | undefined,
): string {
  if (parseModelValue(requested) !== undefined) return requested;
  for (const choice of flattenChoices(findConfigOption(configOptions, MODEL_CONFIG_ID)?.options)) {
    if (typeof choice.value !== 'string') continue;
    if (choice.value === requested) return choice.value;
    if (choice.name === requested) return choice.value;
    const parsed = parseModelValue(choice.value);
    if (parsed !== undefined && parsed.model === requested) return choice.value;
  }
  return requested;
}
