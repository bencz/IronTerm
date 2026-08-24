import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenBuffer } from '../public/tn5250/src/display/ScreenBuffer.js';
import { OutboundBuilder } from '../public/tn5250/src/proto/OutboundBuilder.js';

test('5250 Query Reply describes the selected 24x80 color model honestly', () => {
  const screen = new ScreenBuffer(24, 80);
  const reply = new OutboundBuilder(screen).buildQueryResponse({ modelKey: '5292-2' });
  assert.equal(reply.length, 61);
  assert.deepEqual(Array.from(reply.slice(3, 5)), [0, 0x3A]);
  assert.equal(screen.ebcdic.decode(reply.slice(30, 37)), '5292002');
  assert.equal(reply[50], 0x11);
  assert.equal(reply[53], 0x00);
});

test('experimental enhanced reply advertises graphics only when requested', () => {
  const screen = new ScreenBuffer(24, 80);
  const reply = new OutboundBuilder(screen).buildQueryResponse({ modelKey: '5292-2', enhanced: true });
  assert.equal(reply[53], 0x20);
});

test('5250 Query Reply reports 27x132 and monochrome for 3477-FG', () => {
  const screen = new ScreenBuffer(27, 132);
  const reply = new OutboundBuilder(screen).buildQueryResponse({ modelKey: '3477-FG' });
  assert.equal(screen.ebcdic.decode(reply.slice(30, 37)), '34770FG');
  assert.equal(reply[50], 0x30);
});
