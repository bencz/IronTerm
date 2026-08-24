import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenBuffer } from '../public/tn3270/src/display/ScreenBuffer.js';
import { InboundParser } from '../public/tn3270/src/proto/InboundParser.js';
import { Cmd, Order } from '../public/tn3270/src/proto/Constants.js';

test('a single 3270 field covers the complete presentation space', () => {
  const screen = new ScreenBuffer(2, 4);
  screen.moveTo(0);
  screen.startField(0x00);
  screen.recalcFields();
  assert.equal(screen.fields[0].length, 8);
  assert.equal(screen.fields[0].contentLength, 7);
  assert.equal(screen.fieldAt(7), screen.fields[0]);
});

test('unformatted 3270 screens accept input and return it on Read Modified', async () => {
  const screen = new ScreenBuffer(2, 4);
  screen.keyboardLocked = false;
  assert.equal(screen.typeByte(0xC1), true);
  assert.equal(screen.cells[0].glyph, 'A');
  const { OutboundBuilder } = await import('../public/tn3270/src/proto/OutboundBuilder.js');
  const reply = new OutboundBuilder(screen).buildReadModified(0x7D);
  assert.deepEqual(Array.from(reply), [0x7D, 0x40, 0xC1, 0xC1]);
});

test('truncated orders and illegal addresses produce operation check', () => {
  const screen = new ScreenBuffer(24, 80);
  const parser = new InboundParser(screen);
  assert.throws(() => parser.process(Uint8Array.of(Cmd.W_F1, 0, Order.SBA, 0x40)),
    error => error.senseCode === 0x02);
  // 12-bit address 4095 is outside a 24x80 presentation space.
  assert.throws(() => parser.process(Uint8Array.of(Cmd.W_F1, 0, Order.SBA, 0x7F, 0x7F)),
    error => error.senseCode === 0x02);
});
