import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { temporaryDirectory } from './helpers.js';
import { compareVersions, VsCodeIntegration } from '../core/vscode-integration.js';

async function fixture(t, { installed = null, heartbeat = true } = {}) {
  const sourceRoot = await temporaryDirectory(t, 'ai-router-vscode-integration-');
  await mkdir(path.join(sourceRoot, 'interfaces', 'vscode'), { recursive: true });
  await mkdir(path.join(sourceRoot, 'dist'), { recursive: true });
  await writeFile(path.join(sourceRoot, 'interfaces', 'vscode', 'package.json'), JSON.stringify({ name: 'ai-router-vscode', publisher: 'ai-router-local', version: '0.5.2', engines: { vscode: '^1.85.0' }, contributes: { configuration: { properties: { 'aiRouter.url': { default: 'http://127.0.0.1:43127' } } } } }));
  await writeFile(path.join(sourceRoot, 'dist', 'ai-router-vscode-0.5.2.vsix'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
  let installedVersion = installed; const calls = []; let launched = 0;
  const runner = (command, args) => {
    calls.push({ command, args });
    if (args[0] === '--list-extensions') return { status: 0, stdout: ['publisher.unrelated@9.0.0', installedVersion ? `ai-router-local.ai-router-vscode@${installedVersion}` : ''].filter(Boolean).join('\n'), stderr: '' };
    if (args[0] === '--install-extension') { installedVersion = '0.5.2'; return { status: 0, stdout: 'installed', stderr: '' }; }
    if (args[0] === '--new-window') { launched += 1; return { status: 0, stdout: '', stderr: '' }; }
    return { status: 1, stdout: '', stderr: '' };
  };
  const readinessStore = { async load() { return { vscode: heartbeat && installedVersion === '0.5.2' ? { connected_at: new Date().toISOString(), version: '0.5.2', endpoint: 'http://127.0.0.1:43127' } : null }; } };
  const integration = new VsCodeIntegration({ sourceRoot, readinessStore, runner, env: { AI_ROUTER_VSCODE_CLI: 'C:\\Fake\\Code.exe' }, canAccess: async () => {}, wait: async () => {} });
  return { integration, calls, launched: () => launched, installedVersion: () => installedVersion };
}

test('version comparison supports absent, older, equal, and newer packages', () => {
  assert.equal(compareVersions('0.5.1', '0.5.2'), -1); assert.equal(compareVersions('0.5.2', '0.5.2'), 0); assert.equal(compareVersions('0.6.0', '0.5.2'), 1);
});

test('extension absent installs the packaged VSIX, opens VS Code, and verifies heartbeat', async (t) => {
  const f = await fixture(t); const result = await f.integration.perform('install');
  assert.equal(result.changed, true); assert.equal(result.heartbeat.connected, true); assert.equal(f.installedVersion(), '0.5.2'); assert.equal(f.launched(), 1);
  assert.ok(f.calls.some((call) => call.args[0] === '--install-extension' && call.args.includes('--force')));
});

test('current extension install is idempotent and preserves unrelated extensions', async (t) => {
  const f = await fixture(t, { installed: '0.5.2' }); const result = await f.integration.perform('install');
  assert.equal(result.changed, false); assert.equal(result.idempotent, true); assert.equal(f.calls.some((call) => call.args[0] === '--install-extension'), false);
  assert.equal(f.calls.some((call) => call.args.includes('--uninstall-extension')), false);
});

test('outdated extension upgrades and repair force-reinstalls without uninstalling', async (t) => {
  const outdated = await fixture(t, { installed: '0.5.0' }); const upgrade = await outdated.integration.perform('install');
  assert.equal(upgrade.changed, true); assert.equal(outdated.installedVersion(), '0.5.2');
  const repair = await fixture(t, { installed: '0.5.2' }); const repaired = await repair.integration.perform('repair');
  assert.equal(repaired.changed, true); assert.ok(repair.calls.some((call) => call.args[0] === '--install-extension')); assert.equal(repair.calls.some((call) => call.args.includes('--uninstall-extension')), false);
});

test('offline heartbeat remains a clear non-destructive disconnected state', async (t) => {
  const f = await fixture(t, { installed: '0.5.2', heartbeat: false }); const result = await f.integration.perform('install', { waitForHeartbeat: false });
  assert.equal(result.changed, false); assert.equal(result.heartbeat.connected, false); assert.equal(result.status.extension.status, 'Installed');
});

test('missing VS Code fails safely before changing extensions', async (t) => {
  const f = await fixture(t); f.integration.env = {}; f.integration.canAccess = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  f.integration.runner = () => ({ status: 1, stdout: '', stderr: '' });
  await assert.rejects(() => f.integration.perform('install'), { code: 'VSCODE_NOT_FOUND' });
});

test('only fixed integration actions are accepted', async (t) => {
  const f = await fixture(t); await assert.rejects(() => f.integration.perform('shell'), { code: 'VSCODE_ACTION_NOT_ALLOWED' });
});
