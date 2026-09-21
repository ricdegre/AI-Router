import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('dashboard exposes every required operational page and resilient UI state', async () => {
  const app = await readFile(new URL('../interfaces/dashboard/app.js', import.meta.url), 'utf8');
  for (const page of ['overview','projects','providers','profiles','models','tasks','routing','memory','handoffs','checkpoints','locks','audit','doctor','settings']) assert.match(app, new RegExp(`['\"]${page}['\"]`));
  for (const state of ['loading-page','empty','error-page','Local service unavailable']) assert.match(app, new RegExp(state));
  assert.doesNotMatch(app, /https?:\/\//);
});

test('dashboard visual system includes responsive, accessible light and dark modes', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('../interfaces/dashboard/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../interfaces/dashboard/styles.css', import.meta.url), 'utf8')
  ]);
  assert.match(html, /skip-link/); assert.match(html, /aria-label="Primary navigation"/);
  assert.match(css, /data-theme="dark"/); assert.match(css, /prefers-color-scheme/); assert.match(css, /@media\(max-width:760px\)/);
});

test('automatic refresh is incremental and never reloads or re-renders the page', async () => {
  const app = await readFile(new URL('../interfaces/dashboard/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /(?:window\.)?location\.reload\s*\(/);
  assert.doesNotMatch(app, /setInterval\s*\([^\n]*\brender\s*\(/);
  assert.match(app, /setInterval\(\(\)=>refreshCurrent\('tasks'\),POLL_INTERVALS\.tasks\)/);
  assert.match(app, /setInterval\(\(\)=>refreshCurrent\('health'\),Math\.min\(60_000,Math\.max\(10_000,healthInterval\)\)\)/);
  assert.match(app, /setInterval\(\(\)=>refreshCurrent\('static'\),POLL_INTERVALS\.static\)/);
  const incremental = app.slice(app.indexOf('async function refreshCurrent'), app.indexOf('const renderers='));
  assert.doesNotMatch(incremental, /workspace\.innerHTML|\brender\s*\(/);
});

test('polling uses bounded tiers and retains stale data on failure', async () => {
  const app = await readFile(new URL('../interfaces/dashboard/app.js', import.meta.url), 'utf8');
  assert.match(app, /tasks:\s*4_000/);
  assert.match(app, /health:\s*12_000/);
  assert.match(app, /static:\s*45_000/);
  assert.match(app, /catch\{markStale\(\);\}/);
  assert.match(app, /Using last known state/);
  assert.match(app, /document\.querySelector\('#refresh-button'\)\.addEventListener\('click',\(\)=>refreshCurrent\('manual'\)\)/);
});

test('dashboard exposes optional Jev controls, status, and auditable route evidence', async () => {
  const app = await readFile(new URL('../interfaces/dashboard/app.js', import.meta.url), 'utf8');
  for (const text of ['Decision Engines', 'Jev Decision Engine', 'Deterministic Only', 'Jev Assisted', 'Hybrid', 'Confidence threshold', 'Initial routing', 'Retry / escalation', 'Action risk', 'Handoff quality', 'Context relevance', 'Real Jev connection not enabled yet.', 'Hard rules', 'Jev classification', 'Deterministic policy']) assert.match(app, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(app, /\/api\/decision-engines\/config/);
  assert.match(app, /connect-jev/);
});
