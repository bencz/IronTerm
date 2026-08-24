import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenBuffer } from '../public/tn5250/src/display/ScreenBuffer.js';
import { InboundParser } from '../public/tn5250/src/proto/InboundParser.js';
import { OutboundBuilder } from '../public/tn5250/src/proto/OutboundBuilder.js';
import { Aid, Cmd, Order } from '../public/tn5250/src/proto/Constants.js';

function parse (parser, ...bytes) {
  parser.process(Uint8Array.from(bytes));
}

test('Clear Unit selects 24x80 and Clear Unit Alternate restores model geometry', () => {
  const screen = new ScreenBuffer(27, 132);
  screen.configureGeometry({ alternateRows: 27, alternateCols: 132 });
  const changes = [];
  const parser = new InboundParser(screen, {
    onGeometryChange: (rows, cols) => changes.push([rows, cols]),
  });

  parse(parser, Order.ESC, Cmd.CLEAR_UNIT);
  assert.deepEqual([screen.rows, screen.cols, screen.size], [24, 80, 1920]);

  parse(parser, Order.ESC, Cmd.CLEAR_UNIT_ALT, 0x00);
  assert.deepEqual([screen.rows, screen.cols, screen.size], [27, 132, 3564]);
  assert.deepEqual(changes, [[24, 80], [27, 132]]);
});

test('WCC1 runs before display orders and WCC2 unlock runs afterward', () => {
  const screen = new ScreenBuffer(2, 10);
  screen.keyboardLocked = false;
  const parser = new InboundParser(screen);
  const original = screen.placeByte.bind(screen);
  let lockedWhileWriting = false;
  screen.placeByte = byte => {
    lockedWhileWriting = screen.keyboardLocked;
    original(byte);
  };

  parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0x20, 0x08,
    Order.SBA, 1, 2, 0xC1, Order.ESC);

  assert.equal(lockedWhileWriting, true);
  assert.equal(screen.keyboardLocked, false);
  assert.equal(screen.cells[1].byte, 0xC1);
  assert.equal(screen.cursor, 0, 'host writes must not move the visible cursor');
});

test('WCC1 clear/reset combinations follow IBM field semantics', () => {
  const screen = new ScreenBuffer(2, 10);
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 3, ffw0: 0x08, ffw1: 0, fcws: [] });
  screen.cells[1].byte = 0xC1;
  screen.cells[2].byte = 0xC2;
  const parser = new InboundParser(screen);

  parse(parser, Order.ESC, Cmd.WRITE_TO_DISPLAY, 0x80, 0x00, Order.ESC);
  assert.deepEqual(screen.cells.slice(1, 4).map(cell => cell.byte), [0, 0, 0]);
  assert.equal(screen.fields[0].modified, true, 'clear-modified raises MDT');

  parse(parser, Order.ESC, Cmd.WRITE_TO_DISPLAY, 0x40, 0x00, Order.ESC);
  assert.equal(screen.fields[0].modified, false, 'reset-non-bypass clears MDT');
});

test('SOH replaces the format table and marks PF short-read responses', () => {
  const screen = new ScreenBuffer(2, 10);
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0, ffw1: 0, fcws: [] });
  const parser = new InboundParser(screen);

  parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0, 0,
    Order.SOH, 7, 0x10, 0, 3, 2, 0x80, 0, 0x01,
    Order.ESC);

  assert.equal(screen.fields.length, 0);
  assert.equal(screen.soh.cursorMoveToInput, true);
  assert.equal(screen.soh.errRow, 2);
  assert.equal(screen.isSohShortReadPf(24), true);
  assert.equal(screen.isSohShortReadPf(1), true);
  assert.equal(screen.isSohShortReadPf(2), false);
});

test('SBA row 1 column 0 creates a virtual field attribute before cell zero', () => {
  const screen = new ScreenBuffer(2, 10);
  const parser = new InboundParser(screen);

  parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0, 0,
    Order.SBA, 1, 0,
    Order.SF, 0x24, 0, 2,
    0xF1, 0xF2,
    Order.ESC);

  assert.equal(screen.fields.length, 1);
  assert.equal(screen.fields[0].start, -1);
  assert.equal(screen.fields[0].bypass, false, 'an omitted FFW must not inherit attribute flags');
  assert.deepEqual(screen.cells.slice(0, 2).map(cell => cell.byte), [0xF1, 0xF2]);
  assert.equal(screen.cells[0].attr.underline, true);
});

test('RA and EA include the target address and reject backwards ranges', () => {
  const screen = new ScreenBuffer(2, 5);
  screen.setWriteAddress(1, 2);
  screen.repeatToAddress(1, 4, 0xF1);
  assert.deepEqual(screen.cells.slice(1, 4).map(cell => cell.byte), [0xF1, 0xF1, 0xF1]);
  assert.equal(screen.writeAddress, 4);
  assert.throws(() => screen.repeatToAddress(1, 3, 0xF2), /precedes/);

  screen.setWriteAddress(2, 1);
  screen.cells[5].byte = 0xC1;
  screen.cells[6].byte = 0xC2;
  screen.eraseToAddress(2, 2, [0x00]);
  assert.deepEqual(screen.cells.slice(5, 7).map(cell => cell.byte), [0, 0]);
  assert.equal(screen.writeAddress, 7);
});

