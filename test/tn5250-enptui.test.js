import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenBuffer } from '../public/tn5250/src/display/ScreenBuffer.js';
import { OutboundBuilder } from '../public/tn5250/src/proto/OutboundBuilder.js';
import { decodeWdsf, EnptuiDataStreamError } from '../public/tn5250/src/proto/enptui/WdsfDecoder.js';
import { SenseCode } from '../public/tn5250/src/proto/enptui/Constants.js';

function segment (minor, payload = []) {
  const len = 4 + payload.length;
  return [len >> 8, len & 0xff, 0xD9, minor, ...payload];
}

function selectionHeader ({ flag1 = 0, flag2 = 0, flag3 = 0, type = 0x11,
  gui = 0, textSize = 3, rows = 1, cols = 1, nulls = 0 } = {}) {
  return [flag1, flag2, flag3, type, gui, 0, 0, 0, 0,
    textSize, rows, cols, nulls, 0, 0, 0];
}

test('ENPTUI sense codes match the IBM 0x100501xx family', () => {
  assert.equal(SenseCode.MAJOR_LEN_ERROR, 0x10050110);
  assert.equal(SenseCode.WRITE_DATA_ERROR, 0x10050140);
  assert.equal(SenseCode.GRID_CONSTR, 0x10050150);
  assert.equal(SenseCode.WRITE_DATA_CCSID_ERROR, 0x10050155);
});

test('malformed ENPTUI data raises the IBM sense code', () => {
  const screen = new ScreenBuffer(24, 80);
  assert.throws(
    () => decodeWdsf(Uint8Array.from([0, 4, 0x00, 0x51]), screen),
    error => error instanceof EnptuiDataStreamError
      && error.negativeResponse === true
      && error.senseCode === SenseCode.WSF_CLASS_TYPE,
  );
  assert.throws(
    () => decodeWdsf(Uint8Array.from(segment(0x59, [0, 0])), screen),
    error => error.senseCode === SenseCode.MAJOR_LEN_ERROR,
  );
});

test('IBM Create Window geometry, cursor flag, replacement and removal are decoded', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.cursor = 81;
  decodeWdsf(Uint8Array.from(segment(0x51, [0x80, 0, 0, 5, 12])), screen);
  assert.equal(screen.enptui.all.length, 1);
  assert.deepEqual(
    { kind: screen.enptui.all[0].kind, row: screen.enptui.all[0].topRow,
      col: screen.enptui.all[0].leftCol, height: screen.enptui.all[0].height,
      width: screen.enptui.all[0].width, innerRow: screen.enptui.all[0].innerTopRow,
      innerCol: screen.enptui.all[0].innerLeftCol },
    { kind: 'window', row: 2, col: 2, height: 7, width: 18, innerRow: 3, innerCol: 5 });
  assert.equal(screen.enptui.all[0].cursorRestricted, true);

  decodeWdsf(Uint8Array.from(segment(0x51, [0x00, 0, 0, 6, 14])), screen);
  assert.equal(screen.enptui.all.length, 1);
  assert.equal(screen.enptui.all[0].cursorRestricted, false);
  assert.equal(screen.enptui.all[0].width, 20);

  decodeWdsf(Uint8Array.from(segment(0x59, [0, 0, 0])), screen);
  assert.equal(screen.enptui.all.length, 0);
});

test('creating a window removes ENPTUI fields fully covered by it', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.cursor = 244;
  const choice = [8, 0x10, 0, 0, 0x80, 0xC1, 0xC2, 0xC3];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader(), ...choice,
  ])), screen);
  assert.equal(screen.enptui.all[0].kind, 'selectionField');

  screen.cursor = 162;
  decodeWdsf(Uint8Array.from(segment(0x51, [0, 0, 0, 4, 10])), screen);
  assert.deepEqual(screen.enptui.all.map(c => c.kind), ['window']);
});

