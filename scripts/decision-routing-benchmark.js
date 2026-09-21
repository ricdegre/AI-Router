import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntimeServices } from '../core/runtime-services.js';
import { ProviderAdapter } from '../providers/core/protocol.js';

class BenchmarkProvider extends ProviderAdapter {
  constructor(id, { health = 'healthy', strength = 'standard', local = false } = {}) { super({ id, name: id, type: 'mock', strength_class: strength, capabilities: ['chat', 'coding', 'filesystem', 'web', 'vision', ...(local ? ['local'] : [])], authentication_modes: ['none'] }); this.currentHealth = health; }
  async health() { return { status: this.currentHealth }; }
  async execute() { return { status: 'completed' }; }
}

const dataset = JSON.parse(await readFile(new URL('../tests/fixtures/routing-benchmark.json', import.meta.url), 'utf8'));
const modes = ['deterministic_only', 'jev_assisted', 'hybrid'];
const root = await mkdtemp(path.join(os.tmpdir(), 'ai-router-benchmark-'));
const rows = [];
try {
  for (const mode of modes) for (const scenario of dataset) {
    const dataRoot = path.join(root, mode, scenario.id);
    const localHealth = scenario.id === 'local-offline' ? 'unavailable' : 'healthy';
    const cloudHealth = scenario.id === 'cloud-unavailable' ? 'unavailable' : 'healthy';
    const services = createRuntimeServices({ dataRoot, projectRoots: [], sourceRoot: root }, { registerOllama: false, providers: [new BenchmarkProvider('local', { health: localHealth, local: true }), new BenchmarkProvider('cloud', { health: cloudHealth, strength: 'strong' })] });
    await services.profileRegistry.register({ profile_id: 'local', provider_id: 'local', display_name: 'Local', enabled: true, status: 'available', cost_category: 'local', auth_mode: 'none', location: 'local' });
    await services.profileRegistry.register({ profile_id: 'cloud', provider_id: 'cloud', display_name: 'Cloud', enabled: true, status: 'available', cost_category: 'subscription', auth_mode: 'none', location: 'cloud', limits: scenario.id === 'subscription-exhausted' ? { availability: 'available', remaining_percentage: 0 } : { availability: 'available' } });
    await services.decisionEngineConfigStore.update({ mode, enabled: mode !== 'deterministic_only' });
    const started = performance.now();
    const result = await services.routingPolicy.explain({ objective: scenario.objective, risk: scenario.risk, required_capabilities: scenario.capabilities }, services.providerRegistry, await services.profileRegistry.list());
    rows.push({ scenario: scenario.id, mode, selected_tier: result.selected?.strength_class ?? null, selected_provider: result.selected?.provider_id ?? null, confidence: result.decision_engine.confidence ?? null, policy_violations: result.rejected_candidates.filter((item) => item.eligible).length, fallback: result.decision_engine.fallback, decision_latency_ms: Number((performance.now() - started).toFixed(2)) });
  }
  const summary = modes.map((mode) => { const group = rows.filter((row) => row.mode === mode); return { mode, runs: group.length, routes_found: group.filter((row) => row.selected_provider).length, fallback_rate: group.filter((row) => row.fallback).length / group.length, policy_violations: group.reduce((sum, row) => sum + row.policy_violations, 0), average_latency_ms: Number((group.reduce((sum, row) => sum + row.decision_latency_ms, 0) / group.length).toFixed(2)) }; });
  console.log(JSON.stringify({ benchmark_version: '0.1', purpose: 'plumbing-validation-only', claim_of_jev_superiority: false, scenarios: dataset.length, summary, rows }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
