import test from 'node:test';
import assert from 'node:assert/strict';
import { applyExactReplacement, contentHash } from '../actions/changeset.js';

test('edits written with LF apply to CRLF files and keep CRLF line endings', () => {
  const source = 'import A from "a";\r\nconst x = 1;\r\nexport default x;\r\n';
  const result = applyExactReplacement(source, { kind: 'exact_replace', expected_sha256: contentHash(source), edits: [
    { search: 'import A from "a";\nconst x = 1;', replacement: 'import A from "a";\nimport B from "b";\nconst x = 1;' },
    { search: 'export default x;', replacement: 'export default x + 1;' }
  ] });
  assert.equal(result.content, 'import A from "a";\r\nimport B from "b";\r\nconst x = 1;\r\nexport default x + 1;\r\n');
});

test('replacement text is inserted literally', () => {
  const source = 'price = PRICE;\n';
  const result = applyExactReplacement(source, { kind: 'exact_replace', expected_sha256: contentHash(source), search: 'PRICE', replacement: "'$&' + '$1'" });
  assert.equal(result.content, "price = '$&' + '$1';\n");
});

test('a single-line match in a CRLF file still gets CRLF in a multi-line replacement', () => {
  const source = 'a();\r\nb();\r\n';
  const result = applyExactReplacement(source, { kind: 'exact_replace', expected_sha256: contentHash(source), search: 'a();', replacement: 'a();\nx();' });
  assert.equal(result.content, 'a();\r\nx();\r\nb();\r\n');
});
