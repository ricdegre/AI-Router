import test from 'node:test';
import assert from 'node:assert/strict';
import { runProviderConformance } from '../../providers/core/conformance.js';
import { MockProvider } from '../mock-provider.js';

test('generic provider conformance contract can validate future adapters', async () => {
  const adapter = new MockProvider('conformant-mock', {
    execute: async () => ({ status: 'completed', output: 'ok' })
  });
  const structuredText = JSON.stringify({
    schema_version: '0.1', status: 'ok', summary: 'conformant', observations: [], proposed_actions: [],
    validation_requested: [], remaining_work: [], uncertainty: [], handoff_notes: []
  });
  const report = await runProviderConformance(adapter, { executionRequest: { objective: 'test' }, structuredText });
  assert.equal(report.passed, true);
  assert.ok(report.checks.length >= 10);
});

test('generic provider conformance reports failures without throwing the suite', async () => {
  const adapter = new MockProvider('nonconformant-mock');
  adapter.capabilities = () => 'not-an-array';
  const report = await runProviderConformance(adapter);
  assert.equal(report.passed, false);
  assert.equal(report.checks.find((entry) => entry.name === 'capabilities').passed, false);
});

