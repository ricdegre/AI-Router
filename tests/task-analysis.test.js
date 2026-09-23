import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTask } from '../routing/task-analysis.js';

test('task analysis classifies project analysis before resource routing', () => {
  const analysis = analyzeTask({ objective: 'Analyze this entire project without modifying files', task_type: 'analysis', risk: 'low' });
  assert.equal(analysis.intent, 'project_analysis');
  assert.equal(analysis.scope, 'project');
  assert.equal(analysis.write_mode, 'read_only');
  assert.equal(analysis.complexity, 'high');
  assert.equal(analysis.required_strength, 'strong');
  for (const capability of ['filesystem_read', 'repository_navigation', 'code_understanding', 'long_context']) assert.ok(analysis.required_capabilities.includes(capability));
  assert.equal(analysis.parallelizable, true);
});

test('task analysis distinguishes a small writable selection from project work', () => {
  const analysis = analyzeTask({ objective: 'Change this selected CSS color', has_selection: true, task_type: 'coding' });
  assert.equal(analysis.intent, 'edit');
  assert.equal(analysis.scope, 'selection');
  assert.equal(analysis.write_mode, 'write_allowed');
  assert.equal(analysis.complexity, 'trivial');
  assert.deepEqual(analysis.routing_capabilities, ['coding']);
});
