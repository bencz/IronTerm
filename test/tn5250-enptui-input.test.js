import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenBuffer } from '../public/tn5250/src/display/ScreenBuffer.js';
import { InputController } from '../public/tn5250/src/ui/InputController.js';
import { Aid } from '../public/tn5250/src/proto/Constants.js';
import { ConstructKind } from '../public/tn5250/src/proto/enptui/Constants.js';

const CHOICE_ATTRS = [0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20];

function choice (selected = false, aidCode = 0) {
  return {
    selected, aidCode, unavailable: false, nonCursorable: false,
    dummy: false, flag2: 0,
  };
}

function selection ({
  kind = ConstructKind.SELECTION_FIELD,
  positions = [{ row: 3, col: 5, textCol: 6, textIdx: 165, anchorIdx: 164,
    indicatorIdx: 164, hitWidth: 8 }],
  selected = [true],
  cursorExitable = true,
  autoEnterOnDeselect = false,
  aidCode = Aid.PF5,
} = {}) {
  return {
    kind,
    cursorAtStart: positions[0].anchorIdx,
    items: positions.map((_, i) => choice(selected[i] ?? false, aidCode)),
    itemPositions: positions,
    choiceAttrs: CHOICE_ATTRS.slice(),
    cursorExitable,
    autoEnterOnDeselect,
    drawIndicator: true,
    single: true,
    modified: false,
  };
}

function createHarness (constructs = []) {
  const listeners = {};
  const canvasListeners = {};
  const previousDocument = globalThis.document;
  globalThis.document = {
    activeElement: null,
    addEventListener: (name, callback) => { listeners[name] = callback; },
  };
  const canvas = {
    addEventListener: (name, callback) => { canvasListeners[name] = callback; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 480 }),
  };
  const screen = new ScreenBuffer(24, 80);
  screen.keyboardLocked = false;
  for (const construct of constructs) {
    screen.enptui.add(construct);
    if (construct.kind === ConstructKind.WINDOW)
      screen.currentEnptuiWindowAddress = construct.cursorAtStart;
  }
  const aids = [];
  const moves = [];
  let deletes = 0;
  let backspaces = 0;
  let eraseInputs = 0;
  let fieldExits = 0;
  let fieldPluses = 0;
  let fieldMinuses = 0;
  let newlines = 0;
  let deleteWords = 0;
  let eraseFields = 0;
  let wordTabs = 0;
  let wordBacktabs = 0;
  let dups = 0;
  let fieldMarks = 0;
  let draws = 0;
  const flashes = [];
  new InputController({
    canvas,
    screen,
    renderer: { draw: () => { draws++; }, setSelection () {} },
    onAid: aid => aids.push(aid),
    onMoveCursor: addr => {
      const moved = screen.moveCursorTo(addr);
      if (moved) moves.push(addr);
      return moved;
    },
    onDelete: () => { deletes++; },
    onBackspace: () => { backspaces++; },
    onEraseInput: () => { eraseInputs++; },
    onTab: () => { screen.tab(); },
    onBackTab: () => { screen.backTab(); },
    onFieldExit: () => { fieldExits++; },
    onFieldPlus: () => { fieldPluses++; },
    onFieldMinus: () => { fieldMinuses++; },
    onNewline: () => { newlines++; screen.newLine(); },
    onDeleteWord: () => { deleteWords++; },
    onEraseField: () => { eraseFields++; },
    onWordTab: backwards => { if (backwards) wordBacktabs++; else wordTabs++; },
    onDup: () => { dups++; },
    onFieldMark: () => { fieldMarks++; },
    onFlash: message => flashes.push(message),
  });
  const keydown = (key, overrides = {}) => listeners.keydown({
    key, code: key, ctrlKey: false, metaKey: false, altKey: false,
    shiftKey: false, preventDefault () {}, ...overrides,
  });
  const click = (row, col) => {
    const event = {
      button: 0, clientX: col * 10 + 5, clientY: row * 20 + 10,
      shiftKey: false, preventDefault () {},
    };
    canvasListeners.mousedown(event);
    listeners.mouseup(event);
  };
  const doubleClick = (row, col) => canvasListeners.dblclick({
    button: 0, clientX: col * 10 + 5, clientY: row * 20 + 10,
    shiftKey: false, preventDefault () {},
  });
  const mousePhase = (phase, row, col, overrides = {}) => {
    const event = {
      button: 0, clientX: col * 10 + 5, clientY: row * 20 + 10,
      shiftKey: false, preventDefault () {}, ...overrides,
    };
    if (phase === 'down') canvasListeners.mousedown(event);
    else if (phase === 'up') listeners.mouseup(event);
    else if (phase === 'double') canvasListeners.dblclick(event);
  };
  return {
    screen, aids, moves, flashes, keydown, click, doubleClick, mousePhase,
    counts: () => ({ deletes, backspaces, eraseInputs, fieldExits,
      fieldPluses, fieldMinuses, newlines, deleteWords, eraseFields,
      wordTabs, wordBacktabs, dups, fieldMarks, draws }),
    restore: () => { globalThis.document = previousDocument; },
  };
}

