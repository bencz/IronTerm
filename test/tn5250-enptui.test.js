import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenBuffer } from '../public/tn5250/src/display/ScreenBuffer.js';
import { OutboundBuilder } from '../public/tn5250/src/proto/OutboundBuilder.js';
import { decodeWdsf, EnptuiDataStreamError } from '../public/tn5250/src/proto/enptui/WdsfDecoder.js';
import { SenseCode } from '../public/tn5250/src/proto/enptui/Constants.js';
import { EnptuiOverlay } from '../public/tn5250/src/ui/EnptuiOverlay.js';
import { Renderer } from '../public/tn5250/src/ui/Renderer.js';

function segment (minor, payload = []) {
  const len = 4 + payload.length;
  return [len >> 8, len & 0xff, 0xD9, minor, ...payload];
}

function selectionHeader ({ flag1 = 0, flag2 = 0, flag3 = 0, type = 0x11,
  gui = 0, textSize = 3, rows = 1, cols = 1, nulls = 0 } = {}) {
  return [flag1, flag2, flag3, type, gui, 0, 0, 0, 0,
    textSize, rows, cols, nulls, 0, 0, 0];
}

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
  assert.throws(
    () => decodeWdsf(Uint8Array.from(segment(0x50, selectionHeader())), screen),
    error => error.senseCode === SenseCode.INVALID_MINOR_LENGTH,
  );
  assert.throws(
    () => decodeWdsf(Uint8Array.from(segment(0x50, [
      ...selectionHeader({ flag2: 0x80, type: 0x21 }),
      0, 0, 0, 10, 0, 0, 0, 0,
    ])), screen),
    error => error.senseCode === SenseCode.INVALID_MINOR_LENGTH,
  );
  assert.throws(
    () => decodeWdsf(Uint8Array.from(segment(0x50, [
      ...selectionHeader(), 5, 0x10, 0x08, 0, 0x80,
    ])), screen),
    error => error.senseCode === SenseCode.INVALID_MINOR_LENGTH,
  );
  assert.throws(
    () => decodeWdsf(Uint8Array.from(segment(0x50, [
      ...selectionHeader({ rows: 0 }), 6, 0x10, 0, 0, 0x80, 0xC1,
    ])), screen),
    error => error.senseCode === SenseCode.WSF_PARM,
  );
});

test('IBM Create Window geometry, cursor flag, replacement and removal are decoded', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(81);
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

test('Unrestrict Window Cursor affects only the newest active window', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(81);
  decodeWdsf(Uint8Array.from(segment(0x51, [0x80, 0, 0, 4, 12])), screen);
  const removed = screen.enptui.all[0];
  decodeWdsf(Uint8Array.from(segment(0x59, [0, 0, 0])), screen);

  screen.setWriteAddressIndex(244);
  decodeWdsf(Uint8Array.from(segment(0x51, [0x80, 0, 0, 4, 12])), screen);
  const active = screen.enptui.all[0];
  decodeWdsf(Uint8Array.from(segment(0x52, [0, 0])), screen);

  assert.equal(removed.cursorRestricted, true);
  assert.equal(active.cursorRestricted, false);
});

test('removing the current window does not make an older window current', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(81);
  decodeWdsf(Uint8Array.from(segment(0x51, [0x80, 0, 0, 2, 8])), screen);
  const oldWindow = screen.enptui.all[0];

  screen.setWriteAddressIndex(500);
  decodeWdsf(Uint8Array.from(segment(0x51, [0x80, 0, 0, 2, 8])), screen);
  assert.equal(screen.currentEnptuiWindowAddress, 500);
  decodeWdsf(Uint8Array.from(segment(0x59, [0, 0, 0])), screen);

  assert.equal(screen.currentEnptuiWindowAddress, null);
  screen.setWriteAddressIndex(81);
  decodeWdsf(Uint8Array.from(segment(0x52, [0, 0])), screen);
  assert.equal(oldWindow.cursorRestricted, true);
});

test('removing a window retains only its presentation until overwritten', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(81);
  decodeWdsf(Uint8Array.from(segment(0x51, [0, 0, 0, 4, 12])), screen);
  decodeWdsf(Uint8Array.from(segment(0x59, [0, 0, 0])), screen);
  assert.equal(screen.enptui.all.length, 0);
  assert.equal(screen.enptui.visuals.length, 1);
  assert.equal(screen.enptui.visuals[0].active, false);
  assert.equal(screen.enptui.visuals[0].basicPresentation, undefined);
});

test('creating a window removes ENPTUI fields fully covered by it', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(244);
  const choice = [8, 0x10, 0, 0, 0x80, 0xC1, 0xC2, 0xC3];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader(), ...choice,
  ])), screen);
  assert.equal(screen.enptui.all[0].kind, 'selectionField');

  screen.setWriteAddressIndex(162);
  decodeWdsf(Uint8Array.from(segment(0x51, [0, 0, 0, 4, 10])), screen);
  assert.deepEqual(screen.enptui.all.map(c => c.kind), ['window']);
  assert.deepEqual(screen.cells.slice(242, 249).map(cell => cell.byte),
    [0, 0, 0, 0, 0, 0, 0]);
});

test('a new covering window replaces older windows at different anchors', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(163);
  decodeWdsf(Uint8Array.from(segment(0x51, [0, 0, 0, 1, 2])), screen);
  screen.setWriteAddressIndex(81);
  decodeWdsf(Uint8Array.from(segment(0x51, [0, 0, 0, 5, 12])), screen);

  const windows = screen.enptui.all.filter(construct => construct.kind === 'window');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].cursorAtStart, 81);
});

test('window border and title minors use IBM byte offsets', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(81);
  const border = [13, 0x01, 0x80, 0, 0x27, 0x4A, 0x4B, 0x4C,
    0x4D, 0x4E, 0x4F, 0x50, 0x51];
  const title = [9, 0x10, 0x40, 0, 0x22, 0, 0xC1, 0xC2, 0xC3];
  decodeWdsf(Uint8Array.from(segment(0x51, [0, 0, 0, 4, 12, ...border, ...title])), screen);
  const window = screen.enptui.all[0];
  assert.equal(window.noBorder, true);
  assert.deepEqual(window.borders, [0x4A, 0x4B, 0x4C, 0x4D, 0x4E, 0x4F, 0x50, 0x51]);
  assert.deepEqual(window.borderOverrides, new Array(8).fill(true));
  assert.deepEqual({ text: window.title.text, attr: window.title.attr, align: window.title.align },
    { text: 'ABC', attr: 0x22, align: 'right' });
});

