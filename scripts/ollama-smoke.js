import { OllamaProvider } from '../providers/ollama/ollama-provider.js';

const model = process.env.OLLAMA_SMOKE_MODEL;
if (!model) {
  process.stderr.write('OLLAMA_SMOKE_MODEL must name an already installed model.\n');
  process.exitCode = 2;
} else {
  const provider = new OllamaProvider({ timeoutMs: 45_000 });
  const models = await provider.listModels();
  if (!models.some((entry) => entry.name === model || entry.model === model)) {
    process.stderr.write('Requested smoke-test model is not installed; no download was attempted.\n');
    process.exitCode = 3;
  } else {
    const result = await provider.execute({
      model,
      prompt: 'Return exactly this JSON and nothing else: {"status":"ok"}',
      timeout_ms: 45_000,
      keep_alive: 0,
      options: { temperature: 0, num_predict: 12 }
    });
    process.stdout.write(`${JSON.stringify({ provider: 'ollama', model: result.model, done: result.done, output: result.output.trim(), metrics: result.metrics }, null, 2)}\n`);
  }
}

