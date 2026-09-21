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
    const result = await provider.executeStructured({
      model,
      prompt: 'Return one JSON object matching the requested schema. Use status "ok" and summary exactly "ollama-conformance". Use empty arrays for all list fields. Return no Markdown.',
      timeout_ms: 45_000,
      keep_alive: 0,
      think: false,
      options: { temperature: 0, num_predict: 96 }
    });
    if (!result.output.trim() || !result.structured_valid || result.structured.status !== 'ok' || result.structured.summary !== 'ollama-conformance') {
      throw new Error('Ollama returned a non-conformant semantic response.');
    }
    process.stdout.write(`${JSON.stringify({
      provider: 'ollama', model: result.model, done: result.done, semantic_status: 'passed',
      structured: result.structured, metrics: result.metrics
    }, null, 2)}\n`);
  }
}
