#!/usr/bin/env node
import { loadConfig, validateConfig } from '../config/index.js';
import { ReadinessStore } from '../core/readiness-store.js';
import { VsCodeIntegration } from '../core/vscode-integration.js';

const action = process.argv[2] ?? 'install';
try {
  const config = await validateConfig(await loadConfig());
  const integration = new VsCodeIntegration({ sourceRoot: config.sourceRoot, readinessStore: new ReadinessStore(config.dataRoot) });
  const result = await integration.perform(action, { heartbeatTimeoutMs: 30_000 });
  const status = result.status ?? result;
  const heartbeat = result.heartbeat?.connected ?? status.extension?.connected;
  process.stdout.write(`AI Router VS Code extension ${result.idempotent ? 'was already current' : 'is installed'} (${status.extension?.version ?? result.installed_version ?? 'unknown'}).\n`);
  process.stdout.write(heartbeat ? 'AI Router heartbeat verified.\n' : 'Extension installed, but the AI Router heartbeat was not detected. Confirm that the local service is running and reopen VS Code.\n');
} catch (error) {
  process.stderr.write(`${error.code ?? 'VSCODE_INTEGRATION_FAILED'}: ${error.message}\n`);
  process.exitCode = 1;
}
