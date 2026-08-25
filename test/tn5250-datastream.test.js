import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenBuffer } from '../public/tn5250/src/display/ScreenBuffer.js';
import { InboundParser } from '../public/tn5250/src/proto/InboundParser.js';
import { OutboundBuilder } from '../public/tn5250/src/proto/OutboundBuilder.js';
import { Aid, Cmd, Order, ATTR_BASE } from '../public/tn5250/src/proto/Constants.js';

function parse (parser, ...bytes) {
  parser.process(Uint8Array.from(bytes));
}

test('5250 alternate colour attributes retain blink and column-separator bits', () => {
  assert.deepEqual(
    [0x2A, 0x2B, 0x2E].map(byte => ATTR_BASE[byte].blink),
    [true, true, true]);
  assert.deepEqual(
    [0x34, 0x35, 0x36, 0x37].map(byte => ATTR_BASE[byte].colSep),
    [true, true, true, true]);
});

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

test('Clear Unit leaves a null presentation space without a synthetic attribute byte', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.cells[0].byte = 0xC1;
  screen.cells[0].attributePlace = true;
  screen.clearUnit();

  assert.equal(screen.cells[0].byte, 0x00);
  assert.equal(screen.cells[0].attributePlace, false);
  assert.equal(new OutboundBuilder(screen).buildReadScreenResponse()[0], 0x00);
  assert.equal(screen.cells[0].attr.fg, 'green');
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

test('each ordinary WTD restarts at presentation-space address zero', () => {
  const screen = new ScreenBuffer(2, 10);
  const parser = new InboundParser(screen);

  parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0x00, 0x00,
    Order.SBA, 2, 5, 0xC1, Order.ESC);
  assert.equal(screen.cells[14].byte, 0xC1);
  assert.equal(screen.writeAddress, 15);

  parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0x00, 0x00,
    0xC2, Order.ESC);

  assert.equal(screen.cells[0].byte, 0xC2);
  assert.equal(screen.cells[15].byte, 0x00,
    'the second WTD must not continue after the previous record');
});

test('redundant WCC2 unlock retains the operator cursor on an unlocked workstation', () => {
  const screen = new ScreenBuffer(2, 10);
  const parser = new InboundParser(screen);
  screen.keyboardLocked = false;
  screen.cursor = 9;
  screen.homeAddress = 2;

  parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0x00, 0x08,
    Order.IC, 1, 3,
    Order.ESC);

  assert.equal(screen.keyboardLocked, false);
  assert.equal(screen.cursor, 9);
  assert.equal(screen.pendingCursor, -1,
    'an unlock without a CC0 state change implies retain-cursor');
});

test('WCC2 unlock may position the cursor after CC0 explicitly locks the keyboard', () => {
  const screen = new ScreenBuffer(2, 10);
  const parser = new InboundParser(screen);
  screen.keyboardLocked = false;
  screen.cursor = 9;

  parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0x20, 0x08,
    Order.IC, 1, 3,
    Order.ESC);

  assert.equal(screen.keyboardLocked, false);
  assert.equal(screen.pendingCursor, 2,
    'a real lock-to-unlock transition applies the host insert cursor');
});

test('a later WTD cannot replace the cursor decision of an unlock already pending', () => {
  const screen = new ScreenBuffer(2, 10);
  const parser = new InboundParser(screen);
  screen.keyboardLocked = false;

  parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0x20, 0x08,
    Order.IC, 1, 3,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0x00, 0x08,
    Order.IC, 2, 5,
    Order.ESC);

  assert.equal(screen.keyboardLocked, false);
  assert.equal(screen.pendingCursor, 2,
    'the second redundant unlock retains the cursor selected by the first WTD');
});

