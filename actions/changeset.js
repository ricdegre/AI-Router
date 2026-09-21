import { createHash } from 'node:crypto';
import { AiRouterError } from '../core/errors.js';

export const CHANGESET_VERSION = '0.1';

export function contentHash(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function applyExactReplacement(source, patch) {
  if (!patch || patch.kind !== 'exact_replace') throw new AiRouterError('Only exact_replace changesets are supported.', 'INVALID_CHANGESET');
  if (typeof patch.expected_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(patch.expected_sha256)) {
    throw new AiRouterError('Changeset requires an expected SHA-256.', 'INVALID_CHANGESET');
  }
  const actual = contentHash(source);
  if (actual !== patch.expected_sha256) throw new AiRouterError('Source changed after the changeset was proposed.', 'STALE_CHANGESET', { expected: patch.expected_sha256, actual });
  if (typeof patch.search !== 'string' || patch.search.length === 0 || typeof patch.replacement !== 'string') {
    throw new AiRouterError('Changeset search and replacement must be strings.', 'INVALID_CHANGESET');
  }
  let count = 0;
  let index = source.indexOf(patch.search);
  while (index >= 0) {
    count += 1;
    index = source.indexOf(patch.search, index + Math.max(1, patch.search.length));
  }
  if (count === 0) throw new AiRouterError('Changeset source text was not found.', 'PATCH_SOURCE_NOT_FOUND');
  if (count > 1) throw new AiRouterError('Changeset source text is ambiguous.', 'AMBIGUOUS_CHANGESET', { matches: count });
  const updated = source.replace(patch.search, patch.replacement);
  return {
    content: updated,
    summary: `Replaced one exact ${patch.search.length}-character region with ${patch.replacement.length} characters.`,
    before_sha256: actual,
    after_sha256: contentHash(updated)
  };
}

