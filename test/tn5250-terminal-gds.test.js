import test from 'node:test';
import assert from 'node:assert/strict';
import { wrap, unwrap } from '../public/tn5250/src/proto/GdsHeader.js';
import { Cmd, Gds, NegResp, Order } from '../public/tn5250/src/proto/Constants.js';

const noop = () => {};

function element () {
  return {
    className: '', textContent: '', value: '', style: {},
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop, removeEventListener: noop, appendChild: noop,
    removeChild: noop, focus: noop, click: noop, setAttribute: noop,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 480 }),
    scrollTop: 0, scrollHeight: 0, offsetWidth: 1,
  };
}

function installDom () {
  const context = new Proxy({ measureText: () => ({ width: 8 }) }, {
    get: (target, key) => key in target ? target[key] : noop,
    set: (target, key, value) => { target[key] = value; return true; },
  });
  const canvas = element();
  canvas.width = 800;
  canvas.height = 480;
  canvas.getContext = () => context;
  globalThis.window = { addEventListener: noop, removeEventListener: noop };
  globalThis.document = {
    activeElement: null,
    body: element(),
    addEventListener: noop,
    removeEventListener: noop,
    createElement: element,
    querySelectorAll: () => [],
  };
  globalThis.ResizeObserver = class { observe () {} disconnect () {} };
  globalThis.devicePixelRatio = 1;
  globalThis.setInterval = noop;
  globalThis.requestAnimationFrame = callback => callback();
  return canvas;
}

async function terminalFixture () {
  const canvas = installDom();
  const { Terminal } = await import('../public/tn5250/src/Terminal.js');
  const oiaEls = Object.fromEntries(
    ['conn', 'sys', 'lock', 'insert', 'alarm', 'msg', 'model', 'cursor']
      .map(key => [key, element()]),
  );
  const terminal = new Terminal({
    canvas,
    statusEl: element(),
    oiaEls,
    nvtEl: element(),
  });
  const records = [];
  terminal.telnet = { sendRecord: record => records.push(record) };
  return { terminal, records };
}

test('GDS Read Immediate with an embedded read command responds exactly once', async () => {
  const { terminal, records } = await terminalFixture();
  terminal.handleRecord(wrap(
    Uint8Array.of(Order.ESC, Cmd.READ_IMMEDIATE),
    Gds.Op.READ_IMMEDIATE,
  ));

  assert.equal(records.length, 1);
  const response = unwrap(records[0]);
  assert.equal(response.opcode, Gds.Op.READ_IMMEDIATE);
  assert.equal(response.flags & Gds.Flag.RESPONSE, Gds.Flag.RESPONSE);
  assert.deepEqual(Array.from(response.payload), [1, 1, 0]);
});

test('GDS Read Screen executes its embedded command before replying', async () => {
  const { terminal, records } = await terminalFixture();
  terminal.screen.cells[0].byte = 0xC1;
  terminal.screen.cells[0].glyph = 'A';
  terminal.handleRecord(wrap(
    Uint8Array.of(Order.ESC, Cmd.READ_SCREEN_IMMEDIATE),
    Gds.Op.READ_SCREEN,
  ));

  assert.equal(records.length, 1);
  const response = unwrap(records[0]);
  assert.equal(response.opcode, Gds.Op.READ_SCREEN);
  assert.equal(response.flags & Gds.Flag.RESPONSE, Gds.Flag.RESPONSE);
  assert.equal(response.payload[0], 0xC1);
});

test('GDS Save Screen opcode also accepts an ordinary command stream', async () => {
  const { terminal, records } = await terminalFixture();
  terminal.screen.setWriteAddressIndex(0);
  terminal.screen.addField({ attr: 0x20, length: 1, ffw0: 0x08, ffw1: 0, fcws: [] });
  terminal.handleRecord(wrap(
    Uint8Array.of(Order.ESC, Cmd.CLEAR_FORMAT_TABLE),
    Gds.Op.SAVE_SCREEN,
  ));

  assert.equal(terminal.screen.fields.length, 0);
  assert.equal(records.length, 0);
});

test('Invite selects its read mode from flags1, not startup data-flow flags', async () => {
  const cases = [
    [0x0000, Gds.Op.READ_IMMEDIATE],
    [0x1000, Gds.Op.READ_MDT_FIELDS],
    [0x1800, Gds.Op.READ_MDT_IMMEDIATE_ALT],
  ];
  for (const [flags, expected] of cases) {
    const { terminal } = await terminalFixture();
    terminal.screen.keyboardLocked = true;
    terminal.handleRecord(wrap(
      Uint8Array.of(Order.ESC, Cmd.CLEAR_FORMAT_TABLE),
      Gds.Op.INVITE_OPERATION,
      flags,
    ));
    assert.equal(terminal.parser.readType, expected);
    assert.equal(terminal.parser.readPending, true);
    assert.equal(terminal.screen.keyboardLocked, true,
      'the Invite opcode alone must not synthesize a keyboard unlock');
  }
});