test('window creation clears its footprint and later content remains visible', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(81);
  screen.cells[162].byte = 0xC1;
  screen.cells[162].glyph = 'A';
  decodeWdsf(Uint8Array.from(segment(0x51, [0x40, 0, 0, 4, 12])), screen);
  assert.equal(screen.cells[162].byte, 0);

  screen.cells[164].byte = 0xC2;
  screen.cells[164].glyph = 'B';

  const fills = [];
  const ctx = new Proxy({
    save () {}, restore () {}, beginPath () {}, moveTo () {}, lineTo () {}, stroke () {},
    fillRect (...args) { fills.push(args); },
  }, {
    get (target, key) { return key in target ? target[key] : () => {}; },
    set (target, key, value) { target[key] = value; return true; },
  });
  new EnptuiOverlay(screen).paint(ctx, {
    cellWidth: 8, cellHeight: 16, fontSize: 14, cursorBlink: false,
  });

  assert.deepEqual(fills, []);
  assert.equal(screen.cells[164].glyph, 'B');
});

test('an inactive window retains its decoration until overwritten', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(81);
  decodeWdsf(Uint8Array.from(segment(0x51, [0, 0, 0, 4, 12])), screen);
  const window = screen.enptui.all[0];
  screen.enptui.inactivateWhere(construct => construct === window);

  let strokes = 0;
  const ctx = new Proxy({
    save () {}, restore () {}, beginPath () {}, rect () {}, clip () {},
    moveTo () {}, lineTo () {}, stroke () { strokes++; }, fillRect () {},
  }, {
    get (target, key) { return key in target ? target[key] : () => {}; },
    set (target, key, value) { target[key] = value; return true; },
  });
  new EnptuiOverlay(screen).paint(ctx, {
    cellWidth: 8, cellHeight: 16, fontSize: 14, cursorBlink: false,
  });

  assert.equal(strokes, 1);
});

test('creating a window clears its retained content presentation plane', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(81);
  // The content of this window begins at row 3, column 5 (index 164).
  Object.assign(screen.cells[164], { byte: 0xC1, glyph: 'A' });
  Object.assign(screen.cells[165], {
    byte: 0x22, glyph: ' ', attributePlace: true,
  });

  decodeWdsf(Uint8Array.from(segment(0x51, [0, 0, 0, 4, 12])), screen);

  assert.deepEqual(screen.cells.slice(164, 166).map(cell => ({
    byte: cell.byte, glyph: cell.glyph, attributePlace: cell.attributePlace,
  })), [
    { byte: 0, glyph: ' ', attributePlace: false },
    { byte: 0, glyph: ' ', attributePlace: false },
  ]);
});

test('a foreground window clips every older ENPTUI decoration in its footprint', () => {
  const screen = new ScreenBuffer(24, 80);
  const window = (topRow, leftCol, height, width, borderAttr) => ({
    kind: 'window', topRow, leftCol, height, width,
    contentWidth: width - 6, borderAttr, noBorder: false,
    borderOverrides: new Array(8).fill(false), borders: new Uint8Array(8),
  });
  screen.enptui.add(window(9, 2, 13, 35, 0x3A));
  screen.enptui.add(window(7, 2, 12, 34, 0x22));

  let path = [];
  const clips = [];
  const ctx = new Proxy({
    save () {}, restore () {}, beginPath () { path = []; },
    rect (...args) { path.push(args); }, clip () { clips.push([...path]); },
    moveTo () {}, lineTo () {}, stroke () {}, fillRect () {}, fillText () {},
    setLineDash () {},
  }, {
    get (target, key) { return key in target ? target[key] : () => {}; },
    set (target, key, value) { target[key] = value; return true; },
  });
  new EnptuiOverlay(screen).paint(ctx, {
    cellWidth: 8, cellHeight: 16, fontSize: 14, cursorBlink: false,
  });

  assert.equal(clips.length, 1);
  const contains = (x, y) => clips[0].some(([left, top, width, height]) =>
    x >= left && x < left + width && y >= top && y < top + height);
  assert.equal(contains(12, 152), false, 'foreground interior must hide the old frame');
  assert.equal(contains(12, 312), true, 'uncovered bottom of the old window remains visible');
  assert.equal(contains(284, 152), true, 'uncovered right edge remains visible');
});

test('a smaller nested window may share its SBA with an older window', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(81);
  decodeWdsf(Uint8Array.from(segment(0x51, [0, 0, 0, 5, 20])), screen);
  const oldWindow = screen.enptui.all[0];
  screen.enptui.add({
    kind: 'selectionField', cursorAtStart: 410,
    boundsTopRow: 6, boundsLeftCol: 11, boundsHeight: 1, boundsWidth: 5,
    parent: oldWindow,
  });

  screen.setWriteAddressIndex(81);
  decodeWdsf(Uint8Array.from(segment(0x51, [0, 0, 0, 1, 2])), screen);

  assert.deepEqual(screen.enptui.all.map(construct => construct.kind),
    ['window', 'selectionField', 'window']);
});

test('Remove Window removes one matching same-SBA window at a time', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(81);
  decodeWdsf(Uint8Array.from(segment(0x51, [0x80, 0, 0, 5, 20])), screen);
  decodeWdsf(Uint8Array.from(segment(0x51, [0x80, 0, 0, 1, 2])), screen);
  assert.equal(screen.enptui.all.filter(c => c.kind === 'window').length, 2);

  decodeWdsf(Uint8Array.from(segment(0x59, [0, 0, 0])), screen);
  assert.equal(screen.enptui.all.filter(c => c.kind === 'window').length, 1);
  assert.equal(screen.currentEnptuiWindowAddress, 81);
  decodeWdsf(Uint8Array.from(segment(0x52, [0, 0])), screen);
  assert.equal(screen.enptui.all.find(c => c.kind === 'window').cursorRestricted, false);
});

