import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AiRouterError } from './errors.js';
import { resolveWithin } from './paths.js';

export const IMAGE_MIME_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TASK_IMAGES = 4;
export const MAX_TASK_IMAGE_BYTES = 12 * 1024 * 1024;
export const STAGED_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
export const TASK_ATTACHMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const EXTENSIONS = Object.freeze({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' });

function jpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1]; offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return null;
}

function webpDimensions(buffer) {
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X' && buffer.length >= 30) return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
  if (chunk === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    return { width: 1 + buffer[21] + ((buffer[22] & 0x3f) << 8), height: 1 + (buffer[22] >> 6) + (buffer[23] << 2) + ((buffer[24] & 0x0f) << 10) };
  }
  if (chunk === 'VP8 ') {
    const marker = buffer.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20);
    if (marker >= 0 && marker + 7 <= buffer.length) return { width: buffer.readUInt16LE(marker + 3) & 0x3fff, height: buffer.readUInt16LE(marker + 5) & 0x3fff };
  }
  return null;
}

export function inspectImage(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new AiRouterError('Image attachment is empty or corrupt.', 'ATTACHMENT_CORRUPT_IMAGE');
  let mimeType = null; let dimensions = null;
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString('ascii', 12, 16) === 'IHDR') {
    mimeType = 'image/png'; dimensions = { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } else if (buffer.length >= 12 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.at(-2) === 0xff && buffer.at(-1) === 0xd9) {
    mimeType = 'image/jpeg'; dimensions = jpegDimensions(buffer);
  } else if (buffer.length >= 20 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    mimeType = 'image/webp'; dimensions = webpDimensions(buffer);
  }
  if (!mimeType || !dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 50_000 || dimensions.height > 50_000) {
    throw new AiRouterError('Image attachment is corrupt or uses an unsupported image encoding.', 'ATTACHMENT_CORRUPT_IMAGE');
  }
  return { mime_type: mimeType, width: dimensions.width, height: dimensions.height };
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new AiRouterError('Attachment data must be valid base64.', 'ATTACHMENT_INVALID_DATA');
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length > MAX_IMAGE_BYTES) throw new AiRouterError(`Image attachments may not exceed ${MAX_IMAGE_BYTES} bytes.`, 'ATTACHMENT_TOO_LARGE', { max_bytes: MAX_IMAGE_BYTES });
  return buffer;
}

function safeFilename(value, mimeType) {
  const fallback = `image${EXTENSIONS[mimeType]}`;
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const name = path.basename(value.trim()).replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120);
  return name || fallback;
}

async function exists(file) { try { await stat(file); return true; } catch { return false; } }

export class AttachmentStore {
  constructor(dataRoot, options = {}) {
    this.root = resolveWithin(dataRoot, 'attachments');
    this.now = options.now ?? (() => Date.now());
    this.stagedTtlMs = options.stagedTtlMs ?? STAGED_ATTACHMENT_TTL_MS;
    this.taskRetentionMs = options.taskRetentionMs ?? TASK_ATTACHMENT_RETENTION_MS;
  }

  stagedPath(id, extension = '') { return resolveWithin(this.root, 'staged', `${id}${extension}`); }
  taskDirectory(projectId, taskId) { return resolveWithin(this.root, 'tasks', projectId, taskId); }

