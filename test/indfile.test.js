import test from 'node:test';
import assert from 'node:assert/strict';
import { IndFile } from '../public/tn3270/src/proto/IndFile.js';

test('IND$FILE preserves CLOSE acknowledgement after resetting transfer state', () => {
  const ind = new IndFile();
  ind.process(Uint8Array.of(0x00, 0x12));
  assert.equal(ind.drainReplies().length, 1);
  ind.process(Uint8Array.of(0x41, 0x12));
  const replies = ind.drainReplies();
  assert.equal(replies.length, 1);
  assert.deepEqual(Array.from(replies[0].slice(3, 6)), [0xD0, 0x41, 0x09]);
});

test('IND$FILE preserves ABORT response and rejects zero-length DATA records', () => {
  const ind = new IndFile();
  ind.process(Uint8Array.of(0x00, 0x12, 0x08, 0x02));
  assert.equal(ind.drainReplies().length, 1);
  assert.throws(() => ind.process(Uint8Array.of(0x47, 0x04, 0xC0, 0x80, 0x61, 0, 0)),
    /Invalid IND\$FILE DATA length/);
});

test('IND$FILE enforces upload size limit', () => {
  const ind = new IndFile({ maxFileBytes: 4 });
  assert.throws(() => ind.queueUpload(Uint8Array.of(1, 2, 3, 4, 5), 'large.bin'), RangeError);
});