test('Delete deselects an ENPTUI choice and honors auto-enter on deselect', () => {
  const construct = selection({ autoEnterOnDeselect: true });
  const h = createHarness([construct]);
  try {
    h.screen.cursor = construct.itemPositions[0].textIdx;
    h.keydown('Delete');
    assert.equal(construct.items[0].selected, false);
    assert.equal(construct.modified, true);
    assert.deepEqual(h.aids, [Aid.PF5]);
    assert.equal(h.counts().deletes, 0);
    assert.ok(h.counts().draws > 0);
  } finally {
    h.restore();
  }
});

test('Space deselection submits only when auto-enter-on-deselect is enabled', () => {
  const construct = selection({ selected: [true] });
  construct.autoEnter = true;
  construct.autoEnterOnSelect = true;
  construct.autoEnterOnDeselect = false;
  const h = createHarness([construct]);
  try {
    h.screen.cursor = construct.itemPositions[0].textIdx;
    h.keydown(' ');
    assert.equal(construct.items[0].selected, false);
    assert.equal(construct.modified, true);
    assert.deepEqual(h.aids, []);

    construct.items[0].selected = true;
    construct.autoEnterOnDeselect = true;
    h.keydown(' ');
    assert.equal(construct.items[0].selected, false);
    assert.deepEqual(h.aids, [Aid.PF5]);
  } finally {
    h.restore();
  }
});

test('unavailable single choice clears its selected peer before rejecting Space', () => {
  const construct = selection({
    positions: [
      { row: 3, col: 5, textCol: 6, textIdx: 165, anchorIdx: 164,
        indicatorIdx: 163, hitWidth: 8 },
      { row: 4, col: 5, textCol: 6, textIdx: 245, anchorIdx: 244,
        indicatorIdx: 243, hitWidth: 8 },
    ],
    selected: [true, false],
  });
  construct.items[1].unavailable = true;
  const h = createHarness([construct]);
  try {
    h.screen.cursor = construct.itemPositions[1].textIdx;
    h.keydown(' ');

    assert.deepEqual(construct.items.map(item => item.selected), [false, false]);
    assert.equal(construct.modified, false);
    assert.equal(h.flashes.at(-1), 'choice unavailable');
  } finally {
    h.restore();
  }
});

test('unavailable push button clears its peer for Select but not for Space', () => {
  const construct = selection({
    kind: ConstructKind.PUSH_BUTTONS,
    positions: [
      { row: 3, col: 5, textCol: 5, textIdx: 164, anchorIdx: 163,
        indicatorIdx: -1, hitWidth: 8 },
      { row: 3, col: 13, textCol: 13, textIdx: 172, anchorIdx: 171,
        indicatorIdx: -1, hitWidth: 8 },
    ],
    selected: [true, false],
  });
  construct.drawIndicator = false;
  construct.items[1].unavailable = true;
  const h = createHarness([construct]);
  try {
    h.screen.cursor = construct.itemPositions[1].textIdx;
    h.keydown(' ');
    assert.deepEqual(construct.items.map(item => item.selected), [true, false]);

    h.keydown('/');
    assert.deepEqual(construct.items.map(item => item.selected), [false, false]);
    assert.equal(construct.modified, false);
  } finally {
    h.restore();
  }
});

test('ordinary mouse click moves the cursor without an ENPTUI navigation key', () => {
  const h = createHarness();
  try {
    assert.doesNotThrow(() => h.click(4, 12));
    assert.equal(h.moves.at(-1), 4 * 80 + 12);
  } finally {
    h.restore();
  }
});

test('adjacent choice hit ranges do not overlap at their boundary', () => {
  const construct = selection({
    positions: [
      { row: 3, col: 5, hitCol: 4, hitWidth: 3, textCol: 5,
        textIdx: 164, anchorIdx: 163 },
      { row: 3, col: 8, hitCol: 7, hitWidth: 3, textCol: 8,
        textIdx: 167, anchorIdx: 166 },
    ],
    selected: [false, false],
  });
  const h = createHarness([construct]);
  try {
    h.click(2, 6); // one-based row 3, column 7: start of the second choice
    assert.deepEqual(construct.items.map(item => item.selected), [false, true]);
  } finally {
    h.restore();
  }
});

test('overlapping ENPTUI choices hit the visually topmost construct', () => {
  const lower = selection({ selected: [false], aidCode: Aid.PF4 });
  const upper = selection({ selected: [false], aidCode: Aid.PF5 });
  const h = createHarness([lower, upper]);
  try {
    h.click(2, 4);
    assert.equal(lower.items[0].selected, false);
    assert.equal(upper.items[0].selected, true);
  } finally {
    h.restore();
  }
});

test('a newer window blocks pointer activation of an older covered choice', () => {
  const lower = selection({ selected: [false] });
  const window = {
    kind: ConstructKind.WINDOW,
    cursorAtStart: 500,
    cursorRestricted: false,
    topRow: 2,
    leftCol: 3,
    height: 4,
    width: 12,
  };
  const h = createHarness([lower, window]);
  try {
    h.click(2, 4);
    assert.equal(lower.items[0].selected, false);
    assert.equal(h.moves.at(-1), 2 * 80 + 4);
  } finally {
    h.restore();
  }
});