  async stage(input = {}) {
    if (input.draft_id !== undefined && (typeof input.draft_id !== 'string' || !/^[0-9a-f-]{36}$/.test(input.draft_id))) throw new AiRouterError('Attachment draft ID is invalid.', 'ARTP_ATTACHMENT_INVALID');
    await this.cleanup();
    if (!IMAGE_MIME_TYPES.includes(input.mime_type)) throw new AiRouterError('Only PNG, JPEG, and WebP image attachments are supported.', 'ATTACHMENT_UNSUPPORTED_TYPE', { supported: IMAGE_MIME_TYPES });
    const buffer = decodeBase64(input.data_base64);
    const inspected = inspectImage(buffer);
    if (inspected.mime_type !== input.mime_type) throw new AiRouterError('Declared image type does not match the file content.', 'ATTACHMENT_MIME_MISMATCH', { detected_mime_type: inspected.mime_type });
    const attachmentId = `att-${randomUUID()}`; const extension = EXTENSIONS[inspected.mime_type];
    const createdAt = new Date(this.now()).toISOString();
    const metadata = {
      attachment_id: attachmentId, type: 'image', mime_type: inspected.mime_type,
      filename: safeFilename(input.filename, inspected.mime_type), width: inspected.width, height: inspected.height,
      size_bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'),
      draft_id: input.draft_id ?? null,
      purpose: input.purpose === 'visual_reference' ? input.purpose : 'visual_reference',
      source: { kind: 'attachment_store', attachment_id: attachmentId }, created_at: createdAt, raw_retained: true
    };
    await mkdir(path.dirname(this.stagedPath(attachmentId)), { recursive: true });
    await writeFile(this.stagedPath(attachmentId, extension), buffer, { mode: 0o600 });
    await writeFile(this.stagedPath(attachmentId, '.json'), `${JSON.stringify({ ...metadata, extension }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return metadata;
  }

  async inspectDraft(ids, draftId) {
    if (typeof draftId !== 'string' || !/^[0-9a-f-]{36}$/.test(draftId) || !Array.isArray(ids) || ids.length > MAX_TASK_IMAGES || new Set(ids).size !== ids.length) throw new AiRouterError('Attachment draft references are invalid.', 'ARTP_ATTACHMENT_INVALID');
    const records = [];
    for (const id of ids) {
      if (typeof id !== 'string' || !/^att-[0-9a-f-]{36}$/.test(id)) throw new AiRouterError('Attachment reference is invalid.', 'ARTP_ATTACHMENT_NOT_FOUND');
      let record; try { record = JSON.parse(await readFile(this.stagedPath(id, '.json'), 'utf8')); }
      catch { throw new AiRouterError('Attachment draft is missing.', 'ARTP_ATTACHMENT_NOT_FOUND'); }
      if (record.draft_id !== draftId) throw new AiRouterError('Attachment belongs to another draft.', 'ARTP_ATTACHMENT_OWNERSHIP');
      if (!IMAGE_MIME_TYPES.includes(record.mime_type)) throw new AiRouterError('Attachment MIME is unsupported.', 'ARTP_ATTACHMENT_INVALID');
      if (this.now() - Date.parse(record.created_at) > this.stagedTtlMs) throw new AiRouterError('Attachment draft expired.', 'ARTP_ATTACHMENT_NOT_FOUND');
      const content = await readFile(this.stagedPath(id, EXTENSIONS[record.mime_type])).catch(() => { throw new AiRouterError('Attachment bytes are missing.', 'ARTP_ATTACHMENT_NOT_FOUND'); });
      if (content.length !== record.size_bytes || createHash('sha256').update(content).digest('hex') !== record.sha256) throw new AiRouterError('Attachment draft integrity failed.', 'ARTP_ATTACHMENT_INVALID');
      records.push({ attachment_id: record.attachment_id, type: record.type, mime_type: record.mime_type, size_bytes: record.size_bytes, sha256: record.sha256, width: record.width, height: record.height, filename: record.filename });
    }
    return records;
  }

  async claim(ids, projectId, taskId) {
    const unique = [...new Set(ids ?? [])];
    if (unique.length > MAX_TASK_IMAGES) throw new AiRouterError(`A task may include at most ${MAX_TASK_IMAGES} images.`, 'ATTACHMENT_COUNT_EXCEEDED', { max_attachments: MAX_TASK_IMAGES });
    const records = [];
    for (const id of unique) {
      if (typeof id !== 'string' || !/^att-[0-9a-f-]{36}$/.test(id)) throw new AiRouterError('Attachment reference is invalid.', 'ATTACHMENT_INVALID_REFERENCE');
      let record; try { record = JSON.parse(await readFile(this.stagedPath(id, '.json'), 'utf8')); }
      catch { throw new AiRouterError('Attachment is missing or has expired.', 'ATTACHMENT_NOT_FOUND'); }
      if (this.now() - Date.parse(record.created_at) > this.stagedTtlMs) throw new AiRouterError('Attachment staging period has expired. Attach the image again.', 'ATTACHMENT_EXPIRED');
      records.push(record);
    }
    if (records.reduce((sum, item) => sum + item.size_bytes, 0) > MAX_TASK_IMAGE_BYTES) throw new AiRouterError(`Combined image attachments may not exceed ${MAX_TASK_IMAGE_BYTES} bytes.`, 'ATTACHMENT_TOTAL_TOO_LARGE', { max_bytes: MAX_TASK_IMAGE_BYTES });
    const destination = this.taskDirectory(projectId, taskId); await mkdir(destination, { recursive: true });
    for (const record of records) {
      await rename(this.stagedPath(record.attachment_id, record.extension), resolveWithin(destination, `${record.attachment_id}${record.extension}`));
      await rename(this.stagedPath(record.attachment_id, '.json'), resolveWithin(destination, `${record.attachment_id}.json`));
    }
    return records.map(({ extension: _extension, ...record }) => record);
  }

  async resolve(projectId, taskId, attachments = []) {
    const directory = this.taskDirectory(projectId, taskId); const resolved = [];
    for (const attachment of attachments) {
      let record; try { record = JSON.parse(await readFile(resolveWithin(directory, `${attachment.attachment_id}.json`), 'utf8')); }
      catch { throw new AiRouterError(`Attachment '${attachment.attachment_id}' is missing.`, 'ATTACHMENT_NOT_FOUND'); }
      const localPath = resolveWithin(directory, `${attachment.attachment_id}${record.extension}`);
      if (!record.raw_retained || !(await exists(localPath))) throw new AiRouterError(`Attachment '${attachment.attachment_id}' is no longer retained. Attach the image again.`, 'ATTACHMENT_RAW_EXPIRED');
      resolved.push({ ...attachment, path: localPath });
    }
    return resolved;
  }

  async removeTask(projectId, taskId) { await rm(this.taskDirectory(projectId, taskId), { recursive: true, force: true }); }

  async cleanup() {
    const staged = resolveWithin(this.root, 'staged');
    for (const entry of await readdir(staged, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const metadataPath = resolveWithin(staged, entry.name);
      try {
        const record = JSON.parse(await readFile(metadataPath, 'utf8'));
        if (this.now() - Date.parse(record.created_at) <= this.stagedTtlMs) continue;
        await rm(this.stagedPath(record.attachment_id, record.extension), { force: true }); await rm(metadataPath, { force: true });
      } catch { await rm(metadataPath, { force: true }); }
    }
    const tasksRoot = resolveWithin(this.root, 'tasks');
    for (const project of await readdir(tasksRoot, { withFileTypes: true }).catch(() => [])) if (project.isDirectory()) {
      const projectRoot = resolveWithin(tasksRoot, project.name);
      for (const task of await readdir(projectRoot, { withFileTypes: true }).catch(() => [])) if (task.isDirectory()) {
        const taskRoot = resolveWithin(projectRoot, task.name);
        for (const entry of await readdir(taskRoot, { withFileTypes: true }).catch(() => [])) if (entry.isFile() && entry.name.endsWith('.json')) {
          const metadataPath = resolveWithin(taskRoot, entry.name);
          try {
            const record = JSON.parse(await readFile(metadataPath, 'utf8'));
            if (!record.raw_retained || this.now() - Date.parse(record.created_at) <= this.taskRetentionMs) continue;
            await rm(resolveWithin(taskRoot, `${record.attachment_id}${record.extension}`), { force: true });
            await writeFile(metadataPath, `${JSON.stringify({ ...record, raw_retained: false, raw_removed_at: new Date(this.now()).toISOString() }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
          } catch {}
        }
      }
    }
  }
}
