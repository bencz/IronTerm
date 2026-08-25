import test from 'node:test';
import assert from 'node:assert/strict';
import { wrap, unwrap } from '../public/tn5250/src/proto/GdsHeader.js';

test('GDS round-trips 16-bit flags and validates logical length', () => {
  const framed = wrap(Uint8Array.of(1, 2, 3), 0x03, 0x4500);
  const decoded = unwrap(framed);
  assert.equal(decoded.flags, 0x4500);
  assert.equal(decoded.opcode, 0x03);
  assert.deepEqual(Array.from(decoded.payload), [1, 2, 3]);
  framed[1]--;
  assert.equal(unwrap(framed), null);
});

test('GDS accepts the extended startup header emitted by PUB400', () => {
  const record = Uint8Array.of(
    0x00, 0x0D, 0x12, 0xA0, 0x90, 0x00, 0x05, 0x60, 0x06, 0x00, 0x20, 0xC0, 0x00);
  const decoded = unwrap(record);
  assert.equal(decoded.flags, 0x6006);
  assert.equal(decoded.variableHeaderLength, 5);
  assert.deepEqual(Array.from(decoded.payload), [0xC0, 0x00]);
});