test('window overlay repeats every host-supplied border glyph in its section', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(81);
  const border = [13, 0x01, 0x80, 0, 0x22,
    0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8];
  decodeWdsf(Uint8Array.from(segment(0x51, [0, 0, 0, 4, 12, ...border])), screen);

  const glyphs = [];
  const ctx = new Proxy({
    save () {}, restore () {}, beginPath () {}, moveTo () {}, lineTo () {}, stroke () {},
    fillRect () {}, fillText (glyph) { glyphs.push(glyph); }, setLineDash () {},
  }, {
    get (target, key) { return key in target ? target[key] : () => {}; },
    set (target, key, value) { target[key] = value; return true; },
  });
  new EnptuiOverlay(screen).paint(ctx, {
    cellWidth: 8, cellHeight: 16, fontSize: 14, cursorBlink: false,
  });

  const count = byte => glyphs.filter(glyph => glyph === screen.ebcdic.toChar(byte)).length;
  assert.deepEqual([0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8].map(count),
    [1, 14, 1, 4, 4, 1, 14, 1]);
});

test('window title without its own attribute inherits the border palette', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.enptui.add({
    kind: 'window', topRow: 2, leftCol: 2, width: 18, height: 6,
    contentWidth: 12, borderAttr: 0x3A, noBorder: false,
    borderOverrides: new Array(8).fill(false), borders: new Uint8Array(8),
    title: { text: 'Title', attr: 0, align: 'center' }, footer: null,
  });
  const texts = [];
  const ctx = new Proxy({
    fillStyle: '', save () {}, restore () {}, beginPath () {}, moveTo () {},
    lineTo () {}, stroke () {}, fillRect () {}, setLineDash () {},
    fillText (glyph) { texts.push([this.fillStyle, glyph]); },
  }, {
    get (target, key) { return key in target ? target[key] : () => {}; },
    set (target, key, value) { target[key] = value; return true; },
  });

  new EnptuiOverlay(screen).paint(ctx, {
    cellWidth: 8, cellHeight: 16, fontSize: 14, cursorBlink: false,
  });

  assert.ok(texts.some(([colour, glyph]) => colour === '#3399ff' && glyph === 'T'));
});

test('menu pull-down reuses a supporting menu separator as its top border', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.enptui.add({
    kind: 'window', menuPullDown: true, topRow: 4, leftCol: 10,
    width: 18, height: 7, borderAttr: 0x22, noBorder: false,
    borderOverrides: new Array(8).fill(false), borders: new Uint8Array(8),
  });
  screen.enptui.add({
    kind: 'menuBar', row: 3, menuRows: 1, items: [{}],
    menuSeparator: { startCol: 1, endCol: 80, suppressAttribute: false,
      flags: 0, attr: 0x22, char: 0x60 },
  });
  const lines = [];
  const ctx = new Proxy({
    save () {}, restore () {}, beginPath () {},
    moveTo () {}, lineTo (...args) { lines.push(args); }, stroke () {},
    fillRect () {}, fillText () {}, setLineDash () {},
  }, {
    get (target, key) { return key in target ? target[key] : () => {}; },
    set (target, key, value) { target[key] = value; return true; },
  });
  new EnptuiOverlay(screen).paint(ctx, {
    cellWidth: 8, cellHeight: 16, fontSize: 14, cursorBlink: false,
  });

  assert.ok(lines.some(([x, y]) => x === 204 && y === 56));
});

test('a custom menu character does not replace a pull-down top border', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.enptui.add({
    kind: 'window', menuPullDown: true, topRow: 4, leftCol: 10,
    width: 18, height: 7, borderAttr: 0x22, noBorder: false,
    borderOverrides: new Array(8).fill(false), borders: new Uint8Array(8),
  });
  screen.enptui.add({
    kind: 'menuBar', row: 3, menuRows: 1, items: [{}],
    menuSeparator: { startCol: 1, endCol: 80, suppressAttribute: false,
      flags: 0x80, attr: 0x22, char: 0x60, customCharacter: true },
  });
  const lines = [];
  const ctx = new Proxy({
    save () {}, restore () {}, beginPath () {}, moveTo () {},
    lineTo (...args) { lines.push(args); }, stroke () {}, fillRect () {},
    fillText () {}, setLineDash () {},
  }, {
    get (target, key) { return key in target ? target[key] : () => {}; },
    set (target, key, value) { target[key] = value; return true; },
  });
  new EnptuiOverlay(screen).paint(ctx, {
    cellWidth: 8, cellHeight: 16, fontSize: 14, cursorBlink: false,
  });

  assert.equal(lines.some(([x, y]) => x === 204 && y === 56), false);
});

test('a retained graphical menu line still supports a pull-down', () => {
  const screen = new ScreenBuffer(24, 80);
  const menu = {
    kind: 'menuBar', row: 3, menuRows: 1, items: [{}], active: false,
    menuSeparator: { startCol: 1, endCol: 80, suppressAttribute: false,
      flags: 0, attr: 0x22, char: 0x4B, customCharacter: false },
  };
  screen.enptui.add(menu);
  screen.enptui.add({
    kind: 'window', menuPullDown: true, topRow: 4, leftCol: 10,
    width: 18, height: 7, borderAttr: 0x22, noBorder: false,
    borderOverrides: new Array(8).fill(false), borders: new Uint8Array(8),
  });
  const lines = [];
  const ctx = new Proxy({
    save () {}, restore () {}, beginPath () {}, rect () {}, clip () {}, moveTo () {},
    lineTo (...args) { lines.push(args); }, stroke () {}, fillRect () {},
    fillText () {}, setLineDash () {},
  }, {
    get (target, key) { return key in target ? target[key] : () => {}; },
    set (target, key, value) { target[key] = value; return true; },
  });
  new EnptuiOverlay(screen).paint(ctx, {
    cellWidth: 8, cellHeight: 16, fontSize: 14, cursorBlink: false,
  });

  assert.ok(lines.some(([x, y]) => x === 204 && y === 56));
});

test('vertical scrollbar paints the boxed terminal shaft in its centre column', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.enptui.add({
    kind: 'scrollBar', direction: 0, rowOffset: 2, colOffset: 10,
    length: 8, sliderCellPos: 2, sliderCellSize: 3,
  });
  const fills = [];
  const strokes = [];
  const ctx = new Proxy({
    save () {}, restore () {}, beginPath () {}, moveTo () {}, lineTo () {}, stroke () {},
    fillRect (...args) { fills.push(args); },
    strokeRect (...args) { strokes.push(args); },
  }, {
    get (target, key) { return key in target ? target[key] : () => {}; },
    set (target, key, value) { target[key] = value; return true; },
  });
  new EnptuiOverlay(screen).paint(ctx, {
    cellWidth: 8, cellHeight: 16, fontSize: 14, cursorBlink: false,
  });

  assert.deepEqual(fills[0], [88, 32, 8, 128]);
  assert.deepEqual(strokes[0], [89.5, 32.5, 5, 127]);
  assert.equal(fills.some(([, , width]) => width > 8), false);
  assert.ok(fills.some(([, , width]) => width === 2));
  assert.equal(fills.some(([, , width]) => width === 24), false);
});

