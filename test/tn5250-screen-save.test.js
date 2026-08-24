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
