import test from 'node:test';
import assert from 'node:assert/strict';
import { TelnetCore } from '../public/shared/src/net/TelnetCore.js';
import { Telnet, TelnetOption } from '../public/shared/src/proto/TelnetConstants.js';

function makeCore (extra = {}) {
  const sent = [];
  const records = [];
  const nvt = [];
  const errors = [];
  const core = new TelnetCore({
    send: b => sent.push(Array.from(b)),
    onRecord: b => records.push(Array.from(b)),
    onNvt: b => nvt.push(Array.from(b)),
    onProtocolError: e => errors.push(e),
    terminalType: 'IBM-3278-2-E',
    ...extra,
  });
  return { core, sent, records, nvt, errors };
}

test('keeps local and remote BINARY negotiation independent and idempotent', t => {
  const x = makeCore();
  t.after(() => x.core.close());
  x.core.feed(Uint8Array.of(Telnet.IAC, Telnet.DO, TelnetOption.BINARY,
    Telnet.IAC, Telnet.DO, TelnetOption.BINARY, 0x41));
  assert.deepEqual(x.sent, [[Telnet.IAC, Telnet.WILL, TelnetOption.BINARY]]);
  assert.equal(x.core.state.localBinary, true);
  assert.equal(x.core.state.remoteBinary, false);
  assert.deepEqual(x.nvt, [[0x41]]);
});

test('batches NVT bytes and emits records only after remote BINARY and EOR', t => {
  const x = makeCore();
  t.after(() => x.core.close());
  x.core.feed(Uint8Array.of(0x41, 0x42, 0x43));
  assert.deepEqual(x.nvt, [[0x41, 0x42, 0x43]]);
  x.core.feed(Uint8Array.of(Telnet.IAC, Telnet.WILL, TelnetOption.BINARY,
    Telnet.IAC, Telnet.WILL, TelnetOption.EOR,
    0x01, 0x02, Telnet.IAC, Telnet.EOR));
  assert.deepEqual(x.records, [[0x01, 0x02]]);
});

test('drops oversized record until EOR and recovers for the next record', t => {
  const x = makeCore({ maxRecordBytes: 3 });
  t.after(() => x.core.close());
  x.core.feed(Uint8Array.of(Telnet.IAC, Telnet.WILL, TelnetOption.BINARY,
    Telnet.IAC, Telnet.WILL, TelnetOption.EOR,
    1, 2, 3, 4, Telnet.IAC, Telnet.EOR,
    5, Telnet.IAC, Telnet.EOR));
  assert.equal(x.errors.length, 1);
  assert.deepEqual(x.records, [[5]]);
});

test('negotiates SUPPRESS-GO-AHEAD in both directions', t => {
  const x = makeCore();
  t.after(() => x.core.close());
  x.core.feed(Uint8Array.of(
    Telnet.IAC, Telnet.DO, TelnetOption.SUPPRESS_GO_AHEAD,
    Telnet.IAC, Telnet.WILL, TelnetOption.SUPPRESS_GO_AHEAD));
  assert.deepEqual(x.sent, [
    [Telnet.IAC, Telnet.WILL, TelnetOption.SUPPRESS_GO_AHEAD],
    [Telnet.IAC, Telnet.DO, TelnetOption.SUPPRESS_GO_AHEAD],
  ]);
  assert.equal(x.core.state.localSuppressGoAhead, true);
  assert.equal(x.core.state.remoteSuppressGoAhead, true);
});

test('delivers extension subnegotiation as a Uint8Array', t => {
  let received;
  const extension = {
    attach () {},
    isKnownOption: opt => opt === 0x27,
    handleSubnegotiation: (_opt, bytes) => { received = bytes; },
  };
  const x = makeCore({ extension });
  t.after(() => x.core.close());
  x.core.feed(Uint8Array.of(
    Telnet.IAC, Telnet.SB, 0x27, 0x01, 0x03, 0x41,
    Telnet.IAC, Telnet.SE));
  assert.equal(received instanceof Uint8Array, true);
  assert.deepEqual(Array.from(received), [0x27, 0x01, 0x03, 0x41]);
});
