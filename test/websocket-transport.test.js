import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketTransport } from '../public/shared/src/net/WebSocketTransport.js';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor (url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = MockWebSocket.CONNECTING;
    this.bufferedAmount = 0;
    this.listeners = new Map();
    this.sent = [];
    MockWebSocket.instances.push(this);
  }

  addEventListener (name, fn) {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
  }

  emit (name, event = {}) {
    for (const fn of this.listeners.get(name) ?? []) fn(event);
  }

  send (bytes) { this.sent.push(bytes); }
  close (code, reason) {
    this.closeArgs = [code, reason];
    this.readyState = MockWebSocket.CLOSED;
  }
}

test('WebSocket transport handles binary data, backpressure, and stale events', async t => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = MockWebSocket;
  MockWebSocket.instances = [];
  t.after(() => { globalThis.WebSocket = original; });

  const opened = [];
  const data = [];
  const errors = [];
  const transport = new WebSocketTransport('wss://relay.example/', {
    onOpen: () => opened.push(true),
    onData: bytes => data.push(Array.from(bytes)),
    onError: error => errors.push(error),
    openTimeoutMs: 1000,
    maxBufferedBytes: 3,
  });
  transport.open();
  const ws = MockWebSocket.instances[0];
  assert.equal(ws.protocols, 'binary');
  assert.throws(() => transport.open(), /already open/);
  ws.readyState = MockWebSocket.OPEN;
  ws.emit('open');
  assert.deepEqual(opened, [true]);

  ws.emit('message', { data: Uint8Array.of(1, 2, 3).buffer });
  assert.deepEqual(data, [[1, 2, 3]]);
  assert.equal(transport.send(Uint8Array.of(4, 5)), true);
  assert.deepEqual(Array.from(new Uint8Array(ws.sent[0])), [4, 5]);
  ws.bufferedAmount = 4;
  assert.equal(transport.send(Uint8Array.of(6)), false);
  assert.match(errors.at(-1), /backpressure/);

  transport.close();
  ws.emit('message', { data: Uint8Array.of(9).buffer });
  assert.deepEqual(data, [[1, 2, 3]]);
  assert.deepEqual(ws.closeArgs, [1000, 'client disconnect']);
});

test('WebSocket transport rejects oversized and text frames', t => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = MockWebSocket;
  MockWebSocket.instances = [];
  t.after(() => { globalThis.WebSocket = original; });
  const errors = [];
  const transport = new WebSocketTransport('wss://relay.example/', {
    onError: error => errors.push(error),
    maxMessageBytes: 2,
  });
  transport.open();
  const ws = MockWebSocket.instances[0];
  ws.readyState = MockWebSocket.OPEN;
  ws.emit('open');
  ws.emit('message', { data: 'not binary' });
  ws.emit('message', { data: Uint8Array.of(1, 2, 3).buffer });
  assert.match(errors[0], /text frame/);
  assert.match(errors[1], /exceeds/);
  assert.deepEqual(ws.closeArgs, [1009, 'frame too large']);
  transport.close();
});
