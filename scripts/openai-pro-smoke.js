import { loadConfig, validateConfig } from '../config/index.js';
import { createRuntimeServices } from '../core/runtime-services.js';

const config = await validateConfig(await loadConfig());
const services = createRuntimeServices(config);
const provider = services.providerRegistry.get('openai');
try {
  const result = await provider.executeStructured({ profile: { profile_id: 'chatgpt' }, model: 'gpt-6-luna', prompt: 'Return a successful AI Router structured response with no actions.', context: 'No project files are supplied.', timeout_ms: 60_000 });
  process.stdout.write(`${JSON.stringify({ status: 'passed', model: result.model, structured: result.structured }, null, 2)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ status: 'failed', code: error.code, message: error.message, details: error.details ?? null }, null, 2)}\n`);
  process.exitCode = 1;
}
