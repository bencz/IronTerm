import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenBuffer } from '../public/tn5250/src/display/ScreenBuffer.js';
import { OutboundBuilder } from '../public/tn5250/src/proto/OutboundBuilder.js';

test('Save/Restore preserves fields, cursor and ENPTUI graph', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.clearUnit();
  screen.setWriteAddressIndex(10);
  screen.addField({ attr: 0x20, length: 4, ffw0: 0, ffw1: 0, fcws: [] });
  const parent = { kind: 'selectionField', cursorAtStart: 10, row: 1, col: 11 };
  screen.enptui.add(parent);
  screen.enptui.add({ kind: 'scrollBar', cursorAtStart: 20, parent });
  screen.currentEnptuiWindowAddress = 321;
  screen.cursor = 123;
  screen.keyboardLocked = false;
  const token = screen.saveScreen();

  screen.clearUnit();
  assert.equal(screen.enptui.all.length, 0);
  assert.equal(screen.restoreScreen(token), true);
  assert.equal(screen.cursor, 123);
  assert.equal(screen.keyboardLocked, false);
  assert.equal(screen.fields.length, 1);
  assert.equal(screen.enptui.all.length, 2);
  assert.equal(screen.enptui.all[1].parent, screen.enptui.all[0]);
  assert.equal(screen.currentEnptuiWindowAddress, 321);
});

test('Save/Restore preserves a queued programmable-mouse AID as a byte', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.queuedPointerAid = 0xF1;
  const token = screen.saveScreen();
  screen.queuedPointerAid = null;
  assert.equal(screen.restoreScreen(token), true);
  assert.equal(screen.queuedPointerAid, 0xF1);
});

test('Save Screen response carries ESC Restore plus an opaque token', () => {
  const screen = new ScreenBuffer(2, 3);
  const token = screen.saveScreen();
  const bytes = new OutboundBuilder(screen).buildSaveScreenResponse(token);
  assert.equal(bytes.length, 10);
  assert.deepEqual(Array.from(bytes.slice(0, 2)), [0x04, 0x12]);
  assert.deepEqual(bytes.slice(2), token);
});

test('saved-screen tokens identify independent snapshots', () => {
  const screen = new ScreenBuffer(2, 3);
  screen.cells[0].byte = 0xC1;
  const first = screen.saveScreen();
  screen.cells[0].byte = 0xC2;
  const second = screen.saveScreen();
  screen.cells[0].byte = 0xC3;

  assert.equal(screen.restoreScreen(first), true);
  assert.equal(screen.cells[0].byte, 0xC1);
  assert.equal(screen.restoreScreen(second), true);
  assert.equal(screen.cells[0].byte, 0xC2);
  assert.equal(screen.restoreScreen(Uint8Array.of(1, 2, 3)), false);
});

test('Save Partial response carries its length and required preamble', () => {
  const screen = new ScreenBuffer(2, 10);
  const token = screen.saveScreen({ row: 1, col: 2, width: 7, depth: 1 });
  const bytes = new OutboundBuilder(screen)
    .buildSaveScreenResponse(token, { partial: true });
  assert.deepEqual(Array.from(bytes.slice(0, 8)),
    [0x04, 0x13, 0, 0, 0x04, 0x13, 0, token.length]);
  assert.deepEqual(bytes.slice(8), token);
});

test('Field Exit right-adjusts, fills and satisfies an FER field', () => {
  const screen = new ScreenBuffer(2, 10);
  screen.keyboardLocked = false;
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 4, ffw0: 0, ffw1: 0x45, fcws: [] });
  screen.cursor = 1;
  screen.typeByte(0xF1);
  screen.typeByte(0xF2);
  assert.match(screen.validateForAid().reason, /Field Exit/);
  assert.equal(screen.fieldExit(), true);
  assert.deepEqual(screen.cells.slice(1, 5).map(c => c.byte), [0xF0, 0xF0, 0xF1, 0xF2]);
  assert.equal(screen.validateForAid(), null);
});

