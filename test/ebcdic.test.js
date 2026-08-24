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
