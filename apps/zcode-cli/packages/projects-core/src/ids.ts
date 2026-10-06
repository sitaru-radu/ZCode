/**
 * Identifier derivation — spec `specs/projects/10-domain.md` §5.
 *
 * `node:crypto` is the only import this package is allowed to take, because hashing and (for
 * user-facing entities) randomness cannot be expressed without it. Nothing here reads the clock,
 * touches the filesystem or performs IO.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { ShortId } from './types.js';

/** RFC 4648 base32 alphabet, lowercased so every short id is filesystem-safe (§5). */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Length of every `ShortId` (§5). */
const SHORT_HASH_LENGTH = 10;

/** Separator used when hashing id parts, so `('a','b')` and `('ab')` differ (§5). */
const PART_SEPARATOR = '\u0000';

/**
 * First 10 characters of base32(sha256(input)) — 50 bits of the digest, deterministic and
 * filesystem-safe. Same input always yields the same value (invariants 2 and 9 depend on this).
 */
export function shortHash(input: string): ShortId {
  const digest = createHash('sha256').update(input, 'utf8').digest();
  let accumulator = 0;
  let bitCount = 0;
  let out = '';

  for (const byte of digest) {
    accumulator = (accumulator << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      out += BASE32_ALPHABET.charAt((accumulator >>> (bitCount - 5)) & 31);
      bitCount -= 5;
      if (out.length === SHORT_HASH_LENGTH) {
        return out;
      }
    }
    // Keep only the bits that were not consumed yet, so the shift stays inside 32 bits.
    accumulator &= (1 << bitCount) - 1;
  }

  // Unreachable for a 256-bit digest (10 chars need 50 bits) but keeps the return type total.
  return out;
}

/**
 * Random id for user-facing entities (project, mission): `${prefix}_${randomUUID()}` (§5).
 * Never use it for tasks or workers — those must be derived so that recovery is idempotent.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/**
 * Deterministic id: `${prefix}_${shortHash(parts.join('\u0000'))}` (§5).
 * Used for task ids from `(missionId, planVersion, planKey)` and worker ids from `(taskId, attempt)`.
 */
export function deriveId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${shortHash(parts.join(PART_SEPARATOR))}`;
}