test('Delete, Erase EOF and Insert edit only the active input field', () => {
  const screen = new ScreenBuffer(2, 10);
  screen.keyboardLocked = false;
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 4, ffw0: 0, ffw1: 0, fcws: [] });
  for (let i = 1; i <= 4; i++) {
    screen.cells[i].byte = 0xF0 + i;
    screen.cells[i].glyph = String(i);
  }

  screen.cursor = 2;
  assert.equal(screen.deleteChar(), true);
  assert.deepEqual(screen.cells.slice(1, 5).map(c => c.byte), [0xF1, 0xF3, 0xF4, 0]);
  assert.equal(screen.fields[0].modified, true);

  screen.cursor = 3;
  assert.equal(screen.eraseToEndOfField(), true);
  assert.deepEqual(screen.cells.slice(1, 5).map(c => c.byte), [0xF1, 0xF3, 0, 0]);

  assert.equal(screen.toggleInsertMode(), true);
  screen.cursor = 1;
  assert.equal(screen.typeByte(0xF9), true);
  assert.deepEqual(screen.cells.slice(1, 5).map(c => c.byte), [0xF9, 0xF1, 0xF3, 0]);
});

test('continued fields navigate and edit as one logical input field', () => {
  const screen = new ScreenBuffer(2, 20);
  screen.keyboardLocked = false;
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 3, ffw0: 0, ffw1: 0,
    fcws: [[0x86, 0x01]] });
  screen.setWriteAddressIndex(10);
  screen.addField({ attr: 0x20, length: 3, ffw0: 0, ffw1: 0,
    fcws: [[0x86, 0x02]] });
  screen.setWriteAddressIndex(20);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0, ffw1: 0, fcws: [] });

  assert.equal(screen.firstFocusable(), 1);
  screen.cursor = 1;
  screen.tab();
  assert.equal(screen.cursor, 21, 'Tab skips the trailing physical segment');
  screen.backTab();
  assert.equal(screen.cursor, 1);

  screen.cursor = 3;
  assert.equal(screen.typeByte(0xF3), true);
  assert.equal(screen.cursor, 11, 'typing crosses the inter-segment attribute');

  const positions = [1, 2, 3, 11, 12, 13];
  [0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0].forEach((byte, i) => {
    screen.cells[positions[i]].byte = byte;
    screen.cells[positions[i]].glyph = byte ? String(i + 1) : ' ';
  });
  screen.insertMode = true;
  screen.cursor = 2;
  assert.equal(screen.typeByte(0xF9), true);
  assert.deepEqual(positions.map(pos => screen.cells[pos].byte),
    [0xF1, 0xF9, 0xF2, 0xF3, 0xF4, 0xF5]);

  screen.insertMode = false;
  screen.cursor = 2;
  assert.equal(screen.deleteChar(), true);
  assert.deepEqual(positions.map(pos => screen.cells[pos].byte),
    [0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0]);

  screen.cursor = 11;
  assert.equal(screen.backspace(), true);
  assert.equal(screen.cursor, 3);
  assert.deepEqual(positions.map(pos => screen.cells[pos].byte),
    [0xF1, 0xF2, 0xF4, 0xF5, 0, 0]);

  screen.cursor = 12;
  assert.equal(screen.eraseToEndOfField(), true);
  assert.deepEqual(positions.map(pos => screen.cells[pos].byte),
    [0xF1, 0xF2, 0xF4, 0xF5, 0, 0]);
  assert.ok(screen.fields.slice(0, 2).every(field => field.modified));
});

test('typing outside input and backspacing at field start raise the operator alarm', () => {
  const screen = new ScreenBuffer(2, 10);
  screen.keyboardLocked = false;

  screen.cursor = 5;
  assert.equal(screen.typeByte(0xC1), false);
  assert.equal(screen.alarm, true);

  screen.alarm = false;
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 3, ffw0: 0, ffw1: 0, fcws: [] });
  screen.cursor = 1;
  assert.equal(screen.backspace(), false);
  assert.equal(screen.cursor, 1);
  assert.equal(screen.alarm, true);
});

