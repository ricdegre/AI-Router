import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelDescriptor, resolvedModelValue } from '../providers/core/model-descriptor.js';
import { parseStructuredResponse } from '../providers/core/structured-response.js';
import { buildStructuredTaskPrompt } from '../providers/core/task-prompt.js';

const valid = {
  schema_version: '0.1', status: 'ok', summary: 'done', observations: [], proposed_actions: [],
  validation_requested: [], remaining_work: [], uncertainty: [], handoff_notes: []
};

test('structured response accepts JSON and whole markdown JSON fences', () => {
  assert.equal(parseStructuredResponse(JSON.stringify(valid)).response.summary, 'done');
  assert.equal(parseStructuredResponse(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``).response.status, 'ok');
});

test('a JSON object wrapped in prose or in a mid-text fence is still read', () => {
  assert.equal(parseStructuredResponse(`Here is the result:\n${JSON.stringify(valid)}\nDone.`, { allowTextFallback: false }).response.summary, 'done');
  assert.equal(parseStructuredResponse(`Result below.\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``, { allowTextFallback: false }).response.status, 'ok');
  assert.throws(() => parseStructuredResponse('Sorry, {not json} here', { allowTextFallback: false }), { code: 'MALFORMED_STRUCTURED_RESPONSE' });
});

test('structured response rejects malformed, oversized, and adversarial data', () => {
  assert.throws(() => parseStructuredResponse('{bad json'), { code: 'MALFORMED_STRUCTURED_RESPONSE' });
  assert.throws(() => parseStructuredResponse(JSON.stringify({ ...valid, token: 'forbidden' })), { code: 'UNSAFE_STRUCTURED_RESPONSE' });
  assert.throws(() => parseStructuredResponse(JSON.stringify({ ...valid, proposed_actions: ['shell rm'] })), { code: 'INVALID_STRUCTURED_RESPONSE' });
  assert.throws(() => parseStructuredResponse('x'.repeat(100), { maxBytes: 10 }), { code: 'PROVIDER_OUTPUT_TOO_LARGE' });
});

test('structured response rejects provider actions outside the mediator protocol', () => {
  assert.throws(() => parseStructuredResponse(JSON.stringify({ ...valid, proposed_actions: [{ id: 'edit', instruction: 'change file', file_path: 'index.html' }] })), { code: 'INVALID_ACTION_PROTOCOL' });
  assert.doesNotThrow(() => parseStructuredResponse(JSON.stringify({ ...valid, proposed_actions: [{ action_id: 'edit-index', type: 'modify_file', target: 'index.html', parameters: { patch: {} } }] })));
});

test('plain text fallback is explicit and never marked valid', () => {
  const parsed = parseStructuredResponse('A plain observation.', { allowTextFallback: true });
  assert.equal(parsed.valid, false);
  assert.equal(parsed.fallback, true);
  assert.ok(parsed.response.uncertainty.length > 0);
  assert.throws(() => parseStructuredResponse('plain', { allowTextFallback: false }), { code: 'MALFORMED_STRUCTURED_RESPONSE' });
});

test('read-only worker prompt requires the actual requested answer in the visible summary', () => {
  const prompt = buildStructuredTaskPrompt({ task_analysis: { write_mode: 'read_only' }, prompt: 'Read the numbers in the attached image.' });
  assert.match(prompt, /Put the actual answer requested by the user in summary/);
  assert.match(prompt, /including any exact names, numbers, or visual values requested/);
  assert.match(prompt, /never replace the answer with a statement that you completed or transcribed it/);
});

test('write worker prompt distinguishes a complete action plan from unfinished work', () => {
  const prompt = buildStructuredTaskPrompt({ task_analysis: { write_mode: 'write' }, prompt: 'Create one file.' });
  assert.match(prompt, /If your proposed actions fully satisfy the requested change, use status "ok" with empty remaining_work/);
  assert.match(prompt, /AI Router applies and validates those actions after your response/);
  assert.match(prompt, /one modify_file action per place on the same target/);
  assert.match(prompt, /Never claim a change in summary that your actions do not make/);
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

test('the provider JSON schema requires a target for file actions but not for Git status or validation commands', async () => {
  const { STRUCTURED_RESPONSE_JSON_SCHEMA } = await import('../providers/core/structured-response.js');
  const [fileAction, targetless] = STRUCTURED_RESPONSE_JSON_SCHEMA.properties.proposed_actions.items.anyOf;
  assert.ok(fileAction.required.includes('target')); assert.ok(fileAction.properties.type.enum.includes('modify_file'));
  assert.ok(!targetless.required.includes('target')); assert.deepEqual(targetless.properties.type.enum, ['inspect_git_status', 'run_validation_command']);
  const missingTarget = JSON.stringify({ schema_version: '0.1', status: 'ok', summary: 'Done.', observations: [], proposed_actions: [{ action_id: 'complete-demo-status', type: 'modify_file', parameters: {} }], validation_requested: [], remaining_work: [], uncertainty: [], handoff_notes: [] });
  assert.throws(() => parseStructuredResponse(missingTarget), { code: 'INVALID_ACTION_PROTOCOL' });
});
