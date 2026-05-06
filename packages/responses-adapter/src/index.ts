export const RESPONSES_ADAPTER_PACKAGE_NAME = '@codexbridge/responses-adapter' as const;

export const RESPONSES_ADAPTER_PACKAGE_PHASE = 'phase-3-server' as const;

export const RESPONSES_ADAPTER_OWNS = [
  'responses-to-chat-conversion',
  'chat-to-responses-conversion',
  'sse-stream-conversion',
  'tool-call-conversion',
  'usage-normalization',
  'error-normalization',
  'multimodal-policy',
  'reasoning-thinking-policy',
  'provider-capabilities',
  'payload-rules',
  'local-responses-adapter-server',
] as const;

export const RESPONSES_ADAPTER_DOES_NOT_OWN = [
  'wechat-transport',
  'telegram-transport',
  'slash-commands',
  'i18n',
  'sendgate',
  'bridge-sessions',
  'thread-binding',
  'approvals',
  'retry-reconnect',
  'assistant-records',
  'automations',
  'uploads',
  'artifact-delivery-policy',
] as const;

export type ResponsesAdapterOwnedResponsibility = typeof RESPONSES_ADAPTER_OWNS[number];

export type ResponsesAdapterExcludedResponsibility = typeof RESPONSES_ADAPTER_DOES_NOT_OWN[number];

export * from './capabilities/capability_presets.js';
export * from './capabilities/cliproxy_model_catalog.js';
export * from './capabilities/thinking_policy.js';
export * from './converters/responses_adapter.js';
export * from './server/responses_adapter_server.js';