test('cursor progression counts ENPTUI selection fields in the shared field table', () => {
  const screen = new ScreenBuffer(3, 20);
  screen.keyboardLocked = false;
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0, ffw1: 0,
    fcws: [[0x88, 3]] });
  const source = screen.fields.find(field => field.start === 0);
  screen.setWriteAddressIndex(10);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0, ffw1: 0, fcws: [] });
  const selection = {
    kind: 'selectionField',
    cursorAtStart: 15,
    formatOrder: screen.allocateFormatOrder(),
    fieldAdvance: false,
    items: [{ nonCursorable: false }],
    itemPositions: [{ row: 1, col: 17, textIdx: 16 }],
  };
  screen.enptui.add(selection);

  screen.cursor = source.start + 1;
  screen.tab();
  assert.equal(screen.cursor, 16, 'forward progression targets the ENPTUI pseudo-field');

  screen.backTab();
  assert.equal(screen.cursor, source.start + 1,
    'reverse progression returns to the field that names this target');
});

test('continued fields use one SBA and concatenate every segment in replies', () => {
  const screen = new ScreenBuffer(2, 20);
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 3, ffw0: 0, ffw1: 0,
    fcws: [[0x86, 0x01]] });
  screen.setWriteAddressIndex(10);
  screen.addField({ attr: 0x20, length: 3, ffw0: 0, ffw1: 0,
    fcws: [[0x86, 0x02]] });
  const positions = [1, 2, 3, 11, 12, 13];
  const bytes = [0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6];
  positions.forEach((pos, i) => { screen.cells[pos].byte = bytes[i]; });
  screen.fields[1].modified = true;

  assert.deepEqual(Array.from(new OutboundBuilder(screen).buildReadResponse()),
    [0x11, 1, 2, ...bytes]);
});

test('continued segments inherit input semantics from their first segment', () => {
  const screen = new ScreenBuffer(2, 20);
  screen.keyboardLocked = false;
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 1, ffw0: 0x05, ffw1: 0x80,
    fcws: [[0x86, 0x01]] });
  screen.setWriteAddressIndex(10);
  screen.addField({ attr: 0x20, length: 1, ffw0: 0, ffw1: 0,
    fcws: [[0x86, 0x02]] });

  screen.cursor = 11;
  assert.equal(screen.typeByte(0xC1), false, 'last segment keeps digits-only shift');
  assert.equal(screen.alarm, true);
  screen.alarm = false;
  assert.equal(screen.typeByte(0xF1), true);
  assert.equal(screen.autoEnterRequested, true, 'last segment keeps auto-enter');
});

test('continued fields use first-segment semantics for Home and field clearing', () => {
  const screen = new ScreenBuffer(2, 20);
  screen.keyboardLocked = false;
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0x20, ffw1: 0,
    fcws: [[0x86, 0x01]] });
  screen.setWriteAddressIndex(10);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0, ffw1: 0,
    fcws: [[0x86, 0x02]] });
  screen.setWriteAddressIndex(15);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0, ffw1: 0, fcws: [] });

  screen.homeAddress = 11;
  assert.equal(screen.homePosition(), 16,
    'a later segment inherits the first segment bypass flag');

  for (const pos of [1, 2, 11, 12]) {
    screen.cells[pos].byte = 0xC1;
    screen.cells[pos].glyph = 'A';
  }
  screen.fields[0].modified = true;
  screen.clearNonBypassFields(true);
  assert.deepEqual([1, 2, 11, 12].map(pos => screen.cells[pos].byte),
    [0xC1, 0xC1, 0xC1, 0xC1], 'bypass continued chain is preserved');

  screen.fields[0].bypass = false;
  screen.clearNonBypassFields(true);
  assert.deepEqual([1, 2, 11, 12].map(pos => screen.cells[pos].byte), [0, 0, 0, 0]);
  assert.ok(screen.fields.slice(0, 2).every(field => field.modified));
});

test('word-wrap moves an unsplittable word to the next physical line', () => {
  const screen = new ScreenBuffer(3, 10);
  screen.keyboardLocked = false;
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 19, ffw0: 0, ffw1: 0,
    fcws: [[0x86, 0x80]] });
  const prefix = screen.ebcdic.encode('ABCD HEL');
  prefix.forEach((byte, i) => {
    screen.cells[i + 1].byte = byte;
    screen.cells[i + 1].glyph = screen.ebcdic.toChar(byte);
  });

  screen.cursor = 9;
  assert.equal(screen.typeByte(screen.ebcdic.encode('L')[0]), true);
  assert.equal(screen.cursor, 14, 'cursor follows the wrapped word');
  assert.equal(screen.cells.slice(1, 10).map(cell => cell.glyph).join(''), 'ABCD     ');
  assert.equal(screen.cells.slice(10, 14).map(cell => cell.glyph).join(''), 'HELL');
});