test('an embedded read command overrides the Invite header read mode', async () => {
  const { terminal } = await terminalFixture();
  terminal.handleRecord(wrap(
    Uint8Array.of(Order.ESC, Cmd.READ_INPUT_FIELDS, 0x00, 0x00),
    Gds.Op.INVITE_OPERATION,
    0x1800,
  ));

  assert.equal(terminal.parser.readType, Cmd.READ_INPUT_FIELDS);
});

test('parser failures return a four-byte SNA sense code', async () => {
  const { terminal, records } = await terminalFixture();
  terminal.handleRecord(wrap(
    Uint8Array.of(Order.ESC, 0xFF),
    Gds.Op.OUTPUT_ONLY,
  ));

  assert.equal(records.length, 1);
  const response = unwrap(records[0]);
  assert.equal(response.flags & Gds.Flag.ERR, Gds.Flag.ERR);
  assert.deepEqual(Array.from(response.payload), [
    (NegResp.COMMAND_NOT_VALID >>> 24) & 0xFF,
    (NegResp.COMMAND_NOT_VALID >>> 16) & 0xFF,
    (NegResp.COMMAND_NOT_VALID >>> 8) & 0xFF,
    NegResp.COMMAND_NOT_VALID & 0xFF,
  ]);
});

test('GDS Restore Screen finds the command after a transport prefix', async () => {
  const { terminal, records } = await terminalFixture();
  terminal.screen.cells[0].byte = 0xC1;
  const token = terminal.screen.saveScreen();
  terminal.screen.cells[0].byte = 0xD1;
  terminal.handleRecord(wrap(
    Uint8Array.of(0, 0, Order.ESC, Cmd.RESTORE_SCREEN, ...token),
    Gds.Op.RESTORE_SCREEN,
  ));

  assert.equal(terminal.screen.cells[0].byte, 0xC1);
  assert.equal(records.length, 0);
});

test('a pasted string stops at the character that triggers Auto Enter', async () => {
  const { terminal, records } = await terminalFixture();
  terminal.screen.setWriteAddressIndex(0);
  terminal.screen.addField({ attr: 0x20, length: 2, ffw0: 0, ffw1: 0x80, fcws: [] });
  terminal.screen.cursor = 1;
  terminal.screen.keyboardLocked = false;
  terminal.parser.readPending = true;
  terminal.parser.invited = true;
  terminal.parser.readType = Cmd.READ_INPUT_FIELDS;

  terminal.type('ABC');

  assert.deepEqual(terminal.screen.cells.slice(1, 3).map(cell => cell.glyph), ['A', 'B']);
  assert.equal(records.length, 1);
  assert.equal(terminal.screen.keyboardLocked, true);
});

test('Print and Roll AIDs still enforce mandatory field validation', async () => {
  const { terminal, records } = await terminalFixture();
  terminal.screen.keyboardLocked = false;
  terminal.screen.setWriteAddressIndex(0);
  terminal.screen.addField({
    attr: 0x20, length: 3, ffw0: 0, ffw1: 0x08, fcws: [],
  });
  terminal.screen.setWriteAddressIndex(10);
  terminal.screen.addField({
    attr: 0x20, length: 1, ffw0: 0, ffw1: 0, fcws: [],
  });
  terminal.screen.fields.at(-1).modified = true;
  terminal.parser.readPending = true;
  terminal.sendAid(0xF6);
  terminal.sendAid(0xF5);

  assert.equal(records.length, 0);
  assert.equal(terminal.screen.cursor, 1);
});

test('System Request opens a local input line and sends it only on Enter', async () => {
  const { terminal, records } = await terminalFixture();
  terminal.screen.keyboardLocked = true;
  terminal.screen.cells.at(-terminal.screen.cols).byte = 0xC1;
  terminal.screen.setWriteAddressIndex(0);
  terminal.screen.addField({ attr: 0x20, length: 2, ffw0: 0, ffw1: 0, fcws: [] });
  const originalField = terminal.screen.fields[0];

  terminal.sendSystemRequest();

  assert.equal(records.length, 0);
  assert.equal(terminal.screen.sysreqMode, true);
  assert.equal(terminal.screen.keyboardLocked, false);
  assert.equal(terminal.screen.fields.length, 1);
  assert.equal(terminal.screen.cursor, terminal.screen.size - terminal.screen.cols + 1);

  terminal.type('DSPJOB');
  terminal.sendAid(0xF1);

  assert.equal(records.length, 1);
  const request = unwrap(records[0]);
  assert.equal(request.opcode, Gds.Op.NO_OPERATION);
  assert.equal(request.flags & Gds.Flag.SRQ, Gds.Flag.SRQ);
  assert.equal(terminal.screen.ebcdic.decode(request.payload), 'DSPJOB');
  assert.equal(terminal.screen.sysreqMode, false);
  assert.equal(terminal.screen.keyboardLocked, true);
  assert.equal(terminal.screen.fields[0], originalField);
  assert.equal(terminal.screen.cells.at(-terminal.screen.cols).byte, 0xC1);
});
