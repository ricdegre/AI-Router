import path from 'node:path';
import { resolveWithin } from '../../core/paths.js';
import { readJson, updateJsonAtomic } from '../../core/json-store.js';

const INITIAL = Object.freeze({ usage_version: '0.1', events: [] });
const since = (events, ms) => events.filter((item) => Date.now() - Date.parse(item.at) <= ms);
const sumKnown = (events) => events.reduce((sum, item) => sum + (item.estimated_cost ?? 0), 0);

export class DecisionUsageStore {
  constructor(dataRoot) { this.filePath = resolveWithin(path.resolve(dataRoot), 'decision-engines', 'usage.json'); }
  async record(data) {
    await updateJsonAtomic(this.filePath, INITIAL, (current) => ({ ...current, events: [...(current.events ?? []).slice(-9_999), { at: new Date().toISOString(), category: 'METERED_DECISION', estimated_cost: data.estimated_cost ?? null, currency: data.currency ?? null, estimated_input_tokens: data.estimated_input_tokens ?? null }] }));
  }
  async summary() {
    const state = await readJson(this.filePath, INITIAL); const events = state.events ?? [];
    const make = (items) => ({ request_count: items.length, estimated_cost: !items.length || items.some((item) => item.estimated_cost == null) ? null : sumKnown(items), currency: items.find((item) => item.currency)?.currency ?? null });
    return { category: 'METERED_DECISION', daily: make(since(events, 86_400_000)), weekly: make(since(events, 604_800_000)), monthly: make(since(events, 2_592_000_000)) };
  }
}
