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

export {
  OPENAI_COMPATIBLE_PROFILE_PRESET_REGISTRATIONS,
  buildOpenAICompatibleCapabilityCatalogMetadata,
  buildOpenAICompatibleExternalModelCatalog,
  buildOpenAICompatibleModelCatalog,
  getOpenAICompatibleProviderPreset,
} from './capabilities/capability_presets.js';
export type {
  OpenAICompatibleCapabilityCatalogMetadata,
  OpenAICompatibleCapabilityPresetId,
  OpenAICompatibleProfilePresetRegistration,
  OpenAICompatibleProviderPreset,
} from './capabilities/capability_presets.js';
export {
  CLIPROXY_COMPAT_MODEL_CATALOG,
  buildCliproxyModelCapabilitiesForEntry,
  buildCliproxyModelCatalogEntries,
  buildCliproxyModelCapabilityMap,
  buildCliproxyModelIds,
  findCliproxyModelCatalogEntry,
} from './capabilities/cliproxy_model_catalog.js';
export type {
  BuildCliproxyModelCatalogEntriesOptions,
  CliproxyModelCatalogEntry,
  CliproxyModelCategory,
} from './capabilities/cliproxy_model_catalog.js';
export { assessCodexGatewayProtocolBoundary } from './capabilities/protocol_boundary.js';
export type {
  CodexGatewayProtocolBoundaryDecision,
  CodexGatewayTargetProtocol,
} from './capabilities/protocol_boundary.js';
export {
  applyThinkingPolicyToOpenAIChatRequest,
  getOpenAICompatibleThinkingPolicy,
  getProviderThinkingSupport,
  mergeOpenAICompatibleProviderCapabilities,
  resolveOpenAICompatibleProviderCapabilitiesForModel,
  resolveReasoningEffortForProvider,
  stripThinkingConfig,
} from './capabilities/thinking_policy.js';
export type {
  JsonRecord,
  OpenAICompatibleModelCapabilities,
  OpenAICompatibleModelInfo,
  OpenAICompatibleMultimodalCapabilities,
  OpenAICompatiblePayloadCompatibility,
  OpenAICompatiblePayloadModelRule,
  OpenAICompatiblePayloadRule,
  OpenAICompatibleProviderCapabilities,
  OpenAICompatibleRetryCapabilities,
  OpenAICompatibleThinkingPolicy,
  OpenAICompatibleThinkingPolicyOverrides,
  OpenAICompatibleUsageCapabilities,
} from './capabilities/thinking_policy.js';
export {
  chatCompletionsResponseToResponses,
  inspectOpenAICompatiblePayloadCompatibility,
  responsesRequestToChatCompletions,
  responsesRequestToCompactionResponse,
  translateChatCompletionsSseStreamToResponsesSse,
  translateChatCompletionsSseToResponsesEvents,
} from './converters/responses_adapter.js';
export type {
  ChatToResponsesOptions,
  ResponsesSseTranslateOptions,
  ResponsesToChatOptions,
} from './converters/responses_adapter.js';
export {
  OpenAICompatibleResponsesAdapterServer,
  reserveLocalPort,
} from './server/responses_adapter_server.js';
export type {
  CodexGatewayTraceEvent,
  CodexGatewayTraceSink,
  OpenAICompatibleResponsesAdapterServerOptions,
} from './server/responses_adapter_server.js';
export {
  createCodexGatewayStandaloneServerConfigFromEnv,
  createCodexGatewayStandaloneServerFromEnv,
  loadCodexGatewayStandaloneEnvFile,
  resolveCodexGatewayStandaloneServerEnv,
} from './server/standalone_server.js';
export type { CodexGatewayStandaloneServerConfig } from './server/standalone_server.js';
