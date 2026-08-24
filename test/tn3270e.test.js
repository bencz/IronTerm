import test from 'node:test';
import assert from 'node:assert/strict';
import { Tn3270eExtension } from '../public/tn3270/src/net/Tn3270eExtension.js';
import { TelnetOption, Tn3270e } from '../public/tn3270/src/proto/Constants.js';

function negotiate () {
  const sent = [];
  const framed = [];
  const core = {
    state: {},
    terminalType: 'IBM-3278-2-E',
    setState (patch) { Object.assign(this.state, patch); },
    setImpliedBidirectionalOption () {},
    send (bytes) { sent.push(Array.from(bytes)); },
    sendFramedRecord (bytes) { framed.push(Array.from(bytes)); },
  };
  const ext = new Tn3270eExtension();
  ext.attach(core);
  ext.onOptionEnabled(TelnetOption.TN3270E, 'local');
  ext.handleSubnegotiation(TelnetOption.TN3270E,
    Uint8Array.of(TelnetOption.TN3270E, Tn3270e.SEND, Tn3270e.DEVICE_TYPE));
  ext.handleSubnegotiation(TelnetOption.TN3270E,
    Uint8Array.from([TelnetOption.TN3270E, Tn3270e.DEVICE_TYPE, Tn3270e.IS,
      ...new TextEncoder().encode('IBM-3278-2-E')]));
  ext.handleSubnegotiation(TelnetOption.TN3270E,
    Uint8Array.of(TelnetOption.TN3270E, Tn3270e.FUNCTIONS, Tn3270e.IS,
      Tn3270e.FN_RESPONSES));
  return { ext, core, sent, framed };
}

test('activates only after device and supported function negotiation', () => {
  const x = negotiate();
  assert.equal(x.core.state.tn3270e, true);
  assert.deepEqual(x.core.state.functions, [Tn3270e.FN_RESPONSES]);
});

test('outbound sequence starts at zero and wraps after 32767', () => {
  const { ext } = negotiate();
  assert.deepEqual(Array.from(ext.wrapOutbound(Uint8Array.of(0xF1)).slice(3, 5)), [0, 0]);
  ext.outboundSeq = 0x7FFF;
  assert.deepEqual(Array.from(ext.wrapOutbound(Uint8Array.of(0xF1)).slice(3, 5)), [0x7F, 0xFF]);
  assert.deepEqual(Array.from(ext.wrapOutbound(Uint8Array.of(0xF1)).slice(3, 5)), [0, 0]);
});

test('response records contain one status byte and use valid status values', () => {
  const x = negotiate();
  x.ext.sendPositiveResponse(0x00FF);
  x.ext.sendNegativeResponse(1, 0x10);
  assert.deepEqual(x.framed[0], [2, 0, 0, 0, 0xFF, 0]);
  assert.deepEqual(x.framed[1], [2, 0, 1, 0, 1, 2]);
});
