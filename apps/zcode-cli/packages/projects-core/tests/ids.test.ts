/**
 * §5 ids and determinism: `shortHash` must be the first 10 characters of base32(sha256(input)),
 * `newId` must stay random and prefixed, `deriveId` must be stable and separator-sensitive.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { deriveId, newId, shortHash } from '../src/index.js';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('shortHash returns 10 base32 characters from the filesystem-safe alphabet', () => {
  const value = shortHash('anything at all');
  assert.equal(value.length, 10);
  for (const character of value) {
    assert.ok(ALPHABET.includes(character), `unexpected character "${character}" in ${value}`);
  }
});

test('shortHash matches independently computed references', () => {
  assert.equal(shortHash(''), '4oymiquy7q');
  assert.equal(shortHash('projects'), 'ev34b5kxwl');
  assert.equal(deriveId('tsk', 'msn_1', '1', 'build'), 'tsk_5wa3qn7yyp');
  assert.equal(deriveId('msn', 'prj_1', 'mission'), 'msn_bqraety336');
});

test('shortHash is deterministic and input-sensitive', () => {
  assert.equal(shortHash('mission one'), shortHash('mission one'));
  assert.notEqual(shortHash('mission one'), shortHash('mission two'));
  assert.notEqual(shortHash('ab'), shortHash('ba'));
});

test('shortHash decodes back to the sha256 prefix of its input', () => {
  const inputs = ['', 'projects', '@zcode/projects-core', 'mission\u0000plan\u0000task'];
  for (const input of inputs) {
    const digest = createHash('sha256').update(input, 'utf8').digest();
    const hash = shortHash(input);

    // Decode the 10 base32 characters (50 bits) and compare with the first 6 digest bytes and the
    // two high bits of the seventh: this re-implements the encoding instead of trusting it.
    let bits = '';
    for (const character of hash) {
      const value = ALPHABET.indexOf(character);
      assert.notEqual(value, -1);
      bits += value.toString(2).padStart(5, '0');
    }
    for (let byteIndex = 0; byteIndex < 6; byteIndex += 1) {
      const expectedByte = digest[byteIndex] ?? -1;
      assert.equal(parseInt(bits.slice(byteIndex * 8, byteIndex * 8 + 8), 2), expectedByte, input);
    }
    const seventh = digest[6] ?? -1;
    assert.equal(parseInt(bits.slice(48, 50), 2), seventh >> 6, input);
  }
});

test('deriveId hashes all parts with a separator, so part boundaries matter', () => {
  assert.equal(deriveId('tsk', 'a', 'b'), deriveId('tsk', 'a', 'b'));
  assert.notEqual(deriveId('tsk', 'a', 'b'), deriveId('tsk', 'ab'));
  assert.notEqual(deriveId('tsk', 'a', 'b'), deriveId('tsk', 'ab', ''));
  assert.notEqual(deriveId('tsk', 'a'), deriveId('wkr', 'a'));
  assert.notEqual(deriveId('tsk', '1', '2'), deriveId('tsk', '12'));
  assert.match(deriveId('tsk', 'msn_1', '1', 'build'), /^tsk_[a-z2-7]{10}$/);
});

test('newId is prefixed and random, never derived', () => {
  const first = newId('prj');
  const second = newId('prj');
  assert.equal(first.startsWith('prj_'), true);
  assert.match(first.slice(4), UUID_PATTERN);
  assert.notEqual(first, second);
  assert.equal(newId('msn').startsWith('msn_'), true);
});
