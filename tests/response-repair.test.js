import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStructuredResponse } from '../providers/core/structured-response.js';
import { applyExactReplacement, contentHash } from '../actions/changeset.js';

test('an append edit adds text after the earlier edits of the same changeset', () => {
  const source = 'one\ntwo\n';
  const result = applyExactReplacement(source, { kind: 'exact_replace', expected_sha256: contentHash(source), edits: [{ search: 'one', replacement: 'uno' }, { append: 'three\n' }] });
  assert.equal(result.content, 'uno\ntwo\nthree\n');
  const windows = 'one\r\n';
  assert.equal(applyExactReplacement(windows, { kind: 'exact_replace', expected_sha256: contentHash(windows), edits: [{ append: 'two\n' }] }).content, 'one\r\ntwo\r\n');
  assert.throws(() => applyExactReplacement(source, { kind: 'exact_replace', expected_sha256: contentHash(source), edits: [{ append: '' }] }), { code: 'INVALID_CHANGESET' });
});

test('an unescaped quote or line break inside a string is repaired instead of failing the attempt', () => {
  const valid = {
    schema_version: '0.1', status: 'ok', summary: 'done', observations: ['PLACEHOLDER', 'two\nlines'],
    proposed_actions: [{ action_id: 'edit-one', type: 'modify_file', target: 'a.js', parameters: { patch: { kind: 'exact_replace', search: 'x = "a"', replacement: 'x = "b"' } } }],
    validation_requested: [], remaining_work: [], uncertainty: [], handoff_notes: []
  };
  // The model forgot to escape the quotes around Total and wrote a real line break inside a string.
  const broken = JSON.stringify(valid).replace('PLACEHOLDER', 'The label "Total" is kept').replace('two\\nlines', 'two\nlines');
  assert.throws(() => JSON.parse(broken));
  const parsed = parseStructuredResponse(broken, { allowTextFallback: false });
  assert.equal(parsed.repaired, true);
  assert.deepEqual(parsed.response.observations, ['The label "Total" is kept', 'two\nlines']);
  assert.equal(parsed.response.proposed_actions[0].parameters.patch.search, 'x = "a"');
  // Valid JSON is never touched, and text that cannot be repaired still fails.
  assert.equal(parseStructuredResponse(JSON.stringify(valid)).repaired, false);
  assert.throws(() => parseStructuredResponse('{"schema_version":"0.1","status":"ok","summary":"a "b", c"}', { allowTextFallback: false }), { code: 'MALFORMED_STRUCTURED_RESPONSE' });
});