test('window border and title minors use IBM byte offsets', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.cursor = 81;
  const border = [13, 0x01, 0x80, 0, 0x27, 0x4A, 0x4B, 0x4C,
    0x4D, 0x4E, 0x4F, 0x50, 0x51];
  const title = [9, 0x10, 0x40, 0, 0x22, 0, 0xC1, 0xC2, 0xC3];
  decodeWdsf(Uint8Array.from(segment(0x51, [0, 0, 0, 4, 12, ...border, ...title])), screen);
  const window = screen.enptui.all[0];
  assert.equal(window.noBorder, true);
  assert.deepEqual(window.borders, [0x4A, 0x4B, 0x4C, 0x4D, 0x4E, 0x4F, 0x50, 0x51]);
  assert.deepEqual({ text: window.title.text, attr: window.title.attr, align: window.title.align },
    { text: 'ABC', attr: 0x22, align: 'right' });
});

test('selection text is anchored around SBA and NewRow comes from choice flag1', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.cursor = 162;
  const first = [8, 0x10, 0x40, 0x00, 0x80, 0xC1, 0xC2, 0xC3];
  const second = [8, 0x10, 0x20, 0x00, 0x80, 0xC4, 0xC5, 0xC6];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ type: 0x01, cols: 2 }), ...first, ...second,
  ])), screen);

  const selection = screen.enptui.all[0];
  assert.equal(selection.kind, 'menuBar');
  assert.equal(selection.items[0].selected, true);
  assert.equal(selection.items[1].newRow, true);
  assert.equal(selection.itemPositions[0].indicatorIdx, -1);
  assert.equal(selection.itemPositions[0].textIdx, 163);
  assert.equal(screen.cells[163].glyph, 'A');
  assert.equal(screen.cells[165].glyph, 'C');
  assert.equal(selection.itemPositions[1].textRow, 4);
});

test('selection attributes and indicators occupy the IBM presentation-plane cells', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.cursor = 162;
  const choice = [8, 0x10, 0x40, 0, 0x80, 0xC1, 0xC2, 0xC3];
  const attrs = [13, 0x01, 0x80, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0x2A];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader(), ...choice, ...attrs,
  ])), screen);

  const selection = screen.enptui.all[0];
  assert.equal(selection.itemPositions[0].anchorIdx, 162);
  assert.equal(screen.cells[160].byte, 0x20); // indicator attribute
  assert.equal(screen.cells[161].byte, 0x61); // selected radio marker
  assert.equal(screen.cells[162].byte, 0x2A); // selected-choice attribute
  assert.equal(screen.cells[162].attributePlace, true);
  assert.equal(screen.cells[163].glyph, 'A');
  assert.equal(screen.cells[166].byte, 0x20); // ending attribute
});

test('menu rows change only on Choice Text NewRow, not numOfCols', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.cursor = 162;
  const first = [8, 0x10, 0, 0, 0x80, 0xC1, 0xC2, 0xC3];
  const second = [8, 0x10, 0, 0, 0x80, 0xC4, 0xC5, 0xC6];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ type: 0x01, cols: 1 }), ...first, ...second,
  ])), screen);

  const menu = screen.enptui.all[0];
  assert.equal(menu.itemPositions[0].textRow, 3);
  assert.equal(menu.itemPositions[1].textRow, 3);
  assert.equal(menu.itemPositions[1].textIdx, 168);
  assert.equal(menu.menuRows, 1);
});

test('irregular menu rows retain IBM dummy choices in outbound indexes', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.cursor = 162;
  const first = [8, 0x10, 0, 0, 0x80, 0xC1, 0xC2, 0xC3];
  const second = [8, 0x10, 0x60, 0, 0x80, 0xC4, 0xC5, 0xC6];
  const third = [8, 0x10, 0, 0, 0x80, 0xC7, 0xC8, 0xC9];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ flag1: 0x01, type: 0x01, cols: 1 }),
    ...first, ...second, ...third,
  ])), screen);

  const menu = screen.enptui.all[0];
  assert.equal(menu.items.length, 4);
  assert.equal(menu.items[1].dummy, true);
  assert.equal(menu.items[1].nonCursorable, true);
  assert.equal(menu.items[2].selected, true);
  assert.equal(menu.itemPositions[2].textRow, 4);
  screen.cursor = menu.itemPositions[1].textIdx;
  assert.equal(screen.enptuiItemAtCursor(), null);
  assert.deepEqual([...new OutboundBuilder(screen).buildReadResponse()],
    [0x11, 3, 3, 0x00, 0x22]);
});

