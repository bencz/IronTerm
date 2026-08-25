import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenBuffer } from '../public/tn5250/src/display/ScreenBuffer.js';
import { OutboundBuilder } from '../public/tn5250/src/proto/OutboundBuilder.js';

test('5250 Query Reply describes the selected 24x80 color model honestly', () => {
  const screen = new ScreenBuffer(24, 80);
  const reply = new OutboundBuilder(screen).buildQueryResponse({ modelKey: '5292-2' });
  assert.equal(reply.length, 71);
  assert.deepEqual(Array.from(reply.slice(3, 5)), [0, 0x44]);
  assert.equal(reply[29], 0x01);
  assert.equal(screen.ebcdic.decode(reply.slice(30, 37)), '5292002');
  assert.equal(reply[50], 0x11);
  assert.equal(reply[46], 0x40);
  assert.equal(reply[52], 0x01);
  assert.equal(reply[53], 0x00);
  assert.equal(reply[54], 0x00);
  assert.equal(reply[61], 0x00);
  assert.equal(reply[62], 0x00);
});

test('enhanced reply advertises ENPTUI and one type-1 grid buffer', () => {
  const screen = new ScreenBuffer(24, 80);
  const reply = new OutboundBuilder(screen).buildQueryResponse({ modelKey: '5292-2', enhanced: true });
  assert.equal(reply.length, 71);
  assert.deepEqual(Array.from(reply.slice(3, 5)), [0, 0x44]);
  assert.equal(reply[49], 0x7B);
  assert.equal(reply[53], 0x0F);
  assert.equal(reply[54], 0xC8);
  assert.deepEqual(Array.from(reply.slice(55, 61)), new Array(6).fill(0));
  assert.deepEqual(Array.from(reply.slice(61, 63)), [0x01, 0x01]);
  assert.deepEqual(Array.from(reply.slice(63)), new Array(8).fill(0));
});

test('5250 Query Reply reports 27x132 and monochrome for 3477-FG', () => {
  const screen = new ScreenBuffer(27, 132);
  const reply = new OutboundBuilder(screen).buildQueryResponse({ modelKey: '3477-FG' });
  assert.equal(screen.ebcdic.decode(reply.slice(30, 37)), '34770FG');
  assert.equal(reply[50], 0x30);
});

test('Query Station State supports compact and extended response forms', () => {
  const screen = new ScreenBuffer(24, 80);
  const builder = new OutboundBuilder(screen);
  assert.deepEqual(Array.from(builder.buildQueryStationStateResponse()), [
    0, 0, 0x88, 0, 9, 0xD9, 0x72, 0x80, 0, 3, 1, 4,
  ]);
  assert.deepEqual(Array.from(builder.buildQueryStationStateResponse({ extended: true })), [
    0, 0, 0x88, 0, 12, 0xD9, 0x72, 0xC0, 0,
    0x33, 0x30, 0x45, 0x30, 0x04, 0xB0,
  ]);
});
