#!/usr/bin/env node
import { access, mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, validateConfig } from '../config/index.js';

const mode = process.argv[2] === 'stop' ? 'stop' : 'start';
const config = await validateConfig(await loadConfig());
const statePath = path.join(config.dataRoot, 'control', 'service.json');
const logPath = path.join(config.dataRoot, 'logs', 'control-service.log');

async function state() { try { return JSON.parse(await readFile(statePath, 'utf8')); } catch { return null; } }
async function health(current) {
  if (!current?.url || !/^http:\/\/127\.0\.0\.1:\d+$/.test(current.url)) return null;
  try {
    const response = await fetch(`${current.url}/api/health`, { signal: AbortSignal.timeout(1_000) });
    return response.ok ? { current, nonce: response.headers.get('x-ai-router-control') } : null;
  } catch { return null; }
}
async function waitForService() {
  for (let count = 0; count < 80; count += 1) {
    const ready = await health(await state()); if (ready) return ready;
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error('AI Router did not become ready. See the local control-service log.');
}
function openBrowser(url) {
  if (process.env.AI_ROUTER_NO_BROWSER === '1') return;
  spawn('cmd.exe', ['/d', '/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

async function main() {
  if (mode === 'stop') {
    const running = await health(await state());
    if (!running) return;
    await fetch(`${running.current.url}/api/shutdown`, { method: 'POST', headers: { origin: running.current.url, 'content-type': 'application/json', 'x-ai-router-control': running.nonce }, body: '{}' });
    return;
  }

  const existing = await health(await state());
  if (existing) { openBrowser(existing.current.url); return; }
  await mkdir(path.dirname(logPath), { recursive: true });
  const log = await open(logPath, 'a');
  const child = spawn(process.execPath, [new URL('./control-service.js', import.meta.url).pathname.replace(/^\/(.:)/, '$1')], {
    cwd: path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1')), detached: true,
    stdio: ['ignore', log.fd, log.fd], windowsHide: true, env: { ...process.env }
  });
  child.unref(); await log.close();
  const ready = await waitForService(); openBrowser(ready.current.url);
}

await main();
