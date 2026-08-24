import test from 'node:test';
import assert from 'node:assert/strict';
import { NewEnvironExtension } from '../public/tn5250/src/net/NewEnvironExtension.js';
import { TelnetOption, NewEnviron } from '../public/tn5250/src/proto/Constants.js';

function outputFor (opts, request) {
  let output;
  const core = {
    state: {},
    setState (patch) { Object.assign(this.state, patch); },
    send (bytes) { output = bytes; },
  };
  const ext = new NewEnvironExtension(opts);
  ext.attach(core);
  ext.handleSubnegotiation(TelnetOption.NEW_ENVIRON,
    Uint8Array.from([TelnetOption.NEW_ENVIRON, NewEnviron.SEND, ...request]));
  return Array.from(output);
}

const ascii = s => Array.from(new TextEncoder().encode(s));

test('NEW-ENVIRON sends only explicitly requested variables', () => {
  const bytes = outputFor({ devName: 'IRONTERM', kbdType: 'USB', codePage: '037' },
    [NewEnviron.USERVAR, ...ascii('DEVNAME')]);
  const text = String.fromCharCode(...bytes);
  assert.match(text, /DEVNAME/);
  assert.doesNotMatch(text, /KBDTYPE|CODEPAGE|IBMSENDCONFREC/);
});

test('an empty device name lets the host allocate the workstation', () => {
  const bytes = outputFor({ kbdType: 'USB', codePage: '037' },
    [NewEnviron.USERVAR]);
  const text = String.fromCharCode(...bytes);
  assert.doesNotMatch(text, /DEVNAME/);
  assert.match(text, /KBDTYPE|CODEPAGE/);
});

test('plaintext bypass signon uses an empty IBMRSEED value', () => {
  const request = [
    NewEnviron.VAR, ...ascii('USER'),
    NewEnviron.USERVAR, ...ascii('IBMRSEED'), 0x7D, 0x3E, 0x48, 0x8F, 0x18, 0x08, 0x04, 0x04,
    NewEnviron.USERVAR, ...ascii('IBMSUBSPW'),
  ];
  const bytes = outputFor({ user: 'TESTUSER', password: 'SECRET' }, request);
  const seedNameAt = bytes.findIndex((_, i) => ascii('IBMRSEED').every((b, j) => bytes[i + j] === b));
  const valueAt = seedNameAt + 'IBMRSEED'.length;
  assert.equal(bytes[valueAt], NewEnviron.VALUE);
  assert.equal(bytes[valueAt + 1], NewEnviron.USERVAR);
  assert.equal(bytes.slice(valueAt + 1, valueAt + 10).includes(0), false);
});

test('an IBMRSEED-only request returns the complete substitution pair', () => {
  const request = [
    NewEnviron.USERVAR, ...ascii('IBMRSEED'), 0x7D, 0x3E, 0x48, 0x8F,
  ];
  const bytes = outputFor({ user: 'ALICE', password: 'SECRET' }, request);
  const text = String.fromCharCode(...bytes);
  assert.match(text, /IBMRSEED/);
  assert.match(text, /IBMSUBSPW/);
  assert.match(text, /SECRET/);
});

test('empty VAR/USERVAR markers request all variables alongside an explicit seed', () => {
  const request = [
    NewEnviron.USERVAR, ...ascii('IBMRSEED'), 0x7D, 0x3E, 0x48, 0x8F,
    NewEnviron.VAR,
    NewEnviron.USERVAR,
  ];
  const bytes = outputFor({
    devName: 'IRONTERM', user: 'ALICE', password: 'SECRET',
  }, request);
  const text = String.fromCharCode(...bytes);
  assert.match(text, /DEVNAME/);
  assert.match(text, /IBMSENDCONFREC/);
  assert.match(text, /USER/);
  assert.match(text, /IBMSUBSPW/);
});