test('a field-departure error vetoes pointer activation of a choice', () => {
  const construct = selection({ selected: [false] });
  const h = createHarness([construct]);
  try {
    h.screen.setWriteAddressIndex(0);
    h.screen.addField({ attr: 0x20, length: 3, ffw0: 0, ffw1: 0x07, fcws: [] });
    h.screen.cursor = 1;
    h.screen.typeByte(0xC1);
    assert.equal(h.screen.fields[0].modified, true);

    h.click(2, 4);

    assert.equal(construct.items[0].selected, false);
    assert.equal(h.screen.cursor, 1);
    assert.equal(h.screen.alarm, true);
  } finally {
    h.restore();
  }
});

test('clicking outside a focused pull-down sends its cancel AID', () => {
  const pullDown = selection({ selected: [false] });
  pullDown.subType = 0x31;
  pullDown.cancelAID = Aid.PF3;
  const h = createHarness([pullDown]);
  try {
    h.screen.cursor = pullDown.itemPositions[0].textIdx;
    h.click(10, 20);
    assert.deepEqual(h.aids, [Aid.PF3]);
    assert.equal(h.moves.length, 0);
  } finally {
    h.restore();
  }
});

test('arrow navigation does not send a pull-down cancel AID', () => {
  const pullDown = selection({ selected: [false] });
  pullDown.subType = 0x31;
  pullDown.cancelAID = Aid.PF3;
  const h = createHarness([pullDown]);
  try {
    h.screen.cursor = pullDown.itemPositions[0].textIdx;
    h.keydown('ArrowUp');
    assert.deepEqual(h.aids, []);
  } finally {
    h.restore();
  }
});

test('clicking a pointer-device entry field moves there and sends its AID', () => {
  const h = createHarness();
  try {
    h.screen.setWriteAddressIndex(5 * 80 + 10);
    h.screen.addField({
      attr: 0x20, length: 8, ffw0: 0, ffw1: 0,
      fcws: [[0x8A, Aid.PF4]],
    });
    h.click(5, 13);
    assert.equal(h.moves.at(-1), 5 * 80 + 13);
    assert.deepEqual(h.aids, [Aid.PF4]);
  } finally {
    h.restore();
  }
});

test('continued entry segments inherit the first segment pointer AID', () => {
  const h = createHarness();
  try {
    h.screen.setWriteAddressIndex(5 * 80 + 10);
    h.screen.addField({
      attr: 0x20, length: 3, ffw0: 0, ffw1: 0,
      fcws: [[0x86, 0x01], [0x8A, Aid.PF4]],
    });
    h.screen.setWriteAddressIndex(5 * 80 + 30);
    h.screen.addField({
      attr: 0x20, length: 3, ffw0: 0, ffw1: 0,
      fcws: [[0x86, 0x02]],
    });
    h.click(5, 32);
    assert.equal(h.moves.at(-1), 5 * 80 + 32);
    assert.deepEqual(h.aids, [Aid.PF4]);
  } finally {
    h.restore();
  }
});

test('programmable single click waits for and is cancelled by double click', () => {
  const mouseEvents = {
    kind: ConstructKind.MOUSE_EVENTS,
    cursorAtStart: -1,
    definitions: [
      { flags: 0, firstEvent: 1, secondEvent: 0, aidCode: Aid.PF1 },
      { flags: 0, firstEvent: 3, secondEvent: 0, aidCode: Aid.PF2 },
    ],
  };
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  const scheduled = new Set();
  globalThis.setTimeout = callback => { scheduled.add(callback); return callback; };
  globalThis.clearTimeout = callback => { scheduled.delete(callback); };
  const h = createHarness([mouseEvents]);
  try {
    h.click(8, 20);
    assert.deepEqual(h.aids, []);
    assert.equal(scheduled.size, 1);

    h.doubleClick(8, 20);
    assert.deepEqual(h.aids, [Aid.PF2]);
    assert.equal(scheduled.size, 0);
  } finally {
    h.restore();
    globalThis.setTimeout = previousSetTimeout;
    globalThis.clearTimeout = previousClearTimeout;
  }
});

test('programmable mouse event IDs preserve left, middle, right and Shift groups', () => {
  const mouseEvents = {
    kind: ConstructKind.MOUSE_EVENTS,
    cursorAtStart: -1,
    definitions: [],
  };
  const h = createHarness([mouseEvents]);
  try {
    const cases = [
      [0, false, 1, 2, 3],
      [2, false, 4, 5, 6],
      [1, false, 7, 8, 9],
      [0, true, 10, 11, 12],
      [2, true, 13, 14, 15],
      [1, true, 16, 17, 18],
    ];
    for (const [button, shiftKey, down, up, double] of cases) {
      for (const [phase, eventId] of [['down', down], ['up', up], ['double', double]]) {
        mouseEvents.definitions.splice(0, mouseEvents.definitions.length,
          { flags: 0, firstEvent: eventId, secondEvent: 0, aidCode: eventId });
        h.mousePhase(phase, 8, 20, { button, shiftKey });
        assert.deepEqual(h.aids.splice(0), [eventId]);
      }
    }
  } finally {
    h.restore();
  }
});

