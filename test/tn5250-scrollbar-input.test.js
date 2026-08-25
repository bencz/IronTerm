import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenBuffer } from '../public/tn5250/src/display/ScreenBuffer.js';
import { InputController } from '../public/tn5250/src/ui/InputController.js';
import { Aid } from '../public/tn5250/src/proto/Constants.js';
import { scrollBarMetrics } from '../public/tn5250/src/proto/enptui/primitives/ScrollBar.js';

function createHarness ({ rowsAbove = 25, direction = 0, length = 8 } = {}) {
  const documentListeners = {};
  const canvasListeners = {};
  const previousDocument = globalThis.document;
  globalThis.document = {
    activeElement: null,
    addEventListener: (name, callback) => { documentListeners[name] = callback; },
  };
  const canvas = {
    addEventListener: (name, callback) => { canvasListeners[name] = callback; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 480 }),
  };
  const screen = new ScreenBuffer(24, 80);
  screen.keyboardLocked = false;
  const vertical = direction === 0;
  const metrics = scrollBarMetrics(length, 100, rowsAbove, vertical);
  const scrollBar = {
    kind: 'scrollBar', direction, rowOffset: 2, colOffset: 10,
    length, totalRows: 100, visibleRows: vertical ? length : length - 2,
    sliderPos: rowsAbove,
    ...metrics, modified: false, scrollIncrement: 0,
  };
  screen.enptui.add(scrollBar);
  const aids = [];
  const moves = [];
  let draws = 0;
  new InputController({
    canvas, screen,
    renderer: { draw: () => { draws++; }, setSelection () {} },
    onAid: aid => aids.push(aid),
    onMoveCursor: addr => {
      const moved = screen.moveCursorTo(addr);
      if (moved) moves.push(addr);
      return moved;
    },
  });
  return {
    screen, scrollBar, aids, moves, canvasListeners, documentListeners,
    draws: () => draws,
    restore: () => { globalThis.document = previousDocument; },
  };
}

function mouseEvent (col, row) {
  return {
    button: 0, shiftKey: false,
    clientX: col * 10 + 5,
    clientY: row * 20 + 10,
    preventDefault () {},
  };
}

test('vertical ENPTUI scrollbar thumb drag sends the computed scroll increment', () => {
  const h = createHarness();
  try {
    // Centre column is zero-based 11; the initial thumb begins on row 4.
    h.canvasListeners.mousedown(mouseEvent(11, 4));
    h.canvasListeners.mousemove(mouseEvent(11, 6));
    h.documentListeners.mouseup(mouseEvent(11, 6));

    assert.equal(h.scrollBar.sliderCellPos, 4);
    assert.equal(h.scrollBar.scrollIncrement, 41);
    assert.equal(h.scrollBar.modified, true);
    assert.deepEqual(h.aids, [Aid.ROLL_UP]);
    assert.ok(h.draws() > 0);
  } finally {
    h.restore();
  }
});

test('scrollbar arrow at the dataset boundary does not send a redundant AID', () => {
  const h = createHarness({ rowsAbove: 0 });
  try {
    h.canvasListeners.mousedown(mouseEvent(11, 2));
    h.documentListeners.mouseup(mouseEvent(11, 2));
    assert.deepEqual(h.aids, []);
    assert.equal(h.scrollBar.modified, false);
  } finally {
    h.restore();
  }
});

test('a field-departure error vetoes a scrollbar click', () => {
  const h = createHarness();
  try {
    h.screen.setWriteAddressIndex(0);
    h.screen.addField({ attr: 0x20, length: 3, ffw0: 0, ffw1: 0x07, fcws: [] });
    h.screen.cursor = 1;
    h.screen.typeByte(0xC1);

    h.canvasListeners.mousedown(mouseEvent(11, 2));
    h.documentListeners.mouseup(mouseEvent(11, 2));

    assert.deepEqual(h.aids, []);
    assert.equal(h.scrollBar.modified, false);
    assert.equal(h.screen.cursor, 1);
    assert.equal(h.screen.alarm, true);
  } finally {
    h.restore();
  }
});

