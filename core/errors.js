export class AiRouterError extends Error {
  constructor(message, code = 'AI_ROUTER_ERROR', details = undefined) {
    super(message);
    this.name = 'AiRouterError';
    this.code = code;
    this.details = details;
  }
}