test('a field-departure error vetoes a programmable release event', () => {
  const mouseEvents = {
    kind: ConstructKind.MOUSE_EVENTS,
    cursorAtStart: -1,
    definitions: [
      { flags: 0, firstEvent: 2, secondEvent: 0, aidCode: Aid.PF2 },
    ],
  };
  const h = createHarness([mouseEvents]);
  try {
    h.screen.setWriteAddressIndex(0);
    h.screen.addField({ attr: 0x20, length: 3, ffw0: 0, ffw1: 0x07, fcws: [] });
    h.screen.cursor = 1;
    h.screen.typeByte(0xC1);

    h.mousePhase('up', 8, 20);

    assert.deepEqual(h.aids, []);
    assert.equal(h.screen.cursor, 1);
    assert.equal(h.screen.alarm, true);
  } finally {
    h.restore();
  }
});

test('a programmable press event remains immediate during field validation', () => {
  const mouseEvents = {
    kind: ConstructKind.MOUSE_EVENTS,
    cursorAtStart: -1,
    definitions: [
      { flags: 0, firstEvent: 1, secondEvent: 0, aidCode: Aid.PF1 },
    ],
  };
  const h = createHarness([mouseEvents]);
  try {
    h.screen.setWriteAddressIndex(0);
    h.screen.addField({ attr: 0x20, length: 3, ffw0: 0, ffw1: 0x07, fcws: [] });
    h.screen.cursor = 1;
    h.screen.typeByte(0xC1);

    h.mousePhase('down', 8, 20);

    assert.deepEqual(h.aids, [Aid.PF1]);
    assert.equal(h.screen.alarm, false);
  } finally {
    h.restore();
  }
});

test('non-plain-left programmable events retain precedence over a GUI choice', () => {
  const construct = selection({ selected: [false] });
  const mouseEvents = {
    kind: ConstructKind.MOUSE_EVENTS,
    cursorAtStart: -1,
    definitions: [
      { flags: 0, firstEvent: 4, secondEvent: 0, aidCode: Aid.PF4 },
      { flags: 0, firstEvent: 10, secondEvent: 0, aidCode: Aid.PF10 },
    ],
  };
  const h = createHarness([construct, mouseEvents]);
  try {
    // Choice is on one-based row 3 around columns 5-12.
    h.mousePhase('down', 2, 4, { button: 2 });
    h.mousePhase('down', 2, 4, { button: 0, shiftKey: true });
    assert.deepEqual(h.aids, [Aid.PF4, Aid.PF10]);
    assert.equal(construct.items[0].selected, false);
  } finally {
    h.restore();
  }
});

test('delayed programmable single click fires after its decision window', () => {
  const mouseEvents = {
    kind: ConstructKind.MOUSE_EVENTS,
    cursorAtStart: -1,
    definitions: [
      { flags: 0, firstEvent: 1, secondEvent: 0, aidCode: Aid.PF1 },
      { flags: 0, firstEvent: 3, secondEvent: 0, aidCode: Aid.PF2 },
    ],
  };
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  let scheduled = null;
  globalThis.setTimeout = callback => { scheduled = callback; return callback; };
  globalThis.clearTimeout = callback => { if (scheduled === callback) scheduled = null; };
  const h = createHarness([mouseEvents]);
  try {
    h.click(8, 20);
    assert.equal(typeof scheduled, 'function');
    scheduled();
    assert.deepEqual(h.aids, [Aid.PF1]);
  } finally {
    h.restore();
    globalThis.setTimeout = previousSetTimeout;
    globalThis.clearTimeout = previousClearTimeout;
  }
});

test('double click replaces a related release-first pending mouse event', () => {
  const mouseEvents = {
    kind: ConstructKind.MOUSE_EVENTS,
    cursorAtStart: -1,
    definitions: [
      { flags: 0x90, firstEvent: 2, secondEvent: 5, aidCode: Aid.PF1 },
      { flags: 0x00, firstEvent: 3, secondEvent: 0, aidCode: Aid.PF2 },
    ],
  };
  const h = createHarness([mouseEvents]);
  try {
    h.click(8, 20);
    assert.deepEqual(h.aids, []);
    assert.deepEqual(h.screen.pointerMarker, { row: 8, col: 20 });

    h.doubleClick(8, 20);
    assert.deepEqual(h.aids, [Aid.PF2]);
    assert.equal(h.screen.pointerMarker, null);
  } finally {
    h.restore();
  }
});

test('Backspace is consumed by an ENPTUI pseudo-field', () => {
  const construct = selection();
  const h = createHarness([construct]);
  try {
    h.screen.cursor = construct.itemPositions[0].textIdx;
    h.keydown('Backspace');
    assert.equal(h.counts().backspaces, 0);
  } finally {
    h.restore();
  }
});