test('a field-departure error cancels a scrollbar thumb drag', () => {
  const h = createHarness();
  try {
    h.screen.setWriteAddressIndex(0);
    h.screen.addField({ attr: 0x20, length: 3, ffw0: 0, ffw1: 0x07, fcws: [] });
    h.screen.cursor = 1;
    h.screen.typeByte(0xC1);
    const originalPosition = h.scrollBar.sliderCellPos;

    h.canvasListeners.mousedown(mouseEvent(11, 4));
    h.canvasListeners.mousemove(mouseEvent(11, 6));
    h.documentListeners.mouseup(mouseEvent(11, 6));

    assert.equal(h.scrollBar.sliderCellPos, originalPosition);
    assert.equal(h.scrollBar.modified, false);
    assert.deepEqual(h.aids, []);
    assert.equal(h.screen.cursor, 1);
    assert.equal(h.screen.alarm, true);
  } finally {
    h.restore();
  }
});

test('scrollbar move-cursor flag places the cursor on clicks and the dragged thumb', () => {
  const h = createHarness();
  h.scrollBar.moveCursor = true;
  try {
    h.canvasListeners.mousedown(mouseEvent(11, 2));
    h.documentListeners.mouseup(mouseEvent(11, 2));
    assert.equal(h.moves.at(-1), 2 * h.screen.cols + 11);

    h.canvasListeners.mousedown(mouseEvent(11, 4));
    h.canvasListeners.mousemove(mouseEvent(11, 6));
    h.documentListeners.mouseup(mouseEvent(11, 6));
    assert.equal(h.moves.at(-1),
      (h.scrollBar.rowOffset + h.scrollBar.sliderCellPos) * h.screen.cols
        + h.scrollBar.colOffset + 1);
  } finally {
    h.restore();
  }
});

test('horizontal scrollbar thumb cannot enter the trailing attribute cell', () => {
  const h = createHarness({ direction: 1, length: 10 });
  try {
    // The initial horizontal thumb is at zero-based column 13.
    h.canvasListeners.mousedown(mouseEvent(13, 2));
    h.canvasListeners.mousemove(mouseEvent(50, 2));
    h.documentListeners.mouseup(mouseEvent(50, 2));

    assert.equal(h.scrollBar.sliderCellPos, 6);
    assert.equal(h.scrollBar.scrollIncrement, 65);
    assert.deepEqual(h.aids, [Aid.ROLL_RIGHT]);
  } finally {
    h.restore();
  }
});

test('horizontal scrollbar includes the leading slider cell in its drag zone', () => {
  const h = createHarness({ direction: 1, length: 10 });
  try {
    // The horizontal hit zone begins one cell before the painted shaft.
    // Pressing and releasing it without movement is a thumb operation,
    // not a page-left request.
    h.canvasListeners.mousedown(mouseEvent(12, 2));
    h.documentListeners.mouseup(mouseEvent(12, 2));

    assert.deepEqual(h.aids, []);
    assert.equal(h.scrollBar.modified, false);
  } finally {
    h.restore();
  }
});

test('horizontal scrollbar converts the pointer column to protocol slider position', () => {
  const h = createHarness({ direction: 1, length: 10 });
  try {
    h.canvasListeners.mousedown(mouseEvent(13, 2));
    h.canvasListeners.mousemove(mouseEvent(14, 2));
    h.documentListeners.mouseup(mouseEvent(14, 2));

    assert.equal(h.scrollBar.sliderCellPos, 5);
    assert.equal(h.scrollBar.scrollIncrement, 58);
    assert.deepEqual(h.aids, [Aid.ROLL_RIGHT]);
  } finally {
    h.restore();
  }
});

test('a dragged thumb whose scaled offset is unchanged sends a page increment', () => {
  const h = createHarness({ rowsAbove: 50, length: 8 });
  try {
    // At this scale, moving the thumb from cell 4 to cell 3 still maps to
    // dataset offset 50. ENPTUI represents that operator action as one page.
    h.canvasListeners.mousedown(mouseEvent(11, 6));
    h.canvasListeners.mousemove(mouseEvent(11, 5));
    h.documentListeners.mouseup(mouseEvent(11, 5));

    assert.equal(h.scrollBar.sliderCellPos, 3);
    assert.equal(h.scrollBar.scrollIncrement, 8);
    assert.equal(h.scrollBar.modified, true);
    assert.deepEqual(h.aids, [Aid.ROLL_DOWN]);
  } finally {
    h.restore();
  }
});
