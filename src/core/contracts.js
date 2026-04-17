/**
 * @typedef {Object} ProviderProfile
 * @property {string} id
 * @property {string} providerKind
 * @property {string} displayName
 * @property {Record<string, unknown>} config
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} BridgeSession
 * @property {string} id
 * @property {string} providerProfileId
 * @property {string} codexThreadId
 * @property {string | null} cwd
 * @property {string | null} title
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} PlatformBinding
 * @property {string} platform
 * @property {string} externalScopeId
 * @property {string} bridgeSessionId
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} SessionSettings
 * @property {string} bridgeSessionId
 * @property {string | null} model
 * @property {string | null} reasoningEffort
 * @property {string | null} serviceTier
 * @property {'read-only' | 'default' | 'full-access' | null | undefined} [accessPreset]
 * @property {string | null | undefined} [approvalPolicy]
 * @property {string | null | undefined} [sandboxMode]
 * @property {string | null} locale
 * @property {Record<string, unknown>} metadata
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} PlatformScopeRef
 * @property {string} platform
 * @property {string} externalScopeId
 */

/**
 * @typedef {Object} InboundTextEvent
 * @property {string} platform
 * @property {string} externalScopeId
 * @property {string} text
 * @property {string | null | undefined} [cwd]
 * @property {string | null | undefined} [locale]
 * @property {Record<string, unknown> | undefined} [metadata]
 */

/**
 * @typedef {Object} ProviderThreadStartResult
 * @property {string} threadId
 * @property {string | null} cwd
 * @property {string | null} title
 */

/**
 * @typedef {Object} ProviderThreadSummary
 * @property {string} threadId
 * @property {string | null} cwd
 * @property {string | null} title
 * @property {number | null | undefined} [updatedAt]
 * @property {string | null | undefined} [preview]
 * @property {ProviderThreadTurn[] | null | undefined} [turns]
 * @property {string | null | undefined} [bridgeSessionId]
 */

/**
 * @typedef {Object} ProviderThreadTurnItem
 * @property {string} type
 * @property {string | null} role
 * @property {string | null} phase
 * @property {string} text
 */

/**
 * @typedef {Object} ProviderThreadTurn
 * @property {string} id
 * @property {string | null} status
 * @property {string | null} error
 * @property {ProviderThreadTurnItem[]} items
 */

/**
 * @typedef {Object} ProviderThreadListResult
 * @property {ProviderThreadSummary[]} items
 * @property {string | null} nextCursor
 */

/**
 * @typedef {Object} ThreadMetadata
 * @property {string} providerProfileId
 * @property {string} threadId
 * @property {string | null} alias
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} ProviderTurnResult
 * @property {string} outputText
 * @property {string | null | undefined} [turnId]
 * @property {string | null | undefined} [threadId]
 * @property {string | null | undefined} [title]
 */

/**
 * @typedef {Object} PlatformDeliveryRequest
 * @property {string} kind
 * @property {Record<string, unknown>} payload
 */

/**
 * @typedef {Object} PlatformPluginContract
 * @property {string} id
 * @property {string} displayName
 * @property {() => Promise<void>} start
 * @property {() => Promise<void>} stop
 * @property {(payload: Record<string, unknown>) => InboundTextEvent | null} normalizeInboundEvent
 * @property {(params: { externalScopeId: string, content: string }) => PlatformDeliveryRequest[]} buildTextDeliveries
 */

/**
 * @typedef {Object} ProviderPluginContract
 * @property {string} kind
 * @property {string} displayName
 * @property {(params: { providerProfile: ProviderProfile, cwd?: string | null, title?: string | null, metadata?: Record<string, unknown> }) => Promise<ProviderThreadStartResult>} startThread
 * @property {(params: { providerProfile: ProviderProfile, threadId: string, includeTurns?: boolean }) => Promise<ProviderThreadSummary | null>} readThread
 * @property {(params: { providerProfile: ProviderProfile, limit?: number, cursor?: string | null, searchTerm?: string | null }) => Promise<ProviderThreadListResult>} listThreads
 * @property {(params: { providerProfile: ProviderProfile, bridgeSession: BridgeSession, sessionSettings: SessionSettings | null, event: InboundTextEvent, inputText: string, onProgress?: ((progress: Record<string, unknown>) => Promise<void> | void) | null, onTurnStarted?: ((meta: Record<string, unknown>) => Promise<void> | void) | null }) => Promise<ProviderTurnResult>} startTurn
 * @property {(params: { providerProfile: ProviderProfile, threadId: string, turnId: string }) => Promise<void>} [interruptTurn]
 */

export const PLATFORM_IDS = Object.freeze({
  TELEGRAM: 'telegram',
  WEIXIN: 'weixin',
});

export const PROVIDER_KINDS = Object.freeze({
  OPENAI_NATIVE: 'openai-native',
  MINIMAX_VIA_CLIPROXY: 'minimax-via-cliproxy',
});

export function formatPlatformScopeKey(platform, externalScopeId) {
  return `${platform}:${externalScopeId}`;
}
