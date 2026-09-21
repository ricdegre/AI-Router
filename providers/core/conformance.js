import { validateProviderDescriptor } from './protocol.js';
import { parseStructuredResponse } from './structured-response.js';

async function check(name, operation) {
  try {
    const details = await operation();
    return { name, passed: true, details: details ?? null };
  } catch (error) {
    return { name, passed: false, error_code: error.code ?? 'UNEXPECTED_ERROR', message: error.message };
  }
}

export async function runProviderConformance(adapter, options = {}) {
  const checks = [];
  checks.push(await check('descriptor', () => validateProviderDescriptor(adapter.descriptor)));
  checks.push(await check('availability', async () => ({ available: await adapter.available() })));
  checks.push(await check('health', async () => {
    const health = await adapter.health();
    if (!health || typeof health.status !== 'string') throw new Error('Health must expose status.');
    return health;
  }));
  checks.push(await check('capabilities', () => {
    const value = adapter.capabilities();
    if (!Array.isArray(value)) throw new Error('Capabilities must be an array.');
    return value;
  }));
  checks.push(await check('auth-modes', () => {
    const value = adapter.authenticationModes();
    if (!Array.isArray(value)) throw new Error('Authentication modes must be an array.');
    return value;
  }));
  checks.push(await check('usage', () => adapter.usage()));
  checks.push(await check('limits', () => adapter.limits()));
  checks.push(await check('cancel', async () => {
    const value = await adapter.cancel(options.inactiveRequestId ?? 'conformance-inactive');
    if (!value || typeof value.cancelled !== 'boolean') throw new Error('Cancellation must return a boolean result.');
    return value;
  }));
  if (options.executionRequest) {
    checks.push(await check('execute', async () => {
      const result = await adapter.execute(options.executionRequest);
      if (!result || typeof result.status !== 'string') throw new Error('Execution result must expose status.');
      return { status: result.status };
    }));
  }
  if (options.structuredText !== undefined) {
    checks.push(await check('structured-response', () => parseStructuredResponse(options.structuredText, { allowTextFallback: false }).response));
  }
  return {
    conformance_version: '0.1',
    provider_id: adapter.descriptor?.id ?? null,
    passed: checks.every((entry) => entry.passed),
    checks
  };
}