test('WCC cursor refresh preserves the focused item within one ENPTUI selection field', () => {
  const screen = new ScreenBuffer(2, 10);
  const parser = new InboundParser(screen);
  const construct = {
    kind: 'selectionField', cursorAtStart: 0,
    items: [{}, {}],
    itemPositions: [
      { row: 1, col: 3, textIdx: 2, hitCol: 3, hitWidth: 1 },
      { row: 1, col: 5, textIdx: 4, hitCol: 5, hitWidth: 1 },
    ],
  };
  screen.enptui.add(construct);
  screen.cursor = 2;

  parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0x20, 0x00,
    Order.IC, 1, 5,
    Order.ESC);

  assert.equal(screen.pendingCursor, 2);
});

test('WCC2 does not unlock the keyboard while an error message owns input', () => {
  const screen = new ScreenBuffer(2, 10);
  const parser = new InboundParser(screen);
  screen.keyboardLocked = true;
  screen.errorMode = true;

  parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0x20, 0x08,
    Order.ESC);

  assert.equal(screen.keyboardLocked, true);
});

test('WCC2 unlock does not deselect an ENPTUI field created in the same record', () => {
  const screen = new ScreenBuffer(4, 20);
  screen.keyboardLocked = true;
  const parser = new InboundParser(screen);
  const selectionPayload = [
    0, 0, 0x80, 0x11, 0, 0, 0, 0, 0,
    3, 1, 1, 0, 0, 0, 0,
    8, 0x10, 0x40, 0, 0x80, 0xC1, 0xC2, 0xC3,
  ];
  const segmentLength = 4 + selectionPayload.length;

  parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0, 0x08,
    Order.SBA, 1, 3,
    Order.WTDSF, segmentLength >> 8, segmentLength & 0xFF,
    0xD9, 0x50, ...selectionPayload,
    Order.ESC);

  assert.equal(screen.keyboardLocked, false);
  assert.equal(parser.createdEnptuiThisRecord, true);
  assert.equal(screen.enptui.all[0].items[0].selected, true);

  parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0x20, 0x08,
    Order.ESC);
  assert.equal(parser.createdEnptuiThisRecord, false);
  assert.equal(screen.enptui.all[0].items[0].selected, false);
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

test('WEC writes to the SOH message row and Reset restores the saved line', () => {
  const screen = new ScreenBuffer(3, 6);
  const parser = new InboundParser(screen);
  screen.cells[6].byte = 0xC1;
  screen.cells[7].byte = 0xC2;
  screen.startOfHeader({ errRow: 2 });
  parser.readPending = true;
  parser.invited = true;
  parser.readType = Cmd.READ_INPUT_FIELDS;
  screen.cursor = 3;
  screen.keyboardLocked = true;
  screen.insertMode = true;

  parse(parser,
    Order.ESC, Cmd.WRITE_ERROR_CODE,
    0x22, 0xC5, 0xD9, 0xD9, Order.ESC);

  assert.equal(screen.errorMode, true);
  assert.equal(screen.keyboardLocked, false);
  assert.equal(parser.readPending, false);
  assert.deepEqual(screen.cells.slice(6, 10).map(cell => cell.byte),
    [0x22, 0xC5, 0xD9, 0xD9]);

  parser.clearErrorMode();
  assert.equal(screen.errorMode, false);
  assert.equal(screen.cursor, 3);
  assert.equal(screen.keyboardLocked, false,
    'leaving the temporary error line keeps correction input enabled');
  assert.equal(screen.insertMode, false);
  assert.equal(parser.readPending, true);
  assert.deepEqual(screen.cells.slice(6, 8).map(cell => cell.byte), [0xC1, 0xC2]);
});