test('signed numeric Field Minus is encoded in the preceding digit', () => {
  const screen = new ScreenBuffer(2, 10);
  screen.keyboardLocked = false;
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 4, ffw0: 0x07, ffw1: 0, fcws: [] });
  screen.cursor = 1;
  screen.typeByte(0xF1);
  screen.typeByte(0xF2);
  assert.equal(screen.cursor, 3, 'the final display cell is reserved for the sign');
  assert.equal(screen.fieldSignExit(true), true);

  const payload = new OutboundBuilder(screen).buildAidResponse(0xF1);
  assert.deepEqual(Array.from(payload.slice(-3)), [0xF1, 0xF2, 0xD0]);
});

test('Field Plus exits ordinary fields and Field Minus zones numeric-only data', () => {
  const screen = new ScreenBuffer(2, 20);
  screen.keyboardLocked = false;
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 5, ffw0: 0, ffw1: 0, fcws: [] });
  screen.setWriteAddressIndex(10);
  screen.addField({ attr: 0x20, length: 4, ffw0: 0x03, ffw1: 0, fcws: [] });
  screen.ebcdic.encode('ABCDE').forEach((byte, i) => {
    screen.cells[i + 1].byte = byte;
    screen.cells[i + 1].glyph = String.fromCharCode(65 + i);
  });

  screen.cursor = 3;
  assert.equal(screen.fieldSignExit(false), true);
  assert.deepEqual(screen.cells.slice(1, 6).map(cell => cell.byte),
    [...screen.ebcdic.encode('AB'), 0, 0, 0]);
  assert.equal(screen.cursor, 11);

  screen.cells[11].byte = 0xF1;
  screen.cells[12].byte = 0xF2;
  screen.cursor = 13;
  assert.equal(screen.fieldSignExit(true), true);
  assert.equal(screen.cells[14].byte, 0xD0,
    'numeric-only sign is zoned in the final field position');
});

test('Field Plus/Minus cannot bypass mandatory entry or negate a continued field', () => {
  const mandatory = new ScreenBuffer(2, 20);
  mandatory.keyboardLocked = false;
  mandatory.setWriteAddressIndex(0);
  mandatory.addField({ attr: 0x20, length: 3, ffw0: 0, ffw1: 0x08, fcws: [] });
  mandatory.cursor = 1;

  assert.equal(mandatory.fieldSignExit(false), false);
  assert.equal(mandatory.fields[0].modified, false,
    'validation happens before erase-to-end can raise MDT');

  const continued = new ScreenBuffer(3, 20);
  continued.keyboardLocked = false;
  continued.setWriteAddressIndex(0);
  continued.addField({ attr: 0x20, length: 3, ffw0: 0x03, ffw1: 0,
    fcws: [[0x86, 0x01]] });
  continued.setWriteAddressIndex(20);
  continued.addField({ attr: 0x20, length: 3, ffw0: 0x03, ffw1: 0,
    fcws: [[0x86, 0x02]] });
  continued.cursor = 1;
  continued.typeByte(0xF1);

  assert.equal(continued.fieldSignExit(true), false);
});

test('Modulus 10 and Modulus 11 FCWs validate their check digits', () => {
  const make = (text, value) => {
    const screen = new ScreenBuffer(2, 20);
    screen.setWriteAddressIndex(0);
    screen.addField({ attr: 0x20, length: text.length, ffw0: 0, ffw1: 0,
      fcws: [[0xB1, value]] });
    screen.ebcdic.encode(text).forEach((byte, i) => {
      screen.cells[i + 1].byte = byte;
      screen.cells[i + 1].glyph = text[i];
    });
    screen.cursor = 1;
    return screen;
  };

  const mod10 = make('79927398713', 0xA0);
  assert.equal(mod10.validateForAid(), null);
  mod10.cells[11].byte = 0xF4;
  assert.match(mod10.validateForAid().reason, /Modulus 10/);

  const mod11 = make('123455', 0x40);
  assert.equal(mod11.validateForAid(), null);
  mod11.cells[6].byte = 0xF6;
  assert.match(mod11.validateForAid().reason, /Modulus 11/);
});

