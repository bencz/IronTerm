import test from 'node:test';
import assert from 'node:assert/strict';
import { Ebcdic } from '../public/shared/src/proto/Ebcdic.js';

test('CP1047 uses the canonical variant characters and preserves LF/NEL', () => {
  const cp = Ebcdic.get('CP1047');
  const expected = new Map([
    [0x15, '\u0085'], [0x25, '\n'], [0x4A, '¢'], [0x4F, '|'], [0x5A, '!'],
    [0x5F, '^'], [0xAD, '['], [0xB0, '¬'], [0xBA, 'Ý'], [0xBB, '¨'], [0xBD, ']'],
  ]);
  for (const [byte, char] of expected) assert.equal(cp.toChar(byte), char);
});

test('CP500 international punctuation round-trips', () => {
  const cp = Ebcdic.get('CP500');
  assert.equal(cp.toChar(0x4A), '[');
  assert.equal(cp.toChar(0x5A), ']');
  assert.equal(cp.toChar(0xBB), '|');
  assert.deepEqual(Array.from(cp.encode('[]|!')), [0x4A, 0x5A, 0xBB, 0x4F]);
});

test('CP1141 German characters and euro round-trip', () => {
  const cp = Ebcdic.get('CP1141');
  assert.equal(cp.toChar(0x9F), '€');
  assert.deepEqual(Array.from(cp.encode('ÄÖÜäöüß€')),
    [0x4A, 0xE0, 0x5A, 0xC0, 0x6A, 0xD0, 0xA1, 0x9F]);
});