test('WECW confines the temporary message to its requested columns', () => {
  const screen = new ScreenBuffer(3, 8);
  const parser = new InboundParser(screen);
  screen.startOfHeader({ errRow: 2 });
  screen.cells[8].byte = 0xC1;
  screen.cells[14].byte = 0xC2;
  screen.cells[18].byte = 0xC3;

  parse(parser,
    Order.ESC, Cmd.WRITE_ERROR_CODE_TO_WINDOW,
    3, 5, 0xC5, 0xD9, 0xD9,
    Order.ESC, Cmd.CLEAR_FORMAT_TABLE);

  assert.deepEqual(screen.cells.slice(10, 13).map(cell => cell.byte),
    [0xC5, 0xD9, 0xD9]);
  assert.equal(screen.cells[8].byte, 0xC1);
  assert.equal(screen.cells[14].byte, 0xC2);
  assert.equal(screen.errorMode, true);

  parser.clearErrorMode();
  assert.equal(screen.cells[8].byte, 0xC1);
  assert.equal(screen.cells[14].byte, 0xC2);
  assert.equal(screen.cells[18].byte, 0xC3,
    'restoring a windowed error must not overwrite the following row');
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

test('Clear Format Table inactivates GUI fields while SOH preserves its enclosing window', () => {
  const screen = new ScreenBuffer(24, 80);
  const parser = new InboundParser(screen);
  const window = { kind: 'window', cursorAtStart: 0 };
  screen.enptui.add(window);
  screen.enptui.add({ kind: 'selectionField', cursorAtStart: 20, items: [] });
  screen.enptui.add({ kind: 'grid', cursorAtStart: -1, gridBuf: new Uint8Array(screen.size) });
  screen.enptui.add({ kind: 'mouseEvents', cursorAtStart: -1, definitions: [] });

  parse(parser, Order.ESC, Cmd.CLEAR_FORMAT_TABLE);
  assert.deepEqual(screen.enptui.all.map(construct => construct.kind), ['grid', 'mouseEvents']);
  assert.equal(window.active, false);

  const nextWindow = { kind: 'window', cursorAtStart: 0 };
  screen.enptui.add(nextWindow);
  screen.enptui.add({ kind: 'selectionField', cursorAtStart: 20, items: [] });
  parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0, 0,
    Order.SOH, 1, 0,
    Order.ESC);
  assert.deepEqual(screen.enptui.all.map(construct => construct.kind),
    ['grid', 'mouseEvents', 'window']);
  assert.equal(nextWindow.active, true);
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

test('Start Field accepts only FCW identifiers at or above 0x80', () => {
  const screen = new ScreenBuffer(2, 10);
  const parser = new InboundParser(screen);

  assert.throws(() => parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0, 0,
    Order.SF, 0x40, 0x00, 0x41, 0x00, 0x24, 0, 2,
    Order.ESC), error => {
    assert.equal(error.senseCode, 0x1005012B);
    return /invalid Start Field attribute/.test(error.message);
  });

  assert.throws(() => parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0, 0,
    Order.SF, 0x41, 0, 2,
    Order.ESC), error => {
    assert.equal(error.senseCode, 0x1005012B);
    return /invalid Start Field attribute/.test(error.message);
  });
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

test('RA overwrites retained attribute places without deleting the format table', () => {
  const screen = new ScreenBuffer(2, 5);
  screen.setWriteAddressIndex(0);
  screen.addField({
    attr: 0x24,
    length: 2,
    ffw0: 0x08,
    ffw1: 0,
    fcws: [],
  });
  const field = screen.fields[0];
  screen.setWriteAddress(1, 1);
  screen.repeatToAddress(1, 2, 0xC1);

  assert.deepEqual(screen.cells.slice(0, 2).map(cell => cell.byte), [0xC1, 0xC1]);
  assert.deepEqual(screen.cells.slice(0, 2).map(cell => cell.attributePlace), [false, false]);
  assert.equal(screen.cells[0].startField, false);
  assert.equal(screen.fields[0], field, 'RA must not remove the independent field definition');
});

test('RA attribute fill clears extended attributes and preserves a real SF anchor', () => {
  const screen = new ScreenBuffer(2, 5);
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0, ffw1: 0, fcws: [] });
  screen.cells[1].extAttr = { type: 1, value: 2 };
  screen.extendedAttr = { type: 1, value: 2 };
  screen.setWriteAddress(1, 1);
  screen.repeatToAddress(1, 2, 0x22);

  assert.deepEqual(screen.cells.slice(0, 2).map(cell => cell.byte), [0x22, 0x22]);
  assert.deepEqual(screen.cells.slice(0, 2).map(cell => cell.attributePlace), [true, true]);
  assert.equal(screen.cells[0].startField, true);
  assert.equal(screen.cells[1].startField, false);
  assert.deepEqual(screen.cells.slice(0, 2).map(cell => cell.extAttr), [null, null]);
  assert.equal(screen.extendedAttr, null);
});

test('EA accepts SBCS display planes and rejects deferred NLS planes', () => {
  const screen = new ScreenBuffer(2, 5);
  const parser = new InboundParser(screen);
  screen.cells[0].byte = 0xC1;
  screen.cells[1].byte = 0xC2;

  parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0, 0,
    Order.SBA, 1, 1,
    Order.EA, 1, 2, 2, 0xFF,
    Order.ESC);
  assert.deepEqual(screen.cells.slice(0, 2).map(cell => cell.byte), [0, 0]);

  assert.throws(() => parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0, 0,
    Order.SBA, 1, 1,
    Order.EA, 1, 2, 2, 0x05,
    Order.ESC), /unsupported EA attribute plane/);
});