test('grid edges use the display attribute of each presentation cell', () => {
  const screen = new ScreenBuffer(24, 80);
  const gridBuf = new Uint8Array(screen.size);
  gridBuf[81] = 0x04;
  gridBuf[82] = 0x04;
  screen.cells[81].attr = { fg: 'blue', bg: 'black' };
  screen.cells[82].attr = { fg: 'white', bg: 'black' };
  screen.enptui.add({ kind: 'grid', cursorAtStart: 0, gridBuf });
  const strokes = [];
  const ctx = new Proxy({
    strokeStyle: '', save () {}, restore () {}, beginPath () {},
    moveTo () {}, lineTo () {}, stroke () { strokes.push(this.strokeStyle); },
  }, {
    get (target, key) { return key in target ? target[key] : () => {}; },
    set (target, key, value) { target[key] = value; return true; },
  });

  new EnptuiOverlay(screen).paint(ctx, {
    cellWidth: 8, cellHeight: 16, fontSize: 14, cursorBlink: false,
  });

  assert.deepEqual(strokes, ['#3399ff', '#ffffff']);
});

test('a non-display character attribute does not hide its grid edge', () => {
  const screen = new ScreenBuffer(24, 80);
  const gridBuf = new Uint8Array(screen.size);
  gridBuf[81] = 0x04;
  screen.cells[81].attr = { fg: 'blue', bg: 'black', hidden: true };
  screen.enptui.add({ kind: 'grid', cursorAtStart: 0, gridBuf });
  const strokes = [];
  const ctx = new Proxy({
    strokeStyle: '', save () {}, restore () {}, beginPath () {},
    moveTo () {}, lineTo () {}, stroke () { strokes.push(this.strokeStyle); },
  }, {
    get (target, key) { return key in target ? target[key] : () => {}; },
    set (target, key, value) { target[key] = value; return true; },
  });

  new EnptuiOverlay(screen).paint(ctx, {
    cellWidth: 8, cellHeight: 16, fontSize: 14, cursorBlink: false,
  });

  assert.deepEqual(strokes, ['#3399ff']);
});

test('programmable-pointer marker renders at its event cell without other GUI visuals', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.pointerMarker = { row: 3, col: 7 };
  const strokes = [];
  const ctx = new Proxy({
    save () {}, restore () {},
    strokeRect (...args) { strokes.push(args); },
  }, {
    get (target, key) { return key in target ? target[key] : () => {}; },
    set (target, key, value) { target[key] = value; return true; },
  });

  new EnptuiOverlay(screen).paint(ctx, {
    cellWidth: 8, cellHeight: 16, fontSize: 14, cursorBlink: false,
  });

  assert.deepEqual(strokes, [[56.5, 48.5, 15, 15]]);
});

test('push-button focus uses the host cursor palette even without a box', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.cells[163].glyph = 'A';
  screen.cursor = 163;
  screen.enptui.add({
    kind: 'pushButtons',
    items: [{ selected: true, unavailable: false, nonCursorable: false,
      dummy: false, flag2: 0x04, mnemonicOffset: -1 }],
    itemPositions: [{ row: 3, col: 4, textCol: 4, textIdx: 163,
      anchorIdx: 162, textLength: 1, hitCol: 3, hitWidth: 3 }],
    choiceAttrs: [0x29, 0x23, 0x3B, 0x20, 0x22, 0x3A, 0x20, 0x20],
  });
  const fills = [];
  const texts = [];
  let strokes = 0;
  const ctx = new Proxy({
    fillStyle: '',
    save () {}, restore () {},
    fillRect (...args) { fills.push([this.fillStyle, ...args]); },
    fillText (glyph) { texts.push([this.fillStyle, glyph]); },
    stroke () { strokes++; },
  }, {
    get (target, key) { return key in target ? target[key] : () => {}; },
    set (target, key, value) { target[key] = value; return true; },
  });

  new EnptuiOverlay(screen).paint(ctx, {
    cellWidth: 8, cellHeight: 16, fontSize: 14, cursorBlink: false,
  });

  assert.equal(fills[0][0], '#ff4444');
  assert.deepEqual(texts[0], ['#000000', 'A']);
  assert.equal(strokes, 0);
});

test('menu and no-indicator choices still use the host cursor palette', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.cells[163].glyph = 'A';
  screen.cursor = 163;
  screen.enptui.add({
    kind: 'menuBar', drawIndicator: false, row: 3, menuRows: 1,
    items: [{ selected: false, unavailable: false, nonCursorable: false,
      dummy: false, mnemonicOffset: -1 }],
    itemPositions: [{ row: 3, col: 4, textCol: 4, textIdx: 163,
      anchorIdx: 162, textLength: 1, hitCol: 3, hitWidth: 3 }],
    choiceAttrs: [0x29, 0x23, 0x3B, 0x20, 0x22, 0x3A, 0x20, 0x20],
  });
  const fills = [];
  const texts = [];
  const ctx = new Proxy({
    fillStyle: '',
    save () {}, restore () {},
    fillRect (...args) { fills.push([this.fillStyle, ...args]); },
    fillText (glyph) { texts.push([this.fillStyle, glyph]); },
  }, {
    get (target, key) { return key in target ? target[key] : () => {}; },
    set (target, key, value) { target[key] = value; return true; },
  });

  new EnptuiOverlay(screen).paint(ctx, {
    cellWidth: 8, cellHeight: 16, fontSize: 14, cursorBlink: false,
  });

  assert.equal(fills[0][0], '#ff4444');
  assert.deepEqual(texts[0], ['#000000', 'A']);
});

