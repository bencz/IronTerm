import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenBuffer } from '../public/tn5250/src/display/ScreenBuffer.js';
import { OutboundBuilder } from '../public/tn5250/src/proto/OutboundBuilder.js';

test('Save/Restore preserves fields, cursor and ENPTUI graph', () => {
  const screen = new ScreenBuffer(24, 80);
  screen.clearUnit();
  screen.cursor = 10;
  screen.addField({ attr: 0x20, length: 4, ffw0: 0, ffw1: 0, fcws: [] });
  const parent = { kind: 'selectionField', cursorAtStart: 10, row: 1, col: 11 };
  screen.enptui.add(parent);
  screen.enptui.add({ kind: 'scrollBar', cursorAtStart: 20, parent });
  screen.cursor = 123;
  screen.keyboardLocked = false;
  screen.saveScreen();

  screen.clearUnit();
  assert.equal(screen.enptui.all.length, 0);
  assert.equal(screen.restoreScreen(), true);
  assert.equal(screen.cursor, 123);
  assert.equal(screen.keyboardLocked, false);
  assert.equal(screen.fields.length, 1);
  assert.equal(screen.enptui.all.length, 2);
  assert.equal(screen.enptui.all[1].parent, screen.enptui.all[0]);
});

test('Save Screen response carries ESC Restore plus a complete image', () => {
  const screen = new ScreenBuffer(2, 3);
  screen.cells[1].byte = 0xC1;
  const bytes = new OutboundBuilder(screen).buildSaveScreenResponse();
  assert.equal(bytes.length, 8);
  assert.deepEqual(Array.from(bytes.slice(0, 3)), [0x04, 0x12, 0x40]);
  assert.equal(bytes[3], 0xC1);
});

test('Field Exit right-adjusts, fills and satisfies an FER field', () => {
  const screen = new ScreenBuffer(2, 10);
  screen.keyboardLocked = false;
  screen.cursor = 0;
  screen.addField({ attr: 0x20, length: 4, ffw0: 0, ffw1: 0x45, fcws: [] });
  screen.cursor = 1;
  screen.typeByte(0xF1);
  screen.typeByte(0xF2);
  assert.match(screen.validateForAid().reason, /Field Exit/);
  assert.equal(screen.fieldExit(), true);
  assert.deepEqual(screen.cells.slice(1, 5).map(c => c.byte), [0xF0, 0xF0, 0xF1, 0xF2]);
  assert.equal(screen.validateForAid(), null);
});
