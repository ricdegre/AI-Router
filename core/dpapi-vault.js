import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AiRouterError } from './errors.js';
import { resolveWithin } from './paths.js';

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{1,79}$/;
const POWERSHELL = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

function validateId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new AiRouterError(`${label} is invalid.`, 'INVALID_SECRET_REFERENCE');
  return value;
}

function runPowerShell(script, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `PowerShell exited with ${code}.`)));
    child.stdin.end(input);
  });
}

export class WindowsDpapiProtector {
  async protect(value) {
    if (process.platform !== 'win32') throw new AiRouterError('Secure credential storage requires Windows DPAPI on this build.', 'SECURE_SECRET_STORE_UNAVAILABLE');
    const source = Buffer.from(String(value), 'utf8').toString('base64');
    const script = "Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd().Trim();$b=[Convert]::FromBase64String($v);$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($p))";
    return runPowerShell(script, source);
  }

  async unprotect(value) {
    if (process.platform !== 'win32') throw new AiRouterError('Secure credential storage requires Windows DPAPI on this build.', 'SECURE_SECRET_STORE_UNAVAILABLE');
    const script = "Add-Type -AssemblyName System.Security;$v=[Console]::In.ReadToEnd().Trim();$b=[Convert]::FromBase64String($v);$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($p))";
    const result = await runPowerShell(script, value);
    return Buffer.from(result, 'base64').toString('utf8');
  }
}

export class SecretStore {
  constructor(dataRoot, options = {}) {
    this.directory = resolveWithin(path.resolve(dataRoot), 'secrets', 'profiles');
    this.protector = options.protector ?? new WindowsDpapiProtector();
  }

  file(profileId) { return resolveWithin(this.directory, `${validateId(profileId, 'Profile ID')}.json`); }

  async set(profileId, name, value) {
    validateId(name, 'Secret name');
    if (typeof value !== 'string' || !value.trim() || value.length > 32_768 || value.includes('\0')) throw new AiRouterError('Credential is invalid.', 'INVALID_CREDENTIAL');
    const encrypted = await this.protector.protect(value.trim());
    const filePath = this.file(profileId); const temporary = `${filePath}.${randomUUID()}.tmp`;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let state = { version: 1, profile_id: profileId, secrets: {} };
    try { state = JSON.parse(await readFile(filePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    state.secrets ??= {}; state.secrets[name] = { protection: 'windows-dpapi-current-user', value: encrypted, updated_at: new Date().toISOString() };
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, filePath);
    return { stored: true, profile_id: profileId, name };
  }

  async get(profileId, name) {
    validateId(name, 'Secret name');
    let state;
    try { state = JSON.parse(await readFile(this.file(profileId), 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') throw new AiRouterError('Profile credential is not configured.', 'PROFILE_CREDENTIAL_MISSING');
      if (error instanceof SyntaxError) throw new AiRouterError('Stored profile credentials are corrupt.', 'SECRET_STORE_CORRUPT');
      throw error;
    }
    if (state.profile_id !== profileId) throw new AiRouterError('Stored credential does not match this profile.', 'SECRET_PROFILE_MISMATCH');
    const record = state.secrets?.[name];
    if (!record?.value) throw new AiRouterError('Profile credential is not configured.', 'PROFILE_CREDENTIAL_MISSING');
    if (record.protection !== 'windows-dpapi-current-user') throw new AiRouterError('Stored credential protection is unsupported.', 'SECRET_PROTECTION_UNSUPPORTED');
    try { return await this.protector.unprotect(record.value); }
    catch { throw new AiRouterError('Stored profile credential could not be decrypted for the current Windows user.', 'SECRET_DECRYPT_FAILED'); }
  }

  async has(profileId, name) {
    try { await this.get(profileId, name); return true; } catch (error) { if (error.code === 'PROFILE_CREDENTIAL_MISSING') return false; throw error; }
  }

  async remove(profileId, name = null) {
    const filePath = this.file(profileId);
    if (!name) { await unlink(filePath).catch((error) => { if (error.code !== 'ENOENT') throw error; }); return { removed: true }; }
    validateId(name, 'Secret name');
    let state; try { state = JSON.parse(await readFile(filePath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return { removed: false }; throw error; }
    const removed = Boolean(state.secrets?.[name]); delete state.secrets?.[name];
    if (Object.keys(state.secrets ?? {}).length === 0) await unlink(filePath).catch(() => {});
    else await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return { removed };
  }

  async profileIds() {
    try { return (await readdir(this.directory)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
}
