import test from 'node:test';
import assert from 'node:assert/strict';
import { InputController as Input5250 } from '../public/tn5250/src/ui/InputController.js';
import { Aid as Aid5250 } from '../public/tn5250/src/proto/Constants.js';

test('TN5250 Home AID and shifted PF keys preserve their workstation mapping', () => {
  const listeners = {};
  const previousDocument = globalThis.document;
  globalThis.document = {
    activeElement: null,
    addEventListener: (name, callback) => { listeners[name] = callback; },
  };
  const canvas = {
    addEventListener () {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 480 }),
  };
  const screen = {
    rows: 24, cols: 80, size: 1920, cursor: 5, cells: [], fields: [],
    enptui: { all: [] },
    enptuiItemAtCursor: () => null,
    homePosition: () => 5,
  };
  const aids = [];
  const moves = [];
  new Input5250({
    canvas, screen,
    renderer: { draw () {}, setSelection () {} },
    onAid: aid => aids.push(aid),
    onMoveCursor: target => { moves.push(target); screen.cursor = target; },
  });
  const key = (value, overrides = {}) => listeners.keydown({
    key: value, code: value,
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    preventDefault () {}, ...overrides,
  });

  try {
    key('Home');
    key('F12', { shiftKey: true });
    key('F13', { shiftKey: true });
    screen.cursor = 9;
    key('Home');
    assert.deepEqual(aids, [Aid5250.HOME, Aid5250.PF24, Aid5250.PF13]);
    assert.deepEqual(moves, [5]);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('TN5250 error mode rejects editing but restores before an AID', () => {
  const listeners = {};
  const previousDocument = globalThis.document;
  globalThis.document = {
    activeElement: null,
    addEventListener: (name, callback) => { listeners[name] = callback; },
  };
  const canvas = {
    addEventListener () {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 480 }),
  };
  const screen = {
    rows: 24, cols: 80, size: 1920, cursor: 0, cells: [], fields: [],
    errorMode: true, alarm: false, enptui: { all: [] },
    enptuiItemAtCursor: () => null,
  };
  const aids = [];
  const typed = [];
  let resets = 0;
  new Input5250({
    canvas, screen,
    renderer: { draw () {}, setSelection () {} },
    onAid: aid => aids.push(aid),
    onType: value => typed.push(value),
    onReset: () => { resets++; screen.errorMode = false; },
  });
  const key = (value, code = value) => listeners.keydown({
    key: value, code,
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    preventDefault () {},
  });

  key('x', 'KeyX');
  assert.deepEqual(typed, []);
  assert.equal(resets, 0);
  assert.equal(screen.alarm, true);

  key('Enter', 'Enter');
  assert.equal(resets, 1);
  assert.deepEqual(aids, [Aid5250.ENTER]);
  globalThis.document = previousDocument;
});

test('TN5250 Error Help consumes ordinary keys and Reset dismisses it', () => {
  const listeners = {};
  const previousDocument = globalThis.document;
  globalThis.document = {
    activeElement: null,
    addEventListener: (name, callback) => { listeners[name] = callback; },
  };
  const canvas = {
    addEventListener () {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 480 }),
  };
  const screen = {
    rows: 24, cols: 80, size: 1920, cursor: 0, cells: [], fields: [],
    errorMode: false, errorHelpMode: true, enptui: { all: [] },
    enptuiItemAtCursor: () => null,
  };
  const typed = [];
  let resets = 0;
  new Input5250({
    canvas, screen,
    renderer: { draw () {}, setSelection () {} },
    onType: value => typed.push(value),
    onReset: () => { resets++; screen.errorHelpMode = false; },
  });
  const key = (value, code = value) => listeners.keydown({
    key: value, code,
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
    preventDefault () {},
  });

  key('x', 'KeyX');
  assert.deepEqual(typed, []);
  assert.equal(resets, 0);
  key('Escape', 'Escape');
  assert.equal(resets, 1);
  globalThis.document = previousDocument;
});