test('WEA is rejected while the terminal is operating as SBCS', () => {
  const parser = new InboundParser(new ScreenBuffer(2, 5));
  assert.throws(() => parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0, 0,
    Order.WEA, 0x05, 0x81,
    Order.ESC), /WEA .* unavailable in an SBCS session/);
});

test('ROLL shifts rows without rotating discarded content', () => {
  const screen = new ScreenBuffer(5, 2);
  const parser = new InboundParser(screen);
  for (let row = 0; row < screen.rows; row++) {
    screen.cells[row * 2].byte = 0xC1 + row;
    screen.cells[row * 2 + 1].byte = 0xF1 + row;
  }

  parse(parser, Order.ESC, Cmd.ROLL, 0x01, 2, 4);
  assert.deepEqual([0, 1, 2, 3, 4].map(row => screen.cells[row * 2].byte),
    [0xC1, 0xC3, 0xC4, 0xC4, 0xC5]);

  parse(parser, Order.ESC, Cmd.ROLL, 0x81, 2, 4);
  assert.deepEqual([0, 1, 2, 3, 4].map(row => screen.cells[row * 2].byte),
    [0xC1, 0xC3, 0xC3, 0xC4, 0xC5]);
});

test('ROLL rejects invalid regions and distances', () => {
  const parser = new InboundParser(new ScreenBuffer(5, 2));
  assert.throws(() => parse(parser, Order.ESC, Cmd.ROLL, 0x04, 2, 4), /invalid ROLL/);
  assert.throws(() => parse(parser, Order.ESC, Cmd.ROLL, 0x01, 0, 4), /invalid ROLL/);
});

