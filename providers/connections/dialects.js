// The three request formats ("dialects") that cover almost every model API:
// openai (chat/completions, used by most services and local servers), anthropic (messages)
// and gemini (generateContent). Each dialect only builds requests and reads responses;
// transport, errors and credentials live in ApiConnectionProvider.

const DEFAULT_MAX_TOKENS = 16_000;
const text = (value) => String(value ?? '');

function splitSystem(messages) {
  const system = messages.filter((message) => message.role === 'system').map((message) => text(message.content)).join('\n\n');
  return { system, rest: messages.filter((message) => message.role !== 'system') };
}

const openai = {
  authHeaders: (key) => (key ? { Authorization: `Bearer ${key}` } : {}),
  modelsPath: 'models',
  modelList: (result) => (Array.isArray(result?.data) ? result.data : null),
  modelFacts(model) {
    const modalities = [...(model.architecture?.input_modalities ?? []), ...(model.architecture?.output_modalities ?? [])];
    const params = model.supported_parameters;
    return {
      id: model.id, display_name: model.name ?? model.id, family: model.architecture?.instruct_type ?? model.owned_by ?? null,
      context_size: model.context_length ?? model.max_model_len ?? model.context_window ?? null,
      tool_support: params ? params.includes('tools') : null, structured_output_support: params ? params.includes('response_format') : null,
      reasoning_support: params ? params.includes('reasoning') : null, vision: modalities.length ? modalities.includes('image') : null,
      embedding: /embed|embedding/i.test(model.id), pricing: model.pricing ?? null
    };
  },
  imagePart: (mime, base64) => ({ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }),
  textPart: (value) => ({ type: 'text', text: value }),
  chatRequest({ model, messages, maxTokens, schema, structuredOutput }) {
    const body = { model, messages };
    if (maxTokens) body.max_tokens = maxTokens;
    if (schema && structuredOutput === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: 'ai_router_response', strict: true, schema } };
    if (schema && structuredOutput === 'json_object') body.response_format = { type: 'json_object' };
    return { path: 'chat/completions', body };
  },
  chatResponse: (result, model) => ({ output: text(result?.choices?.[0]?.message?.content), model: result?.model ?? model, usage: result?.usage ?? null })
};

const anthropic = {
  authHeaders: (key) => ({ ...(key ? { 'x-api-key': key } : {}), 'anthropic-version': '2023-06-01' }),
  modelsPath: 'models?limit=1000',
  modelList: (result) => (Array.isArray(result?.data) ? result.data : null),
  modelFacts: (model) => ({
    id: model.id, display_name: model.display_name ?? model.id, family: 'Claude', context_size: model.max_input_tokens ?? null,
    tool_support: true, structured_output_support: true, reasoning_support: null, vision: true, embedding: false, pricing: null
  }),
  imagePart: (mime, base64) => ({ type: 'image', source: { type: 'base64', media_type: mime, data: base64 } }),
  textPart: (value) => ({ type: 'text', text: value }),
  chatRequest({ model, messages, maxTokens, schema, structuredOutput }) {
    const { system, rest } = splitSystem(messages);
    const body = { model, max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS, messages: rest.map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content })) };
    if (system) body.system = system;
    if (schema && structuredOutput === 'json_schema') body.output_config = { format: { type: 'json_schema', schema } };
    return { path: 'messages', body };
  },
  chatResponse: (result, model) => ({
    output: (result?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join(''),
    model: result?.model ?? model, usage: result?.usage ?? null
  })
};

const gemini = {
  authHeaders: (key) => (key ? { 'x-goog-api-key': key } : {}),
  modelsPath: 'models?pageSize=1000',
  modelList: (result) => (Array.isArray(result?.models) ? result.models.filter((model) => model.supportedGenerationMethods?.includes('generateContent')) : null),
  modelFacts: (model) => ({
    id: String(model.name ?? '').replace(/^models\//, ''), display_name: model.displayName ?? model.name, family: 'Gemini',
    context_size: model.inputTokenLimit ?? null, tool_support: null, structured_output_support: true,
    reasoning_support: model.thinking === true || /thinking/i.test(model.name ?? ''), vision: true, embedding: false, pricing: null
  }),
  imagePart: (mime, base64) => ({ inline_data: { mime_type: mime, data: base64 } }),
  textPart: (value) => ({ text: value }),
  chatRequest({ model, messages, maxTokens, schema, structuredOutput }) {
    const { system, rest } = splitSystem(messages);
    const contents = rest.map((message) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: Array.isArray(message.content) ? message.content : [{ text: text(message.content) }] }));
    const generationConfig = {};
    if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
    if (schema && structuredOutput !== 'none') { generationConfig.responseMimeType = 'application/json'; if (structuredOutput === 'json_schema') generationConfig.responseJsonSchema = schema; }
    const body = { contents, ...(Object.keys(generationConfig).length ? { generationConfig } : {}) };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    return { path: `models/${encodeURIComponent(model)}:generateContent`, body };
  },
  chatResponse: (result, model) => ({ output: (result?.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join(''), model, usage: result?.usageMetadata ?? null })
};

export const DIALECTS = Object.freeze({ openai, anthropic, gemini });
export const DIALECT_IDS = Object.freeze(Object.keys(DIALECTS));