test('typing the last position completes an FER field without leaving it', () => {
  const screen = new ScreenBuffer(2, 20);
  screen.keyboardLocked = false;
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0, ffw1: 0x40, fcws: [] });
  screen.setWriteAddressIndex(10);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0, ffw1: 0, fcws: [] });

  screen.cursor = 1;
  assert.equal(screen.typeByte(0xC1), true);
  assert.equal(screen.typeByte(0xC2), true);
  assert.equal(screen.cursor, 2);
  assert.equal(screen.fields[0].exited, true);
  assert.equal(screen.validateForAid(), null);
  assert.equal(screen.tab(), true);
  assert.equal(screen.cursor, 11);
});

test('operator navigation validates only the field being left', () => {
  const screen = new ScreenBuffer(2, 20);
  screen.keyboardLocked = false;
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 3, ffw0: 0, ffw1: 0x07, fcws: [] });
  screen.setWriteAddressIndex(10);
  screen.addField({ attr: 0x20, length: 3, ffw0: 0, ffw1: 0, fcws: [] });

  screen.cursor = 1;
  assert.equal(screen.typeByte(0xF1), true);
  assert.equal(screen.tab(), false, 'partially filled mandatory-fill field blocks Tab');
  assert.equal(screen.cursor, 1);
  assert.equal(screen.alarm, true);

  screen.cells[1].byte = 0;
  screen.cells[1].glyph = ' ';
  assert.equal(screen.tab(), true, 'an entirely cleared mandatory-fill field may be left');
  assert.equal(screen.cursor, 11);
  assert.equal(screen.validateForAid(), null,
    'an inactive mandatory-fill field does not block an AID elsewhere');
});

test('mandatory-entry checking follows MDT rather than prefilled text', () => {
  const screen = new ScreenBuffer(2, 20);
  screen.keyboardLocked = false;
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0, ffw1: 0x08, fcws: [] });
  screen.setWriteAddressIndex(10);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0, ffw1: 0, fcws: [] });
  screen.cells[1].byte = 0xC1;
  screen.cells[1].glyph = 'A';

  screen.cursor = 11;
  assert.equal(screen.validateForAid(), null,
    'mandatory entry is dormant before the operator changes the screen');
  assert.equal(screen.typeByte(0xC2), true);
  const validation = screen.validateForAid();
  assert.equal(validation.field, screen.fields[0]);
  assert.equal(validation.reason, 'mandatory entry');

  screen.fields[0].modified = true;
  assert.equal(screen.validateForAid(), null);
});

test('host-supplied MDT starts field-exit-required fields completed', () => {
  const screen = new ScreenBuffer(2, 10);
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 3, ffw0: 0x08, ffw1: 0x05, fcws: [] });
  screen.cursor = 1;
  assert.equal(screen.fields[0].modified, true);
  assert.equal(screen.fields[0].exited, true);
  assert.equal(screen.validateForAid(), null);
});

test('highlight FCW metadata is normalized and inherited by continued segments', () => {
  const screen = new ScreenBuffer(2, 20);
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0x06, ffw1: 0,
    fcws: [[0x89, 0x3B], [0x86, 0x01]] });
  screen.setWriteAddressIndex(10);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0, ffw1: 0,
    fcws: [[0x86, 0x02]] });
  assert.equal(screen.logicalField(screen.fieldAt(11)).highlightAttr, 0x3B);
  assert.equal(screen.logicalField(screen.fieldAt(11)).cursorInvisible, true);
});

