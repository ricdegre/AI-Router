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