test('menu separator and push-button padding follow their IBM minors', () => {
  const menuScreen = new ScreenBuffer(24, 80);
  menuScreen.cursor = 80;
  const choice = [8, 0x10, 0, 0, 0x80, 0xC1, 0xC2, 0xC3];
  const separator = [8, 0x09, 0x80, 2, 20, 0, 0x22, 0x60];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ type: 0x01 }), ...choice, ...separator,
  ])), menuScreen);
  assert.deepEqual(menuScreen.enptui.all[0].menuSeparator, {
    flags: 0x80, startCol: 2, endCol: 20, attr: 0x22, char: 0x60,
    suppressAttribute: false,
  });

  const pushScreen = new ScreenBuffer(24, 80);
  pushScreen.cursor = 80;
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ type: 0x41, gui: 0x10, textSize: 5 }), ...choice,
  ])), pushScreen);
  const push = pushScreen.enptui.all[0];
  assert.deepEqual([...push.items[0].textBytes], [0x40, 0xC1, 0xC2, 0xC3, 0x40]);
  assert.equal(push.itemPositions[0].textLength, 5);
});

test('deselect-on-unlock clears cursorable ENPTUI choices', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.cursor = 162;
  const choice = [8, 0x10, 0x40, 0, 0x80, 0xC1, 0xC2, 0xC3];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ flag3: 0x80 }), ...choice,
  ])), screen);
  assert.equal(screen.enptui.all[0].items[0].selected, true);
  screen.unlockKeyboard();
  assert.equal(screen.enptui.all[0].items[0].selected, false);
  assert.equal(screen.cells[162].byte, 0x20);
});

test('attached and standalone scroll bars follow IBM header offsets', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.cursor = 162;
  const total = [0, 0, 0, 100];
  const above = [0, 0, 0, 25];
  const choice = [8, 0x10, 0x00, 0, 0x80, 0xC1, 0xC2, 0xC3];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ flag2: 0x80, type: 0x21, rows: 5 }),
    ...total, ...above, ...choice,
  ])), screen);
  const [selection, attached] = screen.enptui.all;
  assert.equal(selection.attachedScrollTotal, 100);
  assert.equal(selection.attachedScrollSlider, 25);
  assert.equal(attached.parent, selection);
  assert.equal(attached.cursorAtStart, 166);

  // Redefining the same SBA without an attached bar must remove the
  // old parent/child graph instead of leaving a phantom scrollbar.
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ type: 0x11 }), ...choice,
  ])), screen);
  assert.deepEqual(screen.enptui.all.map(c => c.kind), ['selectionField']);

  screen.cursor = 400;
  decodeWdsf(Uint8Array.from(segment(0x53, [0x80, 0, ...total, ...above, 12])), screen);
  const standalone = screen.enptui.all.at(-1);
  assert.equal(standalone.direction, 1);
  assert.equal(standalone.totalRows, 100);
  assert.equal(standalone.sliderPos, 25);
  assert.equal(standalone.length, 12);
  assert.equal(standalone.boundsWidth, 12);
  assert.equal(standalone.boundsHeight, 1);
});

test('programmable mouse button payload defines global pointer events, not regions', () => {
  const screen = new ScreenBuffer(24, 80);
  decodeWdsf(Uint8Array.from(segment(0x55, [0, 0, 0, 0xC0, 1, 2, 0xF1])), screen);
  const events = screen.enptui.all[0];
  assert.equal(events.kind, 'mouseEvents');
  assert.deepEqual(events.definitions[0], {
    flags: 0xC0, firstEvent: 1, secondEvent: 2, aidCode: 0xF1,
  });

  decodeWdsf(Uint8Array.from(segment(0x55, [0, 0, 0])), screen);
  assert.equal(screen.enptui.all.length, 0);
});