test('End crosses every segment of a continued logical field', () => {
  const h = createHarness();
  try {
    h.screen.setWriteAddressIndex(0);
    h.screen.addField({ attr: 0x20, length: 3, ffw0: 0, ffw1: 0,
      fcws: [[0x86, 0x01]] });
    h.screen.setWriteAddressIndex(10);
    h.screen.addField({ attr: 0x20, length: 3, ffw0: 0, ffw1: 0,
      fcws: [[0x86, 0x02]] });
    for (const [pos, byte] of [[1, 0xC1], [2, 0xC2], [11, 0xC3], [12, 0xC4]]) {
      h.screen.cells[pos].byte = byte;
      h.screen.cells[pos].glyph = h.screen.ebcdic.toChar(byte);
    }
    h.screen.cursor = 1;
    h.keydown('End');
    assert.equal(h.moves.at(-1), 13);
  } finally {
    h.restore();
  }
});

test('End never advances beyond a completely full field', () => {
  const h = createHarness();
  try {
    h.screen.setWriteAddressIndex(0);
    h.screen.addField({ attr: 0x20, length: 3, ffw0: 0, ffw1: 0, fcws: [] });
    for (const [pos, byte] of [[1, 0xC1], [2, 0xC2], [3, 0xC3]]) {
      h.screen.cells[pos].byte = byte;
      h.screen.cells[pos].glyph = h.screen.ebcdic.toChar(byte);
    }
    h.screen.cursor = 1;
    h.keydown('End');
    assert.equal(h.moves.at(-1), 3);
  } finally {
    h.restore();
  }
});

test('activating an unavailable choice raises local error feedback', () => {
  const construct = selection({ selected: [false] });
  construct.items[0].unavailable = true;
  const h = createHarness([construct]);
  try {
    h.screen.cursor = construct.itemPositions[0].textIdx;
    h.keydown(' ');
    assert.equal(h.screen.alarm, true);
    assert.deepEqual(h.flashes, ['choice unavailable']);
    assert.equal(construct.items[0].selected, false);
  } finally {
    h.restore();
  }
});

test('Enter on an unavailable choice follows the auto-select rule', () => {
  const plain = selection({ selected: [false] });
  plain.items[0].unavailable = true;
  const plainHarness = createHarness([plain]);
  try {
    plainHarness.screen.cursor = plain.itemPositions[0].textIdx;
    plainHarness.keydown('Enter');
    assert.deepEqual(plainHarness.aids, [Aid.ENTER]);
    assert.deepEqual(plainHarness.flashes, []);
  } finally {
    plainHarness.restore();
  }

  const automatic = selection({ selected: [false] });
  automatic.autoSelect = true;
  automatic.items[0].unavailable = true;
  const automaticHarness = createHarness([automatic]);
  try {
    automaticHarness.screen.cursor = automatic.itemPositions[0].textIdx;
    automaticHarness.keydown('Enter');
    assert.deepEqual(automaticHarness.aids, []);
    assert.deepEqual(automaticHarness.flashes, ['choice unavailable']);
  } finally {
    automaticHarness.restore();
  }
});

test('auto-select Enter deselects other push buttons', () => {
  const positions = [
    { row: 3, col: 5, textCol: 6, textIdx: 165, anchorIdx: 164,
      indicatorIdx: -1, hitWidth: 5 },
    { row: 3, col: 12, textCol: 13, textIdx: 172, anchorIdx: 171,
      indicatorIdx: -1, hitWidth: 5 },
  ];
  const buttons = selection({
    kind: ConstructKind.PUSH_BUTTONS,
    positions,
    selected: [true, true],
  });
  buttons.autoSelect = true;
  buttons.drawIndicator = false;
  const h = createHarness([buttons]);
  try {
    h.screen.cursor = positions[0].textIdx;
    h.keydown('Enter');
    assert.deepEqual(buttons.items.map(item => item.selected), [true, false]);
    assert.equal(buttons.modified, true);
    assert.deepEqual(h.aids, [Aid.PF5]);
  } finally {
    h.restore();
  }
});

test('single-choice activation preserves host-selected non-cursorable choices', () => {
  const positions = [
    { row: 3, col: 5, textCol: 6, textIdx: 165, anchorIdx: 164,
      indicatorIdx: 164, hitWidth: 8 },
    { row: 4, col: 5, textCol: 6, textIdx: 245, anchorIdx: 244,
      indicatorIdx: 244, hitWidth: 8 },
    { row: 5, col: 5, textCol: 6, textIdx: 325, anchorIdx: 324,
      indicatorIdx: 324, hitWidth: 8 },
  ];
  const construct = selection({ positions, selected: [false, true, true] });
  construct.items[1].nonCursorable = true;
  const h = createHarness([construct]);
  try {
    h.screen.cursor = positions[0].textIdx;
    h.keydown(' ');
    assert.deepEqual(construct.items.map(item => item.selected), [true, true, false]);

    construct.autoSelect = true;
    construct.items[0].selected = false;
    construct.items[2].selected = true;
    h.keydown('Enter');
    assert.deepEqual(construct.items.map(item => item.selected), [true, true, false]);
  } finally {
    h.restore();
  }
});

