export const CODEX_GATEWAY_PACKAGE_NAME = '@codexbridge/codex-gateway' as const;

export const CODEX_GATEWAY_PACKAGE_PHASE = 'phase-5-internal-package' as const;

export const CODEX_GATEWAY_RELEASE_CHANNEL = 'internal-only' as const;

export const CODEX_GATEWAY_OWNS = [
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
  'local-codex-gateway-server',
] as const;

export const CODEX_GATEWAY_DOES_NOT_OWN = [
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

export type CodexGatewayOwnedResponsibility = typeof CODEX_GATEWAY_OWNS[number];

export type CodexGatewayExcludedResponsibility = typeof CODEX_GATEWAY_DOES_NOT_OWN[number];

export * from './capabilities/capability_presets.js';
export * from './capabilities/cliproxy_model_catalog.js';
export * from './capabilities/thinking_policy.js';
export * from './converters/responses_adapter.js';
export * from './server/responses_adapter_server.js';
export * from './server/standalone_server.js';
