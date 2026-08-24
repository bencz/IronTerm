import test from 'node:test';
import assert from 'node:assert/strict';
import { Ebcdic } from '../public/shared/src/proto/Ebcdic.js';
import { decodeStartupRecord } from '../public/tn5250/src/proto/StartupRecord.js';

test('decodes an RFC 4777 success response', () => {
  const cp = Ebcdic.get('CP037');
  const payload = new Uint8Array(27);
  payload.set([0xC0, 0x00, 0x3D, 0x00, 0x00]);
  payload.set(cp.encode('I902'), 5);
  payload.set(cp.encode('TARGET  '), 9);
  payload.set(cp.encode('IRONTERM  '), 17);
  assert.deepEqual(decodeStartupRecord(payload, cp), {
    code: 'I902', success: true, system: 'TARGET', device: 'IRONTERM',
    message: 'session successfully started', diagnostic: new Uint8Array(0),
  });
});

test('decodes automatic sign-on rejection without treating it as success', () => {
  const cp = Ebcdic.get('CP037');
  const payload = new Uint8Array(27);
  payload.set(cp.encode('8937'), 5);
  payload.set(cp.encode('PUB400  '), 9);
  payload.set(cp.encode('QPADEV0001'), 17);
  const result = decodeStartupRecord(payload, cp);
  assert.equal(result.success, false);
  assert.match(result.message, /sign-on rejected/);
});

test('reports a device that is not varied on', () => {
  const cp = Ebcdic.get('CP037');
  const payload = new Uint8Array(27);
  payload.set(cp.encode('8901'), 5);
  payload.set(cp.encode('PUB400  '), 9);
  const result = decodeStartupRecord(payload, cp);
  assert.equal(result.success, false);
  assert.match(result.message, /not varied on/);
});