test('double-event programmable mouse response includes pointer coordinates', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.cursor = 81;
  screen.pendingPointerAid = { row: 7, col: 12, aid: 0xF1 };
  const bytes = new OutboundBuilder(screen).buildAidResponse(0x80);
  assert.deepEqual([...bytes], [2, 2, 0x80, 7, 12, 0xF1]);
  assert.equal(screen.pendingPointerAid, null);
});

test('ruled-grid repeat values are spacing, not duplicated rectangles', () => {
  const screen = new ScreenBuffer(24, 80);
  const minor = [10, 5, 0x80, 2, 3, 6, 5, 0, 0, 2];
  decodeWdsf(Uint8Array.from(segment(0x60, [1, 0x80, 0, 0, 0, 0, 0, ...minor])), screen);
  const grid = screen.enptui.all[0].gridBuf;
  const at = (row, col) => grid[(row - 1) * 80 + col - 1];
  assert.ok(at(2, 4) & 0x04);
  assert.ok(at(4, 4) & 0x04);
  assert.ok(at(6, 4) & 0x01);
  assert.equal(at(7, 4), 0);
});

test('short IBM Define Grid base header is accepted without minors', () => {
  const screen = new ScreenBuffer(24, 80);
  decodeWdsf(Uint8Array.from(segment(0x60, [1, 0x80, 0, 0, 0])), screen);
  assert.equal(screen.enptui.all[0].kind, 'grid');
  assert.equal(screen.enptui.all[0].records.length, 0);
});

test('horizontal grid records do not require the unused height byte', () => {
  const screen = new ScreenBuffer(24, 80);
  const horizontal = [10, 0, 0x80, 2, 3, 6, 0, 0, 0, 1];
  decodeWdsf(Uint8Array.from(segment(0x60, [1, 0x80, 0, 0, 0, 0, 0, ...horizontal])), screen);
  const grid = screen.enptui.all[0].gridBuf;
  assert.ok(grid[(2 - 1) * 80 + (3 - 1)] & 0x04);
});

test('WRITE_DATA clears stale tail bytes and preserves the field MDT', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.cursor = 160;
  screen.setWriteAddressIndex(160);
  screen.addField({ attr: 0x20, length: 4, ffw0: 0, ffw1: 0, fcws: [] });
  screen.cursor = 160;
  for (let i = 161; i <= 164; i++) {
    screen.cells[i].byte = 0xE7;
    screen.cells[i].glyph = 'X';
  }
  decodeWdsf(Uint8Array.from(segment(0x54, [0x80, 0, 0xC1, 0xC2])), screen);
  assert.deepEqual(screen.cells.slice(161, 165).map(c => c.byte), [0xC1, 0xC2, 0, 0]);
  assert.equal(screen.fields[0].modified, false);
});

test('selected ENPTUI choices are serialized as IBM pseudo-fields', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.cursor = 162;
  const choice = [8, 0x10, 0x40, 0, 0x80, 0xC1, 0xC2, 0xC3];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ flag1: 0x01 }), ...choice,
  ])), screen);

  const bytes = new OutboundBuilder(screen).buildAidResponse(0xF1);
  assert.deepEqual([...bytes], [3, 3, 0xF1, 0x11, 3, 3, 0x00, 0x20]);
});

test('menu bars use the IBM two-byte single-choice response', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.cursor = 162;
  const first = [8, 0x10, 0, 0, 0x80, 0xC1, 0xC2, 0xC3];
  const second = [8, 0x10, 0x40, 0, 0x80, 0xC4, 0xC5, 0xC6];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ flag1: 0x01, type: 0x01, cols: 2 }), ...first, ...second,
  ])), screen);

  const bytes = new OutboundBuilder(screen).buildReadResponse();
  assert.deepEqual([...bytes], [0x11, 3, 3, 0x00, 0x21]);
});

test('concatenated ENPTUI segments remain independently decoded', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.cursor = 162;
  const choice = [8, 0x10, 0, 0, 0x80, 0xC1, 0xC2, 0xC3];
  decodeWdsf(Uint8Array.from([
    ...segment(0x50, [...selectionHeader(), ...choice]),
    ...segment(0x51, [0, 0, 0, 4, 10]),
  ]), screen);
  assert.deepEqual(screen.enptui.all.map(c => c.kind), ['selectionField', 'window']);
});