test('continued fields follow definition order when vertical chains interleave by address', () => {
  const screen = new ScreenBuffer(7, 80);
  const addSegment = (row, col, kind, length) => {
    screen.setWriteAddressIndex((row - 1) * 80 + col - 1);
    screen.addField({ attr: 0x20, length, ffw0: 0x60, ffw1: 0x20,
      fcws: [[0x86, kind]] });
  };

  for (let row = 1; row <= 5; row++)
    addSegment(row, 11, row === 1 ? 1 : row === 5 ? 2 : 3, 40);
  for (let row = 1; row <= 7; row++)
    addSegment(row, 53, row === 1 ? 1 : row === 7 ? 2 : 3, 23);

  const left = screen.fieldAt(11);
  const right = screen.fieldAt(53);
  assert.equal(screen.fieldChain(left).length, 5);
  assert.equal(screen.fieldChain(right).length, 7);
  assert.deepEqual(screen.fieldChain(left).map(field => field.start),
    [10, 90, 170, 250, 330]);
  assert.deepEqual(screen.fieldChain(right).map(field => field.start),
    [52, 132, 212, 292, 372, 452, 532]);
});

test('invalid continued, word-wrap and modulus field combinations are rejected', () => {
  const screen = new ScreenBuffer(4, 20);

  assert.throws(() => screen.addField({
    attr: 0x20, length: 2, ffw0: 0x07, ffw1: 0,
    fcws: [[0x86, 0x01]],
  }), /continued-field/);

  assert.throws(() => screen.addField({
    attr: 0x20, length: 22, ffw0: 0x10, ffw1: 0,
    fcws: [[0x86, 0x80]],
  }), /word-wrap/);

  assert.throws(() => screen.addField({
    attr: 0x20, length: 34, ffw0: 0, ffw1: 0,
    fcws: [[0xB1, 0xA0]],
  }), /33 positions/);
});

test('word-wrap is ignored when the field does not cross a display row', () => {
  const screen = new ScreenBuffer(2, 20);
  screen.addField({ attr: 0x20, length: 5, ffw0: 0, ffw1: 0,
    fcws: [[0x86, 0x80]] });
  assert.equal(screen.fields[0].wordWrap, false);
});

test('DUP fills the logical field remainder and Field Mark advances one position', () => {
  const screen = new ScreenBuffer(2, 20);
  screen.keyboardLocked = false;
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0x10, ffw1: 0,
    fcws: [[0x86, 0x01]] });
  screen.setWriteAddressIndex(10);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0, ffw1: 0,
    fcws: [[0x86, 0x02]] });
  screen.setWriteAddressIndex(15);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0, ffw1: 0, fcws: [] });

  screen.cursor = 2;
  assert.equal(screen.insertDupOrFieldMark(true), true);
  assert.deepEqual([1, 2, 11, 12].map(index => screen.cells[index].byte),
    [0, 0x1C, 0x1C, 0x1C]);
  assert.equal(screen.cursor, 16);
  assert.ok(screen.fields.slice(0, 2).every(field => field.modified && field.exited));

  screen.cursor = 16;
  screen.fields[2].dup = true;
  assert.equal(screen.insertDupOrFieldMark(false), true);
  assert.equal(screen.cells[16].byte, 0x1E);
  assert.equal(screen.cursor, 17);
});

test('DUP with Auto Enter reports the final logical field position', () => {
  const screen = new ScreenBuffer(2, 20);
  screen.keyboardLocked = false;
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0x10, ffw1: 0x80,
    fcws: [[0x86, 0x01]] });
  screen.setWriteAddressIndex(10);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0, ffw1: 0,
    fcws: [[0x86, 0x02]] });
  screen.cursor = 1;

  assert.equal(screen.insertDupOrFieldMark(true), true);
  assert.equal(screen.autoEnterRequested, true);
  assert.equal(screen.cursor, 12);
});

