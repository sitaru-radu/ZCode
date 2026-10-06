/**
 * Secret redaction (spec §7: "Secrets never appear in error messages: stderr excerpts are filtered
 * for `sk-`-like tokens and the `DEEPSEEK_API_KEY` value before being stored").
 *
 * Two layers: literal values (whatever the adapter was told to hide, plus API-key-shaped values
 * taken from the child environment) and shape-based patterns for tokens that were never named.
 * A redactor is a plain function so it can be passed around without importing the adapter.
 */

export type Redactor = (text: string) => string;

/** Replacement marker. Kept stable so tests and log greps can assert on it. */
export const REDACTED = '[redacted]';

/** Values shorter than this are not treated as secrets: replacing them would mangle prose. */
const MIN_SECRET_LENGTH = 6;

/**
 * Shape rules, applied in order. The brackets are excluded from the value character classes so a
 * later rule cannot eat an earlier rule's `[redacted]` marker (and re-report it as a fresh secret).
 */
const SHAPE_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\bsk-[A-Za-z0-9_\-.]{6,}/g, `sk-${REDACTED}`],
  [/(\bBearer\s+)[A-Za-z0-9._\-+/=]{6,}/gi, `$1${REDACTED}`],
  [
    /((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password)\s*[=:]\s*)("?)([^\s"',}[\]]{6,})\2/gi,
    `$1$2${REDACTED}$2`,
  ],
  [/(--(?:api-?key|token|password)[= ])([^\s[\]]{6,})/gi, `$1${REDACTED}`],
];

/** Environment variable names whose values are secret by convention. */
const SECRET_ENV_NAME = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|PASSWD)$/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a redactor. `secrets` are literal values (empty/short entries are ignored); `patterns`
 * extend the built-in shape list (tests use this to prove the rule is applied).
 */
export function createRedactor(secrets: readonly string[] = []): Redactor {
  const literals = [...new Set(secrets.filter((value) => value.length >= MIN_SECRET_LENGTH))].sort(
    (a, b) => b.length - a.length,
  );
  const literalPattern =
    literals.length === 0 ? undefined : new RegExp(literals.map(escapeRegExp).join('|'), 'g');

  return (text: string): string => {
    if (text === '') return text;
    let out = literalPattern === undefined ? text : text.replace(literalPattern, REDACTED);
    for (const [pattern, replacement] of SHAPE_PATTERNS) {
      out = out.replace(pattern, replacement);
    }
    return out;
  };
}

/** Literal secrets implied by an environment map: values of API-key-shaped variables. */
export function secretValuesFromEnv(env: Readonly<Record<string, string | undefined>>): string[] {
  const found: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH && SECRET_ENV_NAME.test(name)) {
      found.push(value);
    }
  }
  return found;
}

/** Redacted one-line description of any thrown value, for error messages and diagnostics. */
export function describeError(error: unknown, redact: Redactor = createRedactor([])): string {
  if (error instanceof Error) return redact(error.message);
  return redact(String(error));
}