test('a later WTD data byte overwrites an existing attribute place', () => {
  const screen = new ScreenBuffer(2, 5);
  const parser = new InboundParser(screen);

  parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0, 0,
    Order.SBA, 2, 4, 0x20,
    Order.SBA, 2, 3, 0x22, 0x40, 0x20,
    Order.ESC);

  assert.equal(screen.cells[7].attributePlace, true);
  assert.equal(screen.cells[8].byte, 0x40);
  assert.equal(screen.cells[8].attributePlace, false);
  assert.equal(screen.cells[9].attributePlace, true);
  assert.equal(screen.writeAddress, screen.size);
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

test('WSF Query Station State uses type 0x72 and validates its flags', () => {
  const screen = new ScreenBuffer(2, 10);
  const parser = new InboundParser(screen);
  parse(parser, Order.ESC, Cmd.WRITE_STRUCTURED_FIELD,
    0, 6, 0xD9, 0x72, 0x40, 0x00);
  assert.deepEqual(parser.queryStationStateRequested, { extended: true });

  const invalid = new InboundParser(new ScreenBuffer(2, 10));
  assert.throws(() => parse(invalid, Order.ESC, Cmd.WRITE_STRUCTURED_FIELD,
    0, 6, 0xD9, 0x72, 0x80, 0x00), /flags/);
});

test('WSF Query requires its defined zero parameter', () => {
  const parser = new InboundParser(new ScreenBuffer(2, 10));
  parse(parser, Order.ESC, Cmd.WRITE_STRUCTURED_FIELD,
    0, 5, 0xD9, 0x70, 0x00);
  assert.equal(parser.queryRequested, true);

  const invalid = new InboundParser(new ScreenBuffer(2, 10));
  assert.throws(() => parse(invalid, Order.ESC, Cmd.WRITE_STRUCTURED_FIELD,
    0, 5, 0xD9, 0x70, 0x01), /Query request/);
});

test('WSF ends at its declared length, resumes command parsing and cancels a pending read', () => {
  const screen = new ScreenBuffer(2, 10);
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0, ffw1: 0, fcws: [] });
  const parser = new InboundParser(screen);
  parser.readPending = true;
  parser.invited = true;

  parse(parser,
    Order.ESC, Cmd.WRITE_STRUCTURED_FIELD, 0, 5, 0xD9, 0x70, 0,
    Order.ESC, Cmd.CLEAR_FORMAT_TABLE);

  assert.equal(parser.queryRequested, true);
  assert.equal(parser.readPending, false);
  assert.equal(parser.invited, false);
  assert.equal(screen.fields.length, 0);
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

test('True Transparency Write consumes its length-delimited metadata block', () => {
  const screen = new ScreenBuffer(2, 10);
  const parser = new InboundParser(screen);
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 1, ffw0: 0x08, ffw1: 0 });

  parse(parser,
    Order.ESC, Cmd.TRUE_TRANSPARENCY_WRITE,
    0x00, 0x09, 0xD9, 0x71, 0x00, 0x00, 0x03, 0x01, 0x06,
    Order.ESC, Cmd.CLEAR_FORMAT_TABLE);

  assert.equal(screen.fields.length, 0, 'the command following the block stays aligned');
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

test('Read Immediate serializes input fields sequentially without SBA orders', () => {
  const screen = new ScreenBuffer(2, 10);
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0x08, ffw1: 0, fcws: [] });
  screen.cells[1].byte = 0xC1;
  screen.cells[2].byte = 0xC2;

  const bytes = new OutboundBuilder(screen).buildReadResponse({
    aid: 0,
    includeAll: true,
    sequential: true,
  });

  assert.deepEqual(Array.from(bytes), [1, 1, 0, 0xC1, 0xC2]);
  assert.equal(bytes.includes(Order.SBA), false);
});

test('sequential reads do not prefix transparent or Unicode fields with TD', () => {
  const screen = new ScreenBuffer(2, 20);
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0x08, ffw1: 0,
    fcws: [[0x84, 0x01]] });
  screen.cells[1].byte = 0xC1;
  screen.cells[2].byte = 0x00;
  screen.setWriteAddressIndex(5);
  screen.addField({ attr: 0x20, length: 4, ffw0: 0x08, ffw1: 0,
    fcws: [[0x90, 0x04], [0x91, 0xB0]] });
  screen.cells[6].byte = 0xC2;
  screen.cells[6].glyph = 'Ω';
  screen.cells[7].byte = 0xC3;
  screen.cells[7].glyph = 'B';

  const bytes = new OutboundBuilder(screen).buildReadResponse({
    includeAll: true,
    aid: 0,
    sequential: true,
  });
  assert.deepEqual(Array.from(bytes), [
    1, 1, 0,
    0xC1, 0x00,
    0x03, 0xA9, 0x00, 0x42,
  ]);
});

test('tagged-CCSID fields return UTF-16BE data and honor maximum return length', () => {
  const screen = new ScreenBuffer(2, 20);
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 8, ffw0: 0x08, ffw1: 0,
    fcws: [[0x90, 0x04], [0x91, 0xB0], [0x92, 0x00], [0x93, 0x06]] });
  screen.cells[1].byte = 0xC1;
  screen.cells[1].glyph = 'A';
  screen.cells[2].byte = 0x6F;
  screen.cells[2].glyph = 'Ω';

  const modified = new OutboundBuilder(screen).buildReadResponse();
  assert.deepEqual(Array.from(modified), [
    0x11, 1, 2, 0x10, 0, 4, 0x00, 0x41, 0x03, 0xA9,
  ]);

  const all = new OutboundBuilder(screen).buildReadResponse({ includeAll: true });
  assert.deepEqual(Array.from(all), [
    0x11, 1, 2, 0x10, 0, 6, 0x00, 0x41, 0x03, 0xA9, 0x00, 0x20,
  ]);
});