test('Erase Input clears cursorable ENPTUI choices without manufacturing MDT', () => {
  const first = selection({ selected: [true] });
  const second = selection({
    positions: [{ row: 6, col: 5, textCol: 6, textIdx: 405, anchorIdx: 404,
      indicatorIdx: 404, hitWidth: 8 }],
    selected: [true],
  });
  const h = createHarness([first, second]);
  try {
    first.modified = true;
    h.screen.cursor = first.itemPositions[0].textIdx;
    h.keydown('Delete', { ctrlKey: true });
    assert.equal(h.counts().eraseInputs, 1);
    assert.equal(first.items[0].selected, false);
    assert.equal(second.items[0].selected, false);
    assert.equal(first.modified, true);
    assert.equal(second.modified, false);
  } finally {
    h.restore();
  }
});

test('Erase Input honors the focused field deselection AID when unavailable', () => {
  const construct = selection({ autoEnterOnDeselect: true });
  construct.items[0].unavailable = true;
  const h = createHarness([construct]);
  try {
    h.screen.cursor = construct.itemPositions[0].textIdx;
    h.keydown('Delete', { ctrlKey: true });
    assert.equal(construct.items[0].selected, false);
    assert.deepEqual(h.aids, [Aid.PF5]);
  } finally {
    h.restore();
  }
});

test('Newline skips a structural next row and continues through the choices', () => {
  const positions = [
    { row: 3, col: 5, textCol: 6, textIdx: 165, anchorIdx: 164,
      indicatorIdx: 164, hitWidth: 8 },
    { row: 4, col: 5, textCol: 6, textIdx: 245, anchorIdx: 244,
      indicatorIdx: 244, hitWidth: 8 },
    { row: 5, col: 5, textCol: 6, textIdx: 325, anchorIdx: 324,
      indicatorIdx: 324, hitWidth: 8 },
  ];
  const construct = selection({ positions, selected: [false, false, false] });
  construct.items[1].nonCursorable = true;
  const h = createHarness([construct]);
  try {
    h.screen.cursor = positions[0].textIdx;
    h.keydown('Enter', { shiftKey: true });
    assert.equal(h.moves.at(-1), positions[2].textIdx);
    assert.equal(h.counts().newlines, 0);
  } finally {
    h.restore();
  }
});

test('Up and Down move horizontally in a non-exitable menu bar', () => {
  const positions = [
    { row: 2, col: 2, textCol: 2, textIdx: 81, anchorIdx: 80, hitWidth: 6 },
    { row: 2, col: 12, textCol: 12, textIdx: 91, anchorIdx: 90, hitWidth: 6 },
    { row: 2, col: 22, textCol: 22, textIdx: 101, anchorIdx: 100, hitWidth: 6 },
  ];
  const menu = selection({
    kind: ConstructKind.MENU_BAR,
    positions,
    selected: [false, false, false],
    cursorExitable: false,
  });
  const h = createHarness([menu]);
  try {
    h.screen.cursor = positions[1].textIdx;
    h.keydown('ArrowUp');
    assert.equal(h.moves.at(-1), positions[0].textIdx);
    h.screen.cursor = positions[1].textIdx;
    h.keydown('ArrowDown');
    assert.equal(h.moves.at(-1), positions[2].textIdx);
  } finally {
    h.restore();
  }
});

test('non-exitable multi-row choices continue in row and column order', () => {
  const positions = [];
  for (let i = 0; i < 6; i++) {
    const row = 3 + Math.floor(i / 3);
    const col = 4 + (i % 3) * 10;
    positions.push({
      row, col, textCol: col, textIdx: (row - 1) * 80 + col - 1,
      anchorIdx: (row - 1) * 80 + col - 2, hitWidth: 6,
    });
  }
  const choices = selection({
    positions,
    selected: positions.map(() => false),
    cursorExitable: false,
  });
  choices.numOfCols = 3;
  const h = createHarness([choices]);
  try {
    h.screen.cursor = positions[3].textIdx;
    h.keydown('ArrowLeft');
    assert.equal(h.moves.at(-1), positions[2].textIdx);

    h.screen.cursor = positions[2].textIdx;
    h.keydown('ArrowRight');
    assert.equal(h.moves.at(-1), positions[3].textIdx);

    h.screen.cursor = positions[0].textIdx;
    h.keydown('ArrowUp');
    assert.equal(h.moves.at(-1), positions[5].textIdx);

    h.screen.cursor = positions[5].textIdx;
    h.keydown('ArrowDown');
    assert.equal(h.moves.at(-1), positions[0].textIdx);
  } finally {
    h.restore();
  }
});

test('cursor-move-to-input leaves a choice at its boundary and skips protected cells', () => {
  const choices = selection({ cursorExitable: true });
  choices.cursorMoveToInput = true;
  choices.boundsTopRow = 3;
  choices.boundsLeftCol = 4;
  choices.boundsWidth = 8;
  const h = createHarness([choices]);
  try {
    h.screen.setWriteAddressIndex(178); // row 3, column 19 attribute
    h.screen.addField({ attr: 0x20, length: 3, ffw0: 0, ffw1: 0, fcws: [] });
    h.screen.cursor = choices.itemPositions[0].textIdx;
    h.keydown('ArrowRight');
    assert.equal(h.moves.at(-1), 179); // first data cell, row 3 column 20
  } finally {
    h.restore();
  }
});

