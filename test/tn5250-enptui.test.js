import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenBuffer } from '../public/tn5250/src/display/ScreenBuffer.js';
import { decodeWdsf } from '../public/tn5250/src/proto/enptui/WdsfDecoder.js';

function segment (minor, payload = []) {
  const len = 4 + payload.length;
  return [len >> 8, len & 0xff, 0xD9, minor, ...payload];
}

test('ENPTUI decodes, replaces and removes a window at the current SBA', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.cursor = 81;
  decodeWdsf(Uint8Array.from(segment(0x51, [0x00, 0x04, 0x00, 5, 12])), screen);
  assert.equal(screen.enptui.all.length, 1);
  assert.deepEqual(
    { kind: screen.enptui.all[0].kind, row: screen.enptui.all[0].topRow,
      col: screen.enptui.all[0].leftCol, height: screen.enptui.all[0].height,
      width: screen.enptui.all[0].width },
    { kind: 'window', row: 2, col: 2, height: 5, width: 12 });

  decodeWdsf(Uint8Array.from(segment(0x51, [0x80, 0x07, 0x00, 6, 14])), screen);
  assert.equal(screen.enptui.all.length, 1);
  assert.equal(screen.enptui.all[0].cursorRestricted, false);
  assert.equal(screen.enptui.all[0].width, 14);

  decodeWdsf(Uint8Array.from(segment(0x59)), screen);
  assert.equal(screen.enptui.all.length, 0);
});

test('ENPTUI selection field paints an item and survives concatenated segments', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.cursor = 160;
  const header = [
    0x00, 0x00, 0x00, 0x11, 0x00, 0, 0, 0, 0,
    3, 1, 1, 0, 0, 0, 0,
  ];
  const choice = [8, 0x10, 0x40, 0x00, 0x00, 0xC1, 0xC2, 0xC3];
  const bytes = [
    ...segment(0x50, [...header, ...choice]),
    ...segment(0x51, [0x00, 0x04, 0x00, 4, 10]),
  ];
  decodeWdsf(Uint8Array.from(bytes), screen);
  assert.equal(screen.enptui.all.length, 2);
  const selection = screen.enptui.all[0];
  assert.equal(selection.kind, 'selectionField');
  assert.equal(selection.items[0].selected, true);
  assert.equal(screen.cells[162].glyph, 'A');
  assert.equal(screen.cells[164].glyph, 'C');
});
