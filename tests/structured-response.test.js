import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelDescriptor, resolvedModelValue } from '../providers/core/model-descriptor.js';
import { parseStructuredResponse } from '../providers/core/structured-response.js';

const valid = {
  schema_version: '0.1', status: 'ok', summary: 'done', observations: [], proposed_actions: [],
  validation_requested: [], remaining_work: [], uncertainty: [], handoff_notes: []
};

test('structured response accepts JSON and whole markdown JSON fences', () => {
  assert.equal(parseStructuredResponse(JSON.stringify(valid)).response.summary, 'done');
  assert.equal(parseStructuredResponse(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``).response.status, 'ok');
});

test('structured response rejects malformed, oversized, and adversarial data', () => {
  assert.throws(() => parseStructuredResponse('{bad json'), { code: 'MALFORMED_STRUCTURED_RESPONSE' });
  assert.throws(() => parseStructuredResponse(JSON.stringify({ ...valid, token: 'forbidden' })), { code: 'UNSAFE_STRUCTURED_RESPONSE' });
  assert.throws(() => parseStructuredResponse(JSON.stringify({ ...valid, proposed_actions: ['shell rm'] })), { code: 'INVALID_STRUCTURED_RESPONSE' });
  assert.throws(() => parseStructuredResponse('x'.repeat(100), { maxBytes: 10 }), { code: 'PROVIDER_OUTPUT_TOO_LARGE' });
});

test('plain text fallback is explicit and never marked valid', () => {
  const parsed = parseStructuredResponse('A plain observation.', { allowTextFallback: true });
  assert.equal(parsed.valid, false);
  assert.equal(parsed.fallback, true);
  assert.ok(parsed.response.uncertainty.length > 0);
  assert.throws(() => parseStructuredResponse('plain', { allowTextFallback: false }), { code: 'MALFORMED_STRUCTURED_RESPONSE' });
});

test('model descriptor keeps facts, overrides, and heuristics separate', () => {
  const model = createModelDescriptor({
    providerId: 'ollama', modelId: 'sample:latest',
    discovered: { local: true, context_size: 8192, vision: null },
    overrides: { coding_suitability: 'confirmed' },
    heuristics: { coding_suitability: 'unknown', strength_class: 'standard' }
  });
  assert.equal(model.discovered_facts.context_size, 8192);
  assert.equal(model.configured_overrides.coding_suitability, 'confirmed');
  assert.equal(resolvedModelValue(model, 'coding_suitability'), 'confirmed');
  assert.equal(resolvedModelValue(model, 'strength_class'), 'standard');
});

