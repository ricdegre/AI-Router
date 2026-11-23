// Ready-made starting points for the Add connection dialog. Every field can be changed
// in the dashboard after a preset is chosen; nothing here is special-cased in code.
// cost: LOCAL (runs on your machine), FREE, SUBSCRIPTION_INCLUDED (flat-rate plan) or
// METERED (charged per use; models whose reported price is zero use a free channel).
// structured_output: json_schema, json_object or none (the prompt always describes the
// JSON shape, so none still works on servers without schema support).

const local = (id, name, baseUrl, notes) => ({ id, name, group: 'Local', dialect: 'openai', base_url: baseUrl, auth: 'none', location: 'local', cost: 'LOCAL', structured_output: 'json_schema', notes });
const cloud = (id, name, dialect, baseUrl, extra = {}) => ({ id, name, group: 'Cloud API', dialect, base_url: baseUrl, auth: 'api-key', location: 'cloud', cost: 'METERED', structured_output: 'json_schema', ...extra });

export const CONNECTION_PRESETS = Object.freeze([
  local('lmstudio', 'LM Studio', 'http://127.0.0.1:1234/v1/', 'Start the server in LM Studio (Developer tab).'),
  local('llamacpp', 'llama.cpp server', 'http://127.0.0.1:8080/v1/', 'Run llama-server with the model you want.'),
  local('vllm', 'vLLM', 'http://127.0.0.1:8000/v1/', 'Run vllm serve <model>.'),
  local('jan', 'Jan', 'http://127.0.0.1:1337/v1/', 'Turn on the Local API Server in Jan settings.'),
  local('localai', 'LocalAI', 'http://127.0.0.1:8080/v1/', 'Any OpenAI-compatible server on this PC or your network also works.'),
  cloud('openrouter', 'OpenRouter', 'openai', 'https://openrouter.ai/api/v1/', { key_info_path: 'key', headers: { 'X-Title': 'AI Router' }, notes: 'Hundreds of models; free models use the free channel.' }),
  cloud('openai-api', 'OpenAI API', 'openai', 'https://api.openai.com/v1/', { notes: 'Pay-per-use API key, not the ChatGPT subscription.' }),
  cloud('anthropic-api', 'Anthropic API', 'anthropic', 'https://api.anthropic.com/v1/', { notes: 'Pay-per-use API key, not the Claude subscription.' }),
  cloud('gemini-api', 'Gemini API', 'gemini', 'https://generativelanguage.googleapis.com/v1beta/', { notes: 'Google AI Studio key.' }),
  cloud('deepseek', 'DeepSeek', 'openai', 'https://api.deepseek.com/v1/', { structured_output: 'json_object' }),
  cloud('groq', 'Groq', 'openai', 'https://api.groq.com/openai/v1/', { structured_output: 'json_object' }),
  cloud('mistral', 'Mistral', 'openai', 'https://api.mistral.ai/v1/'),
  cloud('xai', 'xAI (Grok)', 'openai', 'https://api.x.ai/v1/'),
  cloud('together', 'Together AI', 'openai', 'https://api.together.xyz/v1/', { structured_output: 'json_object' }),
  cloud('fireworks', 'Fireworks AI', 'openai', 'https://api.fireworks.ai/inference/v1/'),
  cloud('cerebras', 'Cerebras', 'openai', 'https://api.cerebras.ai/v1/'),
  cloud('huggingface', 'Hugging Face', 'openai', 'https://router.huggingface.co/v1/', { structured_output: 'none' }),
  { id: 'custom', name: 'Other (OpenAI-compatible)', group: 'Other', dialect: 'openai', base_url: '', auth: 'api-key', location: 'cloud', cost: 'METERED', structured_output: 'none', notes: 'Most services and local servers speak the OpenAI format.' }
]);