test('an active ENPTUI choice suppresses the ordinary terminal cursor', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.cursor = 163;
  screen.enptui.add({
    kind: 'selectionField',
    items: [{ selected: false, unavailable: false, nonCursorable: false,
      dummy: false, mnemonicOffset: -1 }],
    itemPositions: [{ row: 3, col: 4, textCol: 4, textIdx: 163,
      anchorIdx: 162, textLength: 1, hitCol: 3, hitWidth: 3 }],
    choiceAttrs: [0x29, 0x23, 0x3B, 0x20, 0x22, 0x3A, 0x20, 0x20],
  });

  const fills = [];
  const context = new Proxy({
    fillStyle: '', font: '',
    measureText: () => ({ width: 8 }),
    setTransform () {},
    fillRect (...args) { fills.push([this.fillStyle, ...args]); },
  }, {
    get (target, key) { return key in target ? target[key] : () => {}; },
    set (target, key, value) { target[key] = value; return true; },
  });
  const canvas = {
    width: 0, height: 0,
    getContext: () => context,
    getBoundingClientRect: () => ({ width: 800, height: 480 }),
  };
  const originalSetInterval = globalThis.setInterval;
  const originalRaf = globalThis.requestAnimationFrame;
  globalThis.setInterval = () => 0;
  globalThis.requestAnimationFrame = callback => callback();
  try {
    const renderer = new Renderer(canvas, screen);
    renderer.resize();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.requestAnimationFrame = originalRaf;
  }

  assert.equal(fills.some(([style]) => style === 'rgba(255, 255, 255, 0.55)'), false);
  assert.equal(fills.some(([style]) => style === 'rgba(255, 80, 80, 0.55)'), false);
});

test('selection text is anchored around SBA and NewRow comes from choice flag1', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(162);
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
  screen.cursor = 900;
  screen.setWriteAddressIndex(162);
  const choice = [8, 0x10, 0x40, 0, 0x80, 0xC1, 0xC2, 0xC3];
  const attrs = [13, 0x01, 0x80, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0x2A];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader(), ...choice, ...attrs,
  ])), screen);

  const selection = screen.enptui.all[0];
  assert.equal(screen.cursor, 900);
  assert.equal(selection.cursorAtStart, 162);
  assert.equal(selection.itemPositions[0].anchorIdx, 162);
  assert.equal(screen.cells[160].byte, 0x20); // indicator attribute
  assert.equal(screen.cells[161].byte, 0x61); // selected radio marker
  assert.equal(screen.cells[162].byte, 0x2A); // selected-choice attribute
  assert.equal(screen.cells[162].attributePlace, true);
  assert.equal(screen.cells[163].glyph, 'A');
  assert.equal(screen.cells[166].byte, 0x20); // ending attribute
});

test('selected push buttons keep the available text palette', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(162);
  const selected = [6, 0x10, 0x40, 0, 0x80, 0xC1];
  const attrs = [19, 0x01, 0x80, 0,
    0x21, 0, 0x23, 0, 0x3B, 0, 0x28, 0, 0x2A, 0, 0x3A, 0, 0x20, 0, 0x20];

  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ type: 0x41, gui: 0x60, textSize: 1 }),
    ...selected, ...attrs,
  ])), screen);

  const button = screen.enptui.all[0];
  assert.equal(button.kind, 'pushButtons');
  assert.equal(button.items[0].selected, true);
  assert.equal(screen.cells[button.itemPositions[0].anchorIdx].byte, 0x28);
});

test('selection painting preserves an existing field boundary after choice text', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(162);
  Object.assign(screen.cells[164], {
    byte: 0x2A, glyph: ' ', attributePlace: true, startField: true,
  });
  const choice = [6, 0x10, 0, 0, 0x80, 0xC1];

  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ textSize: 1 }), ...choice,
  ])), screen);

  assert.equal(screen.cells[164].byte, 0x2A);
  assert.equal(screen.cells[164].attributePlace, true);
  assert.equal(screen.cells[164].startField, true);
});

test('selection padding is written between columns but not after the last choice', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(162);
  Object.assign(screen.cells[172], { byte: 0xC9, glyph: 'I' });
  Object.assign(screen.cells[173], { byte: 0xD1, glyph: 'J' });
  const first = [6, 0x10, 0, 0, 0x80, 0xC1];
  const second = [6, 0x10, 0, 0, 0x80, 0xC2];

  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ textSize: 1, cols: 2, nulls: 2 }),
    ...first, ...second,
  ])), screen);

  assert.deepEqual(screen.cells.slice(165, 167).map(cell => cell.byte), [0, 0]);
  assert.deepEqual(screen.cells.slice(172, 174).map(cell => cell.byte), [0xC9, 0xD1]);
});

test('selection hit ranges include indicator attributes and inter-column padding', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(162);
  const first = [6, 0x10, 0, 0, 0x80, 0xC1];
  const second = [6, 0x10, 0, 0, 0x80, 0xC2];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ textSize: 1, cols: 2, nulls: 2 }),
    ...first, ...second,
  ])), screen);

  const selection = screen.enptui.all[0];
  assert.deepEqual(
    selection.itemPositions.map(({ hitCol, hitWidth }) => ({ hitCol, hitWidth })),
    [{ hitCol: 1, hitWidth: 7 }, { hitCol: 8, hitWidth: 5 }],
  );
  screen.cursor = 160;
  assert.equal(screen.enptuiItemAtCursor()?.index, 0);
  screen.cursor = 166;
  assert.equal(screen.enptuiItemAtCursor()?.index, 0);
  screen.cursor = 167;
  assert.equal(screen.enptuiItemAtCursor()?.index, 1);
});

test('redefining a selection field clears the complete old footprint', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(162);
  const wide = [8, 0x10, 0, 0, 0x80, 0xC1, 0xC2, 0xC3];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ textSize: 3 }), ...wide,
  ])), screen);
  assert.equal(screen.cells[165].glyph, 'C');
  assert.equal(screen.cells[166].attributePlace, true);

  const narrow = [6, 0x10, 0, 0, 0x80, 0xC4];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ textSize: 3 }), ...narrow,
  ])), screen);

  assert.equal(screen.enptui.all.length, 1);
  assert.equal(screen.cells[163].glyph, 'D');
  assert.equal(screen.cells[164].attributePlace, true);
  assert.equal(screen.cells[165].byte, 0);
  assert.equal(screen.cells[166].byte, 0);
});

test('removing a GUI selection field preserves its presentation text', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(162);
  const choice = [8, 0x10, 0x40, 0, 0x80, 0xC1, 0xC2, 0xC3];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader(), ...choice,
  ])), screen);

  decodeWdsf(Uint8Array.from(segment(0x58, [0, 0])), screen);

  assert.equal(screen.enptui.all.length, 0);
  assert.deepEqual(screen.cells.slice(163, 166).map(cell => cell.byte),
    [0xC1, 0xC2, 0xC3]);
  assert.equal(screen.cells[162].attributePlace, true);
  assert.equal(screen.cells[166].attributePlace, true);
});