test('operator Reset releases an ordinary inhibit but restores pre-SysReq state', () => {
  const screen = new ScreenBuffer(4, 20);
  screen.keyboardLocked = true;
  screen.insertMode = true;
  screen.alarm = true;
  screen.autoEnterRequested = true;
  screen.pendingPointerAid = { row: 1, col: 2, aid: 3 };
  screen.queuedPointerAid = 0x31;
  screen.pointerMarker = { row: 1, col: 2 };

  screen.resetOperatorState();

  assert.equal(screen.keyboardLocked, false);
  assert.equal(screen.insertMode, false);
  assert.equal(screen.sysreqMode, false);
  assert.equal(screen.alarm, false);
  assert.equal(screen.autoEnterRequested, false);
  assert.equal(screen.pendingPointerAid, null);
  assert.equal(screen.queuedPointerAid, 0x31,
    'a host-requested queued single event remains queued until keyboard unlock');
  assert.equal(screen.pointerMarker, null);

  screen.keyboardLocked = true;
  screen.cells[60].byte = 0xC1;
  assert.equal(screen.beginSystemRequest(), true);
  assert.equal(screen.keyboardLocked, false);
  screen.resetOperatorState();
  assert.equal(screen.keyboardLocked, true,
    'cancelling System Request restores the state saved before it opened');
  assert.equal(screen.cells[60].byte, 0xC1);
});

test('Erase Field, Delete Word and Word Tab operate across logical input data', () => {
  const screen = new ScreenBuffer(2, 20);
  screen.keyboardLocked = false;
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 12, ffw0: 0, ffw1: 0, fcws: [] });
  const encoded = screen.ebcdic.encode('ONE  TWO END');
  encoded.forEach((byte, i) => {
    screen.cells[i + 1].byte = byte;
    screen.cells[i + 1].glyph = screen.ebcdic.toChar(byte);
  });

  screen.cursor = 1;
  assert.equal(screen.wordTab(false), true);
  assert.equal(screen.cursor, 6);
  assert.equal(screen.wordTab(false), true);
  assert.equal(screen.cursor, 10);
  assert.equal(screen.wordTab(true), true);
  assert.equal(screen.cursor, 6);

  assert.equal(screen.deleteWord(), true);
  assert.equal(screen.cells.slice(1, 13).map(cell => cell.glyph).join(''), 'ONE  END    ');
  assert.equal(screen.eraseField(), true);
  assert.deepEqual(screen.cells.slice(1, 13).map(cell => cell.byte), new Array(12).fill(0));
  assert.equal(screen.cursor, 1);
  assert.equal(screen.fields[0].modified, true);
});

test('Word Tab scans protected text across the entire presentation space', () => {
  const screen = new ScreenBuffer(2, 20);
  screen.keyboardLocked = false;
  const put = (start, text) => {
    screen.ebcdic.encode(text).forEach((byte, offset) => {
      const cell = screen.cells[start + offset];
      cell.byte = byte;
      cell.glyph = screen.ebcdic.toChar(byte);
    });
  };
  put(2, 'PROTECTED LABEL');
  screen.setWriteAddressIndex(23);
  screen.addField({ attr: 0x20, length: 8, ffw0: 0, ffw1: 0, fcws: [] });
  put(24, 'INPUT');

  screen.cursor = 0;
  assert.equal(screen.wordTab(false), true);
  assert.equal(screen.cursor, 2);
  assert.equal(screen.wordTab(false), true);
  assert.equal(screen.cursor, 12);
  assert.equal(screen.wordTab(false), true);
  assert.equal(screen.cursor, 24);
  assert.equal(screen.wordTab(false), true);
  assert.equal(screen.cursor, 2, 'forward navigation wraps');
  assert.equal(screen.wordTab(true), true);
  assert.equal(screen.cursor, 24, 'backward navigation wraps');
});

test('tagged-CCSID input enforces its logical character capacity', () => {
  const screen = new ScreenBuffer(2, 20);
  screen.keyboardLocked = false;
  screen.setWriteAddressIndex(0);
  screen.addField({ attr: 0x20, length: 4, ffw0: 0, ffw1: 0,
    fcws: [[0x90, 0x04], [0x91, 0xB0]] });
  screen.setWriteAddressIndex(10);
  screen.addField({ attr: 0x20, length: 2, ffw0: 0, ffw1: 0, fcws: [] });

  screen.cursor = 1;
  assert.equal(screen.typeCharacter('Ω'), true);
  assert.equal(screen.cells[1].glyph, 'Ω');
  assert.equal(screen.cursor, 2);
  assert.equal(screen.typeCharacter('B'), true);
  assert.equal(screen.cursor, 11, 'two UTF-16 bytes represent each logical position');
});
