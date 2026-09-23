import { access, open, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AiRouterError } from './errors.js';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:43127';
const DEFAULT_SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function compareVersions(left, right) {
  const parts = (value) => String(value ?? '').replace(/^v/, '').split(/[.-]/).slice(0, 3).map((item) => Number.parseInt(item, 10) || 0);
  const a = parts(left); const b = parts(right);
  for (let index = 0; index < 3; index += 1) { if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1; }
  return 0;
}

function installedExtensions(output) {
  return String(output ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const split = line.lastIndexOf('@');
    return split > 0 ? { id: line.slice(0, split).toLowerCase(), version: line.slice(split + 1) } : { id: line.toLowerCase(), version: null };
  });
}

function defaultCandidates(env = process.env) {
  return [
    env.AI_ROUTER_VSCODE_CLI,
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Microsoft VS Code', 'bin', 'code.cmd'),
    env.ProgramFiles && path.join(env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Microsoft VS Code', 'bin', 'code.cmd'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe')
  ].filter(Boolean);
}

function runProcess(command, args, options = {}) {
  if (/\.cmd$/i.test(command)) {
    return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', command, ...args], { encoding: 'utf8', windowsHide: true, timeout: options.timeout ?? 30_000 });
  }
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: options.timeout ?? 30_000 });
}

async function locateVsCode({ env = process.env, canAccess = access, runner = runProcess } = {}) {
  for (const candidate of defaultCandidates(env)) {
    try { await canAccess(candidate, constants.X_OK); return candidate; } catch {}
  }
  if (process.platform === 'win32') {
    const found = runner('where.exe', ['Code.exe'], { timeout: 5_000 });
    const candidate = found.status === 0 ? String(found.stdout).split(/\r?\n/).find(Boolean)?.trim() : null;
    if (candidate) return candidate;
  }
  return null;
}

export class VsCodeIntegration {
  constructor({ sourceRoot = DEFAULT_SOURCE_ROOT, readinessStore, endpoint = DEFAULT_ENDPOINT, runner = runProcess, wait = delay, env = process.env, canAccess = access } = {}) {
    this.sourceRoot = path.resolve(sourceRoot);
    this.readinessStore = readinessStore;
    this.endpoint = endpoint;
    this.runner = runner;
    this.wait = wait;
    this.env = env;
    this.canAccess = canAccess;
  }

  async packageInfo() {
    const manifestPath = path.join(this.sourceRoot, 'interfaces', 'vscode', 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const vsixPath = path.join(this.sourceRoot, 'dist', `ai-router-vscode-${manifest.version}.vsix`);
    let valid = false; let size = 0;
    try {
      const handle = await open(vsixPath, 'r'); const header = Buffer.alloc(4); const result = await handle.read(header, 0, 4, 0); const info = await handle.stat(); await handle.close();
      valid = result.bytesRead === 4 && header.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])); size = info.size;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { path: vsixPath, valid, size, extension_id: `${manifest.publisher}.${manifest.name}`.toLowerCase(), version: manifest.version, minimum_vscode_version: manifest.engines?.vscode ?? null, endpoint: manifest.contributes?.configuration?.properties?.['aiRouter.url']?.default ?? this.endpoint };
  }

  async inspect() {
    const packageInfo = await this.packageInfo();
    const cli = await locateVsCode({ env: this.env, canAccess: this.canAccess, runner: this.runner });
    let extensions = null; let installed = null; let installedVersion = null;
    if (cli) {
      const result = this.runner(cli, ['--list-extensions', '--show-versions'], { timeout: 15_000 });
      if (result.status === 0) { extensions = installedExtensions(result.stdout); const match = extensions.find((item) => item.id === packageInfo.extension_id); installed = Boolean(match); installedVersion = match?.version ?? null; }
    }
    const readiness = await this.readinessStore.load();
    const connectedAt = readiness.vscode?.connected_at ?? null;
    const connected = Boolean(installed && connectedAt && Date.now() - Date.parse(connectedAt) <= 120_000 && readiness.vscode?.version === packageInfo.version);
    return {
      vscode: { status: cli ? 'Installed' : 'Not Installed', cli_path: cli },
      extension: { status: installed === null ? 'Unknown' : installed ? 'Installed' : 'Not Installed', installed, version: installedVersion, expected_version: packageInfo.version, extension_id: packageInfo.extension_id, current: Boolean(installedVersion && compareVersions(installedVersion, packageInfo.version) >= 0), connected, connected_at: connectedAt, reported_endpoint: readiness.vscode?.endpoint ?? null },
      service: { status: 'Healthy', endpoint: this.endpoint },
      package: packageInfo
    };
  }

  async openVsCode(cli) {
    const result = this.runner(cli, ['--new-window', this.sourceRoot], { timeout: 15_000 });
    if (result.status !== 0) throw new AiRouterError('VS Code could not be opened.', 'VSCODE_LAUNCH_FAILED');
  }

  async waitForHeartbeat(version, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.readinessStore.load();
      if (state.vscode?.version === version && state.vscode?.connected_at && Date.now() - Date.parse(state.vscode.connected_at) <= 120_000) return { connected: true, ...state.vscode };
      await this.wait(1_000);
    }
    return { connected: false, reason: 'heartbeat-timeout' };
  }

  async perform(action, options = {}) {
    if (!['install', 'repair', 'reinstall', 'open', 'test'].includes(action)) throw new AiRouterError('Unsupported VS Code integration action.', 'VSCODE_ACTION_NOT_ALLOWED');
    const before = await this.inspect();
    if (action === 'test') return before;
    if (!before.vscode.cli_path) throw new AiRouterError('Visual Studio Code was not found. Install VS Code 1.85 or newer, then retry.', 'VSCODE_NOT_FOUND');
    if (action === 'open') { await this.openVsCode(before.vscode.cli_path); return { action, launched: true, status: await this.inspect() }; }
    if (!before.package.valid) throw new AiRouterError('The packaged AI Router extension is missing or invalid.', 'VSCODE_VSIX_INVALID');
    const needsInstall = !before.extension.installed || !before.extension.current || action === 'repair' || action === 'reinstall';
    let changed = false;
    if (needsInstall) {
      const result = this.runner(before.vscode.cli_path, ['--install-extension', before.package.path, '--force'], { timeout: 60_000 });
      if (result.status !== 0) throw new AiRouterError('VS Code could not install the AI Router extension.', 'VSCODE_EXTENSION_INSTALL_FAILED', { exit_code: result.status, output: String(result.stderr || result.stdout || '').slice(0, 1_000) });
      changed = true;
    }
    const verified = await this.inspect();
    if (!verified.extension.installed || compareVersions(verified.extension.version, before.package.version) < 0) throw new AiRouterError('The AI Router extension installation could not be verified.', 'VSCODE_EXTENSION_VERIFY_FAILED');
    await this.openVsCode(before.vscode.cli_path);
    const heartbeat = options.waitForHeartbeat === false ? { connected: verified.extension.connected } : await this.waitForHeartbeat(before.package.version, options.heartbeatTimeoutMs ?? 20_000);
    return { action, changed, idempotent: !changed, installed_version: verified.extension.version, expected_version: before.package.version, heartbeat, status: await this.inspect() };
  }
}

export { DEFAULT_ENDPOINT, installedExtensions, runProcess };
