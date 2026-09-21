import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ValidationCommandRegistry, ValidationEngine } from '../validation/validation-engine.js';
import { temporaryDirectory } from './helpers.js';

test('validation engine separates router evidence from model claims', async (t) => {
  const workspace = path.join(await temporaryDirectory(t), 'workspace');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'data.json'), '{"ok":true}\n');
  const engine = new ValidationEngine({ workspaceRoot: workspace });
  const report = await engine.validate([
    { validation_id: 'exists', type: 'file_exists', target: 'data.json' },
    { validation_id: 'json', type: 'json_parses', target: 'data.json' },
    { validation_id: 'contains', type: 'contains_text', target: 'data.json', expected: '"ok":true' }
  ]);
  assert.equal(report.passed, true);
  assert.equal(report.results.length, 3);
});

test('validation fails independently even when a model might claim success', async (t) => {
  const workspace = path.join(await temporaryDirectory(t), 'workspace');
  await mkdir(workspace);
  await writeFile(path.join(workspace, 'value.txt'), 'wrong');
  const report = await new ValidationEngine({ workspaceRoot: workspace }).validate([
    { validation_id: 'exact', type: 'exact_content', target: 'value.txt', expected: 'right' }
  ]);
  assert.equal(report.passed, false);
});

test('validation commands are fixed allowlist entries with no shell strings from models', async (t) => {
  const workspace = path.join(await temporaryDirectory(t), 'workspace');
  await mkdir(workspace);
  const commands = new ValidationCommandRegistry();
  commands.register('node-ok', { command: process.execPath, args: ['-e', 'process.exit(0)'], timeout_ms: 2_000 });
  const engine = new ValidationEngine({ workspaceRoot: workspace, commandRegistry: commands });
  assert.equal((await engine.validate([{ validation_id: 'command-ok', type: 'command', command_id: 'node-ok' }])).passed, true);
  const rejected = await engine.validate([{ validation_id: 'command-bad', type: 'command', command_id: 'model-supplied-shell' }]);
  assert.equal(rejected.passed, false);
  assert.equal(rejected.results[0].error.code, 'VALIDATION_COMMAND_NOT_ALLOWED');
});

