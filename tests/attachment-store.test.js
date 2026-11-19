import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { AttachmentStore, MAX_IMAGE_BYTES } from '../core/attachment-store.js';
import { temporaryDirectory } from './helpers.js';

function png(width = 2, height = 3) {
  const value = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value); value.write('IHDR', 12, 'ascii'); value.writeUInt32BE(width, 16); value.writeUInt32BE(height, 20); return value;
}
function jpeg(width = 4, height = 5) { return Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, height, 0, width, 1, 1, 0x11, 0, 0xff, 0xd9]); }
function webp(width = 6, height = 7) { const value = Buffer.alloc(30); value.write('RIFF'); value.writeUInt32LE(22, 4); value.write('WEBP', 8); value.write('VP8X', 12); value.writeUIntLE(width - 1, 24, 3); value.writeUIntLE(height - 1, 27, 3); return value; }

test('attachment store validates, isolates, claims, resolves, and expires image bytes', async (t) => {
  const root = await temporaryDirectory(t, 'attachments-'); let now = Date.parse('2026-09-23T12:00:00Z');
  const store = new AttachmentStore(root, { now: () => now, stagedTtlMs: 100, taskRetentionMs: 200 });
  const fixtures = [['image/png', png(), [2, 3]], ['image/jpeg', jpeg(), [4, 5]], ['image/webp', webp(), [6, 7]]];
  const staged = [];
  for (const [mime, bytes, dimensions] of fixtures) { const item = await store.stage({ mime_type: mime, filename: `visual${mime.slice(6)}`, data_base64: bytes.toString('base64') }); assert.deepEqual([item.width, item.height], dimensions); staged.push(item); }
  const claimed = await store.claim(staged.map(item => item.attachment_id), 'project-one', 'task-one'); assert.equal(claimed.length, 3); assert.ok(claimed.every(item => !('path' in item)));
  const resolved = await store.resolve('project-one', 'task-one', claimed); assert.equal(resolved.length, 3); assert.deepEqual(await readFile(resolved[0].path), png());
  now += 201; await store.cleanup(); await assert.rejects(() => store.resolve('project-one', 'task-one', claimed), { code: 'ATTACHMENT_RAW_EXPIRED' });
  const metadata = JSON.parse(await readFile(path.join(store.taskDirectory('project-one', 'task-one'), `${claimed[0].attachment_id}.json`), 'utf8')); assert.equal(metadata.raw_retained, false); assert.ok(metadata.raw_removed_at);
});

test('attachment store rejects unsupported, corrupt, mismatched, oversized, expired, and unsafe references', async (t) => {
  const root = await temporaryDirectory(t, 'attachments-reject-'); let now = Date.now(); const store = new AttachmentStore(root, { now: () => now, stagedTtlMs: 10 });
  await assert.rejects(() => store.stage({ mime_type: 'image/gif', data_base64: png().toString('base64') }), { code: 'ATTACHMENT_UNSUPPORTED_TYPE' });
  await assert.rejects(() => store.stage({ mime_type: 'image/png', data_base64: Buffer.from('broken').toString('base64') }), { code: 'ATTACHMENT_CORRUPT_IMAGE' });
  await assert.rejects(() => store.stage({ mime_type: 'image/jpeg', data_base64: png().toString('base64') }), { code: 'ATTACHMENT_MIME_MISMATCH' });
  await assert.rejects(() => store.stage({ mime_type: 'image/png', data_base64: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') }), { code: 'ATTACHMENT_TOO_LARGE' });
  await assert.rejects(() => store.claim(['../../escape'], 'project', 'task'), { code: 'ATTACHMENT_INVALID_REFERENCE' });
  const item = await store.stage({ mime_type: 'image/png', data_base64: png().toString('base64') }); now += 11; await assert.rejects(() => store.claim([item.attachment_id], 'project', 'task'), { code: 'ATTACHMENT_EXPIRED' });
});
