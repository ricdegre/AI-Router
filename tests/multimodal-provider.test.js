import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDirectory } from './helpers.js';
import { OllamaProvider } from '../providers/ollama/ollama-provider.js';
import { OpenRouterProvider } from '../providers/openrouter/openrouter-provider.js';
import { ClaudeCodeProvider } from '../providers/anthropic/claude-code-provider.js';

async function image(t) { const root = await temporaryDirectory(t, 'provider-image-'); const file = path.join(root, 'screen.png'); await writeFile(file, Buffer.from('private-image-bytes')); return file; }

test('Ollama serializes attached images through the native images field', async (t) => {
  const file = await image(t); let body; const provider = new OllamaProvider({ fetch: async (_url, options) => { body = JSON.parse(options.body); return new Response(JSON.stringify({ model: 'vision-local', message: { content: 'blue panel' }, done: true }), { headers: { 'content-type': 'application/json' } }); } });
  const result = await provider.execute({ model: 'vision-local', prompt: 'Describe it', attachments: [{ path: file, mime_type: 'image/png' }] });
  assert.equal(result.output, 'blue panel'); assert.deepEqual(body.messages[0].images, [Buffer.from('private-image-bytes').toString('base64')]); assert.equal(body.messages[0].content, 'Describe it');
});

test('OpenRouter serializes attached images as provider-native image_url content', async (t) => {
  const file = await image(t); let request; const provider = new OpenRouterProvider({ secretStore: { get: async () => 'key' } }); provider.request = async (_path, options) => { request = options.body; return { model: 'visual-free', choices: [{ message: { content: 'green button' } }] }; };
  const result = await provider.execute({ profile_id: 'free', model: 'visual-free', prompt: 'Describe it', attachments: [{ path: file, mime_type: 'image/png' }] });
  assert.equal(result.output, 'green button'); assert.equal(request.messages[0].content[0].type, 'text'); assert.match(request.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
});

test('Claude Code receives absolute image paths without enabling tools', async (t) => {
  const file = await image(t); let call; const worker = { runStreaming: async (_profile, args, options) => { call = { args, options }; const response = JSON.stringify({ schema_version: '0.1', status: 'ok', summary: 'I see the image.', observations: [], proposed_actions: [], validation_requested: [], remaining_work: [], uncertainty: [], handoff_notes: [] }); return { stdout: `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: response })}\n` }; } };
  const provider = new ClaudeCodeProvider({ worker }); const result = await provider.executeStructured({ profile: { profile_id: 'claude' }, model: 'sonnet', prompt: 'Describe it', context: '', task_analysis: { write_mode: 'read_only' }, attachments: [{ path: file, mime_type: 'image/png' }] });
  assert.equal(result.structured.summary, 'I see the image.'); assert.match(call.args[1], new RegExp(file.replaceAll('\\', '\\\\'))); assert.ok(call.args.includes('--tools')); assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
});