test('REMOVE_ALL_GUI redraw flag preserves materialised Choice Text', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(162);
  const choice = [8, 0x10, 0, 0, 0x80, 0xC1, 0xC2, 0xC3];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader(), ...choice,
  ])), screen);

  decodeWdsf(Uint8Array.from(segment(0x5F, [0, 0x80, 0])), screen);

  assert.equal(screen.enptui.all.length, 0);
  assert.equal(screen.enptui.visuals.length, 1);
  assert.equal(screen.enptui.visuals[0].active, false);
  assert.equal(screen.enptui.visuals[0].basicPresentation, true);
  assert.deepEqual(screen.cells.slice(163, 166).map(cell => cell.byte),
    [0xC1, 0xC2, 0xC3]);
  assert.equal(screen.cells[162].attributePlace, true);
  assert.equal(screen.cells[166].attributePlace, true);
});

test('REMOVE_ALL_GUI without redraw also preserves existing presentation cells', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(162);
  const choice = [8, 0x10, 0, 0, 0x80, 0xC1, 0xC2, 0xC3];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader(), ...choice,
  ])), screen);

  decodeWdsf(Uint8Array.from(segment(0x5F, [0, 0, 0])), screen);

  assert.equal(screen.enptui.all.length, 0);
  assert.equal(screen.enptui.visuals.length, 1);
  assert.equal(screen.enptui.visuals[0].active, false);
  assert.equal(screen.enptui.visuals[0].basicPresentation, undefined);
});

test('menu rows change only on Choice Text NewRow, not numOfCols', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(162);
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
  screen.setWriteAddressIndex(162);
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
    [0x11, 3, 4, 0x00, 0x22]);
});

test('a zero-length Choice Text entry is structural and not cursorable', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(162);
  const emptyChoice = [5, 0x10, 0, 0, 0x80];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader(), ...emptyChoice,
  ])), screen);

  const selection = screen.enptui.all[0];
  assert.equal(selection.items.length, 1);
  assert.equal(selection.items[0].actualLength, 0);
  assert.equal(selection.items[0].nonCursorable, true);
  assert.equal(screen.firstFocusable(), null);
});

test('menu separator and push-button padding follow their IBM minors', () => {
  const menuScreen = new ScreenBuffer(24, 80);
  menuScreen.setWriteAddressIndex(80);
  const choice = [8, 0x10, 0, 0, 0x80, 0xC1, 0xC2, 0xC3];
  const separator = [8, 0x09, 0x80, 2, 20, 0, 0x22, 0x60];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ type: 0x01 }), ...choice, ...separator,
  ])), menuScreen);
  assert.deepEqual(menuScreen.enptui.all[0].menuSeparator, {
    flags: 0x80, startCol: 2, endCol: 20, attr: 0x22, char: 0x60,
    customCharacter: true, suppressAttribute: false,
  });
  const separatorGlyphs = [];
  const ctx = new Proxy({
    save () {}, restore () {}, beginPath () {}, moveTo () {}, lineTo () {}, stroke () {},
    fillRect () {}, fillText (glyph) { separatorGlyphs.push(glyph); },
  }, {
    get (target, key) { return key in target ? target[key] : () => {}; },
    set (target, key, value) { target[key] = value; return true; },
  });
  new EnptuiOverlay(menuScreen).paint(ctx, {
    cellWidth: 8, cellHeight: 16, fontSize: 14, cursorBlink: false,
  });
  const separatorGlyph = menuScreen.ebcdic.toChar(0x60);
  assert.equal(separatorGlyphs.filter(glyph => glyph === separatorGlyph).length, 17);

  menuScreen.enptui.all[0].menuSeparator.suppressAttribute = true;
  separatorGlyphs.length = 0;
  new EnptuiOverlay(menuScreen).paint(ctx, {
    cellWidth: 8, cellHeight: 16, fontSize: 14, cursorBlink: false,
  });
  assert.equal(separatorGlyphs.filter(glyph => glyph === separatorGlyph).length, 19);

  const pushScreen = new ScreenBuffer(24, 80);
  pushScreen.setWriteAddressIndex(80);
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ type: 0x41, gui: 0x10, textSize: 5 }), ...choice,
  ])), pushScreen);
  const push = pushScreen.enptui.all[0];
  assert.deepEqual([...push.items[0].textBytes], [0x40, 0xC1, 0xC2, 0xC3, 0x40]);
  assert.equal(push.itemPositions[0].textLength, 5);
});

test('a live graphical menu separator is rendered as a continuous rule', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(1);
  const file = [8, 0x10, 0, 0, 0xE0, 0xC6, 0x89, 0x93];
  const view = [8, 0x10, 0, 0, 0xE0, 0xE5, 0x89, 0x85];
  const separator = [8, 0x09, 0x80, 1, 80, 0x22, 0x22, 0xBB];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ type: 0x01, cols: 1 }),
    ...file, ...view, ...separator,
  ])), screen);
  const separatorGlyphs = [];
  const lines = [];
  const ctx = new Proxy({
    save () {}, restore () {}, beginPath () {}, moveTo (...point) { lines.push(point); },
    lineTo (...point) { lines.push(point); },
    stroke () {}, fillRect () {}, fillText (glyph) { separatorGlyphs.push(glyph); },
  }, {
    get (target, key) { return key in target ? target[key] : () => {}; },
    set (target, key, value) { target[key] = value; return true; },
  });

  new EnptuiOverlay(screen).paint(ctx, {
    cellWidth: 8, cellHeight: 16, fontSize: 14, cursorBlink: false,
  });

  assert.equal(separatorGlyphs.includes(']'), false);
  assert.equal(separatorGlyphs.includes('|'), false);
  assert.deepEqual(lines.slice(-2), [[8, 24], [632, 24]]);
});

test('deselect-on-unlock clears cursorable ENPTUI choices', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(162);
  const choice = [8, 0x10, 0x40, 0, 0x80, 0xC1, 0xC2, 0xC3];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ flag3: 0x80 }), ...choice,
  ])), screen);
  assert.equal(screen.enptui.all[0].items[0].selected, true);
  screen.unlockKeyboard();
  assert.equal(screen.enptui.all[0].items[0].selected, false);
  assert.equal(screen.cells[162].byte, 0x20);
});

