import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ProviderError } from './protocol.js';

export async function readVerifiedImage(attachment, providerId) {
  try {
    if (attachment?.modality && attachment.modality !== 'image') throw new Error('Unsupported modality');
    const bytes = await readFile(attachment.path);
    if (attachment.size_bytes != null && bytes.length !== attachment.size_bytes) throw new Error('Image size changed');
    if (attachment.sha256 && createHash('sha256').update(bytes).digest('hex') !== attachment.sha256) throw new Error('Image hash changed');
    return bytes;
  } catch {
    throw new ProviderError('Resolved image could not be delivered safely.', 'ATTACHMENT_TRANSPORT_FAILED', { providerId, failureCategory: 'execution_failure' });
  }
}