test('read command variants retain their distinct response modes', () => {
  const screen = new ScreenBuffer(2, 10);
  const immediate = new InboundParser(screen);
  parse(immediate, Order.ESC, Cmd.READ_IMMEDIATE);
  assert.equal(immediate.readImmediateRequested, true);
  assert.equal(immediate.readType, Cmd.READ_IMMEDIATE);

  const alternate = new InboundParser(screen);
  parse(alternate, Order.ESC, Cmd.READ_MDT_ALT, 0x00, 0x08);
  assert.equal(alternate.readPending, true);
  assert.equal(alternate.readType, Cmd.READ_MDT_ALT);
  assert.equal(alternate.lastReadCc1, 0x08);
});

test('SOH PF bits produce a short response instead of disabling the key', () => {
  const screen = new ScreenBuffer(2, 10);
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0x08, ffw1: 0, fcws: [] });
  screen.cells[1].byte = 0xC1;
  const builder = new OutboundBuilder(screen);

  const normal = builder.buildAidResponse(Aid.PF1);
  const short = builder.buildAidResponse(Aid.PF1, { shortRead: true });
  assert.ok(normal.length > 3);
  assert.equal(short.length, 3);
  assert.equal(short[2], Aid.PF1);
});

test('commands require ESC and WTD leaves a chained ESC for the next command', () => {
  const screen = new ScreenBuffer(2, 10);
  const parser = new InboundParser(screen);
  assert.throws(() => parse(parser, Cmd.CLEAR_UNIT), /expected command ESC/);

  parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0, 0,
    Order.SBA, 1, 2, 0xC1,
    Order.ESC, Cmd.CLEAR_FORMAT_TABLE);
  assert.equal(screen.cells[1].byte, 0xC1);
});

test('IC defines Home without enabling insert and WCC2 controls cursor movement', () => {
  const screen = new ScreenBuffer(2, 10);
  screen.cursor = 9;
  const parser = new InboundParser(screen);
  parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0, 0,
    Order.IC, 1, 3);
  assert.equal(screen.homeAddress, 2);
  assert.equal(screen.pendingCursor, 2);
  assert.equal(screen.insertMode, false);

  screen.pendingCursor = -1;
  parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0, 0x40,
    Order.IC, 1, 5);
  assert.equal(screen.pendingCursor, -1, 'retain-cursor suppresses IC movement');

  parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0, 0x40,
    Order.MC, 2, 4);
  assert.equal(screen.pendingCursor, 13, 'MC still moves when retain-cursor is set');
});

test('modified fields trim trailing nulls and transparent fields retain raw data', () => {
  const screen = new ScreenBuffer(2, 10);
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 4, ffw0: 0x08, ffw1: 0,
    fcws: [[0x84, 0x00]] });
  screen.cells[1].byte = 0xC1;
  const transparent = new OutboundBuilder(screen).buildReadResponse();
  assert.deepEqual(Array.from(transparent), [0x11, 1, 2, 0x10, 0, 4, 0xC1, 0, 0, 0]);

  screen.fields[0].transparent = false;
  const ordinary = new OutboundBuilder(screen).buildReadResponse();
  assert.deepEqual(Array.from(ordinary), [0x11, 1, 2, 0xC1]);
});

test('SOH and FCW resequence fields in outbound responses', () => {
  const screen = new ScreenBuffer(2, 10);
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 1, ffw0: 0x08, ffw1: 0,
    fcws: [[0x80, 0xFF]] });
  screen.cells[1].byte = 0xC1;
  screen.setWriteAddressIndex(4);
  screen.addField({ attr: 0x20, length: 1, ffw0: 0x08, ffw1: 0,
    fcws: [[0x80, 0x01]] });
  screen.cells[5].byte = 0xC2;
  screen.startOfHeader({ resequence: 2 });

  const bytes = new OutboundBuilder(screen).buildReadResponse();
  assert.deepEqual(Array.from(bytes), [0x11, 1, 6, 0xC2, 0x11, 1, 2, 0xC1]);
});

test('extended read screen trims rows and uses IAC row delimiters', () => {
  const screen = new ScreenBuffer(2, 4);
  screen.cells[0].byte = 0xC1;
  screen.cells[5].byte = 0xC2;
  const bytes = new OutboundBuilder(screen).buildReadScreenWithExtendedAttributes();
  assert.deepEqual(Array.from(bytes), [0xC1, 0xFF, 0, 0xC2, 0xFF]);
});

test('Save/Restore Partial preserves only the requested rectangle', () => {
  const screen = new ScreenBuffer(4, 12);
  const parser = new InboundParser(screen);
  screen.cells[0].byte = 0xC1;
  screen.cells[14].byte = 0xC2; // row 2, column 3

  parse(parser,
    Order.ESC, Cmd.SAVE_PARTIAL_SCREEN,
    2, 3, 0, 2, 1);            // 2 rows, width = 1 + 6
  const request = parser.saveScreenRequested;
  assert.equal(request.partial, true);

  screen.cells[0].byte = 0xD1;  // outside the saved rectangle
  screen.cells[14].byte = 0xD2; // inside the saved rectangle
  parse(parser,
    Order.ESC, Cmd.RESTORE_PARTIAL_SCREEN,
    0, request.token.length, ...request.token);

  assert.equal(screen.cells[0].byte, 0xD1);
  assert.equal(screen.cells[14].byte, 0xC2);
});