test('transparent tagged-CCSID fields preserve UTF-16 null code units', () => {
  const screen = new ScreenBuffer(2, 20);
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 4, ffw0: 0x08, ffw1: 0,
    fcws: [[0x84, 0], [0x90, 0x04], [0x91, 0xB0]] });
  screen.cells[1].byte = 0xC1;
  screen.cells[1].glyph = 'A';

  const bytes = new OutboundBuilder(screen).buildReadResponse();
  assert.deepEqual(Array.from(bytes), [
    0x11, 1, 2, 0x10, 0, 4, 0x00, 0x41, 0x00, 0x00,
  ]);
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

test('grid-line screen reads packetize horizontal and vertical rules with text rows', () => {
  const screen = new ScreenBuffer(2, 4);
  screen.cells[0].byte = 0xC1;
  screen.cells[4].byte = 0xC2;
  const gridBuf = new Uint8Array(screen.size);
  gridBuf[0] = 0x04;
  gridBuf[1] = 0x04;
  gridBuf[3] = 0x02;
  screen.enptui.add({ kind: 'grid', cursorAtStart: 0, gridBuf });

  const bytes = new OutboundBuilder(screen).buildReadScreenWithGridLines();
  assert.deepEqual(Array.from(bytes), [
    0, 0, 0, 0, 0,
    0, 0, 15, 0, 15,
    0x2B, 0xFD, 6, 0, 0, 0x80, 1, 3,
    0x2B, 0xFD, 5, 0, 0, 0x40, 4,
    1, 0, 4, 0, 0, 0xC1, 0, 0, 0,
    2, 0, 4, 0, 0, 0xC2, 0, 0, 0,
  ]);
});

test('extended grid-line reads trim text rows and delimit every packet', () => {
  const screen = new ScreenBuffer(2, 4);
  screen.cells[0].byte = 0xC1;
  screen.cells[4].byte = 0xC2;
  const gridBuf = new Uint8Array(screen.size);
  gridBuf[0] = 0x04;
  screen.enptui.add({ kind: 'grid', cursorAtStart: 0, gridBuf });

  const bytes = new OutboundBuilder(screen)
    .buildReadScreenWithGridLines({ extended: true });
  assert.deepEqual(Array.from(bytes), [
    0, 0, 0, 0, 0,
    0, 0, 9, 0, 8,
    0x2B, 0xFD, 6, 0, 0, 0x80, 1, 2,
    0xFF,
    1, 0, 2, 0, 0, 0xC1, 0xFF,
    2, 0, 2, 0, 0, 0xC2, 0xFF,
  ]);
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

test('Save Partial captures WCC2 unlock and restores pending-read state', () => {
  const screen = new ScreenBuffer(4, 12);
  const parser = new InboundParser(screen);
  parser.readPending = true;
  parser.invited = true;
  parser.readType = Cmd.READ_INPUT_FIELDS;
  screen.keyboardLocked = true;

  parse(parser,
    Order.ESC, Cmd.WRITE_TO_DISPLAY, 0, 0x08,
    Order.ESC, Cmd.SAVE_PARTIAL_SCREEN,
    2, 3, 0, 1, 1);
  const token = parser.saveScreenRequested.token;
  assert.equal(screen.keyboardLocked, false,
    'the preceding WCC2 must run before the partial snapshot');

  parser.readPending = false;
  parser.invited = false;
  parser.readType = 0;
  screen.keyboardLocked = true;
  assert.equal(parser.restoreScreen(token), true);
  assert.equal(screen.keyboardLocked, false);
  assert.equal(parser.readPending, true);
  assert.equal(parser.invited, true);
  assert.equal(parser.readType, Cmd.READ_INPUT_FIELDS);
});
