export const CODEX_NATIVE_API_PACKAGE_NAME = 'codex-native-api' as const;

export const CODEX_NATIVE_API_PACKAGE_PHASE = 'public-core-preview' as const;

export const CODEX_NATIVE_API_RELEASE_CHANNEL = 'public-preview' as const;

export const CODEX_NATIVE_API_OWNS = [
  'logged-in-codex-localhost-api',
  'responses-first-local-surface',
  'chat-completions-compat-surface',
  'native-runtime-readiness',
  'isolated-native-turn-execution',
  'continuation-registry',
  'native-api-side-task-routing',
  'localhost-auth-and-health',
  'cross-platform-daemon-service-manager',
] as const;

export const CODEX_NATIVE_API_DOES_NOT_OWN = [
  'wechat-transport',
  'telegram-transport',
  'slash-commands',
  'sendgate',
  'bridge-session-ux',
  'artifact-delivery-ui-policy',
  'external-provider-gateway-policy',
] as const;

export type CodexNativeApiOwnedResponsibility = typeof CODEX_NATIVE_API_OWNS[number];

export type CodexNativeApiExcludedResponsibility =
  typeof CODEX_NATIVE_API_DOES_NOT_OWN[number];

export {
  decodeJwtPayload,
  extractCodexTokenIdentity,
  readCodexAccountIdentity,
  readCodexAuthState,
  resolveCodexAuthPath,
  resolveCodexHome,
  writeCodexAuthFile,
} from './auth_state.js';
export type {
  CodexAuthIdentity,
  CodexAuthState,
  CodexAuthTokens,
  CodexTokenIdentity,
  WriteCodexAuthOptions,
} from './auth_state.js';
export {
  DefaultCodexNativeProviderPlugin,
  InMemoryProviderProfileRepository,
  SingleProviderRegistry,
  createDefaultCodexNativeProviderBootstrap,
  loadDefaultCodexNativeProviderProfile,
} from './default_provider.js';
export type {
  DefaultCodexNativeProviderBootstrap,
  DefaultCodexProviderProfile,
  DefaultCodexProviderProfileConfig,
  ProviderProfileRepositoryLike,
  ProviderRegistryLike,
} from './default_provider.js';
export { InMemoryCodexNativeApiContinuationRegistry } from './native_api_continuation_registry.js';
export type {
  CodexNativeApiContinuationEntry,
  CodexNativeApiContinuationLookupResult,
  CodexNativeApiContinuationRegistry,
  CodexNativeApiContinuationRegistryDescriptor,
} from './native_api_continuation_registry.js';
export { CodexNativeApiServer } from './native_api_server.js';
export type {
  CodexNativeApiRuntimeContext,
  CodexNativeApiServerOptions,
} from './native_api_server.js';
export { CodexNativeApiService } from './native_api_service.js';
export type {
  CodexNativeApiServiceBinding,
  CodexNativeApiServiceOptions,
} from './native_api_service.js';
export { CodexNativeApiSideTaskRouter } from './native_api_side_task_router.js';
export type {
  CodexNativeApiSideTaskClass,
  CodexNativeApiSideTaskExecutionResult,
  CodexNativeApiSideTaskRequest,
  CodexNativeApiSideTaskRoute,
  CodexNativeApiSideTaskRouterOptions,
} from './native_api_side_task_router.js';
export type {
  CodexNativeInboundAttachment,
  CodexNativeInboundEvent,
  CodexNativeSession,
  CodexNativeSessionSettings,
} from './native_api_types.js';
export { CodexNativeRuntime } from './native_runtime.js';
export type {
  CodexNativeRuntimeContinuationTurnOptions,
  CodexNativeRuntimeReadiness,
  CodexNativeRuntimeReconnectResult,
  CodexNativeRuntimeReconnectSummary,
  CodexNativeRuntimeReconnectSummaryEntry,
  CodexNativeRuntimeRunTurnOptions,
  CodexNativeRuntimeTurnHooks,
  CodexNativeRuntimeTurnPreparation,
  CodexNativeRuntimeTurnResult,
  CodexNativeRuntimeTurnStartedMeta,
} from './native_runtime.js';
export type {
  OutputArtifact,
  OutputArtifactKind,
  ProviderAppInfo,
  ProviderApprovalRequest,
  ProviderInboundAttachmentKind,
  ProviderMcpOauthLoginResult,
  ProviderMcpServerStatus,
  ProviderModelInfo,
  ProviderPluginAppSummary,
  ProviderPluginContract,
  ProviderPluginDetail,
  ProviderPluginInstallResult,
  ProviderPluginLoadError,
  ProviderPluginMarketplace,
  ProviderPluginSkillSummary,
  ProviderPluginSummary,
  ProviderPluginsListResult,
  ProviderProfile,
  ProviderReviewTarget,
  ProviderSkillError,
  ProviderSkillInfo,
  ProviderSkillToolDependency,
  ProviderSkillsListResult,
  ProviderThreadGoal,
  ProviderThreadListResult,
  ProviderThreadStartResult,
  ProviderThreadSummary,
  ProviderThreadTurn,
  ProviderThreadTurnItem,
  ProviderTurnArtifactDeliveredItem,
  ProviderTurnArtifactDeliveryStage,
  ProviderTurnArtifactDeliveryState,
  ProviderTurnArtifactKind,
  ProviderTurnArtifactNoticeCode,
  ProviderTurnArtifactRejectedItem,
  ProviderTurnArtifactRejectionReason,
  ProviderTurnAttachment,
  ProviderTurnEvent,
  ProviderTurnProgress,
  ProviderTurnResult,
  ProviderTurnSession,
  ProviderTurnSessionSettings,
  ProviderUsageBucket,
  ProviderUsageCredits,
  ProviderUsageReport,
  ProviderUsageWindow,
} from './provider.js';
