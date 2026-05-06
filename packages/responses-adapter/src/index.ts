export const RESPONSES_ADAPTER_PACKAGE_NAME = '@codexbridge/responses-adapter' as const;

export const RESPONSES_ADAPTER_PACKAGE_PHASE = 'phase-1a-skeleton' as const;

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