test('cursor-move-to-input includes later segments that inherit input status', () => {
  const h = createHarness();
  try {
    h.screen.soh.cursorMoveToInput = true;
    h.screen.setWriteAddressIndex(0);
    h.screen.addField({ attr: 0x20, length: 1, ffw0: 0, ffw1: 0,
      fcws: [[0x86, 0x01]] });
    h.screen.setWriteAddressIndex(100);
    h.screen.addField({ attr: 0x20, length: 2, ffw0: 0x20, ffw1: 0,
      fcws: [[0x86, 0x02]] });
    h.screen.cursor = 99;
    h.keydown('ArrowRight');
    assert.equal(h.moves.at(-1), 101);
  } finally {
    h.restore();
  }
});

test('selection fields own Tab, Field Plus/Minus and New Line semantics', () => {
  const positions = [
    { row: 3, col: 5, textCol: 6, textIdx: 165, anchorIdx: 164,
      indicatorIdx: 164, hitWidth: 8 },
    { row: 3, col: 15, textCol: 16, textIdx: 175, anchorIdx: 174,
      indicatorIdx: 174, hitWidth: 8 },
    { row: 4, col: 5, textCol: 6, textIdx: 245, anchorIdx: 244,
      indicatorIdx: 244, hitWidth: 8 },
  ];
  const choices = selection({ positions, selected: [false, false, false] });
  choices.fieldAdvance = false;
  const h = createHarness([choices]);
  try {
    h.screen.setWriteAddressIndex(0);
    h.screen.addField({ attr: 0x20, length: 2, ffw0: 0, ffw1: 0, fcws: [] });

    h.screen.cursor = positions[0].textIdx;
    h.keydown('Tab');
    assert.equal(h.screen.cursor, 1, 'Tab leaves a non-field-advance construct');

    h.screen.cursor = positions[1].textIdx;
    h.keydown('Tab', { shiftKey: true });
    assert.equal(h.screen.cursor, positions[0].textIdx,
      'Backtab uses the construct pseudo-field stop from a later choice');

    choices.fieldAdvance = true;
    h.screen.cursor = positions[0].textIdx;
    h.keydown('Tab');
    assert.equal(h.screen.cursor, positions[1].textIdx);

    h.keydown('Tab', { shiftKey: true });
    assert.equal(h.screen.cursor, positions[0].textIdx);

    h.keydown('Tab', { shiftKey: true });
    assert.equal(h.screen.cursor, 1, 'Backtab leaves at the first choice');

    choices.fieldAdvance = false;
    h.screen.cursor = positions[0].textIdx;
    h.keydown('+', { code: 'NumpadAdd' });
    assert.equal(h.screen.cursor, 1);
    assert.equal(h.counts().fieldPluses, 0);

    h.screen.cursor = positions[0].textIdx;
    h.keydown('-', { code: 'NumpadSubtract' });
    assert.equal(h.screen.cursor, 1);
    assert.equal(h.counts().fieldMinuses, 0);

    h.screen.cursor = positions[0].textIdx;
    h.keydown('Enter', { shiftKey: true });
    assert.equal(h.screen.cursor, positions[2].textIdx);
    assert.equal(h.counts().newlines, 0);
  } finally {
    h.restore();
  }
});

test('selection fields accept slash and a case-insensitive host-defined selection character', () => {
  const construct = selection({ selected: [false] });
  construct.selectChar = 0;
  const h = createHarness([construct]);
  try {
    h.screen.cursor = construct.itemPositions[0].textIdx;
    h.keydown('/');
    assert.equal(construct.items[0].selected, true);

    construct.items[0].selected = false;
    construct.selectChar = h.screen.ebcdic.fromCharCode('X'.codePointAt(0));
    h.keydown('x');
    assert.equal(construct.items[0].selected, true);
    assert.deepEqual(h.flashes, []);
  } finally {
    h.restore();
  }
});

test('End is consumed by an ENPTUI pseudo-field', () => {
  const construct = selection();
  const h = createHarness([construct]);
  try {
    h.screen.setWriteAddressIndex(160);
    h.screen.addField({ attr: 0x20, length: 12, ffw0: 0, ffw1: 0, fcws: [] });
    h.screen.cursor = construct.itemPositions[0].textIdx;
    h.keydown('End');
    assert.deepEqual(h.moves, []);
  } finally {
    h.restore();
  }
});

test('Ctrl/Command+Enter invokes Field Exit without replacing numeric Enter', () => {
  const h = createHarness();
  try {
    h.keydown('Enter', { ctrlKey: true });
    h.keydown('Enter', { metaKey: true });
    assert.equal(h.counts().fieldExits, 2);
    assert.deepEqual(h.aids, []);

    h.keydown('Enter', { code: 'NumpadEnter' });
    assert.deepEqual(h.aids, [Aid.ENTER]);
  } finally {
    h.restore();
  }
});

