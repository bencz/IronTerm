import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWebSocketUrl } from '../public/shared/src/net/WebSocketUrl.js';

test('normalises a WebSocket URL and substitutes a validated port', () => {
  assert.equal(
    buildWebSocketUrl('wss://relay.example/tcp?port={port}', '23'),
    'wss://relay.example/tcp?port=23');
  assert.equal(buildWebSocketUrl('wss://tk5.bencz.cc', 3270), 'wss://tk5.bencz.cc/');
});

test('rejects unsafe schemes, mixed content and credentials in URLs', () => {
  assert.throws(() => buildWebSocketUrl('https://example.com', 23), /ws:\/\/ or wss:\/\//);
  assert.throws(() => buildWebSocketUrl('ws://example.com', 23, { pageProtocol: 'https:' }), /requires/);
  assert.throws(() => buildWebSocketUrl('ws://example.com', 23, { hasSensitiveCredentials: true }), /credentials require/);
  assert.throws(() => buildWebSocketUrl('wss://user:pass@example.com', 23), /credentials are not allowed/);
  assert.throws(() => buildWebSocketUrl('wss://example.com/#{port}', 23), /fragment/);
  assert.throws(() => buildWebSocketUrl('wss://example.com/{port}', 70000), /1 to 65535/);
});
