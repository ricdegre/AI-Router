import { createHash } from 'node:crypto';
import { AiRouterError } from '../core/errors.js';


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
  // Several edits to one file are applied in order; each must match exactly once in the text left by the previous one.
  const edits = Array.isArray(patch.edits) ? patch.edits : [{ search: patch.search, replacement: patch.replacement }];
  if (!edits.length || edits.length > 50) throw new AiRouterError('Changeset must contain between 1 and 50 edits.', 'INVALID_CHANGESET');
  let updated = source;
  // Models write LF; a CRLF file (common on Windows) would never match, so adapt the edit to the file's line endings.
  const crlf = source.includes('\r\n');
  for (const original of edits) {
    if (typeof original?.search !== 'string' || original.search.length === 0 || typeof original.replacement !== 'string') {
      throw new AiRouterError('Changeset search and replacement must be strings.', 'INVALID_CHANGESET');
    }
    const toFile = (text) => (crlf && !text.includes('\r') ? text.replace(/\n/g, '\r\n') : text);
    const edit = { search: updated.includes(original.search) ? original.search : toFile(original.search), replacement: toFile(original.replacement) };
    let count = 0;
    let index = updated.indexOf(edit.search);
    while (index >= 0) {
      count += 1;
      index = updated.indexOf(edit.search, index + Math.max(1, edit.search.length));
    }
    if (count === 0) throw new AiRouterError('Changeset source text was not found.', 'PATCH_SOURCE_NOT_FOUND');
    if (count > 1) throw new AiRouterError('Changeset source text is ambiguous.', 'AMBIGUOUS_CHANGESET', { matches: count });
    updated = updated.replace(edit.search, () => edit.replacement);
  }
  return {
    content: updated,
    summary: edits.length === 1 ? `Replaced one exact ${edits[0].search.length}-character region with ${edits[0].replacement.length} characters.` : `Applied ${edits.length} exact replacements in order.`,
    before_sha256: actual,
    after_sha256: contentHash(updated)
  };
}

