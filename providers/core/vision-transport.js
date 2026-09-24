import { resolvedModelValue } from './model-descriptor.js';

// Model support, channel declaration and adapter implementation are separate facts.
// Contract tests do not mean a real provider has perceived an image.
export function visionExecutionStatus(model, channel, adapter) {
  const modelSupportsImage = resolvedModelValue(model, 'vision') === true;
  const channelSupportsImage = channel?.input_modalities?.includes('image') === true;
  const implementation = adapter?.imageTransport?.(channel?.id) ?? { implemented: false, mechanism: null };
  const adapterImplementsImage = implementation.implemented === true;
  const reason = !modelSupportsImage ? 'VISION_MODEL_UNSUPPORTED'
    : !channelSupportsImage ? 'VISION_CHANNEL_UNSUPPORTED'
      : !adapterImplementsImage ? 'VISION_ADAPTER_UNSUPPORTED' : null;
  return {
    model_input_modalities: modelSupportsImage ? ['text', 'image'] : ['text'],
    execution_channel_modalities: channel?.input_modalities ?? ['text'],
    adapter_transport_support: adapterImplementsImage,
    transport_mechanism: adapterImplementsImage ? implementation.mechanism : null,
    transport_contract_status: adapterImplementsImage ? 'IMPLEMENTED' : 'UNSUPPORTED',
    real_provider_verified: false,
    eligible: reason === null,
    reason
  };
}
