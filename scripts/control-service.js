#!/usr/bin/env node
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, validateConfig } from '../config/index.js';
import { createRuntimeServices } from '../core/runtime-services.js';
import { ControlSettingsStore } from '../core/control-settings-store.js';
import { ControlApi } from '../interfaces/control/control-api.js';
import { createControlServer } from '../interfaces/control/control-server.js';

const config = await validateConfig(await loadConfig());
const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const settingsStore = new ControlSettingsStore(config.dataRoot);
const settings = await settingsStore.load();
const services = createRuntimeServices(config);
const api = new ControlApi({ config, services, version: metadata.version, settingsStore });
const statePath = path.join(config.dataRoot, 'control', 'service.json');
const server = createControlServer({ api, port: Number(process.env.AI_ROUTER_PORT || settings.port), findAvailable: true, onShutdown: cleanup });
let closing = false;

async function cleanup() {
  if (closing) return;
  closing = true;
  await unlink(statePath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
}

try {
  const address = await server.start();
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify({ pid: process.pid, ...address, started_at: new Date().toISOString(), version: metadata.version }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`AI Router control panel: ${address.url}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error.code ?? 'CONTROL_START_FAILED', message: error.message })}\n`);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await cleanup(); await server.stop(); process.exit(0); });