test('attached and standalone scroll bars follow their header offsets', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(162);
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

  // SBA alone is not the construct identity. A smaller, differently
  // shaped field may coexist at the same anchor until the host removes
  // or covers the older field.
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ type: 0x11 }), ...choice,
  ])), screen);
  assert.deepEqual(screen.enptui.all.map(c => c.kind),
    ['selectionField', 'scrollBar', 'selectionField']);

  screen.setWriteAddressIndex(400);
  decodeWdsf(Uint8Array.from(segment(0x53, [0x80, 0, ...total, ...above, 12])), screen);
  const standalone = screen.enptui.all.at(-1);
  assert.equal(standalone.direction, 1);
  assert.equal(standalone.totalRows, 100);
  assert.equal(standalone.sliderPos, 25);
  assert.equal(standalone.length, 12);
  assert.equal(standalone.boundsWidth, 12);
  assert.equal(standalone.boundsHeight, 1);
});

test('an equivalent menu refresh inherits its existing separator', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(80);
  const choice = [8, 0x10, 0, 0, 0x80, 0xC1, 0xC2, 0xC3];
  const separator = [8, 0x09, 0x80, 2, 20, 0, 0x22, 0x60];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ type: 0x01 }), ...choice, ...separator,
  ])), screen);

  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ type: 0x01 }), ...choice,
  ])), screen);

  assert.equal(screen.enptui.all.length, 1);
  assert.deepEqual(screen.enptui.all[0].menuSeparator, {
    flags: 0x80, startCol: 2, endCol: 20, attr: 0x22, char: 0x60,
    customCharacter: true, suppressAttribute: false,
  });
  assert.equal(screen.enptui.all[0].boundsWidth, 19);
});

test('menu separator retains its graphical line when no custom character is supplied', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(80);
  const choice = [8, 0x10, 0, 0, 0x80, 0xC1, 0xC2, 0xC3];
  const separator = [8, 0x09, 0x80, 2, 20, 0, 0x22, 0];

  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ type: 0x01 }), ...choice, ...separator,
  ])), screen);

  assert.equal(screen.enptui.all[0].menuSeparator.customCharacter, false);
  assert.equal(screen.enptui.all[0].menuSeparator.char, 0x4B);
});

test('menu separator accepts a nonzero custom character only when enabled', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(80);
  const choice = [8, 0x10, 0, 0, 0x80, 0xC1, 0xC2, 0xC3];
  const separator = [8, 0x09, 0x00, 2, 20, 0, 0x22, 0x60];

  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ type: 0x01 }), ...choice, ...separator,
  ])), screen);

  assert.equal(screen.enptui.all[0].menuSeparator.customCharacter, false);
  assert.equal(screen.enptui.all[0].menuSeparator.char, 0x4B);
});

