import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDirectory } from './helpers.js';
import { OllamaProvider } from '../providers/ollama/ollama-provider.js';
import { ApiConnectionProvider } from '../providers/connections/api-connection-provider.js';
import { CONNECTION_PRESETS } from '../providers/connections/presets.js';
import { validateConnection } from '../core/connection-store.js';
import { ClaudeCodeProvider } from '../providers/anthropic/claude-code-provider.js';

async function image(t) { const root = await temporaryDirectory(t, 'provider-image-'); const file = path.join(root, 'screen.png'); await writeFile(file, Buffer.from('private-image-bytes')); return file; }

test('Ollama serializes attached images through the native images field', async (t) => {
  const file = await image(t); let body; const provider = new OllamaProvider({ fetch: async (_url, options) => { body = JSON.parse(options.body); return new Response(JSON.stringify({ model: 'vision-local', message: { content: 'blue panel' }, done: true }), { headers: { 'content-type': 'application/json' } }); } });
  const result = await provider.execute({ model: 'vision-local', prompt: 'Describe it', attachments: [{ path: file, mime_type: 'image/png' }] });
  assert.equal(result.output, 'blue panel'); assert.deepEqual(body.messages[0].images, [Buffer.from('private-image-bytes').toString('base64')]); assert.equal(body.messages[0].content, 'Describe it');
});

test('API connections serialize attached images in the native form of each dialect', async (t) => {
  const file = await image(t); const base64 = Buffer.from('private-image-bytes').toString('base64');
  const make = (id) => { const provider = new ApiConnectionProvider(validateConnection(CONNECTION_PRESETS.find((item) => item.id === id)), { secretStore: { get: async () => 'key' } }); provider.request = async (_path, options) => { provider.sent = options.body; return { choices: [{ message: { content: 'green button' } }], content: [{ type: 'text', text: 'green button' }], candidates: [{ content: { parts: [{ text: 'green button' }] } }] }; }; return provider; };
  const openai = make('openrouter'); const result = await openai.execute({ profile_id: 'free', model: 'visual-free', prompt: 'Describe it', attachments: [{ path: file, mime_type: 'image/png' }] });
  assert.equal(result.output, 'green button'); assert.equal(openai.sent.messages[0].content[0].type, 'text'); assert.equal(openai.sent.messages[0].content[1].image_url.url, `data:image/png;base64,${base64}`);
  const anthropic = make('anthropic-api'); await anthropic.execute({ profile_id: 'p', model: 'm', prompt: 'Describe it', attachments: [{ path: file, mime_type: 'image/png' }] });
  assert.deepEqual(anthropic.sent.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } });
  const gemini = make('gemini-api'); await gemini.execute({ profile_id: 'p', model: 'm', prompt: 'Describe it', attachments: [{ path: file, mime_type: 'image/png' }] });
  assert.deepEqual(gemini.sent.contents[0].parts, [{ text: 'Describe it' }, { inline_data: { mime_type: 'image/png', data: base64 } }]);
});

test('Claude Code sends native image blocks over stream-json stdin without exposing local paths', async (t) => {
  const file = await image(t); let call; const worker = { runStreaming: async (_profile, args, options) => { call = { args, options }; const response = JSON.stringify({ schema_version: '0.1', status: 'ok', summary: 'I see the image.', observations: [], proposed_actions: [], validation_requested: [], remaining_work: [], uncertainty: [], handoff_notes: [] }); return { stdout: `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: response })}\n` }; } };
  const provider = new ClaudeCodeProvider({ worker }); const result = await provider.executeStructured({ profile: { profile_id: 'claude' }, model: 'sonnet', prompt: 'Describe it', context: '', task_analysis: { write_mode: 'read_only' }, attachments: [{ path: file, mime_type: 'image/png' }] });
  assert.equal(result.structured.summary, 'I see the image.');
  assert.equal(call.args[call.args.indexOf('--input-format') + 1], 'stream-json');
  assert.ok(!call.args.join(' ').includes(file));
  const input = JSON.parse(call.options.stdin.trim());
  assert.equal(input.message.content[1].type, 'image');
  assert.equal(input.message.content[1].source.media_type, 'image/png');
  assert.equal(input.message.content[1].source.data, Buffer.from('private-image-bytes').toString('base64'));
  assert.ok(call.args.includes('--tools')); assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
});