test('Field Exit tabs from an ENPTUI choice and invalid field keys are rejected', () => {
  const construct = selection({
    positions: [
      { row: 3, col: 5, textCol: 6, textIdx: 165, anchorIdx: 164,
        indicatorIdx: 164, hitWidth: 8 },
      { row: 4, col: 5, textCol: 6, textIdx: 245, anchorIdx: 244,
        indicatorIdx: 244, hitWidth: 8 },
    ],
    selected: [false, false],
  });
  construct.fieldAdvance = true;
  const h = createHarness([construct]);
  try {
    h.screen.cursor = construct.itemPositions[0].textIdx;
    h.keydown('Enter', { ctrlKey: true });
    assert.equal(h.screen.cursor, construct.itemPositions[1].textIdx);
    assert.equal(h.counts().fieldExits, 0);

    h.keydown('d', { ctrlKey: true, shiftKey: true });
    h.keydown('m', { metaKey: true, shiftKey: true });
    assert.equal(h.counts().dups, 0);
    assert.equal(h.counts().fieldMarks, 0);
    assert.deepEqual(h.flashes, ['invalid selection key', 'invalid selection key']);
    assert.equal(h.screen.alarm, true);
  } finally {
    h.restore();
  }
});

test('editing-key chords expose Delete Word, Erase Field, Word Tab, DUP and Field Mark', () => {
  const h = createHarness();
  try {
    h.keydown('Backspace', { ctrlKey: true });
    h.keydown('Backspace', { metaKey: true, shiftKey: true });
    h.keydown('ArrowRight', { ctrlKey: true });
    h.keydown('ArrowLeft', { metaKey: true });
    h.keydown('d', { ctrlKey: true, shiftKey: true });
    h.keydown('m', { metaKey: true, shiftKey: true });
    assert.deepEqual(h.counts(), {
      deletes: 0, backspaces: 0, eraseInputs: 0, fieldExits: 0,
      fieldPluses: 0, fieldMinuses: 0, newlines: 0,
      deleteWords: 1, eraseFields: 1, wordTabs: 1, wordBacktabs: 1,
      dups: 1, fieldMarks: 1, draws: 0,
    });
  } finally {
    h.restore();
  }
});

test('restricted-window cursor movement wraps across every edge', () => {
  const window = {
    kind: ConstructKind.WINDOW,
    cursorAtStart: 100,
    cursorRestricted: true,
    innerTopRow: 4,
    innerLeftCol: 10,
    innerHeight: 3,
    innerWidth: 5,
  };
  const h = createHarness([window]);
  const addr = (row1, col1) => (row1 - 1) * h.screen.cols + col1 - 1;
  try {
    h.screen.cursor = addr(4, 10);
    h.keydown('ArrowLeft');
    assert.equal(h.moves.at(-1), addr(6, 14));

    h.screen.cursor = addr(4, 12);
    h.keydown('ArrowUp');
    assert.equal(h.moves.at(-1), addr(6, 12));

    h.screen.cursor = addr(6, 14);
    h.keydown('ArrowRight');
    assert.equal(h.moves.at(-1), addr(4, 10));

    h.screen.cursor = addr(6, 12);
    h.keydown('ArrowDown');
    assert.equal(h.moves.at(-1), addr(4, 12));
  } finally {
    h.restore();
  }
});

test('an exitable selection field still obeys its restricted window', () => {
  const textIdx = (4 - 1) * 80 + 10 - 1;
  const choices = selection({
    positions: [{ row: 4, col: 10, textCol: 10, textIdx,
      anchorIdx: textIdx - 1, indicatorIdx: textIdx - 1, hitWidth: 5 }],
    cursorExitable: true,
  });
  choices.boundsTopRow = 4;
  choices.boundsLeftCol = 10;
  choices.boundsWidth = 5;
  choices.numOfCols = 1;
  const window = {
    kind: ConstructKind.WINDOW,
    cursorAtStart: 100,
    cursorRestricted: true,
    innerTopRow: 4,
    innerLeftCol: 10,
    innerHeight: 3,
    innerWidth: 5,
  };
  const h = createHarness([window, choices]);
  const addr = (row1, col1) => (row1 - 1) * h.screen.cols + col1 - 1;
  try {
    h.screen.currentEnptuiWindowAddress = window.cursorAtStart;
    h.screen.cursor = textIdx;
    h.keydown('ArrowLeft');
    assert.equal(h.moves.at(-1), addr(6, 14));
  } finally {
    h.restore();
  }
});

test('only the current ENPTUI window restricts cursor movement', () => {
  const oldWindow = {
    kind: ConstructKind.WINDOW,
    cursorAtStart: 100,
    cursorRestricted: true,
    innerTopRow: 4,
    innerLeftCol: 10,
    innerHeight: 3,
    innerWidth: 5,
  };
  const currentWindow = {
    kind: ConstructKind.WINDOW,
    cursorAtStart: 500,
    cursorRestricted: true,
    innerTopRow: 10,
    innerLeftCol: 20,
    innerHeight: 3,
    innerWidth: 5,
  };
  const h = createHarness([oldWindow, currentWindow]);
  const addr = (row1, col1) => (row1 - 1) * h.screen.cols + col1 - 1;
  try {
    h.screen.cursor = addr(4, 10);
    h.keydown('ArrowLeft');
    assert.equal(h.moves.at(-1), addr(4, 9));

    h.screen.currentEnptuiWindowAddress = null;
    h.screen.cursor = addr(4, 10);
    h.keydown('ArrowLeft');
    assert.equal(h.moves.at(-1), addr(4, 9));
  } finally {
    h.restore();
  }
});