test('standalone scroll bars sharing an SBA are replaced only when equivalent', () => {
  const screen = new ScreenBuffer(24, 80);
  const total = [0, 0, 0, 100];
  const above = [0, 0, 0, 25];
  screen.setWriteAddressIndex(400);
  decodeWdsf(Uint8Array.from(segment(0x53, [0, 0, ...total, ...above, 8])), screen);
  decodeWdsf(Uint8Array.from(segment(0x53, [0, 0, ...total, ...above, 6])), screen);
  assert.equal(screen.enptui.all.filter(c => c.kind === 'scrollBar').length, 2);

  decodeWdsf(Uint8Array.from(segment(0x53, [0, 0, ...total, ...above, 6])), screen);
  assert.equal(screen.enptui.all.filter(c => c.kind === 'scrollBar').length, 2);
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

test('programmable mouse definitions accumulate and replace by first event', () => {
  const screen = new ScreenBuffer(24, 80);
  decodeWdsf(Uint8Array.from(segment(0x55, [0, 0, 0, 0x00, 1, 0, 0x31])), screen);
  screen.queuedPointerAid = 0x32;
  decodeWdsf(Uint8Array.from(segment(0x55, [0, 0, 0, 0x00, 4, 0, 0x33])), screen);
  assert.deepEqual(screen.enptui.all[0].definitions.map(d => d.firstEvent), [1, 4]);
  assert.equal(screen.queuedPointerAid, 0x32);

  decodeWdsf(Uint8Array.from(segment(0x55, [0, 0, 0, 0x40, 1, 0, 0x34])), screen);
  assert.deepEqual(screen.enptui.all[0].definitions.map(d => [d.firstEvent, d.aidCode]),
    [[1, 0x34], [4, 0x33]]);
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
  const minor = [10, 5, 0x00, 2, 3, 6, 5, 0, 0, 2];
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
  const horizontal = [10, 0, 0x00, 2, 3, 6, 0, 0, 0, 1];
  decodeWdsf(Uint8Array.from(segment(0x60, [1, 0x80, 0, 0, 0, 0, 0, ...horizontal])), screen);
  const grid = screen.enptui.all[0].gridBuf;
  assert.ok(grid[(2 - 1) * 80 + (3 - 1)] & 0x04);
});

test('a single repeated grid rule accepts a zero unused spacing byte', () => {
  const screen = new ScreenBuffer(24, 80);
  const horizontal = [11, 0, 0x00, 2, 3, 6, 0, 0, 0, 1, 0];
  decodeWdsf(Uint8Array.from(segment(0x60, [
    1, 0x80, 0, 0, 0, 0, 0, ...horizontal,
  ])), screen);
  assert.ok(screen.enptui.all[0].gridBuf[82] & 0x04);
});

test('grid minor clear option removes only the requested edge', () => {
  const screen = new ScreenBuffer(24, 80);
  const setLine = [10, 0, 0x00, 2, 3, 6, 0, 0, 0, 1];
  const clearLine = [10, 0, 0x80, 2, 3, 6, 0, 0, 0, 1];
  decodeWdsf(Uint8Array.from(segment(0x60, [1, 0x80, 0, 0, 0, 0, 0, ...setLine])), screen);
  assert.ok(screen.enptui.all[0].gridBuf[82] & 0x04);
  decodeWdsf(Uint8Array.from(segment(0x60, [1, 0x00, 0, 0, 0, 0, 0, ...clearLine])), screen);
  assert.equal(screen.enptui.all[0].gridBuf[82] & 0x04, 0);
});

test('WRITE_DATA clears stale tail bytes and preserves the field MDT', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.cursor = 160;
  screen.setWriteAddressIndex(160);
  screen.addField({ attr: 0x20, length: 4, ffw0: 0, ffw1: 0, fcws: [] });
  screen.setWriteAddressIndex(161);
  for (let i = 161; i <= 164; i++) {
    screen.cells[i].byte = 0xE7;
    screen.cells[i].glyph = 'X';
  }
  decodeWdsf(Uint8Array.from(segment(0x54, [0x80, 0, 0xC1, 0xC2])), screen);
  assert.deepEqual(screen.cells.slice(161, 165).map(c => c.byte), [0xC1, 0xC2, 0, 0]);
  assert.equal(screen.fields[0].modified, false);
});

test('WRITE_DATA spans and clears a complete continued-field chain', () => {
  const screen = new ScreenBuffer(24, 80);
  const addSegment = (start, kind) => {
    screen.setWriteAddressIndex(start);
    screen.addField({
      attr: 0x20, length: 3, ffw0: 0, ffw1: 0,
      fcws: [[0x86, kind]],
    });
    for (let i = 1; i <= 3; i++) {
      screen.cells[start + i].byte = 0xE7;
      screen.cells[start + i].glyph = 'X';
    }
  };
  addSegment(80, 1);
  addSegment(160, 3);
  addSegment(240, 2);
  screen.fields[1].modified = true;
  screen.setWriteAddressIndex(81);

  decodeWdsf(Uint8Array.from(segment(0x54,
    [0x80, 0, 0xC1, 0xC2, 0xC3, 0xC4, 0xC5])), screen);

  assert.deepEqual([81, 82, 83, 161, 162, 163, 241, 242, 243]
    .map(index => screen.cells[index].byte),
  [0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0, 0, 0, 0]);
  assert.deepEqual(screen.fields.map(field => field.modified), [false, true, false]);
});

test('WRITE_DATA applies word-wrap without changing the field MDT', () => {
  const screen = new ScreenBuffer(3, 10);
  screen.setWriteAddressIndex(0);
  screen.addField({
    attr: 0x20, length: 19, ffw0: 0, ffw1: 0,
    fcws: [[0x86, 0x80]],
  });
  screen.setWriteAddressIndex(1);
  const text = Array.from(screen.ebcdic.encode('ABCD HELL'));

  decodeWdsf(Uint8Array.from(segment(0x54, [0x80, 0, ...text])), screen);

  assert.equal(screen.cells.slice(1, 10).map(cell => cell.glyph).join(''), 'ABCD     ');
  assert.equal(screen.cells.slice(10, 14).map(cell => cell.glyph).join(''), 'HELL');
  assert.equal(screen.fields[0].modified, false);
});

test('CCSID WRITE_DATA writes formatted chains and unformatted screen data', () => {
  const screen = new ScreenBuffer(3, 20);
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0, ffw1: 0,
    fcws: [[0x86, 0x01]] });
  screen.setWriteAddressIndex(10);
  screen.addField({ attr: 0x20, length: 4, ffw0: 0, ffw1: 0,
    fcws: [[0x86, 0x02]] });
  screen.fields[0].modified = true;
  screen.setWriteAddressIndex(1);

  decodeWdsf(Uint8Array.from(segment(0x54,
    [0x40, 0, 0x04, 0xB0, 0x00, 0x41, 0x03, 0xA9, 0x00, 0x42])), screen);
  assert.deepEqual([1, 11, 12].map(index => screen.cells[index].glyph), ['A', 'Ω', 'B']);
  assert.deepEqual(screen.fields.map(field => field.modified), [true, false]);

  screen.setWriteAddressIndex(30);
  decodeWdsf(Uint8Array.from(segment(0x54,
    [0x40, 0, 0x04, 0xB0, 0x00, 0x58, 0x00, 0x59])), screen);
  assert.equal(screen.cells[30].glyph, 'X');
  assert.equal(screen.cells[31].glyph, 'Y');
  assert.equal(screen.writeAddress, 32);
});

test('selected ENPTUI choices are serialized as IBM pseudo-fields', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(162);
  const choice = [8, 0x10, 0x40, 0, 0x80, 0xC1, 0xC2, 0xC3];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ flag1: 0x01 }), ...choice,
  ])), screen);

  screen.cursor = 162;
  const bytes = new OutboundBuilder(screen).buildAidResponse(0xF1);
  assert.deepEqual([...bytes], [3, 3, 0xF1, 0x11, 3, 4, 0x00, 0x20]);
});

test('ordinary and ENPTUI input fields retain their shared definition order', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 1, ffw0: 0, ffw1: 0, fcws: [] });
  screen.fields[0].modified = true;
  screen.cells[1].byte = 0xC1;

  screen.setWriteAddressIndex(20);
  const choice = [8, 0x10, 0x40, 0, 0x80, 0xC2, 0xC3, 0xC4];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ flag1: 0x01 }), ...choice,
  ])), screen);

  screen.setWriteAddressIndex(40);
  screen.addField({ attr: 0x20, length: 1, ffw0: 0, ffw1: 0, fcws: [] });
  screen.fields.find(field => field.start === 40).modified = true;
  screen.cells[41].byte = 0xC5;

  assert.deepEqual([...new OutboundBuilder(screen).buildReadResponse()], [
    0x11, 1, 2, 0xC1,
    0x11, 1, 22, 0x00, 0x20,
    0x11, 1, 42, 0xC5,
  ]);
});

test('menu bars use the IBM two-byte single-choice response', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(162);
  const first = [8, 0x10, 0, 0, 0x80, 0xC1, 0xC2, 0xC3];
  const second = [8, 0x10, 0x40, 0, 0x80, 0xC4, 0xC5, 0xC6];
  decodeWdsf(Uint8Array.from(segment(0x50, [
    ...selectionHeader({ flag1: 0x01, type: 0x01, cols: 2 }), ...first, ...second,
  ])), screen);

  const bytes = new OutboundBuilder(screen).buildReadResponse();
  assert.deepEqual([...bytes], [0x11, 3, 4, 0x00, 0x21]);
});

test('concatenated ENPTUI segments remain independently decoded', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.setWriteAddressIndex(162);
  const choice = [8, 0x10, 0, 0, 0x80, 0xC1, 0xC2, 0xC3];
  decodeWdsf(Uint8Array.from([
    ...segment(0x50, [...selectionHeader(), ...choice]),
    ...segment(0x51, [0, 0, 0, 4, 10]),
  ]), screen);
  assert.deepEqual(screen.enptui.all.map(c => c.kind), ['selectionField', 'window']);
});
