import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { formatPlatformScopeKey } from './contracts.js';
import { parseSlashCommand } from './command_parser.js';
import { NotFoundError } from './errors.js';
import {
  normalizeAssistantDraftForStorage,
  normalizeAssistantRecordForStorage,
  type AssistantRecordDraft,
} from './assistant_record_service.js';
import {
  createPendingTurnArtifactDeliveryState,
  createTurnArtifactContext,
  ensureTurnArtifactDirectories,
  finalizeTurnArtifacts,
} from './turn_artifacts.js';
import { writeSequencedDebugLog } from './sequenced_stderr.js';
import {
  createI18n,
  formatRelativeTimeLocalized,
  normalizeLocale,
  type SupportedLocale,
  type Translator,
} from '../i18n/index.js';
import {
  CodexInstructionsManager,
  type CodexInstructionsSnapshot,
} from '../providers/codex/instructions_state.js';
import type { WeiboHotSearchServiceLike } from '../services/weibo_hot_search.js';
import type {
  AgentJob,
  AgentJobCategory,
  AgentJobMode,
  AgentJobRiskLevel,
  AssistantRecord,
  AssistantRecordPriority,
  AssistantRecordStatus,
  AssistantRecordType,
  AutomationMode,
  AutomationSchedule,
  PlatformScopeRef,
  PluginAlias,
  SessionSettings,
  TurnArtifactIntent,
  TurnArtifactDeliveredItem,
  TurnArtifactDeliveryState,
  UploadBatchItem,
  UploadBatchState,
} from '../types/core.js';
import type { InboundAttachment, InboundTextEvent } from '../types/platform.js';
import type {
  ProviderAppInfo,
  OutputArtifact,
  ProviderMcpServerStatus,
  ProviderApprovalRequest,
  ProviderPluginDetail,
  ProviderPluginInstallResult,
  ProviderPluginsListResult,
  ProviderProfile,
  ProviderPluginSummary,
  ProviderReviewTarget,
  ProviderSkillInfo,
  ProviderSkillsListResult,
  ProviderTurnProgress,
} from '../types/provider.js';

const THREAD_PAGE_SIZE = 5;
const PLUGIN_CATEGORY_PAGE_SIZE = 20;
const PLUGIN_SEARCH_MIN_SCORE = 64;
const APP_PAGE_SIZE = 12;
const THREAD_PREVIEW_LIMIT = 72;
const THREAD_HISTORY_TURN_LIMIT = 3;
const HELP_FLAG_SET = new Set(['-h', '--help', '-help', '-helps']);
const STATUS_DETAILS_ARG_SET = new Set(['details', 'detail', 'full']);
const FAST_SERVICE_TIER = 'fast';
const NORMAL_SERVICE_TIER = 'flex';
const CODEX_BACKED_PROVIDER_KIND_SET = new Set(['openai-native', 'minimax-via-cliproxy']);
const REVIEW_PROGRESS_HEARTBEAT_MS = 20_000;
const REVIEW_PROGRESS_HEARTBEAT_MAX_RUNS = 1;

type CoordinatorResponse = {
  type: 'message';
  messages: Array<{
    text?: string | null;
    artifact?: OutputArtifact | null;
    mediaPath?: string | null;
    caption?: string | null;
  }>;
  session: any;
  meta?: Record<string, any>;
};

type StartTurnOptions = {
  onProgress?: ((progress: ProviderTurnProgress) => Promise<void> | void) | null;
  onTurnStarted?: (meta: {
    turnId: string | null;
    threadId: string | null;
    bridgeSessionId: string;
    providerProfileId: string;
  }) => Promise<void> | void;
  onApprovalRequest?: (request: ProviderApprovalRequest) => Promise<void> | void;
};

type ProgressHandler = ((progress: ProviderTurnProgress) => Promise<void> | void) | null;

type RecoveryFailure = Error & {
  reasonCode?: string;
};

type CommandHelpSpec = {
  name: string;
  aliases: readonly string[];
  summary: string;
  usage: readonly string[];
  examples: readonly string[];
  notes: readonly string[];
};

type RetryableRequestSnapshot = {
  text: string;
  attachments: InboundAttachment[];
  cwd: string | null;
  storedAt: number;
};

type AutomationDraftCandidate = {
  title: string;
  mode: AutomationMode;
  schedule?: AutomationSchedule;
  schedules?: AutomationSchedule[];
  prompt: string;
};

type PendingAutomationDraft = {
  createdAt: number;
  rawInput: string;
  normalizedBy: 'explicit' | 'codex' | 'agents-sdk';
  title: string;
  mode: AutomationMode;
  schedule: AutomationSchedule;
  schedules: AutomationSchedule[];
  prompt: string;
  providerProfileId: string;
  locale: string | null;
  cwd: string | null;
  initialSettings: Partial<SessionSettings>;
  threadBridgeSessionId: string | null;
};

type AgentDraftCandidate = {
  title: string;
  goal: string;
  expectedOutput: string;
  plan: string[];
  category: AgentJobCategory;
  riskLevel: AgentJobRiskLevel;
  mode: AgentJobMode;
};

type PendingAgentDraft = AgentDraftCandidate & {
  createdAt: number;
  rawInput: string;
  normalizedBy: 'agents-sdk' | 'codex' | 'local';
  providerProfileId: string;
  locale: string | null;
  cwd: string | null;
  initialSettings: Partial<SessionSettings>;
};

type AssistantRecordUpdateAction = 'update' | 'complete' | 'cancel' | 'archive';
type AssistantRecordRouteAction = 'create' | AssistantRecordUpdateAction | 'none';

type AssistantRecordRouteDecision = {
  action: AssistantRecordRouteAction;
  targetRecordId: string | null;
  confidence: number;
  reason: string;
  type: AssistantRecordType | null;
};

type PendingAssistantRecordUpdateDraft = {
  createdAt: number;
  rawInput: string;
  instructions: string[];
  targetRecordId: string;
  matchedRecord: AssistantRecord;
  action: AssistantRecordUpdateAction;
  updatedRecord: AssistantRecord;
  matchedScore: number;
  normalizedBy: 'codex' | 'agents-sdk' | 'local';
  changeSummary: string | null;
};

type AssistantRecordRewriteCandidate = {
  action: AssistantRecordUpdateAction;
  type: AssistantRecordType;
  title: string;
  content: string;
  status: AssistantRecordStatus;
  priority: AssistantRecordPriority;
  dueAt: number | null;
  remindAt: number | null;
  recurrence: string | null;
  project: string | null;
  tags: string[];
  changeSummary: string;
  confidence: number;
};

type AssistantRecordDraftNormalizeSource = 'codex' | 'agents-sdk' | 'local';

type AgentVerificationResult = {
  pass: boolean;
  summary: string;
  issues: string[];
  nextAction: 'complete' | 'retry' | 'fail';
};

type OpenAIAgentRuntimeConfig = {
  apiKey: string | null;
  baseURL: string | null;
  model: string;
  useResponses: boolean | undefined;
};

type SkillBrowserState = {
  cwd: string | null;
  searchTerm: string | null;
  items: ProviderSkillInfo[];
  errors: Array<{ path: string; message: string }>;
  updatedAt: number;
};

type AppBrowserState = {
  providerProfileId: string;
  mode: 'default' | 'all' | 'search';
  searchTerm: string | null;
  items: ProviderAppInfo[];
  pageNumber: number;
  pageCount: number;
  totalCount: number;
  updatedAt: number;
};

type PluginCategoryBucket = {
  key: string;
  label: string;
  description: string;
  items: ProviderPluginDetail[];
};

type PluginSearchMatch = {
  detail: ProviderPluginDetail;
  score: number;
};

type PluginBrowserState = {
  providerProfileId: string;
  cwd: string | null;
  mode: 'featured' | 'category' | 'search';
  categoryKey: string | null;
  searchTerm?: string | null;
  pageNumber?: number;
  items: ProviderPluginSummary[];
  updatedAt: number;
};

type McpBrowserState = {
  providerProfileId: string;
  items: ProviderMcpServerStatus[];
  updatedAt: number;
};

type PendingPluginAliasDraft = {
  action: 'set' | 'clear';
  createdAt: number;
  platform: string;
  externalScopeId: string;
  providerProfileId: string;
  plugin: ProviderPluginSummary;
  alias: string | null;
};

type ResolvedPluginAlias = {
  pluginId: string;
  alias: string;
  source: 'user' | 'auto';
  pluginName: string;
  displayName: string | null;
};

type ExplicitPluginTargetHint = {
  pluginId: string;
  pluginName: string;
  pluginDisplayName: string | null;
  alias: string | null;
  source: 'user' | 'auto' | 'resolved';
  syntax: 'slash_use' | 'at_alias' | 'zh_alias' | 'inline_at_alias';
};

type ExplicitPluginTargetIssue =
  | {
    kind: 'plugin_not_installed';
    target: ExplicitPluginTargetHint;
    plugin: ProviderPluginSummary;
  }
  | {
    kind: 'app_auth_required' | 'app_disabled' | 'app_unavailable';
    target: ExplicitPluginTargetHint;
    plugin: ProviderPluginSummary;
    appToken: string;
    appName: string;
  }
  | {
    kind: 'mcp_auth_required' | 'mcp_disabled' | 'mcp_unavailable';
    target: ExplicitPluginTargetHint;
    plugin: ProviderPluginSummary;
    serverName: string;
  };

type ParsedConversationPluginInvocation = {
  token: string;
  taskText: string;
  syntax: 'at_alias' | 'zh_alias';
};

type CodexLoginAccountSummary = {
  id: string;
  email?: string | null;
  name?: string | null;
  plan?: string | null;
  planType?: string | null;
  accountId?: string | null;
  addedAt?: number | null;
  lastUsedAt?: number | null;
  isActive?: boolean;
};

type CodexPendingLoginSummary = {
  flowId?: string | null;
  requestedByScope?: string | null;
  mode?: string | null;
  verificationUri?: string | null;
  verificationUriComplete?: string | null;
  userCode?: string | null;
  expiresAt?: number | null;
  startedAt?: number | null;
  error?: string | null;
};

type CodexPendingLoginRefreshResult = {
  status: 'pending' | 'completed' | 'expired' | 'failed';
  pendingLogin?: CodexPendingLoginSummary | null;
  account?: CodexLoginAccountSummary | null;
  error?: string | null;
};

type CodexAccountListResult = {
  accounts: CodexLoginAccountSummary[];
  activeAccountId: string | null;
  pendingLogin?: CodexPendingLoginSummary | null;
};

type CodexAccountSwitchResult = {
  account: CodexLoginAccountSummary;
  authPath?: string | null;
  refreshed?: boolean;
};

interface CodexAuthManagerLike {
  getPendingLogin?(): Promise<CodexPendingLoginSummary | null>;
  startDeviceLogin?(params?: { requestedByScope?: string | null }): Promise<CodexPendingLoginSummary>;
  refreshPendingLogin?(): Promise<CodexPendingLoginRefreshResult | null>;
  cancelPendingLogin?(): Promise<boolean>;
  listAccounts?(): Promise<CodexAccountListResult>;
  switchAccountByIndex?(index: number): Promise<CodexAccountSwitchResult>;
}

interface CodexInstructionsManagerLike {
  readInstructions(): Promise<CodexInstructionsSnapshot>;
  writeInstructions(content: string): Promise<CodexInstructionsSnapshot>;
  clearInstructions(): Promise<CodexInstructionsSnapshot>;
}

interface HandleWeiboCommandResult {
  limit: number;
}

type StopCheckpointSnapshot = {
  threadId: string;
  stoppedAt: number;
  interruptedTurnIds: string[];
  pendingApprovalCount: number;
  interruptErrors: string[];
  requestedWhileStarting: boolean;
  settled: boolean;
};

export class BridgeCoordinator {
  bridgeSessions: any;
  automationJobs: any;
  agentJobs: any;
  assistantRecords: any;
  activeTurns: any;
  providerProfiles: any;
  providerRegistry: any;
  pluginAliases: any;
  defaultProviderProfileId: any;
  defaultCwd: any;
  restartBridge: any;
  weiboHotSearch: WeiboHotSearchServiceLike | null;

  codexAuthManager: CodexAuthManagerLike | null;
  codexInstructionsManager: CodexInstructionsManagerLike;
  now: any;
  threadBrowserStates: Map<any, any>;
  skillBrowserStates: Map<any, SkillBrowserState>;
  appBrowserStates: Map<any, AppBrowserState>;
  pluginBrowserStates: Map<any, PluginBrowserState>;
  mcpBrowserStates: Map<any, McpBrowserState>;
  pendingPluginAliasDraftsByScope: Map<string, PendingPluginAliasDraft>;
  localeOverridesByScope: Map<string, SupportedLocale>;
  pendingInstructionsEditsByScope: Map<string, { startedAt: number }>;
  pendingAutomationDraftsByScope: Map<string, PendingAutomationDraft>;
  pendingAgentDraftsByScope: Map<string, PendingAgentDraft>;
  pendingAssistantUpdateDraftsByScope: Map<string, PendingAssistantRecordUpdateDraft>;
  localeContext: AsyncLocalStorage<SupportedLocale>;
  i18n: Translator;

  constructor({
    bridgeSessions,
    automationJobs = null,
    agentJobs = null,
    assistantRecords = null,
    activeTurns = null,
    providerProfiles,
    providerRegistry,
    pluginAliases = null,
    defaultProviderProfileId,
    defaultCwd = null,
    restartBridge = null,
    codexAuthManager = null,
    codexInstructionsManager = null,
    weiboHotSearch = null,
    now = () => Date.now(),
    locale = null,
  }) {
    this.bridgeSessions = bridgeSessions;
    this.automationJobs = automationJobs;
    this.agentJobs = agentJobs;
    this.assistantRecords = assistantRecords;
    this.activeTurns = activeTurns;
    this.providerProfiles = providerProfiles;
    this.providerRegistry = providerRegistry;
    this.pluginAliases = pluginAliases;
    this.defaultProviderProfileId = defaultProviderProfileId;
    this.defaultCwd = normalizeCwd(defaultCwd);
    this.restartBridge = restartBridge;
    this.weiboHotSearch = weiboHotSearch;
    this.codexAuthManager = codexAuthManager;
    this.codexInstructionsManager = codexInstructionsManager ?? new CodexInstructionsManager();
    this.now = now;
    this.threadBrowserStates = new Map();
    this.skillBrowserStates = new Map();
    this.appBrowserStates = new Map();
    this.pluginBrowserStates = new Map();
    this.mcpBrowserStates = new Map();
    this.pendingPluginAliasDraftsByScope = new Map();
    this.localeOverridesByScope = new Map();
    this.pendingInstructionsEditsByScope = new Map();
    this.pendingAutomationDraftsByScope = new Map();
    this.pendingAgentDraftsByScope = new Map();
    this.pendingAssistantUpdateDraftsByScope = new Map();
    this.localeContext = new AsyncLocalStorage();
    this.i18n = createI18n(locale);
  }

  t(key, params = {}) {
    return this.currentI18n.t(key, params);
  }

  get currentI18n() {
    const locale = this.localeContext.getStore();
    if (!locale) {
      return this.i18n;
    }
    return createI18n(locale);
  }

  resolveLocaleForEvent(scopeRef, event) {
    const session = this.resolveSessionForEvent(scopeRef, event);
    if (session) {
      const settings = this.bridgeSessions.getSessionSettings(session.id);
      if (settings?.locale) {
        return normalizeLocale(settings.locale);
      }
    }
    const scopeLocale = this.localeOverridesByScope.get(formatPlatformScopeKey(scopeRef.platform, scopeRef.externalScopeId));
    if (scopeLocale) {
      return scopeLocale;
    }
    if (typeof event?.locale === 'string' && event.locale.trim()) {
      return normalizeLocale(event.locale);
    }
    return this.i18n.locale;
  }

  resolveScopeLocale(scopeRef, event = null) {
    return this.resolveLocaleForEvent(scopeRef, event);
  }

  setScopeLocale(scopeRef, locale) {
    const normalized = normalizeLocale(locale);
    this.localeOverridesByScope.set(formatPlatformScopeKey(scopeRef.platform, scopeRef.externalScopeId), normalized);
  }

  async handleInboundEvent(event, options = {}) {
    const scopeRef = toScopeRef(event);
    const locale = this.resolveLocaleForEvent(scopeRef, event);
    return this.localeContext.run(locale, () => this.handleInboundEventWithLocale(event, options));
  }

  async handleInboundEventWithLocale(event, options = {}) {
    if (!parseSlashCommand(event.text) && this.hasPendingInstructionsEdit(event)) {
      return this.handlePendingInstructionsEdit(event);
    }
    const command = parseSlashCommand(event.text);
    if (command) {
      return this.handleCommand(event, command, options);
    }
    return this.handleConversationTurn(event, options);
  }

  renderApprovalPrompt(event) {
    const activeTurn = this.activeTurns?.resolveScopeTurn(toScopeRef(event)) ?? null;
    const pendingApprovals = Array.isArray(activeTurn?.pendingApprovals) ? activeTurn.pendingApprovals : [];
    if (pendingApprovals.length === 0) {
      return '';
    }
    return renderApprovalPromptLines(pendingApprovals, this.currentI18n).join('\n');
  }

  async handleConversationTurn(event, options = {}) {
    const scopeRef = toScopeRef(event);
    const providerProfile = this.resolveScopeProviderProfile(scopeRef);
    const targetedEvent = await this.rewriteConversationEventForExplicitPluginTarget(event, providerProfile);
    debugCoordinator('conversation_turn_begin', {
      platform: scopeRef.platform,
      scopeId: scopeRef.externalScopeId,
      textPreview: truncateCoordinatorText(targetedEvent?.text, 160),
      attachmentCount: Array.isArray(targetedEvent?.attachments) ? targetedEvent.attachments.length : 0,
    });
    const clarification = this.resolveArtifactClarification(scopeRef, targetedEvent);
    if (clarification.response) {
      debugCoordinator('conversation_turn_clarification_requested', {
        platform: scopeRef.platform,
        scopeId: scopeRef.externalScopeId,
      });
      return clarification.response;
    }
    const effectiveEvent = clarification.event ?? targetedEvent;
    const currentSession = this.resolveSessionForEvent(scopeRef, effectiveEvent);
    const uploadState = currentSession ? this.getUploadsStateForSession(currentSession.id) : null;
    if (uploadState?.active) {
      debugCoordinator('conversation_turn_blocked_uploads', {
        platform: scopeRef.platform,
        scopeId: scopeRef.externalScopeId,
        bridgeSessionId: currentSession?.id ?? null,
        uploadState,
      });
      return this.handleUploadsConversationTurn(effectiveEvent, scopeRef, currentSession, uploadState, options);
    }
    const activeTurn = await this.reconcileActiveTurn(scopeRef);
    if (activeTurn) {
      debugCoordinator('conversation_turn_blocked_active_turn', {
        platform: scopeRef.platform,
        scopeId: scopeRef.externalScopeId,
        activeTurn,
      });
      return this.buildActiveTurnBlockedResponse(effectiveEvent, activeTurn);
    }
    const explicitPluginIssueResponse = await this.buildExplicitPluginIssueResponse(effectiveEvent, providerProfile);
    if (explicitPluginIssueResponse) {
      debugCoordinator('conversation_turn_blocked_plugin_unavailable', {
        platform: scopeRef.platform,
        scopeId: scopeRef.externalScopeId,
        textPreview: truncateCoordinatorText(effectiveEvent?.text, 160),
      });
      return explicitPluginIssueResponse;
    }
    this.activeTurns?.beginScopeTurn(scopeRef);
    let session = null;
    try {
      const locale = this.resolveScopeLocale(scopeRef, effectiveEvent);
      if (currentSession) {
        session = currentSession;
      } else {
        session = await this.bridgeSessions.resolveOrCreateScopeSession(scopeRef, {
          providerProfileId: this.resolveDefaultProviderProfileId(),
          cwd: this.resolveEventCwd(effectiveEvent),
          initialSettings: {
            locale,
          },
          providerStartOptions: {
            sourcePlatform: effectiveEvent.platform,
          },
        });
      }
      debugCoordinator('conversation_turn_session_resolved', {
        platform: scopeRef.platform,
        scopeId: scopeRef.externalScopeId,
        bridgeSessionId: session.id,
        providerProfileId: session.providerProfileId,
        threadId: session.codexThreadId,
        cwd: session.cwd ?? null,
      });
      this.activeTurns?.updateScopeTurn(scopeRef, {
        bridgeSessionId: session.id,
        providerProfileId: session.providerProfileId,
        threadId: session.codexThreadId,
      });
      if (!isAutomationEvent(effectiveEvent)) {
        this.storeRetryableRequest(session.id, effectiveEvent);
      }
      const { result, session: nextSession } = await this.startTurnWithRecovery(scopeRef, session, effectiveEvent, options);
      debugCoordinator('conversation_turn_result', {
        platform: scopeRef.platform,
        scopeId: scopeRef.externalScopeId,
        bridgeSessionId: nextSession?.id ?? session?.id ?? null,
        threadId: nextSession?.codexThreadId ?? session?.codexThreadId ?? null,
        turnId: result?.turnId ?? null,
        outputState: result?.outputState ?? null,
        finalSource: result?.finalSource ?? null,
        outputTextPreview: truncateCoordinatorText(result?.outputText, 160),
        previewTextPreview: truncateCoordinatorText(result?.previewText, 160),
        outputArtifactCount: Array.isArray(result?.outputArtifacts) ? result.outputArtifacts.length : 0,
      });
      const response = turnResponse(result, this.currentI18n, buildSessionMeta(nextSession));
      response.meta = {
        ...(response.meta ?? {}),
        codexTurn: {
          outputState: result.outputState ?? 'complete',
          previewText: result.previewText ?? '',
          finalSource: result.finalSource ?? 'thread_items',
          errorMessage: result.errorMessage ?? '',
        },
      };
      return response;
    } catch (error) {
      const failure = classifyTurnFailure(error, this.currentI18n);
      debugCoordinator('conversation_turn_failure', {
        platform: scopeRef.platform,
        scopeId: scopeRef.externalScopeId,
        bridgeSessionId: session?.id ?? null,
        threadId: session?.codexThreadId ?? null,
        error: error instanceof Error ? error.message : String(error),
        failure: failure ?? null,
      });
      if (!failure) {
        throw error;
      }
      const response = messageResponse([''], session ? buildSessionMeta(session) : this.buildScopedSessionMeta(effectiveEvent));
      response.meta = {
        ...(response.meta ?? {}),
        codexTurn: {
          outputState: failure.outputState,
          previewText: '',
          finalSource: 'none',
          errorMessage: failure.errorMessage ?? '',
        },
      };
      return response;
    } finally {
      await this.releaseActiveTurnIfStillRunning(scopeRef);
    }
  }

  resolveArtifactClarification(scopeRef, event) {
    return { event, response: null };
  }

  async handleCommand(event, command, options = {}) {
    const commandName = normalizeCommandName(command.name);
    if (commandName !== 'helps' && command.args.some((arg) => isHelpFlag(arg))) {
      return this.handleHelpsCommand(event, [commandName]);
    }
    switch (commandName) {
      case 'help':
      case 'helps':
        return this.handleHelpsCommand(event, command.args);
      case 'status':
      case 'where':
        return this.handleStatusCommand(event, command.args);
      case 'usage':
        return this.handleUsageCommand(event);
      case 'login':
        return this.handleLoginCommand(event, command.args);
      case 'new':
        return this.handleNewCommand(event, command.args);
      case 'uploads':
        return this.handleUploadsCommand(event, command.args);
      case 'assistant':
        return this.handleAssistantCommand(event, command.args, null);
      case 'log':
        return this.handleAssistantCommand(event, command.args, 'log');
      case 'todo':
        return this.handleAssistantCommand(event, command.args, 'todo');
      case 'remind':
        return this.handleAssistantCommand(event, command.args, 'reminder');
      case 'note':
        return this.handleAssistantCommand(event, command.args, 'note');
      case 'stop':
      case 'interrupt':
        return this.handleStopCommand(event);
      case 'review':
        return this.handleReviewCommand(event, command.args, options);
      case 'agent':
        return this.handleAgentCommand(event, command.args);
      case 'skills':
        return this.handleSkillsCommand(event, command.args);
      case 'apps':
        return this.handleAppsCommand(event, command.args);
      case 'plugins':
        return this.handlePluginsCommand(event, command.args);
      case 'mcp':
        return this.handleMcpCommand(event, command.args);
      case 'use':
        return this.handleUseCommand(event, command.args, options);
      case 'automation':
        return this.handleAutomationCommand(event, command.args);
      case 'weibo':
        return this.handleWeiboCommand(event, command.args);
      case 'threads':
        return this.handleThreadsCommand(event, command.args);
      case 'search':
        return this.handleSearchCommand(event, command.args);
      case 'next':
        return this.handleNextThreadsCommand(event);
      case 'prev':
        return this.handlePrevThreadsCommand(event);
      case 'open':
        return this.handleOpenCommand(event, command.args);
      case 'rename':
        return this.handleRenameCommand(event, command.args);
      case 'peek':
        return this.handlePeekCommand(event, command.args);
      case 'provider':
        return this.handleProviderCommand(event, command.args);
      case 'lang':
        return this.handleLangCommand(event, command.args);
      case 'restart':
        return this.handleRestartCommand(event);
      case 'reconnect':
        return this.handleReconnectCommand(event);
      case 'retry':
        return this.handleRetryCommand(event, options);
      case 'permissions':
        return this.handlePermissionsCommand(event, command.args);
      case 'allow':
        return this.handleAllowCommand(event, command.args);
      case 'deny':
        return this.handleDenyCommand(event, command.args);
      case 'models':
        return this.handleModelsCommand(event);
      case 'model':
        return this.handleModelCommand(event, command.args);
      case 'plan':
        return this.handlePlanCommand(event, command.args);
      case 'personality':
        return this.handlePersonalityCommand(event, command.args);
      case 'instructions':
        return this.handleInstructionsCommand(event, command.args);
      case 'fast':
        return this.handleFastCommand(event, command.args);
      default:
        return messageResponse([
          this.t('coordinator.command.unsupported', { name: command.name }),
          this.t('coordinator.command.useHelps'),
        ], this.buildScopedSessionMeta(event));
    }
  }

  async handleHelpsCommand(event, args) {
    const requested = normalizeHelpTarget(args[0]);
    if (!requested) {
      return textResponse(renderCommandCatalog(this.currentI18n), this.buildScopedSessionMeta(event));
    }
    const spec = resolveCommandHelpSpec(requested, this.currentI18n);
    if (!spec) {
      return messageResponse([
        this.t('coordinator.command.unknown', { name: requested }),
        this.t('coordinator.command.useHelps'),
      ], this.buildScopedSessionMeta(event));
    }
    return textResponse(renderCommandHelp(spec, this.currentI18n), this.buildScopedSessionMeta(event));
  }

  async handleStatusCommand(event, args = []) {
    const scopeRef = toScopeRef(event);
    const session = this.bridgeSessions.resolveScopeSession(scopeRef);
    const statusMode = this.resolveStatusMode(args);
    if (statusMode === 'invalid') {
      return this.handleHelpsCommand(event, ['status']);
    }
    const details = statusMode === 'details';
    const platformStatusLines = await this.renderPlatformStatusLines(event, { details });
    const providerProfile = session
      ? this.requireProviderProfile(session.providerProfileId)
      : this.resolveScopeProviderProfile(scopeRef);
    const usageReport = await this.resolveProviderUsage(providerProfile);
    const settings = session ? this.bridgeSessions.getSessionSettings(session.id) : null;
    const instructionsSnapshot = await this.codexInstructionsManager.readInstructions();
    const modelValue = await this.resolveStatusModelValue(providerProfile, settings);
    const lastArtifactDelivery = resolveStoredArtifactDelivery(settings);
    if (!session) {
      const lines = [
        this.t('coordinator.status.interfaceProfile', { id: providerProfile.id }),
        ...(details ? [this.t('coordinator.status.providerKind', { kind: providerProfile.providerKind })] : []),
        ...this.renderUsageSummaryLines(usageReport),
        this.t('coordinator.status.defaultCwd', { cwd: this.defaultCwd ?? this.t('common.notSet') }),
        this.t('coordinator.status.speedMode', { value: formatSpeedMode(null) }),
        this.t('coordinator.status.model', { value: modelValue }),
        this.t('coordinator.status.personality', { value: formatPersonality(null, this.currentI18n) }),
        this.t('coordinator.status.reasoningEffort', { value: '' }),
        this.t('coordinator.status.accessPreset', { value: '' }),
        ...platformStatusLines,
        ...(!details ? [this.t('coordinator.status.detailHint')] : []),
      ];
      return messageResponse(lines);
    }
    const activeTurn = this.activeTurns?.resolveScopeTurn(scopeRef) ?? null;
    const simpleLines = [
      this.t('coordinator.status.interfaceProfile', { id: providerProfile.id }),
      this.t('coordinator.status.threadTitle', {
        value: formatCurrentBindingTitle(session.title, session.codexThreadId, this.currentI18n),
      }),
      ...this.renderUsageSummaryLines(usageReport),
      this.t('coordinator.status.workingDirectory', { cwd: session.cwd ?? this.defaultCwd ?? this.t('common.notSet') }),
      this.t('coordinator.status.speedMode', { value: formatSpeedMode(settings?.serviceTier ?? null) }),
      this.t('coordinator.status.model', { value: modelValue }),
      this.t('coordinator.status.planMode', { value: formatPlanMode(settings?.collaborationMode ?? null, this.currentI18n) }),
      this.t('coordinator.status.personality', { value: formatPersonality(settings?.personality ?? null, this.currentI18n) }),
      this.t('coordinator.status.reasoningEffort', { value: settings?.reasoningEffort ?? '' }),
      this.t('coordinator.status.accessPreset', { value: settings?.accessPreset ?? '' }),
    ];
    const detailLines = [
      this.t('coordinator.status.scope', { scope: `${event.platform}:${event.externalScopeId}` }),
      this.t('coordinator.status.bridgeSession', { id: session.id }),
      this.t('coordinator.status.providerProfile', { id: providerProfile.id }),
      this.t('coordinator.status.providerKind', { kind: providerProfile.providerKind }),
      this.t('coordinator.status.threadTitle', {
        value: formatCurrentBindingTitle(session.title, session.codexThreadId, this.currentI18n),
      }),
      ...this.renderUsageSummaryLines(usageReport),
      this.t('coordinator.status.codexThread', { id: session.codexThreadId }),
      this.t('coordinator.status.workingDirectory', { cwd: session.cwd ?? this.defaultCwd ?? this.t('common.notSet') }),
      this.t('coordinator.status.speedMode', { value: formatSpeedMode(settings?.serviceTier ?? null) }),
      this.t('coordinator.status.model', { value: settings?.model ?? this.t('common.default') }),
      this.t('coordinator.status.planMode', { value: formatPlanMode(settings?.collaborationMode ?? null, this.currentI18n) }),
      this.t('coordinator.status.personality', { value: formatPersonality(settings?.personality ?? null, this.currentI18n) }),
      this.t('coordinator.status.reasoningEffort', { value: settings?.reasoningEffort ?? this.t('common.default') }),
      this.t('coordinator.status.serviceTier', { value: normalizeServiceTier(settings?.serviceTier) ?? this.t('common.default') }),
      this.t('coordinator.status.accessPreset', { value: formatAccessPreset(resolveAccessPreset(settings)) }),
      this.t('coordinator.status.approvalPolicy', { value: resolveApprovalPolicy(settings) }),
      this.t('coordinator.status.sandboxMode', { value: resolveSandboxMode(settings) }),
      this.t('coordinator.status.customInstructions', {
        value: formatInstructionsStatus(instructionsSnapshot.exists, this.currentI18n),
      }),
      this.t('coordinator.status.instructionsPath', { value: instructionsSnapshot.path }),
      this.t('coordinator.status.currentTurn', { value: formatActiveTurnValue(activeTurn, this.currentI18n) }),
      this.t('coordinator.status.turnState', { value: formatActiveTurnState(activeTurn, this.currentI18n) }),
      ...(activeTurn ? [this.t('coordinator.status.turnControl')] : []),
      ...renderArtifactDeliveryStatusLines(activeTurn?.artifactDelivery ?? lastArtifactDelivery, this.currentI18n),
    ];
    const lines = details
      ? [...detailLines, ...platformStatusLines]
      : [...simpleLines, ...platformStatusLines, this.t('coordinator.status.detailHint')];
    return messageResponse(lines, buildSessionMeta(session));
  }

  async handleUsageCommand(event) {
    const scopeRef = toScopeRef(event);
    const providerProfile = this.resolveScopeProviderProfile(scopeRef);
    const report = await this.resolveProviderUsage(providerProfile);
    if (!report) {
      return messageResponse([
        this.t('coordinator.usage.title', { providerProfileId: providerProfile.id }),
        this.t('coordinator.usage.unavailable'),
      ], this.resolveScopedSessionMeta(scopeRef));
    }
    return messageResponse([
      this.t('coordinator.usage.title', { providerProfileId: providerProfile.id }),
      ...this.renderUsageDetailLines(report),
    ], this.resolveScopedSessionMeta(scopeRef));
  }

  async handleLoginCommand(event, args = []) {
    if (!this.codexAuthManager) {
      return messageResponse([
        this.t('coordinator.login.unsupported'),
      ], this.buildScopedSessionMeta(event));
    }
    const action = String(args[0] ?? '').trim();
    if (!action) {
      return this.handleLoginStartOrStatusCommand(event);
    }
    const normalized = action.toLowerCase();
    if (normalized === 'list') {
      return this.handleLoginListCommand(event);
    }
    if (normalized === 'cancel') {
      return this.handleLoginCancelCommand(event);
    }
    if (/^\d+$/u.test(normalized)) {
      return this.handleLoginSwitchCommand(event, Number.parseInt(normalized, 10));
    }
    return this.handleHelpsCommand(event, ['login']);
  }

  async handleLoginStartOrStatusCommand(event) {
    const scopeKey = formatPlatformScopeKey(event.platform, event.externalScopeId);
    try {
      const refreshResult = await this.codexAuthManager?.refreshPendingLogin?.() ?? null;
      if (refreshResult?.status === 'completed') {
        return messageResponse([
          this.t('coordinator.login.completed'),
          ...this.renderLoginAccountLines(refreshResult.account ?? null, { includePrefix: true }),
          this.t('coordinator.login.completedNext'),
        ], this.buildScopedSessionMeta(event));
      }
      if (refreshResult?.status === 'pending' && refreshResult.pendingLogin) {
        return messageResponse(
          this.renderPendingLoginLines(refreshResult.pendingLogin, {
            includeContinueHint: true,
            includeTitle: true,
          }),
          this.buildScopedSessionMeta(event),
        );
      }
      if (refreshResult?.status === 'failed') {
        return messageResponse([
          this.t('coordinator.login.startFailed', {
            error: formatCodexLoginError(refreshResult.error, this.currentI18n),
          }),
        ], this.buildScopedSessionMeta(event));
      }
      const pendingLogin = await this.codexAuthManager?.startDeviceLogin?.({
        requestedByScope: scopeKey,
      });
      return messageResponse(
        this.renderPendingLoginLines(pendingLogin ?? null, {
          includeContinueHint: true,
          includeTitle: true,
        }),
        this.buildScopedSessionMeta(event),
      );
    } catch (error) {
      return messageResponse([
        this.t('coordinator.login.startFailed', {
          error: formatCodexLoginError(error, this.currentI18n),
        }),
      ], this.buildScopedSessionMeta(event));
    }
  }

  async handleLoginListCommand(event) {
    const refreshResult = await this.codexAuthManager?.refreshPendingLogin?.() ?? null;
    const listing = await this.codexAuthManager?.listAccounts?.();
    if (!listing) {
      return messageResponse([
        this.t('coordinator.login.unsupported'),
      ], this.buildScopedSessionMeta(event));
    }
    const lines = [
      this.t('coordinator.login.listTitle', { count: listing.accounts.length }),
    ];
    if (listing.accounts.length === 0) {
      lines.push(this.t('coordinator.login.listEmpty'));
      lines.push(this.t('coordinator.login.listEmptyHint'));
    } else {
      for (const [index, account] of listing.accounts.entries()) {
        lines.push(formatLoginListItem(index, account, this.currentI18n));
      }
      lines.push(this.t('coordinator.login.listSwitchHint'));
    }
    if (refreshResult?.status === 'completed' && refreshResult.account) {
      lines.push('');
      lines.push(this.t('coordinator.login.completed'));
      lines.push(...this.renderLoginAccountLines(refreshResult.account, { includePrefix: true }));
    } else if (listing.pendingLogin) {
      lines.push('');
      lines.push(...this.renderPendingLoginLines(listing.pendingLogin, {
        includeContinueHint: false,
        includeTitle: false,
      }));
    }
    return messageResponse(lines, this.buildScopedSessionMeta(event));
  }

  async handleLoginCancelCommand(event) {
    const cancelled = await this.codexAuthManager?.cancelPendingLogin?.() ?? false;
    return messageResponse([
      cancelled
        ? this.t('coordinator.login.cancelled')
        : this.t('coordinator.login.noPending'),
    ], this.buildScopedSessionMeta(event));
  }

  async handleLoginSwitchCommand(event, index: number) {
    if (!Number.isFinite(index) || index < 1) {
      return messageResponse([
        this.t('coordinator.login.switchInvalidIndex', { index: String(index) }),
        this.t('coordinator.login.switchUsage'),
      ], this.buildScopedSessionMeta(event));
    }
    if (this.activeTurns?.hasAnyActiveTurn?.()) {
      return messageResponse([
        this.t('coordinator.login.switchBlocked'),
      ], this.buildScopedSessionMeta(event));
    }
    try {
      const result = await this.codexAuthManager?.switchAccountByIndex?.(index);
      if (!result?.account) {
        return messageResponse([
          this.t('coordinator.login.switchMissing'),
        ], this.buildScopedSessionMeta(event));
      }
      const reconnectSummary = await this.reconnectOpenAINativeProfilesAfterAuthSwitch();
      const lines = [
        this.t('coordinator.login.switchSuccess'),
        ...this.renderLoginAccountLines(result.account, { includePrefix: true }),
        ...(result.authPath ? [this.t('coordinator.login.authPath', { value: result.authPath })] : []),
        ...(result.refreshed ? [this.t('coordinator.login.switchRefreshed')] : []),
        ...(reconnectSummary.refreshedCount > 0
          ? [this.t('coordinator.login.reconnected', { count: reconnectSummary.refreshedCount })]
          : [this.t('coordinator.login.reconnectedNone')]),
        ...(reconnectSummary.errors.length > 0
          ? [this.t('coordinator.login.reconnectFailed', { error: reconnectSummary.errors[0] })]
          : []),
        this.t('coordinator.login.switchThreadNotice'),
      ];
      return messageResponse(lines, this.buildScopedSessionMeta(event));
    } catch (error) {
      return messageResponse([
        this.t('coordinator.login.switchFailed', { error: formatUserError(error) }),
      ], this.buildScopedSessionMeta(event));
    }
  }

  async reconnectOpenAINativeProfilesAfterAuthSwitch() {
    const profiles = this.providerProfiles?.list?.()
      ?.filter((profile) => profile?.providerKind === 'openai-native') ?? [];
    if (profiles.length === 0) {
      return {
        refreshedCount: 0,
        errors: [],
      };
    }
    const providerPlugin = this.providerRegistry.getProvider('openai-native');
    if (!providerPlugin || typeof providerPlugin.reconnectProfile !== 'function') {
      return {
        refreshedCount: 0,
        errors: [],
      };
    }
    let refreshedCount = 0;
    const errors: string[] = [];
    for (const profile of profiles) {
      try {
        await providerPlugin.reconnectProfile({ providerProfile: profile });
        refreshedCount += 1;
      } catch (error) {
        errors.push(formatUserError(error));
      }
    }
    return {
      refreshedCount,
      errors,
    };
  }

  async reconnectCodexBackedProfiles() {
    const profiles = this.providerProfiles?.list?.()
      ?.filter((profile) => CODEX_BACKED_PROVIDER_KIND_SET.has(profile?.providerKind)) ?? [];
    if (profiles.length === 0) {
      return {
        refreshedCount: 0,
        errors: [],
      };
    }
    let refreshedCount = 0;
    const errors: string[] = [];
    for (const profile of profiles) {
      const providerPlugin = this.providerRegistry.getProvider(profile.providerKind);
      if (!providerPlugin || typeof providerPlugin.reconnectProfile !== 'function') {
        continue;
      }
      try {
        await providerPlugin.reconnectProfile({ providerProfile: profile });
        refreshedCount += 1;
      } catch (error) {
        errors.push(formatUserError(error));
      }
    }
    return {
      refreshedCount,
      errors,
    };
  }

  renderPendingLoginLines(pendingLogin, {
    includeContinueHint = true,
    includeTitle = true,
  } = {}) {
    const lines = [];
    if (includeTitle) {
      lines.push(this.t('coordinator.login.pendingTitle'));
    }
    if (pendingLogin?.verificationUriComplete) {
      lines.push(this.t('coordinator.login.url', { value: pendingLogin.verificationUriComplete }));
    } else if (pendingLogin?.verificationUri) {
      lines.push(this.t('coordinator.login.url', { value: pendingLogin.verificationUri }));
    }
    if (pendingLogin?.userCode) {
      lines.push(this.t('coordinator.login.userCode', { value: pendingLogin.userCode }));
    }
    if (typeof pendingLogin?.expiresAt === 'number') {
      lines.push(this.t('coordinator.login.expiresAt', {
        value: new Date(pendingLogin.expiresAt).toISOString(),
      }));
    }
    if (pendingLogin?.error) {
      lines.push(this.t('coordinator.login.pendingError', { error: pendingLogin.error }));
    }
    lines.push(this.t('coordinator.login.globalNotice'));
    if (includeContinueHint) {
      lines.push(this.t('coordinator.login.pendingNext'));
    }
    return lines;
  }

  hasPendingInstructionsEdit(event): boolean {
    return this.pendingInstructionsEditsByScope.has(buildInstructionsEditKey(event));
  }

  setPendingInstructionsEdit(event) {
    this.pendingInstructionsEditsByScope.set(buildInstructionsEditKey(event), {
      startedAt: this.now(),
    });
  }

  clearPendingInstructionsEdit(event) {
    this.pendingInstructionsEditsByScope.delete(buildInstructionsEditKey(event));
  }

  getPendingAutomationDraft(scopeRef: PlatformScopeRef): PendingAutomationDraft | null {
    return this.pendingAutomationDraftsByScope.get(buildAutomationDraftKey(scopeRef)) ?? null;
  }

  setPendingAutomationDraft(scopeRef: PlatformScopeRef, draft: PendingAutomationDraft) {
    this.pendingAutomationDraftsByScope.set(buildAutomationDraftKey(scopeRef), draft);
  }

  clearPendingAutomationDraft(scopeRef: PlatformScopeRef) {
    this.pendingAutomationDraftsByScope.delete(buildAutomationDraftKey(scopeRef));
  }

  getPendingAssistantUpdateDraft(scopeRef: PlatformScopeRef): PendingAssistantRecordUpdateDraft | null {
    return this.pendingAssistantUpdateDraftsByScope.get(buildAssistantUpdateDraftKey(scopeRef)) ?? null;
  }

  setPendingAssistantUpdateDraft(scopeRef: PlatformScopeRef, draft: PendingAssistantRecordUpdateDraft) {
    this.pendingAssistantUpdateDraftsByScope.set(buildAssistantUpdateDraftKey(scopeRef), draft);
  }

  clearPendingAssistantUpdateDraft(scopeRef: PlatformScopeRef) {
    this.pendingAssistantUpdateDraftsByScope.delete(buildAssistantUpdateDraftKey(scopeRef));
  }

  async handlePendingInstructionsEdit(event) {
    if (!String(event.text ?? '').trim()) {
      return messageResponse([
        this.t('coordinator.instructions.editNeedsText'),
        this.t('coordinator.instructions.editHint'),
      ], this.buildScopedSessionMeta(event));
    }
    return this.applyInstructionsContent(event, event.text);
  }

  async renderInstructionsStatus(event) {
    const snapshot = await this.codexInstructionsManager.readInstructions();
    const lines = [
      this.t('coordinator.instructions.current', {
        value: snapshot.exists ? this.t('common.enabled') : this.t('common.notSet'),
      }),
      this.t('coordinator.instructions.path', { value: snapshot.path }),
      this.t('coordinator.instructions.contentLabel'),
      snapshot.exists
        ? snapshot.content.trimEnd() || this.t('common.empty')
        : this.t('common.notSet'),
      this.t('coordinator.instructions.usage'),
      this.t('coordinator.instructions.help'),
    ];
    if (this.hasPendingInstructionsEdit(event)) {
      lines.push(this.t('coordinator.instructions.editPending'));
    }
    return messageResponse(lines, this.buildScopedSessionMeta(event));
  }

  async applyInstructionsContent(event, content: string) {
    if (this.activeTurns?.hasAnyActiveTurn?.()) {
      return messageResponse([
        this.t('coordinator.instructions.blocked'),
      ], this.buildScopedSessionMeta(event));
    }
    try {
      const snapshot = await this.codexInstructionsManager.writeInstructions(content);
      this.clearPendingInstructionsEdit(event);
      const reconnectSummary = await this.reconnectCodexBackedProfiles();
      return messageResponse(this.renderInstructionsSavedLines({
        action: 'saved',
        snapshot,
        reconnectSummary,
      }), this.buildScopedSessionMeta(event));
    } catch (error) {
      return messageResponse([
        this.t('coordinator.instructions.failed', { error: formatUserError(error) }),
      ], this.buildScopedSessionMeta(event));
    }
  }

  cancelInstructionsEdit(event) {
    if (!this.hasPendingInstructionsEdit(event)) {
      return messageResponse([
        this.t('coordinator.instructions.editNotPending'),
      ], this.buildScopedSessionMeta(event));
    }
    this.clearPendingInstructionsEdit(event);
    return messageResponse([
      this.t('coordinator.instructions.editCancelled'),
    ], this.buildScopedSessionMeta(event));
  }

  renderInstructionsSavedLines({
    action,
    snapshot,
    reconnectSummary,
  }: {
    action: 'saved' | 'cleared';
    snapshot: CodexInstructionsSnapshot;
    reconnectSummary: { refreshedCount: number; errors: string[] };
  }): string[] {
    const lines = [
      action === 'saved'
        ? this.t('coordinator.instructions.saved')
        : this.t('coordinator.instructions.cleared'),
      this.t('coordinator.instructions.path', { value: snapshot.path }),
      ...(reconnectSummary.refreshedCount > 0
        ? [this.t('coordinator.instructions.reconnected', { count: reconnectSummary.refreshedCount })]
        : [this.t('coordinator.instructions.reconnectedNone')]),
      ...(reconnectSummary.errors.length > 0
        ? [this.t('coordinator.instructions.reconnectFailed', { error: reconnectSummary.errors[0] })]
        : []),
      this.t('coordinator.instructions.applyNextTurn'),
    ];
    return lines;
  }

  renderLoginAccountLines(account, { includePrefix = false } = {}) {
    if (!account) {
      return [];
    }
    const identity = formatCodexLoginAccountIdentity(account, this.currentI18n);
    const planType = account.planType ?? account.plan ?? null;
    const lines = [];
    if (includePrefix) {
      lines.push(this.t('coordinator.login.account', { value: identity }));
    } else {
      lines.push(identity);
    }
    if (planType) {
      lines.push(this.t('coordinator.login.plan', { value: planType }));
    }
    return lines;
  }

  resolveStatusMode(args = []) {
    const mode = String(args[0] ?? '').trim().toLowerCase();
    if (!mode) {
      return 'simple';
    }
    if (STATUS_DETAILS_ARG_SET.has(mode)) {
      return 'details';
    }
    return 'invalid';
  }

  async renderPlatformStatusLines(event, { details = false } = {}) {
    const platformPlugin = this.providerRegistry?.listPlatforms?.()
      ?.find((plugin) => plugin?.id === event.platform) ?? null;
    if (!platformPlugin || typeof platformPlugin.getStatus !== 'function') {
      return [];
    }
    const status = await platformPlugin.getStatus({
      externalScopeId: event.externalScopeId,
    });
    return renderPlatformStatusLines(event.platform, status?.data ?? null, this.currentI18n, { details });
  }

  async handleNewCommand(event, args) {
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'new');
    if (activeResponse) {
      return activeResponse;
    }
    const scopeRef = toScopeRef(event);
    const existing = this.bridgeSessions.resolveScopeSession(scopeRef);
    const existingSettings = existing ? this.bridgeSessions.getSessionSettings(existing.id) : null;
    const providerProfileId = existing?.providerProfileId ?? this.resolveDefaultProviderProfileId();
    const nextSession = await this.bridgeSessions.createSessionForScope(scopeRef, {
      providerProfileId,
      cwd: args.join(' ').trim() || existing?.cwd || this.resolveEventCwd(event),
      initialSettings: this.buildReboundSessionSettings(existingSettings, {
        locale: this.resolveScopeLocale(scopeRef, event),
      }),
      providerStartOptions: {
        sourcePlatform: event.platform,
        trigger: 'new-command',
      },
    });
    return messageResponse([
      this.t('coordinator.new.created'),
      this.t('coordinator.status.providerProfile', { id: nextSession.providerProfileId }),
      this.t('coordinator.status.codexThread', { id: nextSession.codexThreadId }),
    ], buildSessionMeta(nextSession));
  }

  async handleUploadsCommand(event, args) {
    const action = String(args[0] ?? '').trim().toLowerCase();
    if (action === 'status') {
      return this.handleUploadsStatusCommand(event);
    }
    if (action === 'cancel') {
      const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'uploads');
      if (activeResponse) {
        return activeResponse;
      }
      return this.handleUploadsCancelCommand(event);
    }
    if (action) {
      return this.handleHelpsCommand(event, ['uploads']);
    }
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'uploads');
    if (activeResponse) {
      return activeResponse;
    }
    const scopeRef = toScopeRef(event);
    const session = await this.bridgeSessions.resolveOrCreateScopeSession(scopeRef, {
      providerProfileId: this.resolveScopeProviderProfile(scopeRef).id,
      cwd: this.resolveEventCwd(event),
      initialSettings: {
        locale: this.resolveScopeLocale(scopeRef, event),
      },
      providerStartOptions: {
        sourcePlatform: event.platform,
        trigger: 'uploads-command',
      },
    });
    const existing = this.getUploadsStateForSession(session.id);
    if (existing?.active) {
      return messageResponse([
        this.t('coordinator.uploads.alreadyActive'),
        ...this.renderUploadsStateLines(session, existing),
        this.t('coordinator.uploads.waiting'),
        this.t('coordinator.uploads.statusHint'),
        this.t('coordinator.uploads.cancelHint'),
      ], buildSessionMeta(session));
    }
    const nextState = createUploadBatchState(this.now());
    this.setUploadsStateForSession(session.id, nextState);
    return messageResponse([
      this.t('coordinator.uploads.started'),
      this.t('coordinator.uploads.batch', { id: nextState.batchId }),
      this.t('coordinator.uploads.directory', {
        value: this.resolveUploadBatchDirectory(session, nextState) ?? this.t('common.notSet'),
      }),
      this.t('coordinator.uploads.waiting'),
      this.t('coordinator.uploads.statusHint'),
      this.t('coordinator.uploads.cancelHint'),
    ], buildSessionMeta(session));
  }

  async handleAssistantCommand(event, args, forcedType: AssistantRecordType | null = null) {
    if (!this.assistantRecords) {
      return messageResponse([this.t('coordinator.assistant.unsupported')], this.buildScopedSessionMeta(event));
    }
    const scopeRef = toScopeRef(event);
    const commandName = assistantCommandNameForType(forcedType);
    const action = String(args[0] ?? '').trim().toLowerCase();
    const typeFilter = forcedType ?? null;
    if (['list', 'ls', 'status'].includes(action)) {
      return this.renderAssistantList(event, typeFilter);
    }
    if (action === 'search') {
      const query = args.slice(1).join(' ').trim();
      if (!query) {
        return messageResponse([
          this.t('coordinator.assistant.searchUsage', { command: commandName }),
        ], this.buildScopedSessionMeta(event));
      }
      return this.renderAssistantList(event, typeFilter, query);
    }
    if (action === 'show') {
      return this.handleAssistantShowCommand(event, args.slice(1), typeFilter);
    }
    if (['done', 'complete'].includes(action)) {
      return this.handleAssistantDoneCommand(event, args.slice(1), typeFilter);
    }
    if (['del', 'delete', 'archive'].includes(action)) {
      return this.handleAssistantDeleteCommand(event, args.slice(1), typeFilter);
    }
    if (action === 'ok' || action === 'confirm') {
      return this.handleAssistantConfirmCommand(event, typeFilter);
    }
    if (action === 'cancel') {
      if (args[1]) {
        return this.handleAssistantCancelRecordCommand(event, args.slice(1), typeFilter);
      }
      return this.handleAssistantCancelPendingCommand(event, typeFilter);
    }
    if (action === 'edit') {
      return this.handleAssistantEditPendingCommand(event, args.slice(1), forcedType);
    }
    const rawInput = args.join(' ').trim();
    if (!rawInput) {
      return this.renderAssistantList(event, typeFilter);
    }
    const uploadContext = this.resolveActiveUploadContext(scopeRef);
    if (!uploadContext.state?.active && forcedType === null) {
      const updateDraft = await this.buildAssistantRecordUpdateDraft(event, scopeRef, rawInput);
      if (updateDraft) {
        this.setPendingAssistantUpdateDraft(scopeRef, updateDraft);
        return messageResponse(this.renderAssistantUpdateDraftLines(updateDraft), this.buildScopedSessionMeta(event));
      }
    }
    const localDraft = this.assistantRecords.parseDraft(rawInput, forcedType);
    const draft = await this.normalizeAssistantRecordDraft(event, scopeRef, rawInput, forcedType, localDraft);
    const shouldConfirm = this.assistantRecords.shouldConfirmDraft(draft, forcedType);
    const record = await this.assistantRecords.createRecord({
      scopeRef,
      source: event.platform === 'telegram' ? 'telegram' : 'weixin',
      contextThreadId: uploadContext.session?.codexThreadId ?? this.bridgeSessions.resolveScopeSession(scopeRef)?.codexThreadId ?? null,
      timezone: extractEventTimezone(event),
      draft,
      status: shouldConfirm ? 'pending' : 'active',
      parseStatus: shouldConfirm ? 'auto' : forcedType ? 'confirmed' : 'auto',
      uploadItems: uploadContext.state?.active ? uploadContext.state.items : [],
    });
    if (uploadContext.session && uploadContext.state?.active) {
      await this.removeUploadBatchFiles(uploadContext.session, uploadContext.state);
      this.setUploadsStateForSession(uploadContext.session.id, null);
    }
    if (record.status === 'pending') {
      return messageResponse(this.renderAssistantPendingLines(record, commandName), this.buildScopedSessionMeta(event));
    }
    return messageResponse(this.renderAssistantSavedLines(record, commandName), this.buildScopedSessionMeta(event));
  }

  async normalizeAssistantRecordDraft(
    event,
    scopeRef: PlatformScopeRef,
    rawInput: string,
    forcedType: AssistantRecordType | null,
    localDraft: AssistantRecordDraft,
  ): Promise<AssistantRecordDraft> {
    const timezone = extractEventTimezone(event);
    const codexDraft = await this.normalizeAssistantRecordDraftWithCodex(event, scopeRef, rawInput, forcedType, localDraft, timezone).catch(() => null);
    if (codexDraft) {
      return normalizeAssistantDraftForStorage(codexDraft, {
        timezone,
        now: this.now(),
      });
    }
    const agentsDraft = await normalizeAssistantRecordDraftWithOpenAIAgents(
      rawInput,
      forcedType,
      this.currentI18n.locale,
      this.now(),
      localDraft,
      timezone,
    ).catch(() => null);
    if (agentsDraft) {
      return normalizeAssistantDraftForStorage(agentsDraft, {
        timezone,
        now: this.now(),
      });
    }
    return normalizeAssistantDraftForStorage({
      ...localDraft,
      parsedJson: {
        ...(localDraft.parsedJson ?? {}),
        normalizer: 'local',
      },
    }, {
      timezone,
      now: this.now(),
    });
  }

  async normalizeAssistantRecordDraftWithCodex(
    event,
    scopeRef: PlatformScopeRef,
    rawInput: string,
    forcedType: AssistantRecordType | null,
    localDraft: AssistantRecordDraft,
    timezone: string | null,
  ): Promise<AssistantRecordDraft | null> {
    const boundSession = this.bridgeSessions.resolveScopeSession(scopeRef);
    const providerProfile = boundSession
      ? this.requireProviderProfile(boundSession.providerProfileId)
      : this.resolveScopeProviderProfile(scopeRef);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (!providerPlugin || typeof providerPlugin.startThread !== 'function' || typeof providerPlugin.startTurn !== 'function') {
      return null;
    }
    const inheritedSettings = boundSession
      ? this.bridgeSessions.getSessionSettings(boundSession.id)
      : null;
    const locale = inheritedSettings?.locale ?? this.resolveScopeLocale(scopeRef, event);
    const cwd = normalizeCwd(boundSession?.cwd) ?? this.resolveEventCwd(event) ?? null;
    const thread = await providerPlugin.startThread({
      providerProfile,
      cwd,
      title: 'Assistant Record Classifier',
      metadata: {
        sourcePlatform: event.platform,
        source: 'assistant-record-classifier',
      },
    });
    const parserSession = {
      id: crypto.randomUUID(),
      providerProfileId: providerProfile.id,
      codexThreadId: thread.threadId,
      cwd: thread.cwd ?? cwd,
      title: thread.title ?? 'Assistant Record Classifier',
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    const prompt = buildAssistantRecordDraftPrompt(rawInput, forcedType, locale, this.now(), timezone);
    const result = await providerPlugin.startTurn({
      providerProfile,
      bridgeSession: parserSession,
      sessionSettings: {
        bridgeSessionId: parserSession.id,
        model: inheritedSettings?.model ?? null,
        reasoningEffort: inheritedSettings?.reasoningEffort ?? null,
        serviceTier: inheritedSettings?.serviceTier ?? null,
        collaborationMode: null,
        personality: null,
        accessPreset: 'read-only',
        approvalPolicy: 'never',
        sandboxMode: 'read-only',
        locale,
        metadata: {},
        updatedAt: this.now(),
      },
      event: {
        ...event,
        text: prompt,
        cwd: parserSession.cwd ?? null,
        locale,
        attachments: [],
      },
      inputText: prompt,
    });
    return parseAssistantRecordDraftCandidate(result.outputText, rawInput, forcedType, localDraft, 'codex');
  }

  async handleAssistantShowCommand(event, args, typeFilter: AssistantRecordType | null) {
    const scopeRef = toScopeRef(event);
    const token = String(args[0] ?? '').trim();
    const record = this.assistantRecords.resolveForScope(scopeRef, token, typeFilter);
    if (!record) {
      return messageResponse([this.t('coordinator.assistant.notFound')], this.buildScopedSessionMeta(event));
    }
    return messageResponse(this.renderAssistantDetailLines(record), this.buildScopedSessionMeta(event));
  }

  async handleAssistantDoneCommand(event, args, typeFilter: AssistantRecordType | null) {
    const scopeRef = toScopeRef(event);
    const token = String(args[0] ?? '').trim();
    const record = this.assistantRecords.resolveForScope(scopeRef, token, typeFilter);
    if (!record) {
      return messageResponse([this.t('coordinator.assistant.notFound')], this.buildScopedSessionMeta(event));
    }
    const updated = this.assistantRecords.completeRecord(record.id);
    return messageResponse([
      this.t('coordinator.assistant.done', { title: updated.title }),
    ], this.buildScopedSessionMeta(event));
  }

  async handleAssistantDeleteCommand(event, args, typeFilter: AssistantRecordType | null) {
    const scopeRef = toScopeRef(event);
    const token = String(args[0] ?? '').trim();
    const record = this.assistantRecords.resolveForScope(scopeRef, token, typeFilter);
    if (!record) {
      return messageResponse([this.t('coordinator.assistant.notFound')], this.buildScopedSessionMeta(event));
    }
    const updated = this.assistantRecords.archiveRecord(record.id);
    return messageResponse([
      this.t('coordinator.assistant.deleted', { title: updated.title }),
    ], this.buildScopedSessionMeta(event));
  }

  async handleAssistantCancelRecordCommand(event, args, typeFilter: AssistantRecordType | null) {
    const scopeRef = toScopeRef(event);
    const token = String(args[0] ?? '').trim();
    const record = this.assistantRecords.resolveForScope(scopeRef, token, typeFilter);
    if (!record) {
      return messageResponse([this.t('coordinator.assistant.notFound')], this.buildScopedSessionMeta(event));
    }
    const updated = this.assistantRecords.cancelRecord(record.id);
    return messageResponse([
      this.t('coordinator.assistant.cancelled', { title: updated.title }),
    ], this.buildScopedSessionMeta(event));
  }

  async handleAssistantConfirmCommand(event, typeFilter: AssistantRecordType | null) {
    const scopeRef = toScopeRef(event);
    if (!typeFilter) {
      const updateDraft = this.getPendingAssistantUpdateDraft(scopeRef);
      if (updateDraft) {
        const updated = this.applyAssistantRecordUpdateDraft(updateDraft);
        this.clearPendingAssistantUpdateDraft(scopeRef);
        if (!updated) {
          return messageResponse([this.t('coordinator.assistant.notFound')], this.buildScopedSessionMeta(event));
        }
        return messageResponse(this.renderAssistantUpdateAppliedLines(updateDraft, updated), this.buildScopedSessionMeta(event));
      }
    }
    const record = this.assistantRecords.getLatestPendingForScope(scopeRef, typeFilter);
    if (!record) {
      return messageResponse([this.t('coordinator.assistant.noPending')], this.buildScopedSessionMeta(event));
    }
    if (record.type === 'reminder' && !record.remindAt && !record.recurrence) {
      return messageResponse([
        this.t('coordinator.assistant.reminderNeedsTime'),
        this.t('coordinator.assistant.editHint', { command: assistantCommandNameForType(typeFilter) }),
      ], this.buildScopedSessionMeta(event));
    }
    const updated = this.assistantRecords.confirmRecord(record.id);
    return messageResponse(this.renderAssistantSavedLines(updated, assistantCommandNameForType(typeFilter)), this.buildScopedSessionMeta(event));
  }

  async handleAssistantCancelPendingCommand(event, typeFilter: AssistantRecordType | null) {
    const scopeRef = toScopeRef(event);
    if (!typeFilter) {
      const updateDraft = this.getPendingAssistantUpdateDraft(scopeRef);
      if (updateDraft) {
        this.clearPendingAssistantUpdateDraft(scopeRef);
        return messageResponse([
          this.t('coordinator.assistant.updateDraftCancelled'),
        ], this.buildScopedSessionMeta(event));
      }
    }
    const record = this.assistantRecords.getLatestPendingForScope(scopeRef, typeFilter);
    if (!record) {
      return messageResponse([this.t('coordinator.assistant.noPending')], this.buildScopedSessionMeta(event));
    }
    const updated = this.assistantRecords.cancelRecord(record.id);
    return messageResponse([
      this.t('coordinator.assistant.cancelled', { title: updated.title }),
    ], this.buildScopedSessionMeta(event));
  }

  async handleAssistantEditPendingCommand(event, args, forcedType: AssistantRecordType | null) {
    const input = args.join(' ').trim();
    if (!input) {
      return messageResponse([
        this.t('coordinator.assistant.editNeedsText'),
      ], this.buildScopedSessionMeta(event));
    }
    const scopeRef = toScopeRef(event);
    if (!forcedType) {
      const updateDraft = this.getPendingAssistantUpdateDraft(scopeRef);
      if (updateDraft) {
        if (shouldCreateAssistantRecordInsteadOfUpdating(input)) {
          this.clearPendingAssistantUpdateDraft(scopeRef);
          return this.handleAssistantCommand(event, [input], null);
        }
        const instructions = [...updateDraft.instructions, input];
        const baseRecord = this.assistantRecords.getById(updateDraft.targetRecordId) ?? updateDraft.matchedRecord;
        const updatedRecord = await this.previewAssistantRecordAction(event, scopeRef, baseRecord, instructions, updateDraft.action);
        const updatedDraft: PendingAssistantRecordUpdateDraft = {
          ...updateDraft,
          rawInput: instructions.join('\n'),
          instructions,
          matchedRecord: cloneAssistantRecord(baseRecord),
          updatedRecord: updatedRecord.record,
          normalizedBy: updatedRecord.normalizedBy,
          changeSummary: updatedRecord.changeSummary,
        };
        this.setPendingAssistantUpdateDraft(scopeRef, updatedDraft);
        return messageResponse(this.renderAssistantUpdateDraftLines(updatedDraft), this.buildScopedSessionMeta(event));
      }
    }
    const record = this.assistantRecords.getLatestPendingForScope(scopeRef, forcedType ?? null);
    if (!record) {
      return messageResponse([this.t('coordinator.assistant.noPending')], this.buildScopedSessionMeta(event));
    }
    const updated = this.assistantRecords.updatePendingFromInstruction(record, input, forcedType);
    return messageResponse(this.renderAssistantPendingLines(updated, assistantCommandNameForType(forcedType)), this.buildScopedSessionMeta(event));
  }

  async buildAssistantRecordUpdateDraft(event, scopeRef: PlatformScopeRef, rawInput: string): Promise<PendingAssistantRecordUpdateDraft | null> {
    const records = this.assistantRecords.listForScope(scopeRef, null);
    if (records.length === 0) {
      return null;
    }
    const route = await this.resolveAssistantRecordRoute(event, scopeRef, rawInput, records).catch(() => null);
    if (route) {
      if (route.action === 'create' || route.action === 'none') {
        return null;
      }
      const routedRecord = records.find((record) => record.id === route.targetRecordId);
      if (!routedRecord) {
        return null;
      }
      const resolvedAction = route.action === 'complete' && shouldTreatAssistantCompletionAsPartialUpdate(routedRecord, rawInput)
        ? 'update'
        : route.action;
      const instructions = [rawInput];
      const updatedRecord = await this.previewAssistantRecordAction(event, scopeRef, routedRecord, instructions, resolvedAction);
      return {
        createdAt: this.now(),
        rawInput,
        instructions,
        targetRecordId: routedRecord.id,
        matchedRecord: cloneAssistantRecord(routedRecord),
        action: resolvedAction,
        updatedRecord: updatedRecord.record,
        matchedScore: Math.round(route.confidence * 100),
        normalizedBy: updatedRecord.normalizedBy,
        changeSummary: updatedRecord.changeSummary ?? route.reason,
      };
    }
    if (shouldCreateAssistantRecordInsteadOfUpdating(rawInput)) {
      return null;
    }
    const action = inferAssistantRecordNaturalAction(rawInput);
    if (!action) {
      return null;
    }
    const match = findBestAssistantRecordMatch(records, rawInput);
    if (!match) {
      return null;
    }
    const resolvedAction = action === 'complete' && shouldTreatAssistantCompletionAsPartialUpdate(match.record, rawInput)
      ? 'update'
      : action;
    const instructions = [rawInput];
    const updatedRecord = await this.previewAssistantRecordAction(event, scopeRef, match.record, instructions, resolvedAction);
    return {
      createdAt: this.now(),
      rawInput,
      instructions,
      targetRecordId: match.record.id,
      matchedRecord: cloneAssistantRecord(match.record),
      action: resolvedAction,
      updatedRecord: updatedRecord.record,
      matchedScore: match.score,
      normalizedBy: updatedRecord.normalizedBy,
      changeSummary: updatedRecord.changeSummary,
    };
  }

  async resolveAssistantRecordRoute(
    event,
    scopeRef: PlatformScopeRef,
    rawInput: string,
    records: AssistantRecord[],
  ): Promise<AssistantRecordRouteDecision | null> {
    const candidates = records
      .filter((record) => record.status !== 'archived')
      .slice(0, 12);
    if (candidates.length === 0) {
      return null;
    }
    const codexRoute = await this.resolveAssistantRecordRouteWithCodex(event, scopeRef, rawInput, candidates).catch(() => null);
    if (codexRoute) {
      return codexRoute;
    }
    const agentsRoute = await resolveAssistantRecordRouteWithOpenAIAgents(
      rawInput,
      candidates,
      this.currentI18n.locale,
      this.now(),
    ).catch(() => null);
    return agentsRoute;
  }

  async resolveAssistantRecordRouteWithCodex(
    event,
    scopeRef: PlatformScopeRef,
    rawInput: string,
    records: AssistantRecord[],
  ): Promise<AssistantRecordRouteDecision | null> {
    const boundSession = this.bridgeSessions.resolveScopeSession(scopeRef);
    const providerProfile = boundSession
      ? this.requireProviderProfile(boundSession.providerProfileId)
      : this.resolveScopeProviderProfile(scopeRef);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (!providerPlugin || typeof providerPlugin.startThread !== 'function' || typeof providerPlugin.startTurn !== 'function') {
      return null;
    }
    const inheritedSettings = boundSession
      ? this.bridgeSessions.getSessionSettings(boundSession.id)
      : null;
    const locale = inheritedSettings?.locale ?? this.resolveScopeLocale(scopeRef, event);
    const cwd = normalizeCwd(boundSession?.cwd) ?? this.resolveEventCwd(event) ?? null;
    const thread = await providerPlugin.startThread({
      providerProfile,
      cwd,
      title: 'Assistant Record Router',
      metadata: {
        sourcePlatform: event.platform,
        source: 'assistant-record-router',
      },
    });
    const routerSession = {
      id: crypto.randomUUID(),
      providerProfileId: providerProfile.id,
      codexThreadId: thread.threadId,
      cwd: thread.cwd ?? cwd,
      title: thread.title ?? 'Assistant Record Router',
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    const prompt = buildAssistantRecordRoutePrompt(rawInput, records, locale, this.now());
    const result = await providerPlugin.startTurn({
      providerProfile,
      bridgeSession: routerSession,
      sessionSettings: {
        bridgeSessionId: routerSession.id,
        model: inheritedSettings?.model ?? null,
        reasoningEffort: inheritedSettings?.reasoningEffort ?? null,
        serviceTier: inheritedSettings?.serviceTier ?? null,
        collaborationMode: null,
        personality: null,
        accessPreset: 'read-only',
        approvalPolicy: 'never',
        sandboxMode: 'read-only',
        locale,
        metadata: {},
        updatedAt: this.now(),
      },
      event: {
        ...event,
        text: prompt,
        cwd: routerSession.cwd ?? null,
        locale,
        attachments: [],
      },
      inputText: prompt,
    });
    return parseAssistantRecordRouteDecision(result.outputText, records);
  }

  async previewAssistantRecordAction(
    event,
    scopeRef: PlatformScopeRef,
    record: AssistantRecord,
    instructions: string[],
    action: AssistantRecordUpdateAction,
  ): Promise<{ record: AssistantRecord; normalizedBy: 'codex' | 'agents-sdk' | 'local'; changeSummary: string | null }> {
    const rawInput = instructions.join('\n');
    if (action === 'update') {
      const codexRecord = await this.previewAssistantRecordUpdateWithCodex(event, scopeRef, record, instructions).catch(() => null);
      if (codexRecord) {
        return codexRecord;
      }
      const agentsRecord = await normalizeAssistantRecordUpdateWithOpenAIAgents(
        record,
        instructions,
        this.currentI18n.locale,
        this.now(),
        record.timezone,
      ).catch(() => null);
      if (agentsRecord) {
        return agentsRecord;
      }
      return {
        record: this.assistantRecords.previewUpdate(record, rawInput, null),
        normalizedBy: 'local',
        changeSummary: null,
      };
    }
    const now = this.now();
    const parsedJson = {
      ...(record.parsedJson ?? {}),
      lastNaturalAction: {
        action,
        instruction: rawInput,
        appliedAt: now,
        parser: 'local-rule-natural-action',
      },
    };
    const next: AssistantRecord = {
      ...record,
      originalText: appendAssistantActionOriginalText(record.originalText, rawInput),
      parsedJson,
      parseStatus: 'edited',
      attachments: record.attachments.map((attachment) => ({ ...attachment })),
      updatedAt: now,
    };
    if (action === 'complete') {
      return {
        record: {
          ...next,
          status: 'done',
          completedAt: now,
        },
        normalizedBy: 'local',
        changeSummary: null,
      };
    }
    if (action === 'cancel') {
      return {
        record: {
          ...next,
          status: 'cancelled',
          cancelledAt: now,
        },
        normalizedBy: 'local',
        changeSummary: null,
      };
    }
    return {
      record: {
        ...next,
        status: 'archived',
        archivedAt: now,
      },
      normalizedBy: 'local',
      changeSummary: null,
    };
  }

  async previewAssistantRecordUpdateWithCodex(
    event,
    scopeRef: PlatformScopeRef,
    record: AssistantRecord,
    instructions: string[],
  ): Promise<{ record: AssistantRecord; normalizedBy: 'codex'; changeSummary: string | null } | null> {
    const boundSession = this.bridgeSessions.resolveScopeSession(scopeRef);
    const providerProfile = boundSession
      ? this.requireProviderProfile(boundSession.providerProfileId)
      : this.resolveScopeProviderProfile(scopeRef);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (!providerPlugin || typeof providerPlugin.startThread !== 'function' || typeof providerPlugin.startTurn !== 'function') {
      return null;
    }
    const inheritedSettings = boundSession
      ? this.bridgeSessions.getSessionSettings(boundSession.id)
      : null;
    const locale = inheritedSettings?.locale ?? this.resolveScopeLocale(scopeRef, event);
    const cwd = normalizeCwd(boundSession?.cwd) ?? this.resolveEventCwd(event) ?? null;
    const thread = await providerPlugin.startThread({
      providerProfile,
      cwd,
      title: 'Assistant Record Rewriter',
      metadata: {
        sourcePlatform: event.platform,
        source: 'assistant-record-rewriter',
      },
    });
    const parserSession = {
      id: crypto.randomUUID(),
      providerProfileId: providerProfile.id,
      codexThreadId: thread.threadId,
      cwd: thread.cwd ?? cwd,
      title: thread.title ?? 'Assistant Record Rewriter',
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    const prompt = buildAssistantRecordRewritePrompt(record, instructions, locale, this.now(), extractEventTimezone(event) ?? record.timezone);
    const result = await providerPlugin.startTurn({
      providerProfile,
      bridgeSession: parserSession,
      sessionSettings: {
        bridgeSessionId: parserSession.id,
        model: inheritedSettings?.model ?? null,
        reasoningEffort: inheritedSettings?.reasoningEffort ?? null,
        serviceTier: inheritedSettings?.serviceTier ?? null,
        collaborationMode: null,
        personality: null,
        accessPreset: 'read-only',
        approvalPolicy: 'never',
        sandboxMode: 'read-only',
        locale,
        metadata: {},
        updatedAt: this.now(),
      },
      event: {
        ...event,
        text: prompt,
        cwd: parserSession.cwd ?? null,
        locale,
        attachments: [],
      },
      inputText: prompt,
    });
    const candidate = parseAssistantRecordRewriteCandidate(result.outputText, record);
    if (!candidate) {
      return null;
    }
    const rewritten = applyAssistantRecordRewriteCandidate(record, candidate, instructions, 'codex', this.now());
    if (!rewritten) {
      return null;
    }
    return {
      record: rewritten,
      normalizedBy: 'codex',
      changeSummary: candidate.changeSummary || null,
    };
  }

  applyAssistantRecordUpdateDraft(draft: PendingAssistantRecordUpdateDraft): AssistantRecord | null {
    const existing = this.assistantRecords.getById(draft.targetRecordId);
    if (!existing) {
      return null;
    }
    const record = draft.updatedRecord;
    return this.assistantRecords.updateRecord(existing.id, {
      type: record.type,
      status: record.status,
      title: record.title,
      content: record.content,
      originalText: record.originalText,
      priority: record.priority,
      project: record.project,
      tags: record.tags,
      dueAt: record.dueAt,
      remindAt: record.remindAt,
      recurrence: record.recurrence,
      attachments: record.attachments,
      parseStatus: record.parseStatus,
      confidence: record.confidence,
      parsedJson: record.parsedJson,
      lastRemindedAt: record.lastRemindedAt,
      completedAt: record.completedAt,
      cancelledAt: record.cancelledAt,
      archivedAt: record.archivedAt,
    });
  }

  renderAssistantList(event, typeFilter: AssistantRecordType | null, query = '') {
    const scopeRef = toScopeRef(event);
    const records = query
      ? this.assistantRecords.searchForScope(scopeRef, query, typeFilter)
      : this.assistantRecords.listForScope(scopeRef, typeFilter);
    const title = query
      ? this.t('coordinator.assistant.searchTitle', { query })
      : this.t('coordinator.assistant.listTitle', { type: this.t(`coordinator.assistant.type.${typeFilter ?? 'all'}`) });
    if (records.length === 0) {
      return messageResponse([
        title,
        this.t('coordinator.assistant.empty'),
        this.t('coordinator.assistant.addHint'),
      ], this.buildScopedSessionMeta(event));
    }
    const lines = [
      title,
      ...records.slice(0, 10).flatMap((record, index) => this.renderAssistantListItem(record, index + 1)),
      this.t('coordinator.assistant.listActions'),
    ];
    return messageResponse(lines, this.buildScopedSessionMeta(event));
  }

  renderAssistantListItem(record: AssistantRecord, index: number): string[] {
    const head = `${index}. [${this.t(`coordinator.assistant.type.${record.type}`)}] ${record.title}`;
    const lines = [
      head,
      this.t('coordinator.assistant.listMeta', {
        status: this.t(`coordinator.assistant.status.${record.status}`),
        priority: this.t(`coordinator.assistant.priority.${record.priority}`),
      }),
    ];
    const timeLine = renderAssistantRecordTimeLine(record, this.currentI18n);
    if (timeLine) {
      lines.push(timeLine);
    }
    if (record.attachments.length > 0) {
      lines.push(this.t('coordinator.assistant.attachmentCount', { count: record.attachments.length }));
    }
    if (record.tags.length > 0) {
      lines.push(this.t('coordinator.assistant.tagsLine', { value: record.tags.join(', ') }));
    }
    return lines;
  }

  renderAssistantPendingLines(record: AssistantRecord, commandName: string): string[] {
    const lines = [
      this.t('coordinator.assistant.pendingTitle'),
      this.t('coordinator.assistant.detectedType', { type: this.t(`coordinator.assistant.type.${record.type}`) }),
      this.t('coordinator.assistant.recordTitle', { title: record.title }),
    ];
    this.pushAssistantContentLines(lines, record);
    const timeLine = renderAssistantRecordTimeLine(record, this.currentI18n);
    if (timeLine) {
      lines.push(timeLine);
    }
    if (record.attachments.length > 0) {
      lines.push(this.t('coordinator.assistant.attachmentCount', { count: record.attachments.length }));
    }
    lines.push(this.t('coordinator.assistant.confirmHint', { command: commandName }));
    lines.push(this.t('coordinator.assistant.editHint', { command: commandName }));
    lines.push(this.t('coordinator.assistant.cancelHint', { command: commandName }));
    return lines;
  }

  renderAssistantSavedLines(record: AssistantRecord, commandName: string): string[] {
    const lines = [
      this.t('coordinator.assistant.saved'),
      this.t('coordinator.assistant.detectedType', { type: this.t(`coordinator.assistant.type.${record.type}`) }),
      this.t('coordinator.assistant.recordTitle', { title: record.title }),
    ];
    this.pushAssistantContentLines(lines, record);
    const timeLine = renderAssistantRecordTimeLine(record, this.currentI18n);
    if (timeLine) {
      lines.push(timeLine);
    }
    if (record.attachments.length > 0) {
      lines.push(this.t('coordinator.assistant.attachmentCount', { count: record.attachments.length }));
    }
    lines.push(this.t('coordinator.assistant.showHint', { command: commandName }));
    return lines;
  }

  renderAssistantUpdateDraftLines(draft: PendingAssistantRecordUpdateDraft): string[] {
    const record = draft.updatedRecord;
    const lines = [
      this.t('coordinator.assistant.updateDraftTitle'),
      this.t('coordinator.assistant.updateDraftTarget', { title: draft.matchedRecord.title }),
      this.t('coordinator.assistant.updateDraftAction', {
        action: this.t(`coordinator.assistant.updateAction.${draft.action}`),
      }),
      this.t('coordinator.assistant.detectedType', { type: this.t(`coordinator.assistant.type.${record.type}`) }),
      this.t('coordinator.assistant.statusLine', { value: this.t(`coordinator.assistant.status.${record.status}`) }),
    ];
    if (draft.action === 'update') {
      if (draft.changeSummary) {
        lines.push(this.t('coordinator.assistant.changeSummary', { value: draft.changeSummary }));
      }
      this.pushAssistantContentLines(lines, record);
      const timeLine = renderAssistantRecordTimeLine(record, this.currentI18n);
      if (timeLine) {
        lines.push(timeLine);
      }
    }
    lines.push(this.t('coordinator.assistant.confirmHint', { command: '/as' }));
    lines.push(this.t('coordinator.assistant.editHint', { command: '/as' }));
    lines.push(this.t('coordinator.assistant.cancelHint', { command: '/as' }));
    return lines;
  }

  renderAssistantUpdateAppliedLines(draft: PendingAssistantRecordUpdateDraft, record: AssistantRecord): string[] {
    const lines = [
      this.t('coordinator.assistant.updateApplied'),
      this.t('coordinator.assistant.updateDraftTarget', { title: draft.matchedRecord.title }),
      this.t('coordinator.assistant.updateDraftAction', {
        action: this.t(`coordinator.assistant.updateAction.${draft.action}`),
      }),
      this.t('coordinator.assistant.statusLine', { value: this.t(`coordinator.assistant.status.${record.status}`) }),
    ];
    if (draft.action === 'update') {
      if (draft.changeSummary) {
        lines.push(this.t('coordinator.assistant.changeSummary', { value: draft.changeSummary }));
      }
      this.pushAssistantContentLines(lines, record);
      const timeLine = renderAssistantRecordTimeLine(record, this.currentI18n);
      if (timeLine) {
        lines.push(timeLine);
      }
    }
    lines.push(this.t('coordinator.assistant.showHint', { command: '/as' }));
    return lines;
  }

  renderAssistantDetailLines(record: AssistantRecord): string[] {
    const lines = [
      this.t('coordinator.assistant.detailTitle', { title: record.title }),
      this.t('coordinator.assistant.detectedType', { type: this.t(`coordinator.assistant.type.${record.type}`) }),
      this.t('coordinator.assistant.statusLine', { value: this.t(`coordinator.assistant.status.${record.status}`) }),
      this.t('coordinator.assistant.priorityLine', { value: this.t(`coordinator.assistant.priority.${record.priority}`) }),
    ];
    if (record.content) {
      this.pushAssistantContentLines(lines, record);
    }
    const timeLine = renderAssistantRecordTimeLine(record, this.currentI18n);
    if (timeLine) {
      lines.push(timeLine);
    }
    if (record.tags.length > 0) {
      lines.push(this.t('coordinator.assistant.tagsLine', { value: record.tags.join(', ') }));
    }
    if (record.attachments.length > 0) {
      lines.push(this.t('coordinator.assistant.attachmentsTitle', { count: record.attachments.length }));
      for (const attachment of record.attachments) {
        lines.push(`${attachment.filename}`);
        lines.push(attachment.storagePath);
      }
    }
    lines.push(this.t('coordinator.assistant.detailActions'));
    return lines;
  }

  pushAssistantContentLines(lines: string[], record: AssistantRecord): void {
    const content = String(record?.content ?? '').trim();
    if (!content) {
      return;
    }
    lines.push(this.t('coordinator.assistant.contentLabel'));
    lines.push(content);
  }

  resolveActiveUploadContext(scopeRef: PlatformScopeRef): { session: any | null; state: UploadBatchState | null } {
    const session = this.bridgeSessions.resolveScopeSession(scopeRef);
    if (!session) {
      return { session: null, state: null };
    }
    const state = this.getUploadsStateForSession(session.id);
    if (!state?.active) {
      return { session, state: null };
    }
    return { session, state };
  }

  async handleUploadsStatusCommand(event) {
    const session = this.bridgeSessions.resolveScopeSession(toScopeRef(event));
    if (!session) {
      return messageResponse([this.t('coordinator.uploads.noneActive')], this.buildScopedSessionMeta(event));
    }
    const state = this.getUploadsStateForSession(session.id);
    if (!state?.active) {
      return messageResponse([this.t('coordinator.uploads.noneActive')], buildSessionMeta(session));
    }
    return messageResponse(this.renderUploadsStateLines(session, state), buildSessionMeta(session));
  }

  async handleUploadsCancelCommand(event) {
    const session = this.bridgeSessions.resolveScopeSession(toScopeRef(event));
    if (!session) {
      return messageResponse([this.t('coordinator.uploads.noneActive')], this.buildScopedSessionMeta(event));
    }
    const state = this.getUploadsStateForSession(session.id);
    if (!state?.active) {
      return messageResponse([this.t('coordinator.uploads.noneActive')], buildSessionMeta(session));
    }
    await this.removeUploadBatchFiles(session, state);
    this.setUploadsStateForSession(session.id, null);
    return messageResponse([
      this.t('coordinator.uploads.cancelled'),
      this.t('coordinator.uploads.cleared', { count: state.items.length }),
    ], buildSessionMeta(session));
  }

  async handleUploadsConversationTurn(event, scopeRef, session, uploadState, options: StartTurnOptions = {}) {
    const activeTurn = await this.reconcileActiveTurn(scopeRef);
    if (activeTurn) {
      return this.buildActiveTurnBlockedResponse(event, activeTurn);
    }
    const currentAttachments = normalizeInboundAttachments(event.attachments);
    const newItems = await this.stageUploadAttachments(session, uploadState, currentAttachments);
    const nextState: UploadBatchState = {
      ...uploadState,
      items: [...uploadState.items, ...newItems],
      updatedAt: this.now(),
    };
    const submissionText = resolveUploadSubmissionText(event, currentAttachments);
    if (!submissionText) {
      this.setUploadsStateForSession(session.id, nextState);
      if (currentAttachments.length === 0) {
        return messageResponse([
          this.t('coordinator.uploads.waiting'),
          this.t('coordinator.uploads.statusHint'),
          this.t('coordinator.uploads.cancelHint'),
        ], buildSessionMeta(session));
      }
      const lines = [
        this.t('coordinator.uploads.added', { count: newItems.length }),
      ];
      if (containsVoiceWithoutTranscript(currentAttachments)) {
        lines.push(this.t('coordinator.uploads.voiceNeedsText'));
      } else {
        lines.push(this.t('coordinator.uploads.waitingForPrompt'));
      }
      lines.push(this.t('coordinator.uploads.statusHint'));
      lines.push(this.t('coordinator.uploads.cancelHint'));
      return messageResponse(lines, buildSessionMeta(session));
    }

    this.activeTurns?.beginScopeTurn(scopeRef);
    let nextSession = session;
    try {
      this.setUploadsStateForSession(session.id, nextState);
      this.activeTurns?.updateScopeTurn(scopeRef, {
        bridgeSessionId: session.id,
        providerProfileId: session.providerProfileId,
        threadId: session.codexThreadId,
      });
      const mergedEvent = buildUploadTurnEvent(event, submissionText, nextState);
      this.storeRetryableRequest(session.id, mergedEvent);
      const started = await this.startTurnWithRecovery(scopeRef, session, mergedEvent, options);
      nextSession = started.session;
      this.setUploadsStateForSession(nextSession.id, null);
      const response = messageResponse([started.result.outputText], buildSessionMeta(nextSession));
      response.meta = {
        ...(response.meta ?? {}),
        codexTurn: {
          outputState: started.result.outputState ?? 'complete',
          previewText: started.result.previewText ?? '',
          finalSource: started.result.finalSource ?? 'thread_items',
          errorMessage: started.result.errorMessage ?? '',
        },
      };
      return response;
    } catch (error) {
      const failure = classifyTurnFailure(error, this.currentI18n);
      if (!failure) {
        throw error;
      }
      const response = messageResponse([''], buildSessionMeta(nextSession));
      response.meta = {
        ...(response.meta ?? {}),
        codexTurn: {
          outputState: failure.outputState,
          previewText: '',
          finalSource: 'none',
          errorMessage: failure.errorMessage ?? '',
        },
      };
      return response;
    } finally {
      this.activeTurns?.endScopeTurn(scopeRef);
    }
  }

  getUploadsStateForSession(bridgeSessionId: string): UploadBatchState | null {
    const settings = this.bridgeSessions.getSessionSettings(bridgeSessionId);
    return normalizeUploadBatchState(settings?.metadata?.uploads ?? null);
  }

  resolveRetryableRequest(bridgeSessionId: string): RetryableRequestSnapshot | null {
    const settings = this.bridgeSessions.getSessionSettings(bridgeSessionId);
    return normalizeRetryableRequestSnapshot(settings?.metadata?.lastRetryableRequest ?? null);
  }

  resolveStopCheckpoint(bridgeSessionId: string): StopCheckpointSnapshot | null {
    const settings = this.bridgeSessions.getSessionSettings(bridgeSessionId);
    return normalizeStopCheckpointSnapshot(settings?.metadata?.lastStopCheckpoint ?? null);
  }

  storeRetryableRequest(bridgeSessionId: string, event: InboundTextEvent) {
    this.bridgeSessions.upsertSessionSettings(bridgeSessionId, {
      metadata: {
        lastRetryableRequest: {
          text: String(event?.text ?? ''),
          attachments: cloneInboundAttachments(normalizeInboundAttachments(event?.attachments)),
          cwd: normalizeCwd(event?.cwd),
          storedAt: this.now(),
        },
      },
    });
  }

  storeStopCheckpoint(bridgeSessionId: string, checkpoint: StopCheckpointSnapshot) {
    this.bridgeSessions.upsertSessionSettings(bridgeSessionId, {
      metadata: {
        lastStopCheckpoint: checkpoint,
      },
    });
  }

  clearStopCheckpoint(bridgeSessionId: string) {
    this.bridgeSessions.upsertSessionSettings(bridgeSessionId, {
      metadata: {
        lastStopCheckpoint: null,
      },
    });
  }

  setUploadsStateForSession(bridgeSessionId: string, state: UploadBatchState | null) {
    this.bridgeSessions.upsertSessionSettings(bridgeSessionId, {
      metadata: {
        uploads: state,
      },
    });
  }

  renderUploadsStateLines(session, state: UploadBatchState) {
    const lines = [
      this.t('coordinator.uploads.statusTitle', { count: state.items.length }),
      this.t('coordinator.uploads.batch', { id: state.batchId }),
      this.t('coordinator.uploads.directory', {
        value: this.resolveUploadBatchDirectory(session, state) ?? this.t('common.notSet'),
      }),
      this.t('coordinator.uploads.fileCount', { count: state.items.length }),
    ];
    if (state.items.length === 0) {
      lines.push(this.t('coordinator.uploads.empty'));
      return lines;
    }
    for (const [index, item] of state.items.entries()) {
      lines.push(this.t('coordinator.uploads.item', {
        index: index + 1,
        kind: this.t(`coordinator.uploads.kind.${item.kind}`),
        name: item.fileName ?? path.basename(item.localPath),
      }));
      lines.push(this.t('coordinator.uploads.path', { value: item.localPath }));
      if (item.mimeType) {
        lines.push(this.t('coordinator.uploads.mime', { value: item.mimeType }));
      }
      if (typeof item.sizeBytes === 'number') {
        lines.push(this.t('coordinator.uploads.size', { value: item.sizeBytes }));
      }
      if (typeof item.durationSeconds === 'number') {
        lines.push(this.t('coordinator.uploads.duration', { value: item.durationSeconds }));
      }
      if (item.transcriptText) {
        lines.push(this.t('coordinator.uploads.transcript', {
          value: truncateInlineText(item.transcriptText, 120),
        }));
      }
    }
    return lines;
  }

  resolveUploadBatchDirectory(session, state: UploadBatchState) {
    const cwd = normalizeCwd(session?.cwd) ?? this.defaultCwd ?? null;
    if (!cwd) {
      return null;
    }
    return path.join(cwd, '.codexbridge', 'uploads', state.batchId);
  }

  async stageUploadAttachments(session, uploadState: UploadBatchState, attachments: InboundAttachment[]) {
    if (attachments.length === 0) {
      return [];
    }
    const staged: UploadBatchItem[] = [];
    const batchDir = this.resolveUploadBatchDirectory(session, uploadState);
    for (const attachment of attachments) {
      const stagedPath = await stageAttachmentFile(attachment, batchDir, uploadState.items.length + staged.length);
      const sizeBytes = await readFileSize(stagedPath ?? attachment.localPath);
      staged.push({
        id: crypto.randomUUID(),
        kind: attachment.kind,
        localPath: stagedPath ?? attachment.localPath,
        originalPath: attachment.localPath,
        fileName: normalizeNullableString(attachment.fileName) ?? path.basename(stagedPath ?? attachment.localPath),
        mimeType: normalizeNullableString(attachment.mimeType),
        transcriptText: normalizeNullableString(attachment.transcriptText),
        durationSeconds: typeof attachment.durationSeconds === 'number' ? attachment.durationSeconds : null,
        sizeBytes,
        receivedAt: this.now(),
      });
    }
    return staged;
  }

  async removeUploadBatchFiles(session, state: UploadBatchState) {
    const batchDir = this.resolveUploadBatchDirectory(session, state);
    if (!batchDir) {
      return;
    }
    await fs.promises.rm(batchDir, {
      recursive: true,
      force: true,
    });
  }

  async handleThreadsCommand(event, args = []) {
    const action = String(args[0] ?? '').trim().toLowerCase();
    if (action === 'all') {
      return this.renderThreadsHomePage(event, { includeArchived: true, onlyPinned: false });
    }
    if (action === 'pinned') {
      return this.renderThreadsHomePage(event, { includeArchived: false, onlyPinned: true });
    }
    if (action === 'del') {
      return this.handleThreadsArchiveCommand(event, args.slice(1));
    }
    if (action === 'restore') {
      return this.handleThreadsRestoreCommand(event, args.slice(1));
    }
    if (action === 'pin') {
      if (args.length === 1) {
        return this.renderThreadsHomePage(event, { includeArchived: false, onlyPinned: true });
      }
      return this.handleThreadsPinCommand(event, args.slice(1));
    }
    if (action === 'unpin') {
      return this.handleThreadsUnpinCommand(event, args.slice(1));
    }
    if (action) {
      return messageResponse([
        this.t('coordinator.threads.usage'),
        this.t('coordinator.threads.help'),
      ], this.buildScopedSessionMeta(event));
    }
    return this.renderThreadsHomePage(event, { includeArchived: false, onlyPinned: false });
  }

  async renderThreadsHomePage(event, { includeArchived = false, onlyPinned = false } = {}) {
    const scopeRef = toScopeRef(event);
    const current = this.bridgeSessions.resolveScopeSession(scopeRef);
    const providerProfileId = current?.providerProfileId ?? this.resolveDefaultProviderProfileId();
    return this.renderThreadsPage(event, {
      providerProfileId,
      cursor: null,
      previousCursors: [],
      searchTerm: null,
      pageNumber: 1,
      includeArchived,
      onlyPinned,
    });
  }

  async handleSearchCommand(event, args) {
    const searchTerm = args.join(' ').trim();
    if (!searchTerm) {
      return messageResponse([
        this.t('coordinator.search.usage'),
        this.t('coordinator.search.help'),
      ], this.buildScopedSessionMeta(event));
    }
    const scopeRef = toScopeRef(event);
    const current = this.bridgeSessions.resolveScopeSession(scopeRef);
    const providerProfileId = current?.providerProfileId ?? this.resolveDefaultProviderProfileId();
    return this.renderThreadsPage(event, {
      providerProfileId,
      cursor: null,
      previousCursors: [],
      searchTerm,
      pageNumber: 1,
      includeArchived: false,
      onlyPinned: false,
    });
  }

  async handleNextThreadsCommand(event) {
    const state = this.getThreadBrowserState(event);
    if (!state) {
      return messageResponse([this.t('coordinator.threads.needContext')]);
    }
    if (!state.nextCursor) {
      return messageResponse([this.t('coordinator.threads.lastPage')], this.buildScopedSessionMeta(event));
    }
    return this.renderThreadsPage(event, {
      providerProfileId: state.providerProfileId,
      cursor: state.nextCursor,
      previousCursors: [...state.previousCursors, state.cursor],
      searchTerm: state.searchTerm,
      pageNumber: state.pageNumber + 1,
      includeArchived: Boolean(state.includeArchived),
      onlyPinned: Boolean(state.onlyPinned),
    });
  }

  async handlePrevThreadsCommand(event) {
    const state = this.getThreadBrowserState(event);
    if (!state) {
      return messageResponse([this.t('coordinator.threads.needContext')]);
    }
    if (state.previousCursors.length === 0) {
      return messageResponse([this.t('coordinator.threads.firstPage')], this.buildScopedSessionMeta(event));
    }
    const previousCursors = state.previousCursors.slice(0, -1);
    const cursor = state.previousCursors.at(-1) ?? null;
    return this.renderThreadsPage(event, {
      providerProfileId: state.providerProfileId,
      cursor,
      previousCursors,
      searchTerm: state.searchTerm,
      pageNumber: Math.max(1, state.pageNumber - 1),
      includeArchived: Boolean(state.includeArchived),
      onlyPinned: Boolean(state.onlyPinned),
    });
  }

  async handleThreadsArchiveCommand(event, args) {
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'threads');
    if (activeResponse) {
      return activeResponse;
    }
    const targets = args.map((item) => String(item ?? '').trim()).filter(Boolean);
    if (!targets.length) {
      return messageResponse([
        this.t('coordinator.threads.delUsage'),
        this.t('coordinator.threads.help'),
      ], this.buildScopedSessionMeta(event));
    }
    const resolvedThreads = this.resolveRequestedThreads(event, targets);
    const dedupedThreadIds = new Set();
    const lines = [];
    let archivedCount = 0;

    for (const resolvedThread of resolvedThreads) {
      if (!resolvedThread.ok) {
        lines.push(resolvedThread.message);
        continue;
      }
      const dedupeKey = `${resolvedThread.providerProfileId}:${resolvedThread.threadId}`;
      if (dedupedThreadIds.has(dedupeKey)) {
        continue;
      }
      dedupedThreadIds.add(dedupeKey);
      if (typeof resolvedThread.archivedAt === 'number') {
        lines.push(this.t('coordinator.thread.archiveAlreadyArchived', { threadId: resolvedThread.threadId }));
        continue;
      }
      this.bridgeSessions.setProviderThreadArchived(resolvedThread.providerProfileId, resolvedThread.threadId, true);
      this.patchThreadBrowserArchiveStatus(event, resolvedThread.providerProfileId, resolvedThread.threadId, true);
      lines.push(this.t('coordinator.thread.archived', { threadId: resolvedThread.threadId }));
      archivedCount += 1;
    }

    if (archivedCount > 0) {
      lines.push(this.t('coordinator.thread.archiveActions'));
    }

    return messageResponse(lines, this.buildScopedSessionMeta(event));
  }

  async handleThreadsRestoreCommand(event, args) {
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'threads');
    if (activeResponse) {
      return activeResponse;
    }
    const targets = args.map((item) => String(item ?? '').trim()).filter(Boolean);
    if (!targets.length) {
      return messageResponse([
        this.t('coordinator.threads.restoreUsage'),
        this.t('coordinator.threads.help'),
      ], this.buildScopedSessionMeta(event));
    }
    const state = this.getThreadBrowserState(event);
    if (!state || !state.includeArchived) {
      return messageResponse([
        this.t('coordinator.thread.restoreNeedAll'),
      ], this.buildScopedSessionMeta(event));
    }
    const resolvedThreads = this.resolveRequestedThreads(event, targets);
    const dedupedThreadIds = new Set();
    const lines = [];
    let restoredCount = 0;

    for (const resolvedThread of resolvedThreads) {
      if (!resolvedThread.ok) {
        lines.push(resolvedThread.message);
        continue;
      }
      const dedupeKey = `${resolvedThread.providerProfileId}:${resolvedThread.threadId}`;
      if (dedupedThreadIds.has(dedupeKey)) {
        continue;
      }
      dedupedThreadIds.add(dedupeKey);
      if (typeof resolvedThread.archivedAt !== 'number') {
        lines.push(this.t('coordinator.thread.restoreNotArchived', { threadId: resolvedThread.threadId }));
        continue;
      }
      this.bridgeSessions.setProviderThreadArchived(resolvedThread.providerProfileId, resolvedThread.threadId, false);
      this.patchThreadBrowserArchiveStatus(event, resolvedThread.providerProfileId, resolvedThread.threadId, false);
      lines.push(this.t('coordinator.thread.restored', { threadId: resolvedThread.threadId }));
      restoredCount += 1;
    }

    if (restoredCount > 0) {
      lines.push(this.t('coordinator.thread.restoreActions'));
    }

    return messageResponse(lines, this.buildScopedSessionMeta(event));
  }

  async handleThreadsPinCommand(event, args) {
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'threads');
    if (activeResponse) {
      return activeResponse;
    }
    const targets = args.map((item) => String(item ?? '').trim()).filter(Boolean);
    if (!targets.length) {
      return messageResponse([
        this.t('coordinator.threads.pinUsage'),
        this.t('coordinator.threads.help'),
      ], this.buildScopedSessionMeta(event));
    }
    const resolvedThreads = this.resolveRequestedThreads(event, targets);
    const dedupedThreadIds = new Set();
    const lines = [];
    let pinnedCount = 0;

    for (const resolvedThread of resolvedThreads) {
      if (!resolvedThread.ok) {
        lines.push(resolvedThread.message);
        continue;
      }
      const dedupeKey = `${resolvedThread.providerProfileId}:${resolvedThread.threadId}`;
      if (dedupedThreadIds.has(dedupeKey)) {
        continue;
      }
      dedupedThreadIds.add(dedupeKey);
      if (typeof resolvedThread.pinnedAt === 'number') {
        lines.push(this.t('coordinator.thread.pinAlreadyPinned', { threadId: resolvedThread.threadId }));
        continue;
      }
      this.bridgeSessions.setProviderThreadPinned(resolvedThread.providerProfileId, resolvedThread.threadId, true);
      this.patchThreadBrowserPinStatus(event, resolvedThread.providerProfileId, resolvedThread.threadId, true);
      lines.push(this.t('coordinator.thread.pinned', { threadId: resolvedThread.threadId }));
      pinnedCount += 1;
    }

    if (pinnedCount > 0) {
      lines.push(this.t('coordinator.thread.pinActions'));
    }

    return messageResponse(lines, this.buildScopedSessionMeta(event));
  }

  async handleThreadsUnpinCommand(event, args) {
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'threads');
    if (activeResponse) {
      return activeResponse;
    }
    const targets = args.map((item) => String(item ?? '').trim()).filter(Boolean);
    if (!targets.length) {
      return messageResponse([
        this.t('coordinator.threads.unpinUsage'),
        this.t('coordinator.threads.help'),
      ], this.buildScopedSessionMeta(event));
    }
    const resolvedThreads = this.resolveRequestedThreads(event, targets);
    const dedupedThreadIds = new Set();
    const lines = [];
    let unpinnedCount = 0;

    for (const resolvedThread of resolvedThreads) {
      if (!resolvedThread.ok) {
        lines.push(resolvedThread.message);
        continue;
      }
      const dedupeKey = `${resolvedThread.providerProfileId}:${resolvedThread.threadId}`;
      if (dedupedThreadIds.has(dedupeKey)) {
        continue;
      }
      dedupedThreadIds.add(dedupeKey);
      if (typeof resolvedThread.pinnedAt !== 'number') {
        lines.push(this.t('coordinator.thread.unpinNotPinned', { threadId: resolvedThread.threadId }));
        continue;
      }
      this.bridgeSessions.setProviderThreadPinned(resolvedThread.providerProfileId, resolvedThread.threadId, false);
      this.patchThreadBrowserPinStatus(event, resolvedThread.providerProfileId, resolvedThread.threadId, false);
      lines.push(this.t('coordinator.thread.unpinned', { threadId: resolvedThread.threadId }));
      unpinnedCount += 1;
    }

    if (unpinnedCount > 0) {
      lines.push(this.t('coordinator.thread.unpinActions'));
    }

    return messageResponse(lines, this.buildScopedSessionMeta(event));
  }

  async handleOpenCommand(event, args) {
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'open');
    if (activeResponse) {
      return activeResponse;
    }
    const requested = args[0]?.trim() ?? '';
    if (!requested) {
      return messageResponse([
        this.t('coordinator.open.usage'),
        this.t('coordinator.open.help'),
      ], this.buildScopedSessionMeta(event));
    }
    const scopeRef = toScopeRef(event);
    const currentSession = this.bridgeSessions.resolveScopeSession(scopeRef);
    const currentSettings = currentSession ? this.bridgeSessions.getSessionSettings(currentSession.id) : null;
    const resolvedThread = this.resolveRequestedThread(event, requested);
    if (!resolvedThread.ok) {
      return messageResponse([resolvedThread.message], this.buildScopedSessionMeta(event));
    }
    const providerProfile = this.requireProviderProfile(resolvedThread.providerProfileId);
    const session = await this.bridgeSessions.bindScopeToProviderThread(
      scopeRef,
      {
        providerProfileId: providerProfile.id,
        codexThreadId: resolvedThread.threadId,
      },
      {
        initialSettings: this.buildReboundSessionSettings(currentSettings, {
          locale: this.resolveScopeLocale(scopeRef, event),
        }),
      },
    );
    return messageResponse([
      this.t('coordinator.open.opened', { threadId: session.codexThreadId }),
      this.t('coordinator.status.providerProfile', { id: providerProfile.id }),
      this.t('coordinator.status.bridgeSession', { id: session.id }),
    ], buildSessionMeta(session));
  }

  async handleModelsCommand(event) {
    const scopeRef = toScopeRef(event);
    const providerProfile = this.resolveScopeProviderProfile(scopeRef);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (typeof providerPlugin.listModels !== 'function') {
      return messageResponse([
        this.t('coordinator.model.unsupported'),
      ], this.resolveScopedSessionMeta(scopeRef));
    }
    const models = await providerPlugin.listModels({
      providerProfile,
    });
    const session = this.bridgeSessions.resolveScopeSession(scopeRef);
    const settings = session ? this.bridgeSessions.getSessionSettings(session.id) : null;
    const currentModel = settings?.model ?? this.t('coordinator.model.currentDefault');
    return messageResponse([
      this.t('coordinator.models.listTitle', { providerProfileId: providerProfile.id }),
      this.t('coordinator.model.current', { value: currentModel }),
      this.t('coordinator.models.helpHeader'),
      ...(models.length === 0 ? [this.t('coordinator.models.empty')] : this.renderModelLines(models)),
      this.t('coordinator.model.usageHint'),
    ], this.resolveScopedSessionMeta(scopeRef));
  }

  async handleModelCommand(event, args) {
    const scopeRef = toScopeRef(event);
    const providerProfile = this.resolveScopeProviderProfile(scopeRef);
    const normalizedArgs = args.map((arg) => String(arg ?? '').trim()).filter((arg) => arg.length > 0);
    if (!normalizedArgs.length) {
      const sessionForDisplay = this.bridgeSessions.resolveScopeSession(scopeRef);
      const settings = sessionForDisplay ? this.bridgeSessions.getSessionSettings(sessionForDisplay.id) : null;
      const currentModel = settings?.model ?? this.t('coordinator.model.currentDefault');
      const currentReasoningEffort = settings?.reasoningEffort ?? this.t('common.default');
      return messageResponse([
        this.t('coordinator.model.current', { value: currentModel }),
        this.t('coordinator.model.currentEffort', { value: currentReasoningEffort }),
        this.t('coordinator.model.noArgHint', { providerProfileId: providerProfile.id }),
      ], this.resolveScopedSessionMeta(scopeRef));
    }
    if (normalizedArgs.length > 2) {
      return messageResponse([
        this.t('coordinator.model.noArgHint', { providerProfileId: providerProfile.id }),
      ], this.resolveScopedSessionMeta(scopeRef));
    }
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'model');
    if (activeResponse) {
      return activeResponse;
    }
    const session = this.bridgeSessions.resolveScopeSession(scopeRef);
    if (!session) {
      return messageResponse([
        this.t('coordinator.model.noSession'),
      ], this.resolveScopedSessionMeta(scopeRef));
    }
    if (typeof providerPlugin.listModels !== 'function') {
      return messageResponse([
        this.t('coordinator.model.unsupported'),
      ], buildSessionMeta(session));
    }
    const models = await providerPlugin.listModels({
      providerProfile,
    });
    const requestedModel = normalizedArgs[0] ?? '';
    const requestedEffort = normalizedArgs[1] ?? '';
    const normalizedModel = requestedModel.toLowerCase();
    const normalizedEffort = requestedEffort.trim().toLowerCase();
    const sessionSettings = this.bridgeSessions.getSessionSettings(session.id);
    const currentModel = this.resolveSessionModelForEffort(models, sessionSettings?.model);

    if (['default', 'reset', 'clear', 'none', '默认', '重置'].includes(normalizedModel)) {
      const updates = {
        model: null,
        reasoningEffort: null,
      };
      const messages = [this.t('coordinator.model.reset')];
      if (normalizedEffort) {
        const resolvedEffort = this.resolveEffortForModel(currentModel, normalizedEffort);
        if (!resolvedEffort) {
          return messageResponse([
            this.t('coordinator.model.unsupportedEffort', {
              effort: requestedEffort,
              supported: this.formatSupportedEfforts(currentModel),
            }),
          ], buildSessionMeta(session));
        }
        updates.reasoningEffort = resolvedEffort;
        messages.push(this.t('coordinator.model.effortUpdated', { value: resolvedEffort }));
      }
      this.bridgeSessions.upsertSessionSettings(session.id, {
        ...updates,
      });
      return messageResponse([...messages, this.t('coordinator.permissions.nextTurn')], buildSessionMeta(session));
    }
    const matchedModel = this.findModelByToken(models, requestedModel);
    if (!matchedModel && normalizedArgs.length === 1) {
      const mergedInput = this.parseConcatenatedModelEffortToken(normalizedModel, models);
      if (mergedInput) {
        return messageResponse([
          this.t('coordinator.model.missingEffortSeparator', {
            model: mergedInput.model,
            effort: mergedInput.effort,
          }),
        ], buildSessionMeta(session));
      }
      const resolvedEffort = this.resolveEffortForModel(currentModel, normalizedModel);
      if (!resolvedEffort) {
        return messageResponse([
          this.t('coordinator.model.unknown', { name: requestedModel }),
          this.t('coordinator.model.notFoundHint'),
        ], buildSessionMeta(session));
      }
      this.bridgeSessions.upsertSessionSettings(session.id, {
        reasoningEffort: resolvedEffort,
      });
      return messageResponse([
        this.t('coordinator.model.effortUpdated', { value: resolvedEffort }),
        this.t('coordinator.permissions.nextTurn'),
      ], buildSessionMeta(session));
    }
    if (!matchedModel && normalizedArgs.length > 1) {
      return messageResponse([
        this.t('coordinator.model.unknown', { name: requestedModel }),
        this.t('coordinator.model.notFoundHint'),
      ], buildSessionMeta(session));
    }
    const resolvedEffort = requestedEffort
      ? this.resolveEffortForModel(
          matchedModel ?? currentModel,
          normalizedEffort,
        )
      : null;
    if (requestedEffort && !resolvedEffort) {
      const modelForEffort = matchedModel ?? currentModel;
      return messageResponse([
        this.t('coordinator.model.unsupportedEffort', {
          effort: requestedEffort,
          supported: this.formatSupportedEfforts(modelForEffort),
        }),
      ], buildSessionMeta(session));
    }
    const updates = {} as {
      model?: string;
      reasoningEffort?: string;
    };
    const messages = [];
    if (matchedModel) {
      updates.model = String(matchedModel.model ?? matchedModel.id);
      messages.push(this.t('coordinator.model.updated', { name: String(matchedModel.model ?? matchedModel.id) }));
    }
    if (requestedEffort) {
      updates.reasoningEffort = resolvedEffort;
      messages.push(this.t('coordinator.model.effortUpdated', { value: resolvedEffort }));
    }
    if (messages.length === 0) {
      messages.push(this.t('coordinator.model.noArgHint', { providerProfileId: providerProfile.id }));
    }
    this.bridgeSessions.upsertSessionSettings(session.id, updates);
    return messageResponse([...messages, this.t('coordinator.permissions.nextTurn')], buildSessionMeta(session));
  }

  async handlePlanCommand(event, args) {
    const normalizedArgs = args.map((arg) => String(arg ?? '').trim()).filter((arg) => arg.length > 0);
    if (normalizedArgs.length > 1) {
      return this.handleHelpsCommand(event, ['plan']);
    }
    const action = String(normalizedArgs[0] ?? '').trim().toLowerCase();
    const enable = !action || ['on', 'enable', 'enabled', 'plan', '1'].includes(action);
    const disable = ['off', 'disable', 'disabled', 'default', 'normal', '0'].includes(action);
    const scopeRef = toScopeRef(event);
    const session = this.bridgeSessions.resolveScopeSession(scopeRef);
    if (!normalizedArgs.length) {
      const currentMode = formatPlanMode(
        session ? this.bridgeSessions.getSessionSettings(session.id)?.collaborationMode ?? null : null,
        this.currentI18n,
      );
      const lines = [
        this.t('coordinator.plan.current', { value: currentMode }),
        this.t('coordinator.plan.usage'),
        this.t('coordinator.plan.help'),
      ];
      return messageResponse(lines, session ? buildSessionMeta(session) : this.buildScopedSessionMeta(event));
    }
    if (!enable && !disable) {
      return this.handleHelpsCommand(event, ['plan']);
    }
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'plan');
    if (activeResponse) {
      return activeResponse;
    }
    if (disable) {
      if (!session) {
        return messageResponse([
          this.t('coordinator.plan.disabled'),
          this.t('coordinator.plan.current', { value: formatPlanMode(null, this.currentI18n) }),
        ], this.buildScopedSessionMeta(event));
      }
      this.bridgeSessions.upsertSessionSettings(session.id, {
        collaborationMode: 'default',
      });
      return messageResponse([
        this.t('coordinator.plan.disabled'),
        this.t('coordinator.plan.current', { value: formatPlanMode('default', this.currentI18n) }),
        this.t('coordinator.permissions.nextTurn'),
      ], buildSessionMeta(session));
    }
    const ensuredSession = await this.bridgeSessions.resolveOrCreateScopeSession(scopeRef, {
      providerProfileId: this.resolveScopeProviderProfile(scopeRef).id,
      cwd: this.resolveEventCwd(event),
      initialSettings: {
        locale: this.resolveScopeLocale(scopeRef, event),
      },
      providerStartOptions: {
        sourcePlatform: event.platform,
        trigger: 'plan-command',
      },
    });
    this.bridgeSessions.upsertSessionSettings(ensuredSession.id, {
      collaborationMode: 'plan',
    });
    return messageResponse([
      this.t('coordinator.plan.enabled'),
      this.t('coordinator.plan.current', { value: formatPlanMode('plan', this.currentI18n) }),
      this.t('coordinator.permissions.nextTurn'),
    ], buildSessionMeta(ensuredSession));
  }

  async handlePersonalityCommand(event, args) {
    const scopeRef = toScopeRef(event);
    const session = this.bridgeSessions.resolveScopeSession(scopeRef);
    if (!session) {
      return messageResponse([
        this.t('coordinator.personality.noSession'),
        this.t('coordinator.personality.setupHint'),
      ], this.buildScopedSessionMeta(event));
    }
    if (args.length === 0) {
      const settings = this.bridgeSessions.getSessionSettings(session.id);
      return messageResponse([
        this.t('coordinator.personality.current', {
          value: formatPersonality(settings?.personality ?? null, this.currentI18n),
        }),
        this.t('coordinator.personality.usage'),
        this.t('coordinator.personality.help'),
      ], buildSessionMeta(session));
    }
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'personality');
    if (activeResponse) {
      return activeResponse;
    }
    const value = normalizeCodexPersonalityArg(args[0] ?? null);
    if (!value) {
      return messageResponse([
        this.t('coordinator.personality.usage'),
        this.t('coordinator.personality.help'),
      ], buildSessionMeta(session));
    }
    this.bridgeSessions.upsertSessionSettings(session.id, {
      personality: value,
    });
    return messageResponse([
      this.t('coordinator.personality.updated', {
        value: formatPersonality(value, this.currentI18n),
      }),
      this.t('coordinator.permissions.nextTurn'),
    ], buildSessionMeta(session));
  }

  async handleInstructionsCommand(event, args) {
    const action = String(args[0] ?? '').trim().toLowerCase();
    if (!action) {
      return this.renderInstructionsStatus(event);
    }
    if (action === 'cancel') {
      return this.cancelInstructionsEdit(event);
    }
    if (action === 'clear') {
      if (this.activeTurns?.hasAnyActiveTurn?.()) {
        return messageResponse([
          this.t('coordinator.instructions.blocked'),
        ], this.buildScopedSessionMeta(event));
      }
      try {
        const snapshot = await this.codexInstructionsManager.clearInstructions();
        this.clearPendingInstructionsEdit(event);
        const reconnectSummary = await this.reconnectCodexBackedProfiles();
        return messageResponse(this.renderInstructionsSavedLines({
          action: 'cleared',
          snapshot,
          reconnectSummary,
        }), this.buildScopedSessionMeta(event));
      } catch (error) {
        return messageResponse([
          this.t('coordinator.instructions.failed', { error: formatUserError(error) }),
        ], this.buildScopedSessionMeta(event));
      }
    }
    if (action === 'edit') {
      this.setPendingInstructionsEdit(event);
      return messageResponse([
        this.t('coordinator.instructions.editArmed'),
        this.t('coordinator.instructions.editHint'),
      ], this.buildScopedSessionMeta(event));
    }
    if (action === 'set') {
      const inlineContent = extractInstructionsInlineContent(event.text);
      if (!inlineContent) {
        this.setPendingInstructionsEdit(event);
        return messageResponse([
          this.t('coordinator.instructions.editArmed'),
          this.t('coordinator.instructions.editHint'),
        ], this.buildScopedSessionMeta(event));
      }
      return this.applyInstructionsContent(event, inlineContent);
    }
    return messageResponse([
      this.t('coordinator.instructions.usage'),
      this.t('coordinator.instructions.help'),
    ], this.buildScopedSessionMeta(event));
  }

  async handleFastCommand(event, args) {
    const normalizedArgs = args.map((arg) => String(arg ?? '').trim()).filter((arg) => arg.length > 0);
    if (normalizedArgs.length > 1) {
      return this.handleHelpsCommand(event, ['fast']);
    }
    const action = String(normalizedArgs[0] ?? '').trim().toLowerCase();
    const enable = !action || ['on', 'enable', 'enabled', 'fast', '1'].includes(action);
    const disable = ['off', 'disable', 'disabled', 'normal', 'default', '0'].includes(action);
    if (!enable && !disable) {
      return this.handleHelpsCommand(event, ['fast']);
    }
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'fast');
    if (activeResponse) {
      return activeResponse;
    }
    const scopeRef = toScopeRef(event);
    if (disable) {
      const existing = this.bridgeSessions.resolveScopeSession(scopeRef);
      if (!existing) {
        return messageResponse([
          this.t('coordinator.fast.disabled'),
          this.t('coordinator.fast.current', { value: formatSpeedMode(null) }),
        ], this.buildScopedSessionMeta(event));
      }
      this.bridgeSessions.upsertSessionSettings(existing.id, {
        serviceTier: NORMAL_SERVICE_TIER,
      });
      return messageResponse([
        this.t('coordinator.fast.disabled'),
        this.t('coordinator.fast.current', { value: formatSpeedMode(NORMAL_SERVICE_TIER) }),
        this.t('coordinator.status.serviceTier', { value: NORMAL_SERVICE_TIER }),
        this.t('coordinator.permissions.nextTurn'),
      ], buildSessionMeta(existing));
    }
    const session = await this.bridgeSessions.resolveOrCreateScopeSession(scopeRef, {
      providerProfileId: this.resolveScopeProviderProfile(scopeRef).id,
      cwd: this.resolveEventCwd(event),
      initialSettings: {
        locale: this.resolveScopeLocale(scopeRef, event),
      },
      providerStartOptions: {
        sourcePlatform: event.platform,
        trigger: 'fast-command',
      },
    });
    this.bridgeSessions.upsertSessionSettings(session.id, {
      serviceTier: FAST_SERVICE_TIER,
    });
    return messageResponse([
      this.t('coordinator.fast.enabled'),
      this.t('coordinator.fast.current', { value: formatSpeedMode(FAST_SERVICE_TIER) }),
      this.t('coordinator.status.serviceTier', { value: FAST_SERVICE_TIER }),
      this.t('coordinator.permissions.nextTurn'),
    ], buildSessionMeta(session));
  }

  resolveSessionModelForEffort(models, requestedModel) {
    if (requestedModel) {
      const matched = this.findModelByToken(models, requestedModel);
      if (matched) {
        return matched;
      }
    }
    return models.find((model) => model.isDefault) ?? models[0] ?? null;
  }

  resolveEffortForModel(model, requestedEffort) {
    if (!requestedEffort) {
      return null;
    }
    const supportedEfforts = Array.isArray(model?.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [];
    if (supportedEfforts.length === 0) {
      return null;
    }
    const normalized = String(requestedEffort).trim().toLowerCase();
    const matched = supportedEfforts.find((effort) => String(effort ?? '').trim().toLowerCase() === normalized);
    return matched ? String(matched) : null;
  }

  formatSupportedEfforts(model) {
    const supportedEfforts = Array.isArray(model?.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [];
    return supportedEfforts.length > 0 ? supportedEfforts.join(', ') : this.t('coordinator.model.unsupportedEffortFallback');
  }

  findModelByToken(models, request) {
    const normalized = String(request ?? '').trim();
    const lowered = normalized.toLowerCase();
    return models.find((model) => {
      const modelId = String(model.model ?? '');
      const modelDisplayName = String(model.displayName ?? '');
      const modelConfigId = String(model.id ?? '');
      const normalizedModelId = modelId.toLowerCase();
      const normalizedDisplayName = modelDisplayName.toLowerCase();
      const normalizedConfigId = modelConfigId.toLowerCase();
      return modelId === normalized
        || normalizedModelId === lowered
        || modelDisplayName === normalized
        || normalizedDisplayName === lowered
        || modelConfigId === normalized
        || normalizedConfigId === lowered;
    }) ?? null;
  }

  parseConcatenatedModelEffortToken(token, models) {
    const normalizedToken = String(token ?? '').trim().toLowerCase();
    if (!normalizedToken) {
      return null;
    }
    for (const model of models) {
      const supportedEfforts = Array.isArray(model?.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [];
      if (supportedEfforts.length === 0) {
        continue;
      }
      const modelTokens = [
        String(model.id ?? ''),
        String(model.model ?? ''),
        String(model.displayName ?? ''),
      ].map((value) => value.trim().toLowerCase()).filter(Boolean);
      for (const effort of supportedEfforts) {
        const normalizedEffort = String(effort ?? '').trim().toLowerCase();
        if (!normalizedEffort || !normalizedToken.endsWith(normalizedEffort)) {
          continue;
        }
        const modelPart = normalizedToken.slice(0, -normalizedEffort.length);
        if (!modelPart || !modelTokens.includes(modelPart)) {
          continue;
        }
        return {
          model: String(model.model ?? model.id ?? model.displayName ?? ''),
          effort: String(effort),
        };
      }
    }
    return null;
  }

  async handleRenameCommand(event, args) {
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'rename');
    if (activeResponse) {
      return activeResponse;
    }
    const target = args[0]?.trim() ?? '';
    const nextName = args.slice(1).join(' ').trim();
    if (!target || !nextName) {
      return messageResponse([
        this.t('coordinator.rename.usage'),
        this.t('coordinator.rename.help'),
      ], this.buildScopedSessionMeta(event));
    }
    const resolvedThread = this.resolveRequestedThread(event, target);
    if (!resolvedThread.ok) {
      return messageResponse([resolvedThread.message], this.buildScopedSessionMeta(event));
    }
    this.bridgeSessions.renameProviderThread(resolvedThread.providerProfileId, resolvedThread.threadId, nextName);
    this.patchThreadBrowserTitle(event, resolvedThread.providerProfileId, resolvedThread.threadId, nextName);
    return textResponse([
      this.t('coordinator.rename.updated'),
      this.t('coordinator.rename.name', { name: nextName }),
      this.t('coordinator.rename.thread', { threadId: resolvedThread.threadId }),
      this.t('coordinator.rename.actions'),
    ].join('\n'), this.buildScopedSessionMeta(event));
  }

  async handlePeekCommand(event, args) {
    const target = args[0]?.trim() ?? '';
    if (!target) {
      return messageResponse([
        this.t('coordinator.peek.usage'),
        this.t('coordinator.peek.help'),
      ], this.buildScopedSessionMeta(event));
    }
    const resolvedThread = this.resolveRequestedThread(event, target);
    if (!resolvedThread.ok) {
      return messageResponse([resolvedThread.message], this.buildScopedSessionMeta(event));
    }
    const thread = await this.bridgeSessions.readProviderThread(
      resolvedThread.providerProfileId,
      resolvedThread.threadId,
      { includeTurns: true },
    );
    if (!thread) {
      return messageResponse([this.t('coordinator.peek.notFound', { threadId: resolvedThread.threadId })], this.buildScopedSessionMeta(event));
    }
    return textResponse(renderThreadPeek(thread, this.currentI18n), this.buildScopedSessionMeta(event));
  }

  async handleProviderCommand(event, args) {
    const scopeRef = toScopeRef(event);
    if (args.length === 0) {
      const current = this.bridgeSessions.resolveScopeSession(scopeRef);
      const profiles = this.providerProfiles.list().map((profile) => `- ${profile.id} (${profile.providerKind})`);
      return messageResponse([
        this.t('coordinator.provider.current', { id: current?.providerProfileId ?? this.resolveDefaultProviderProfileId() }),
        this.t('coordinator.provider.available'),
        ...profiles,
      ], current ? buildSessionMeta(current) : undefined);
    }
    const requested = args.join(' ').trim();
    const profile = this.resolveProviderProfile(requested);
    if (!profile) {
      return messageResponse([this.t('coordinator.provider.unknown', { id: requested })]);
    }
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'provider');
    if (activeResponse) {
      return activeResponse;
    }
    const current = this.bridgeSessions.resolveScopeSession(scopeRef);
    const currentSettings = current ? this.bridgeSessions.getSessionSettings(current.id) : null;
    const switched = await this.bridgeSessions.switchScopeProvider(scopeRef, {
      nextProviderProfileId: profile.id,
      initialSettings: this.buildReboundSessionSettings(currentSettings, {
        locale: this.resolveScopeLocale(scopeRef, event),
      }),
      providerStartOptions: {
        sourcePlatform: event.platform,
        trigger: 'provider-command',
      },
    });
    return messageResponse([
      this.t('coordinator.provider.switched', { id: profile.id }),
      this.t('coordinator.provider.newSession', { id: switched.id }),
      this.t('coordinator.status.codexThread', { id: switched.codexThreadId }),
    ], buildSessionMeta(switched));
  }

  async handleLangCommand(event, args) {
    const scopeRef = toScopeRef(event);
    const requested = args[0]?.trim() ?? '';
    if (!requested) {
      const current = this.resolveScopeLocale(scopeRef, event);
      const localeName = current === 'zh-CN' ? '中文' : 'English';
      return messageResponse([
        this.t('coordinator.lang.current', { value: localeName }),
      ], this.buildScopedSessionMeta(event));
    }
    const requestedLocale = parseExplicitLocale(requested);
    if (!requestedLocale) {
      return messageResponse([
        this.t('coordinator.lang.invalid', { value: requested }),
        this.t('coordinator.lang.usage'),
      ], this.buildScopedSessionMeta(event));
    }
    const previousSession = this.bridgeSessions.resolveScopeSession(scopeRef);
    this.setScopeLocale(scopeRef, requestedLocale);
    if (previousSession) {
      this.bridgeSessions.upsertSessionSettings(previousSession.id, {
        locale: requestedLocale,
      });
    }
    return textResponse(
      createI18n(requestedLocale).t('coordinator.lang.set', {
        value: requestedLocale,
      }),
      this.buildScopedSessionMeta(event),
    );
  }

  async handleRestartCommand(event) {
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'restart');
    if (activeResponse) {
      return activeResponse;
    }
    if (typeof this.restartBridge !== 'function') {
      return messageResponse([this.t('coordinator.restart.unsupported')]);
    }
    const scopeRef = toScopeRef(event);
    const current = this.bridgeSessions.resolveScopeSession(scopeRef);
    const response = messageResponse([
      this.t('coordinator.restart.queued'),
      this.t('coordinator.restart.continue'),
    ], current ? buildSessionMeta(current) : undefined);
    response.meta = {
      ...(response.meta ?? {}),
      systemAction: {
        kind: 'restart_bridge',
      },
    };
    return response;
  }

  async handleReconnectCommand(event) {
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'reconnect');
    if (activeResponse) {
      return activeResponse;
    }
    const scopeRef = toScopeRef(event);
    const session = this.bridgeSessions.resolveScopeSession(scopeRef);
    const providerProfileId = session?.providerProfileId ?? this.resolveDefaultProviderProfileId();
    const providerProfile = this.requireProviderProfile(providerProfileId);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (typeof providerPlugin.reconnectProfile !== 'function') {
      return messageResponse([this.t('coordinator.reconnect.unsupported')], session ? buildSessionMeta(session) : undefined);
    }
    try {
      const result = await providerPlugin.reconnectProfile({ providerProfile });
      const identity = formatAccountIdentity(result?.accountIdentity ?? null);
      const lines = [
        this.t('coordinator.reconnect.refreshed'),
        ...(identity ? [this.t('coordinator.reconnect.account', { value: identity })] : []),
        this.t('coordinator.reconnect.continue'),
      ];
      return messageResponse(lines, session ? buildSessionMeta(session) : undefined);
    } catch (error) {
      return messageResponse([
        this.t('coordinator.reconnect.failed', { error: formatUserError(error) }),
      ], session ? buildSessionMeta(session) : undefined);
    }
  }

  async handleRetryCommand(event, options: StartTurnOptions = {}) {
    const scopeRef = toScopeRef(event);
    const session = this.bridgeSessions.resolveScopeSession(scopeRef);
    if (!session) {
      return messageResponse([this.t('coordinator.retry.none')], this.buildScopedSessionMeta(event));
    }
    const snapshot = this.resolveRetryableRequest(session.id);
    if (!snapshot) {
      return messageResponse([this.t('coordinator.retry.none')], buildSessionMeta(session));
    }
    const missingAttachment = snapshot.attachments.find((attachment) => !fs.existsSync(attachment.localPath)) ?? null;
    if (missingAttachment) {
      return messageResponse([
        this.t('coordinator.retry.missingAttachments'),
        this.t('coordinator.retry.attachmentPath', { value: missingAttachment.localPath }),
      ], buildSessionMeta(session));
    }
    const stopResult = await this.stopThreadForSession(scopeRef, session, {
      waitForSettleMs: 10_000,
    });
    if (!stopResult.settled) {
      return messageResponse([
        this.t('coordinator.retry.stopPending'),
      ], buildSessionMeta(session));
    }
    if (stopResult.interruptErrors.length > 0 && stopResult.interruptedTurnIds.length === 0 && !stopResult.requestedWhileStarting) {
      return messageResponse([
        this.t('coordinator.retry.stopFailed', { error: stopResult.interruptErrors[0] }),
      ], buildSessionMeta(session));
    }
    const providerProfile = this.requireProviderProfile(session.providerProfileId);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (typeof providerPlugin.resumeThread === 'function') {
      try {
        await providerPlugin.resumeThread({
          providerProfile,
          threadId: session.codexThreadId,
        });
      } catch (error) {
        if (typeof providerPlugin.reconnectProfile === 'function') {
          try {
            await providerPlugin.reconnectProfile({ providerProfile });
            await providerPlugin.resumeThread({
              providerProfile,
              threadId: session.codexThreadId,
            });
          } catch (resumeError) {
            return messageResponse([
              this.t('coordinator.retry.resumeFailed', { error: formatUserError(resumeError) }),
            ], buildSessionMeta(session));
          }
        } else {
          return messageResponse([
            this.t('coordinator.retry.resumeFailed', { error: formatUserError(error) }),
          ], buildSessionMeta(session));
        }
      }
    } else if (typeof providerPlugin.reconnectProfile === 'function') {
      try {
        await providerPlugin.reconnectProfile({ providerProfile });
      } catch (error) {
        return messageResponse([
          this.t('coordinator.retry.reconnectFailed', { error: formatUserError(error) }),
        ], buildSessionMeta(session));
      }
    }
    return this.handleConversationTurn(withRetryContext({
      platform: event.platform,
      externalScopeId: event.externalScopeId,
      text: snapshot.text,
      attachments: cloneInboundAttachments(snapshot.attachments),
      cwd: snapshot.cwd ?? normalizeCwd(session.cwd) ?? this.defaultCwd ?? null,
      locale: this.resolveScopeLocale(scopeRef, event),
      metadata: event.metadata,
    }, {
      threadId: session.codexThreadId,
      stoppedAt: stopResult.stoppedAt,
      interruptedTurnIds: stopResult.interruptedTurnIds,
      pendingApprovalCount: stopResult.pendingApprovalCount,
      interruptErrors: stopResult.interruptErrors,
      originalRequestStoredAt: snapshot.storedAt,
    }), options);
  }

  async handlePermissionsCommand(event, args) {
    const scopeRef = toScopeRef(event);
    const session = this.bridgeSessions.resolveScopeSession(scopeRef);
    if (!session) {
      return messageResponse([
        this.t('coordinator.permissions.noSession'),
        this.t('coordinator.permissions.setupHint'),
      ]);
    }
    if (args.length === 0) {
      return messageResponse(renderPermissionsLines(this.bridgeSessions.getSessionSettings(session.id), this.currentI18n), buildSessionMeta(session));
    }
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'permissions');
    if (activeResponse) {
      return activeResponse;
    }
    const preset = normalizeAccessPreset(args[0]);
    if (!preset) {
      return messageResponse([
        this.t('coordinator.permissions.usage'),
        this.t('coordinator.permissions.help'),
      ], buildSessionMeta(session));
    }
    const access = resolveAccessModeForPreset(preset);
    this.bridgeSessions.upsertSessionSettings(session.id, {
      accessPreset: preset,
      approvalPolicy: access.approvalPolicy,
      sandboxMode: access.sandboxMode,
    });
    return messageResponse([
      this.t('coordinator.permissions.updated', { value: formatAccessPreset(preset) }),
      this.t('coordinator.status.approvalPolicy', { value: access.approvalPolicy }),
      this.t('coordinator.status.sandboxMode', { value: access.sandboxMode }),
      this.t('coordinator.permissions.nextTurn'),
    ], buildSessionMeta(session));
  }

  async handleAllowCommand(event, args) {
    const scopeRef = toScopeRef(event);
    const active = await this.reconcileActiveTurn(scopeRef);
    const sessionMeta = buildActiveTurnMeta(active) ?? this.buildScopedSessionMeta(event);
    const pendingApprovals = Array.isArray(active?.pendingApprovals) ? active.pendingApprovals : [];
    if (args.length === 0) {
      if (pendingApprovals.length === 0) {
        return messageResponse([this.t('coordinator.allow.none')], sessionMeta);
      }
      return messageResponse(renderAllowLines(pendingApprovals, this.currentI18n), sessionMeta);
    }
    const parsed = parseAllowCommandArgs(args);
    if (!parsed.option) {
      return messageResponse([
        this.t('coordinator.allow.usage'),
        this.t('coordinator.allow.help'),
      ], sessionMeta);
    }
    if (!active || pendingApprovals.length === 0) {
      return messageResponse([this.t('coordinator.allow.none')], sessionMeta);
    }
    const request = pendingApprovals[parsed.requestIndex - 1] ?? null;
    if (!request) {
      return messageResponse([
        this.t('coordinator.allow.missingRequest', { index: parsed.requestIndex }),
      ], sessionMeta);
    }
    const providerProfile = this.requireProviderProfile(active.providerProfileId);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (typeof providerPlugin.respondToApproval !== 'function') {
      return messageResponse([
        this.t('coordinator.allow.unsupported', { kind: providerProfile.providerKind }),
      ], sessionMeta);
    }
    try {
      await providerPlugin.respondToApproval({
        providerProfile,
        request,
        option: parsed.option,
      });
      this.activeTurns?.clearPendingApproval(scopeRef, request.requestId);
      const reconciledActive = await this.reconcileActiveTurn(scopeRef);
      return messageResponse(
        renderAllowAcknowledgementLines(request, parsed.option, this.currentI18n, Boolean(reconciledActive)),
        buildActiveTurnMeta(reconciledActive) ?? sessionMeta,
      );
    } catch (error) {
      return messageResponse([
        this.t('coordinator.allow.failed', { error: formatUserError(error) }),
      ], sessionMeta);
    }
  }

  async handleDenyCommand(event, args) {
    if (args.length > 1) {
      return this.handleHelpsCommand(event, ['deny']);
    }
    const indexArg = String(args[0] ?? '').trim();
    if (!indexArg) {
      return this.handleAllowCommand(event, ['3']);
    }
    const requestIndex = Number.parseInt(indexArg, 10);
    if (!Number.isFinite(requestIndex) || requestIndex <= 0) {
      return this.handleHelpsCommand(event, ['deny']);
    }
    return this.handleAllowCommand(event, ['3', String(requestIndex)]);
  }

  async handleStopCommand(event) {
    const scopeRef = toScopeRef(event);
    const active = await this.reconcileActiveTurn(scopeRef);
    const session = this.bridgeSessions.resolveScopeSession(scopeRef);
    if (!active && !session) {
      return messageResponse([this.t('coordinator.stop.none')], this.buildScopedSessionMeta(event));
    }
    if (!session) {
      if (active?.interruptRequested) {
        return messageResponse([this.t('coordinator.stop.alreadyRequested')], buildActiveTurnMeta(active));
      }
      if (active && !active.turnId) {
        this.activeTurns?.requestInterrupt(scopeRef);
        return messageResponse([this.t('coordinator.stop.starting')], buildActiveTurnMeta(active));
      }
      if (active?.turnId) {
        try {
          this.activeTurns?.requestInterrupt(scopeRef);
          await this.dispatchInterruptForActiveTurn(active);
          return messageResponse([this.t('coordinator.stop.requested')], buildActiveTurnMeta(active));
        } catch (error) {
          this.activeTurns?.updateScopeTurn(scopeRef, {
            interruptRequested: false,
          });
          return messageResponse([
            this.t('coordinator.stop.failed', { error: formatUserError(error) }),
          ], buildActiveTurnMeta(active));
        }
      }
      return messageResponse([this.t('coordinator.stop.none')], this.buildScopedSessionMeta(event));
    }
    const stopResult = await this.stopThreadForSession(scopeRef, session);
    if (stopResult.interruptedTurnIds.length === 0 && !stopResult.requestedWhileStarting) {
      if (active?.interruptRequested) {
        return messageResponse([this.t('coordinator.stop.alreadyRequested')], buildActiveTurnMeta(active) ?? buildSessionMeta(session));
      }
      return messageResponse([this.t('coordinator.stop.none')], buildActiveTurnMeta(active) ?? buildSessionMeta(session));
    }
    const lines: string[] = [];
    if (stopResult.interruptedTurnIds.length > 1) {
      lines.push(this.t('coordinator.stop.requestedThread', {
        count: stopResult.interruptedTurnIds.length,
      }));
    } else if (stopResult.interruptedTurnIds.length === 1) {
      lines.push(this.t('coordinator.stop.requested'));
    }
    if (stopResult.requestedWhileStarting) {
      lines.push(this.t('coordinator.stop.starting'));
    }
    if (stopResult.pendingApprovalCount > 0) {
      lines.push(this.t('coordinator.stop.pendingCleared', {
        count: stopResult.pendingApprovalCount,
      }));
    }
    if (stopResult.interruptErrors.length > 0) {
      lines.push(this.t('coordinator.stop.partialFailed', { error: stopResult.interruptErrors[0] }));
    }
    if (lines.length === 0) {
      lines.push(this.t('coordinator.stop.none'));
    }
    return messageResponse(lines, buildActiveTurnMeta(active) ?? buildSessionMeta(session));
  }

  async handleReviewCommand(event, args = [], options: StartTurnOptions = {}) {
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'review');
    if (activeResponse) {
      return activeResponse;
    }
    const target = parseReviewTargetArgs(args);
    if (!target) {
      return this.handleHelpsCommand(event, ['review']);
    }
    const scopeRef = toScopeRef(event);
    const currentSession = this.bridgeSessions.resolveScopeSession(scopeRef);
    const providerProfile = currentSession
      ? this.requireProviderProfile(currentSession.providerProfileId)
      : this.resolveScopeProviderProfile(scopeRef);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (typeof providerPlugin.startReview !== 'function') {
      return messageResponse([
        this.t('coordinator.review.unsupported'),
      ], currentSession ? buildSessionMeta(currentSession) : undefined);
    }
    const cwd = normalizeCwd(currentSession?.cwd) ?? this.resolveEventCwd(event);
    if (!cwd) {
      return messageResponse([
        this.t('coordinator.review.noCwd'),
      ], currentSession ? buildSessionMeta(currentSession) : undefined);
    }
    let stopReviewHeartbeat = () => {};
    try {
      this.activeTurns?.beginScopeTurn(scopeRef, {
        bridgeSessionId: currentSession?.id ?? null,
        providerProfileId: providerProfile.id,
        threadId: currentSession?.codexThreadId ?? null,
      });
      await emitProgressUpdate(
        options.onProgress ?? null,
        this.t('coordinator.review.started', {
          target: formatReviewTargetTitle(target, this.currentI18n),
        }),
        'commentary',
      );
      stopReviewHeartbeat = startProgressHeartbeat(
        options.onProgress ?? null,
        () => this.t('coordinator.review.heartbeat', {
          target: formatReviewTargetTitle(target, this.currentI18n),
        }),
        REVIEW_PROGRESS_HEARTBEAT_MS,
        { maxRuns: REVIEW_PROGRESS_HEARTBEAT_MAX_RUNS },
      );
      const sessionSettings = currentSession
        ? this.bridgeSessions.getSessionSettings(currentSession.id)
        : null;
      const result = await providerPlugin.startReview({
        providerProfile,
        bridgeSession: currentSession,
        sessionSettings,
        cwd,
        target,
        locale: this.currentI18n.locale,
        onProgress: options.onProgress ?? null,
        onTurnStarted: async (meta: { turnId?: string | null; threadId?: string | null } = {}) => {
          const active = this.activeTurns?.updateScopeTurn(scopeRef, {
            bridgeSessionId: currentSession?.id ?? null,
            providerProfileId: providerProfile.id,
            threadId: meta.threadId ?? currentSession?.codexThreadId ?? null,
            turnId: meta.turnId ?? null,
          }) ?? null;
          if (active?.interruptRequested && active.turnId && !active.interruptDispatched) {
            await this.dispatchInterruptForActiveTurn(active);
          }
        },
      });
      return buildReviewResponse({
        result,
        target,
        i18n: this.currentI18n,
        session: currentSession ? buildSessionMeta(currentSession) : undefined,
      });
    } catch (error) {
      const failure = classifyTurnFailure(error, this.currentI18n);
      const message = failure?.errorMessage || formatUserError(error);
      return messageResponse([
        this.t('coordinator.review.failed', { error: message }),
      ], currentSession ? buildSessionMeta(currentSession) : undefined);
    } finally {
      stopReviewHeartbeat();
      await this.releaseActiveTurnIfStillRunning(scopeRef);
    }
  }

  async handleAgentCommand(event, args = []) {
    if (!this.agentJobs) {
      return messageResponse([
        this.t('coordinator.agent.unsupported'),
      ], this.buildScopedSessionMeta(event));
    }
    const scopeRef = toScopeRef(event);
    const normalizedArgs = Array.isArray(args) ? args.map((value) => String(value ?? '').trim()).filter(Boolean) : [];
    const subcommand = String(normalizedArgs[0] ?? '').trim().toLowerCase();
    if (!subcommand) {
      const pendingDraft = this.getPendingAgentDraft(scopeRef);
      if (pendingDraft) {
        return this.renderAgentDraftResponse(event, pendingDraft);
      }
      return this.handleAgentListCommand(event);
    }
    if (['confirm', 'c'].includes(subcommand)) {
      return this.handleAgentConfirmCommand(event);
    }
    if (['edit'].includes(subcommand)) {
      return this.handleAgentEditCommand(event);
    }
    if (['cancel'].includes(subcommand)) {
      return this.handleAgentCancelCommand(event);
    }
    if (['list', 'ls'].includes(subcommand)) {
      return this.handleAgentListCommand(event);
    }
    if (['show', 's'].includes(subcommand)) {
      return this.handleAgentShowCommand(event, normalizedArgs[1] ?? '');
    }
    if (['result', 'res'].includes(subcommand)) {
      return this.handleAgentResultCommand(event, normalizedArgs[1] ?? '', normalizedArgs[2] ?? '');
    }
    if (['send', 'resend'].includes(subcommand)) {
      return this.handleAgentSendCommand(event, normalizedArgs[1] ?? '');
    }
    if (['stop'].includes(subcommand)) {
      return this.handleAgentStopCommand(event, normalizedArgs[1] ?? '');
    }
    if (['retry', 'rt'].includes(subcommand)) {
      return this.handleAgentRetryCommand(event, normalizedArgs[1] ?? '');
    }
    if (['delete', 'del'].includes(subcommand)) {
      return this.handleAgentDeleteCommand(event, normalizedArgs[1] ?? '');
    }
    if (['rename'].includes(subcommand)) {
      return this.handleAgentRenameCommand(event, normalizedArgs[1] ?? '', extractAgentRenameTitle(event.text));
    }
    if (['add'].includes(subcommand)) {
      return this.handleAgentAddCommand(event, extractAgentAddBody(event.text));
    }
    return this.handleAgentAddCommand(event, extractAgentBody(event.text));
  }

  async handleAgentAddCommand(event, rawInput) {
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'agent');
    if (activeResponse) {
      return activeResponse;
    }
    const scopeRef = toScopeRef(event);
    const body = compactWhitespace(rawInput);
    if (!body) {
      return this.handleHelpsCommand(event, ['agent']);
    }
    const draft = await this.normalizeAgentDraft(event, scopeRef, body);
    this.setPendingAgentDraft(scopeRef, draft);
    return this.renderAgentDraftResponse(event, draft);
  }

  async handleAgentConfirmCommand(event) {
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'agent');
    if (activeResponse) {
      return activeResponse;
    }
    const scopeRef = toScopeRef(event);
    const draft = this.getPendingAgentDraft(scopeRef);
    if (!draft) {
      return messageResponse([
        this.t('coordinator.agent.noDraft'),
      ], this.buildScopedSessionMeta(event));
    }
    const targetSession = await this.bridgeSessions.createDetachedSession({
      providerProfileId: draft.providerProfileId,
      cwd: draft.cwd,
      title: `Agent | ${draft.title}`,
      initialSettings: {
        ...draft.initialSettings,
        locale: draft.locale,
        collaborationMode: 'plan',
        accessPreset: 'full-access',
        approvalPolicy: 'never',
        sandboxMode: 'danger-full-access',
      },
      providerStartOptions: {
        sourcePlatform: event.platform,
        source: 'agent',
      },
    });
    const job: AgentJob = this.agentJobs.createJob({
      scopeRef,
      title: draft.title,
      originalInput: draft.rawInput,
      goal: draft.goal,
      expectedOutput: draft.expectedOutput,
      plan: draft.plan,
      category: draft.category,
      riskLevel: draft.riskLevel,
      mode: draft.mode,
      providerProfileId: draft.providerProfileId,
      bridgeSessionId: targetSession.id,
      cwd: draft.cwd,
      locale: draft.locale,
      maxAttempts: 2,
    });
    this.clearPendingAgentDraft(scopeRef);
    const response = messageResponse([
      this.t('coordinator.agent.created'),
      this.t('coordinator.agent.title', { value: job.title }),
      this.t('coordinator.agent.mode', { value: formatAgentMode(job.mode, this.currentI18n) }),
      this.t('coordinator.agent.status', { value: formatAgentStatusLabel(job.status, job.running, this.currentI18n) }),
      this.t('coordinator.agent.deliveryTarget'),
      this.t('coordinator.agent.showHint', { index: this.agentJobs.listForScope(scopeRef).length }),
    ], this.buildScopedSessionMeta(event));
    response.meta = {
      ...(response.meta ?? {}),
      systemAction: {
        kind: 'run_agent_sweep',
      },
    };
    return response;
  }

  async handleAgentEditCommand(event) {
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'agent');
    if (activeResponse) {
      return activeResponse;
    }
    const instruction = extractAgentEditBody(event.text);
    if (!instruction) {
      return this.handleHelpsCommand(event, ['agent']);
    }
    const scopeRef = toScopeRef(event);
    const draft = this.getPendingAgentDraft(scopeRef);
    if (!draft) {
      return messageResponse([
        this.t('coordinator.agent.noDraft'),
      ], this.buildScopedSessionMeta(event));
    }
    const updatedDraft = await this.normalizeAgentDraftEdit(event, scopeRef, draft, instruction);
    if (!updatedDraft) {
      return messageResponse([
        this.t('coordinator.agent.parseFailed'),
      ], this.buildScopedSessionMeta(event));
    }
    this.setPendingAgentDraft(scopeRef, updatedDraft);
    return this.renderAgentDraftResponse(event, updatedDraft);
  }

  handleAgentCancelCommand(event) {
    const scopeRef = toScopeRef(event);
    if (!this.getPendingAgentDraft(scopeRef)) {
      return messageResponse([
        this.t('coordinator.agent.noDraft'),
      ], this.buildScopedSessionMeta(event));
    }
    this.clearPendingAgentDraft(scopeRef);
    return messageResponse([
      this.t('coordinator.agent.draftCancelled'),
    ], this.buildScopedSessionMeta(event));
  }

  handleAgentListCommand(event) {
    const scopeRef = toScopeRef(event);
    const jobs = this.agentJobs.listForScope(scopeRef);
    if (jobs.length === 0) {
      return messageResponse([
        this.t('coordinator.agent.listTitle', { count: 0 }),
        this.t('coordinator.agent.empty'),
        this.t('coordinator.agent.emptyHint'),
      ], this.buildScopedSessionMeta(event));
    }
    const lines = [
      this.t('coordinator.agent.listTitle', { count: jobs.length }),
    ];
    for (const [index, job] of jobs.entries()) {
      lines.push(this.t('coordinator.agent.item', {
        index: index + 1,
        title: job.title,
      }));
      lines.push(this.t('coordinator.agent.status', {
        value: formatAgentStatusLabel(job.status, job.running, this.currentI18n),
      }));
      lines.push(this.t('coordinator.agent.attempts', {
        value: `${job.attemptCount}/${job.maxAttempts}`,
      }));
      if (job.lastResultPreview) {
        lines.push(this.t('coordinator.agent.lastResult', { value: job.lastResultPreview }));
        lines.push(this.t('coordinator.agent.resultHint', { index: index + 1 }));
      }
      const artifacts = this.resolveAgentJobArtifacts(job);
      if (artifacts.length > 0) {
        lines.push(this.t('coordinator.agent.attachments', { value: formatAgentArtifactSummary(artifacts, this.currentI18n) }));
      }
      if (job.lastError) {
        lines.push(this.t('coordinator.agent.lastError', { value: job.lastError }));
      }
    }
    lines.push(this.t('coordinator.agent.actionsHint'));
    return messageResponse(lines, this.buildScopedSessionMeta(event));
  }

  handleAgentShowCommand(event, token) {
    const resolved = this.resolveAgentJobForScope(event, token);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.agent.notFound', { value: token || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    const job = resolved.job;
    const lines = [
      this.t('coordinator.agent.detailTitle', { title: job.title }),
      this.t('coordinator.agent.status', { value: formatAgentStatusLabel(job.status, job.running, this.currentI18n) }),
      this.t('coordinator.agent.mode', { value: formatAgentMode(job.mode, this.currentI18n) }),
      this.t('coordinator.agent.category', { value: formatAgentCategory(job.category, this.currentI18n) }),
      this.t('coordinator.agent.risk', { value: formatAgentRisk(job.riskLevel, this.currentI18n) }),
      this.t('coordinator.agent.providerProfile', { value: job.providerProfileId }),
      this.t('coordinator.agent.workingDirectory', { value: job.cwd ?? this.t('common.notSet') }),
      this.t('coordinator.agent.goal', { value: job.goal }),
      this.t('coordinator.agent.expectedOutput', { value: job.expectedOutput }),
      this.t('coordinator.agent.planTitle'),
      ...job.plan.map((line, index) => `${index + 1}. ${line}`),
      this.t('coordinator.agent.attempts', { value: `${job.attemptCount}/${job.maxAttempts}` }),
    ];
    if (job.verificationSummary) {
      lines.push(this.t('coordinator.agent.verification', { value: job.verificationSummary }));
    }
    if (job.lastResultPreview) {
      lines.push(this.t('coordinator.agent.lastResult', { value: job.lastResultPreview }));
      lines.push(this.t('coordinator.agent.resultHint', { index: resolved.index ?? job.id }));
    }
    const artifacts = this.resolveAgentJobArtifacts(job);
    if (artifacts.length > 0) {
      lines.push(this.t('coordinator.agent.attachmentsTitle'));
      lines.push(...artifacts.map((artifact, index) => formatAgentArtifactLine(artifact, index, this.currentI18n)));
    }
    if (job.lastError) {
      lines.push(this.t('coordinator.agent.lastError', { value: job.lastError }));
    }
    lines.push(this.t('coordinator.agent.detailActions', { index: resolved.index }));
    return messageResponse(lines, this.buildScopedSessionMeta(event));
  }

  async handleAgentResultCommand(event, token, pageOrAction = '') {
    const resolved = this.resolveAgentJobForScope(event, token);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.agent.notFound', { value: token || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    const resultText = await this.resolveAgentJobResultText(resolved.job);
    if (!resultText) {
      return messageResponse([
        this.t('coordinator.agent.noResultText'),
        this.t('coordinator.agent.title', { value: resolved.job.title }),
      ], this.buildScopedSessionMeta(event));
    }
    const isPreviewOnly = isAgentResultPreviewOnly(resolved.job, resultText);
    if (!resolved.job.resultText || isAgentResultPreviewOnly(resolved.job, resolved.job.resultText)) {
      this.agentJobs.updateJob(resolved.job.id, {
        resultText,
      });
    }
    const normalizedAction = String(pageOrAction ?? '').trim().toLowerCase();
    const commandToken = resolved.index ?? resolved.job.id;
    if (['file', 'md', 'markdown', 'export'].includes(normalizedAction)) {
      if (isPreviewOnly) {
        return messageResponse([
          this.t('coordinator.agent.resultOnlyPreview'),
          this.t('coordinator.agent.resultRetryHint', { index: commandToken }),
        ], this.buildScopedSessionMeta(event));
      }
      const artifact = this.createAgentResultTextArtifact(resolved.job, resultText);
      const existingArtifacts = normalizeAgentArtifacts(resolved.job.resultArtifacts ?? null);
      if (!existingArtifacts.some((item) => item.path === artifact.path)) {
        this.agentJobs.updateJob(resolved.job.id, {
          resultText,
          resultArtifacts: [
            ...existingArtifacts,
            artifact,
          ],
        });
      }
      const response = messageResponse([
        this.t('coordinator.agent.resultFileReady'),
        this.t('coordinator.agent.title', { value: resolved.job.title }),
      ], this.buildScopedSessionMeta(event));
      response.messages.push({
        artifact,
        mediaPath: artifact.path,
        caption: artifact.caption ?? artifact.displayName ?? null,
      });
      return response;
    }
    const pages = paginateTextByUtf8(resultText, 1500);
    const requestedPage = Number.parseInt(normalizedAction || '1', 10);
    const page = Number.isInteger(requestedPage)
      ? Math.min(Math.max(requestedPage, 1), Math.max(pages.length, 1))
      : 1;
    const pageText = pages[page - 1] ?? '';
    const lines = [
      this.t('coordinator.agent.resultTitle', { title: resolved.job.title }),
      this.t('coordinator.agent.resultPage', { page, pages: pages.length }),
      '',
      pageText,
    ];
    if (page < pages.length) {
      lines.push('', this.t('coordinator.agent.resultNextHint', { index: commandToken, next: page + 1 }));
    }
    lines.push(this.t('coordinator.agent.resultFileHint', { index: commandToken }));
    return messageResponse([lines.join('\n')], this.buildScopedSessionMeta(event));
  }

  handleAgentSendCommand(event, token) {
    const resolved = this.resolveAgentJobForScope(event, token);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.agent.notFound', { value: token || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    const artifacts = this.resolveAgentJobArtifacts(resolved.job);
    if (artifacts.length === 0) {
      return messageResponse([
        this.t('coordinator.agent.noAttachments'),
        this.t('coordinator.agent.title', { value: resolved.job.title }),
      ], this.buildScopedSessionMeta(event));
    }
    const response = messageResponse([
      this.t('coordinator.agent.resendingAttachments'),
      this.t('coordinator.agent.title', { value: resolved.job.title }),
      this.t('coordinator.agent.attachments', { value: formatAgentArtifactSummary(artifacts, this.currentI18n) }),
    ], this.buildScopedSessionMeta(event));
    response.messages.push(...artifacts.map((artifact) => ({
      artifact,
      mediaPath: artifact.path,
      caption: artifact.caption ?? artifact.displayName ?? null,
    })));
    return response;
  }

  async handleAgentStopCommand(event, token) {
    const resolved = this.resolveAgentJobForScope(event, token);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.agent.notFound', { value: token || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    const job = this.agentJobs.requestStop(resolved.job.id);
    const session = this.agentJobs.getSession(job);
    if (session) {
      await this.stopThreadForSession(toScopeRef(event), session, { waitForSettleMs: 0 }).catch(() => null);
    }
    return messageResponse([
      this.t('coordinator.agent.stopped'),
      this.t('coordinator.agent.title', { value: job.title }),
    ], this.buildScopedSessionMeta(event));
  }

  handleAgentRetryCommand(event, token) {
    const resolved = this.resolveAgentJobForScope(event, token);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.agent.notFound', { value: token || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    const job = this.agentJobs.retryJob(resolved.job.id);
    const response = messageResponse([
      this.t('coordinator.agent.retryQueued'),
      this.t('coordinator.agent.title', { value: job.title }),
    ], this.buildScopedSessionMeta(event));
    response.meta = {
      ...(response.meta ?? {}),
      systemAction: {
        kind: 'run_agent_sweep',
      },
    };
    return response;
  }

  handleAgentDeleteCommand(event, token) {
    const resolved = this.resolveAgentJobForScope(event, token);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.agent.notFound', { value: token || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    this.agentJobs.deleteJob(resolved.job.id);
    return messageResponse([
      this.t('coordinator.agent.deleted'),
      this.t('coordinator.agent.title', { value: resolved.job.title }),
    ], this.buildScopedSessionMeta(event));
  }

  handleAgentRenameCommand(event, token, title) {
    const resolved = this.resolveAgentJobForScope(event, token);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.agent.notFound', { value: token || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    if (!title) {
      return this.handleHelpsCommand(event, ['agent']);
    }
    const job = this.agentJobs.renameJob(resolved.job.id, title);
    return messageResponse([
      this.t('coordinator.agent.renamed'),
      this.t('coordinator.agent.title', { value: job.title }),
    ], this.buildScopedSessionMeta(event));
  }

  async normalizeAgentDraft(event, scopeRef: PlatformScopeRef, rawInput: string): Promise<PendingAgentDraft> {
    const codexDraft = await this.normalizeAgentDraftWithCodex(event, scopeRef, rawInput).catch(() => null);
    if (codexDraft) {
      const draft = this.buildPendingAgentDraft(event, scopeRef, codexDraft, rawInput, 'codex');
      if (draft) {
        return draft;
      }
    }
    const openAiDraft = await normalizeAgentDraftWithOpenAIAgents(rawInput, this.currentI18n.locale).catch(() => null);
    if (openAiDraft) {
      const draft = this.buildPendingAgentDraft(event, scopeRef, openAiDraft, rawInput, 'agents-sdk');
      if (draft) {
        return draft;
      }
    }
    return this.buildPendingAgentDraft(event, scopeRef, buildLocalAgentDraftCandidate(rawInput), rawInput, 'local');
  }

  async normalizeAgentDraftEdit(
    event,
    scopeRef: PlatformScopeRef,
    draft: PendingAgentDraft,
    instruction: string,
  ): Promise<PendingAgentDraft | null> {
    const locale = draft.locale ?? this.resolveScopeLocale(scopeRef, event);
    const providerProfile = this.requireProviderProfile(draft.providerProfileId);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const prompt = buildAgentDraftEditPrompt(draft, instruction, normalizeLocale(locale) ?? 'zh-CN');
    if (providerPlugin && typeof providerPlugin.startThread === 'function' && typeof providerPlugin.startTurn === 'function') {
      const thread = await providerPlugin.startThread({
        providerProfile,
        cwd: draft.cwd,
        title: 'Agent Draft Editor',
        metadata: {
          sourcePlatform: event.platform,
          source: 'agent-draft-editor',
        },
      });
      const parserSession = {
        id: crypto.randomUUID(),
        providerProfileId: providerProfile.id,
        codexThreadId: thread.threadId,
        cwd: thread.cwd ?? draft.cwd,
        title: thread.title ?? 'Agent Draft Editor',
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      const result = await providerPlugin.startTurn({
        providerProfile,
        bridgeSession: parserSession,
        sessionSettings: {
          bridgeSessionId: parserSession.id,
          model: draft.initialSettings.model ?? null,
          reasoningEffort: draft.initialSettings.reasoningEffort ?? null,
          serviceTier: draft.initialSettings.serviceTier ?? null,
          collaborationMode: null,
          personality: null,
          accessPreset: 'read-only',
          approvalPolicy: 'never',
          sandboxMode: 'read-only',
          locale,
          metadata: {},
          updatedAt: this.now(),
        },
        event: {
          ...event,
          text: prompt,
          cwd: parserSession.cwd ?? null,
          locale,
          attachments: [],
        },
        inputText: prompt,
      });
      const candidate = parseAgentDraftCandidate(result.outputText);
      if (candidate) {
        return this.buildEditedPendingAgentDraft(draft, instruction, candidate, 'codex');
      }
    }
    const agentsCandidate = await normalizeAgentDraftEditWithOpenAIAgents(draft, instruction, locale).catch(() => null);
    return agentsCandidate ? this.buildEditedPendingAgentDraft(draft, instruction, agentsCandidate, 'agents-sdk') : null;
  }

  buildPendingAgentDraft(
    event,
    scopeRef: PlatformScopeRef,
    candidate: AgentDraftCandidate,
    rawInput: string,
    normalizedBy: 'agents-sdk' | 'codex' | 'local',
  ): PendingAgentDraft {
    const boundSession = this.bridgeSessions.resolveScopeSession(scopeRef);
    const providerProfile = boundSession
      ? this.requireProviderProfile(boundSession.providerProfileId)
      : this.resolveScopeProviderProfile(scopeRef);
    const inheritedSettings = boundSession
      ? this.bridgeSessions.getSessionSettings(boundSession.id)
      : null;
    const locale = inheritedSettings?.locale ?? this.resolveScopeLocale(scopeRef, event);
    const cwd = normalizeCwd(boundSession?.cwd) ?? this.resolveEventCwd(event) ?? null;
    return {
      createdAt: this.now(),
      rawInput,
      normalizedBy,
      title: candidate.title,
      goal: candidate.goal,
      expectedOutput: candidate.expectedOutput,
      plan: candidate.plan,
      category: candidate.category,
      riskLevel: candidate.riskLevel,
      mode: candidate.mode,
      providerProfileId: providerProfile.id,
      locale,
      cwd,
      initialSettings: {
        locale,
        model: inheritedSettings?.model ?? null,
        reasoningEffort: inheritedSettings?.reasoningEffort ?? null,
        serviceTier: inheritedSettings?.serviceTier ?? null,
        collaborationMode: 'plan',
        personality: inheritedSettings?.personality ?? null,
        accessPreset: 'full-access',
        approvalPolicy: 'never',
        sandboxMode: 'danger-full-access',
      },
    };
  }

  buildEditedPendingAgentDraft(
    draft: PendingAgentDraft,
    instruction: string,
    candidate: AgentDraftCandidate,
    normalizedBy: 'agents-sdk' | 'codex',
  ): PendingAgentDraft {
    return {
      ...draft,
      createdAt: this.now(),
      rawInput: appendAgentDraftEditInput(draft.rawInput, instruction),
      normalizedBy,
      title: candidate.title,
      goal: candidate.goal,
      expectedOutput: candidate.expectedOutput,
      plan: candidate.plan,
      category: candidate.category,
      riskLevel: candidate.riskLevel,
      mode: candidate.mode,
    };
  }

  async normalizeAgentDraftWithCodex(event, scopeRef: PlatformScopeRef, rawInput: string): Promise<AgentDraftCandidate | null> {
    const boundSession = this.bridgeSessions.resolveScopeSession(scopeRef);
    const providerProfile = boundSession
      ? this.requireProviderProfile(boundSession.providerProfileId)
      : this.resolveScopeProviderProfile(scopeRef);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const inheritedSettings = boundSession
      ? this.bridgeSessions.getSessionSettings(boundSession.id)
      : null;
    const locale = inheritedSettings?.locale ?? this.resolveScopeLocale(scopeRef, event);
    const cwd = normalizeCwd(boundSession?.cwd) ?? this.resolveEventCwd(event) ?? null;
    const thread = await providerPlugin.startThread({
      providerProfile,
      cwd,
      title: 'Agent Draft Parser',
      metadata: {
        sourcePlatform: event.platform,
        source: 'agent-draft',
      },
    });
    const parserSession = {
      id: crypto.randomUUID(),
      providerProfileId: providerProfile.id,
      codexThreadId: thread.threadId,
      cwd: thread.cwd ?? cwd,
      title: thread.title ?? 'Agent Draft Parser',
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    const parserPrompt = buildAgentDraftPrompt(rawInput, locale);
    const result = await providerPlugin.startTurn({
      providerProfile,
      bridgeSession: parserSession,
      sessionSettings: {
        bridgeSessionId: parserSession.id,
        model: inheritedSettings?.model ?? null,
        reasoningEffort: inheritedSettings?.reasoningEffort ?? null,
        serviceTier: inheritedSettings?.serviceTier ?? null,
        collaborationMode: null,
        personality: null,
        accessPreset: 'read-only',
        approvalPolicy: 'never',
        sandboxMode: 'read-only',
        locale,
        metadata: {},
        updatedAt: this.now(),
      },
      event: {
        ...event,
        text: parserPrompt,
        cwd: parserSession.cwd ?? null,
        locale,
        attachments: [],
      },
      inputText: parserPrompt,
    });
    return parseAgentDraftCandidate(result.outputText);
  }

  renderAgentDraftResponse(event, draft: PendingAgentDraft) {
    return messageResponse([
      this.t('coordinator.agent.draftTitle', { title: draft.title }),
      this.t('coordinator.agent.normalizedBy', { value: formatAgentNormalizer(draft.normalizedBy, this.currentI18n) }),
      this.t('coordinator.agent.mode', { value: formatAgentMode(draft.mode, this.currentI18n) }),
      this.t('coordinator.agent.category', { value: formatAgentCategory(draft.category, this.currentI18n) }),
      this.t('coordinator.agent.risk', { value: formatAgentRisk(draft.riskLevel, this.currentI18n) }),
      this.t('coordinator.agent.goal', { value: draft.goal }),
      this.t('coordinator.agent.expectedOutput', { value: draft.expectedOutput }),
      this.t('coordinator.agent.planTitle'),
      ...draft.plan.map((line, index) => `${index + 1}. ${line}`),
      this.t('coordinator.agent.deliveryTarget'),
      this.t('coordinator.agent.draftNotice'),
      this.t('coordinator.agent.confirmHint'),
      this.t('coordinator.agent.editHint'),
      this.t('coordinator.agent.cancelHint'),
    ], this.buildScopedSessionMeta(event));
  }

  getPendingAgentDraft(scopeRef: PlatformScopeRef): PendingAgentDraft | null {
    return this.pendingAgentDraftsByScope.get(formatPlatformScopeKey(scopeRef.platform, scopeRef.externalScopeId)) ?? null;
  }

  setPendingAgentDraft(scopeRef: PlatformScopeRef, draft: PendingAgentDraft): void {
    this.pendingAgentDraftsByScope.set(formatPlatformScopeKey(scopeRef.platform, scopeRef.externalScopeId), draft);
  }

  clearPendingAgentDraft(scopeRef: PlatformScopeRef): void {
    this.pendingAgentDraftsByScope.delete(formatPlatformScopeKey(scopeRef.platform, scopeRef.externalScopeId));
  }

  resolveAgentJobForScope(event, token) {
    const scopeRef = toScopeRef(event);
    const job = this.agentJobs.resolveForScope(scopeRef, token);
    if (!job) {
      return null;
    }
    const jobs = this.agentJobs.listForScope(scopeRef);
    const index = jobs.findIndex((entry) => entry.id === job.id);
    return {
      job,
      index: index >= 0 ? index + 1 : null,
    };
  }

  resolveAgentJobArtifacts(job: AgentJob): TurnArtifactDeliveredItem[] {
    const direct = normalizeAgentArtifacts(job.resultArtifacts ?? null);
    if (direct.length > 0) {
      return direct;
    }
    const session = this.agentJobs?.getSession?.(job) ?? this.bridgeSessions.getSessionById(job.bridgeSessionId);
    const settings = session ? this.bridgeSessions.getSessionSettings(session.id) : null;
    return normalizeAgentArtifacts(resolveStoredArtifactDelivery(settings)?.deliveredArtifacts ?? null);
  }

  async resolveAgentJobResultText(job: AgentJob): Promise<string> {
    const stored = stripAgentArtifactProtocol(job.resultText ?? '').trim();
    if (stored && !isAgentResultPreviewOnly(job, stored)) {
      return stored;
    }
    const session = this.agentJobs?.getSession?.(job) ?? this.bridgeSessions.getSessionById(job.bridgeSessionId);
    if (!session) {
      return stored || String(job.lastResultPreview ?? '').trim();
    }
    try {
      const thread = await this.bridgeSessions.readProviderThread(
        session.providerProfileId,
        session.codexThreadId,
        { includeTurns: true },
      );
      const recovered = stripAgentArtifactProtocol(extractLastAssistantThreadText(thread));
      if (recovered && !isAgentResultPreviewOnly(job, recovered)) {
        return recovered;
      }
    } catch {
      // Keep the command usable even if the provider thread cannot be reopened.
    }
    const rolloutRecovered = stripAgentArtifactProtocol(readCodexRolloutLastAgentMessage(session.codexThreadId));
    if (rolloutRecovered && !isAgentResultPreviewOnly(job, rolloutRecovered)) {
      return rolloutRecovered;
    }
    return stored || String(job.lastResultPreview ?? '').trim();
  }

  createAgentResultTextArtifact(job: AgentJob, resultText: string): TurnArtifactDeliveredItem {
    const baseDir = normalizeCwd(job.cwd) ?? this.defaultCwd ?? process.cwd();
    const outputDir = path.join(baseDir, '.codexbridge', 'agent-results', job.id);
    fs.mkdirSync(outputDir, { recursive: true });
    const displayName = `${sanitizeFilename(job.title || 'agent-result')}.txt`;
    const filePath = path.join(outputDir, displayName);
    const content = [
      `标题：${job.title}`,
      `Agent Job: ${job.id}`,
      `状态：${job.status}`,
      `完成时间：${job.completedAt ? new Date(job.completedAt).toISOString() : ''}`,
      '----------------------------------------',
      '',
      resultText.trim(),
      '',
    ].join('\n');
    fs.writeFileSync(filePath, content, 'utf8');
    const stat = fs.statSync(filePath);
    return {
      kind: 'file',
      path: filePath,
      displayName,
      mimeType: 'text/plain',
      sizeBytes: stat.size,
      caption: displayName,
      source: 'bridge_declared',
      turnId: null,
    };
  }

  async handleSkillsCommand(event, args = []) {
    const scopeRef = toScopeRef(event);
    const normalizedArgs = Array.isArray(args) ? args.map((value) => String(value ?? '').trim()).filter(Boolean) : [];
    const session = this.resolveSessionForEvent(scopeRef, event);
    const providerProfile = session
      ? this.requireProviderProfile(session.providerProfileId)
      : this.resolveScopeProviderProfile(scopeRef);
    try {
      const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
      if (typeof providerPlugin.listSkills !== 'function') {
        return messageResponse([
          this.t('coordinator.skills.unsupported'),
        ], session ? buildSessionMeta(session) : this.buildScopedSessionMeta(event));
      }

      const subcommand = String(normalizedArgs[0] ?? '').trim().toLowerCase();
      if (!subcommand || subcommand === 'list') {
        return await this.handleSkillsListCommand(event, providerProfile, false);
      }
      if (subcommand === 'reload') {
        return await this.handleSkillsListCommand(event, providerProfile, true);
      }
      if (subcommand === 'search') {
        return await this.handleSkillsSearchCommand(event, providerProfile, normalizedArgs.slice(1).join(' '));
      }
      if (subcommand === 'show') {
        return await this.handleSkillsShowCommand(event, providerProfile, normalizedArgs.slice(1).join(' '));
      }
      if (subcommand === 'on' || subcommand === 'enable') {
        return await this.handleSkillsToggleCommand(event, providerProfile, normalizedArgs.slice(1).join(' '), true);
      }
      if (subcommand === 'off' || subcommand === 'disable') {
        return await this.handleSkillsToggleCommand(event, providerProfile, normalizedArgs.slice(1).join(' '), false);
      }
      return await this.handleHelpsCommand(event, ['skills']);
    } catch (error) {
      return messageResponse([
        this.t('coordinator.skills.failed', { error: formatUserError(error) }),
      ], session ? buildSessionMeta(session) : this.buildScopedSessionMeta(event));
    }
  }

  async handleSkillsListCommand(event, providerProfile, forceReload = false) {
    const result = await this.fetchSkillsForEvent(event, providerProfile, {
      forceReload,
      searchTerm: null,
    });
    if (result.skills.length === 0) {
      const lines = [
        this.t('coordinator.skills.listTitle', {
          cwd: result.cwd ?? this.t('common.notSet'),
          count: 0,
        }),
        this.t('coordinator.skills.empty'),
      ];
      if (result.errors.length > 0) {
        lines.push(this.t('coordinator.skills.errorCount', { count: result.errors.length }));
      }
      return messageResponse(lines, this.buildScopedSessionMeta(event));
    }
    return messageResponse(
      renderSkillsListLines({
        i18n: this.currentI18n,
        cwd: result.cwd,
        items: result.skills,
        errors: result.errors,
        searchTerm: null,
      }),
      this.buildScopedSessionMeta(event),
    );
  }

  async handleSkillsSearchCommand(event, providerProfile, searchTerm) {
    const query = String(searchTerm ?? '').trim();
    if (!query) {
      return this.handleHelpsCommand(event, ['skills']);
    }
    const result = await this.fetchSkillsForEvent(event, providerProfile, {
      forceReload: false,
      searchTerm: query,
    });
    if (result.skills.length === 0) {
      return messageResponse([
        this.t('coordinator.skills.listTitle', {
          cwd: result.cwd ?? this.t('common.notSet'),
          count: 0,
        }),
        this.t('coordinator.skills.searchLabel', { term: query }),
        this.t('coordinator.skills.noMatch'),
      ], this.buildScopedSessionMeta(event));
    }
    return messageResponse(
      renderSkillsListLines({
        i18n: this.currentI18n,
        cwd: result.cwd,
        items: result.skills,
        errors: result.errors,
        searchTerm: query,
      }),
      this.buildScopedSessionMeta(event),
    );
  }

  async handleSkillsShowCommand(event, providerProfile, token) {
    const resolved = await this.resolveSkillSelection(event, providerProfile, token);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.skills.notFound', { value: String(token ?? '').trim() || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    return messageResponse(
      renderSkillDetailLines({
        i18n: this.currentI18n,
        index: resolved.index,
        cwd: resolved.cwd,
        skill: resolved.skill,
      }),
      this.buildScopedSessionMeta(event),
    );
  }

  async handleSkillsToggleCommand(event, providerProfile, token, enabled) {
    const resolved = await this.resolveSkillSelection(event, providerProfile, token);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.skills.notFound', { value: String(token ?? '').trim() || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (typeof providerPlugin.setSkillEnabled !== 'function') {
      return messageResponse([
        this.t('coordinator.skills.unsupported'),
      ], this.buildScopedSessionMeta(event));
    }
    await providerPlugin.setSkillEnabled({
      providerProfile,
      enabled,
      path: resolved.skill.path,
      name: resolved.skill.name,
    });
    const refreshed = await this.fetchSkillsForEvent(event, providerProfile, {
      forceReload: true,
      searchTerm: this.skillBrowserStates.get(formatPlatformScopeKey(event.platform, event.externalScopeId))?.searchTerm ?? null,
    });
    const currentSkill = refreshed.skills.find((entry) => entry.path === resolved.skill.path || entry.name === resolved.skill.name)
      ?? resolved.skill;
    return messageResponse([
      enabled
        ? this.t('coordinator.skills.enabled')
        : this.t('coordinator.skills.disabled'),
      this.t('coordinator.skills.nameLabel', { value: currentSkill.displayName || currentSkill.name }),
      this.t('coordinator.skills.statusLabel', {
        value: currentSkill.enabled ? this.t('common.enabled') : this.t('common.disabled'),
      }),
    ], this.buildScopedSessionMeta(event));
  }

  async handleAppsCommand(event, args = []) {
    const scopeRef = toScopeRef(event);
    const normalizedArgs = Array.isArray(args) ? args.map((value) => String(value ?? '').trim()).filter(Boolean) : [];
    const session = this.resolveSessionForEvent(scopeRef, event);
    const providerProfile = session
      ? this.requireProviderProfile(session.providerProfileId)
      : this.resolveScopeProviderProfile(scopeRef);
    try {
      const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
      if (typeof providerPlugin.listApps !== 'function') {
        return messageResponse([
          this.t('coordinator.apps.unsupported'),
        ], session ? buildSessionMeta(session) : this.buildScopedSessionMeta(event));
      }

      const subcommand = String(normalizedArgs[0] ?? '').trim().toLowerCase();
      if (!subcommand || subcommand === 'default') {
        return await this.handleAppsListCommand(event, providerProfile, {
          mode: 'default',
        });
      }
      if (subcommand === 'list') {
        return await this.handleAppsListCommand(event, providerProfile, {
          pageToken: normalizedArgs[1],
        });
      }
      if (parsePositiveIntegerToken(subcommand) !== null) {
        return await this.handleAppsListCommand(event, providerProfile, {
          pageToken: subcommand,
        });
      }
      if (subcommand === 'all') {
        return await this.handleAppsListCommand(event, providerProfile, {
          mode: 'all',
          pageToken: normalizedArgs[1],
        });
      }
      if (subcommand === 'search') {
        return await this.handleAppsSearchCommand(event, providerProfile, normalizedArgs.slice(1).join(' '));
      }
      if (subcommand === 'show') {
        return await this.handleAppsShowCommand(event, providerProfile, normalizedArgs.slice(1).join(' '));
      }
      if (subcommand === 'on' || subcommand === 'enable') {
        return await this.handleAppsToggleCommand(event, providerProfile, normalizedArgs.slice(1).join(' '), true);
      }
      if (subcommand === 'off' || subcommand === 'disable') {
        return await this.handleAppsToggleCommand(event, providerProfile, normalizedArgs.slice(1).join(' '), false);
      }
      if (subcommand === 'auth') {
        return await this.handleAppsAuthCommand(event, providerProfile, normalizedArgs.slice(1).join(' '));
      }
      return await this.handleHelpsCommand(event, ['apps']);
    } catch (error) {
      return messageResponse([
        this.t('coordinator.apps.failed', { error: formatUserError(error) }),
      ], session ? buildSessionMeta(session) : this.buildScopedSessionMeta(event));
    }
  }

  async handleAppsListCommand(event, providerProfile, {
    mode = null,
    pageToken = '',
    searchTerm = null,
  }: {
    mode?: 'default' | 'all' | 'search' | null;
    pageToken?: string | null;
    searchTerm?: string | null;
  } = {}) {
    const allItems = await this.fetchAppsForEvent(event, providerProfile);
    const currentState = this.getAppBrowserState(event, providerProfile);
    const requestedPage = parsePositiveIntegerToken(pageToken) ?? 1;
    const resolvedMode = mode ?? currentState?.mode ?? 'default';
    const resolvedSearchTerm = resolvedMode === 'search'
      ? normalizeNullableString(searchTerm ?? currentState?.searchTerm ?? null)
      : null;
    const installedPluginLookups = resolvedMode === 'default'
      ? await this.listInstalledPluginLookupsForApps(event, providerProfile)
      : null;
    const page = this.storeAppBrowserPage(event, providerProfile, allItems, {
      mode: resolvedMode,
      searchTerm: resolvedSearchTerm,
      requestedPage,
      installedPluginLookups,
    });
    return messageResponse(
      renderAppsListLines({
        i18n: this.currentI18n,
        items: page.items,
        totalCount: page.totalCount,
        pageNumber: page.pageNumber,
        pageCount: page.pageCount,
        mode: page.mode,
        searchTerm: page.searchTerm,
      }),
      this.buildScopedSessionMeta(event),
    );
  }

  async handleAppsSearchCommand(event, providerProfile, searchTerm) {
    const query = String(searchTerm ?? '').trim();
    if (!query) {
      return this.handleHelpsCommand(event, ['apps']);
    }
    return this.handleAppsListCommand(event, providerProfile, {
      mode: 'search',
      searchTerm: query,
    });
  }

  async handleAppsShowCommand(event, providerProfile, token) {
    const resolved = await this.resolveAppSelection(event, providerProfile, token);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.apps.notFound', { value: String(token ?? '').trim() || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    return messageResponse(
      renderAppDetailLines({
        i18n: this.currentI18n,
        index: resolved.index,
        app: resolved.app,
      }),
      this.buildScopedSessionMeta(event),
    );
  }

  async handleAppsToggleCommand(event, providerProfile, token, enabled) {
    const resolved = await this.resolveAppSelection(event, providerProfile, token);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.apps.notFound', { value: String(token ?? '').trim() || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (typeof providerPlugin.setAppEnabled !== 'function') {
      return messageResponse([
        this.t('coordinator.apps.unsupported'),
      ], this.buildScopedSessionMeta(event));
    }
    await providerPlugin.setAppEnabled({
      providerProfile,
      appId: resolved.app.id,
      enabled,
    });
    const items = await this.fetchAppsForEvent(event, providerProfile);
    const currentState = this.getAppBrowserState(event, providerProfile);
    const mode = currentState?.mode ?? 'default';
    const searchTerm = currentState?.searchTerm ?? null;
    const installedPluginLookups = mode === 'default'
      ? await this.listInstalledPluginLookupsForApps(event, providerProfile)
      : null;
    const visibleItems = filterAppsForBrowserView(items, {
      mode,
      searchTerm,
      installedPluginLookups,
    });
    const updatedIndex = visibleItems.findIndex((entry) => entry.id === resolved.app.id);
    const pageNumber = updatedIndex >= 0
      ? pageNumberForItemIndex(updatedIndex, APP_PAGE_SIZE)
      : currentState?.pageNumber ?? 1;
    const page = this.storeAppBrowserPage(event, providerProfile, items, {
      mode,
      searchTerm,
      requestedPage: pageNumber,
      installedPluginLookups,
    });
    return messageResponse([
      enabled
        ? this.t('coordinator.apps.enableSuccess', { name: resolved.app.name })
        : this.t('coordinator.apps.disableSuccess', { name: resolved.app.name }),
      ...renderAppsListLines({
        i18n: this.currentI18n,
        items: page.items,
        totalCount: page.totalCount,
        pageNumber: page.pageNumber,
        pageCount: page.pageCount,
        mode: page.mode,
        searchTerm: page.searchTerm,
      }),
    ], this.buildScopedSessionMeta(event));
  }

  async handleAppsAuthCommand(event, providerProfile, token) {
    const resolved = await this.resolveAppSelection(event, providerProfile, token);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.apps.notFound', { value: String(token ?? '').trim() || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    if (resolved.app.isAccessible) {
      return messageResponse([
        this.t('coordinator.apps.authNonePending', { name: resolved.app.name }),
      ], this.buildScopedSessionMeta(event));
    }
    const installUrl = normalizeNullableString(resolved.app.installUrl ?? null);
    if (!installUrl) {
      return messageResponse([
        this.t('coordinator.apps.authNoUrl', { name: resolved.app.name }),
      ], this.buildScopedSessionMeta(event));
    }
    return messageResponse([
      this.t('coordinator.apps.authUrl', {
        name: resolved.app.name,
        url: installUrl,
      }),
      this.t('coordinator.apps.authFollowupHint', {
        value: resolved.app.id || resolved.app.name,
      }),
    ], this.buildScopedSessionMeta(event));
  }

  async handleUseCommand(event, args = [], options = {}) {
    const scopeRef = toScopeRef(event);
    const normalizedArgs = Array.isArray(args) ? args.map((value) => String(value ?? '').trim()).filter(Boolean) : [];
    if (normalizedArgs.length < 2) {
      return this.handleHelpsCommand(event, ['use']);
    }
    const providerProfile = this.resolveScopeProviderProfile(scopeRef);
    const catalog = await this.fetchPluginsForEvent(event, providerProfile);
    const aliases = this.resolveDisplayPluginAliases(event, providerProfile, catalog.allPlugins);
    const targets: ExplicitPluginTargetHint[] = [];
    let splitIndex = 0;
    for (; splitIndex < normalizedArgs.length; splitIndex += 1) {
      const hint = resolvePluginTargetHintFromCatalog({
        token: normalizedArgs[splitIndex],
        allPlugins: catalog.allPlugins,
        aliases,
        syntax: 'slash_use',
        aliasOnly: false,
      });
      if (!hint) {
        break;
      }
      pushUniqueExplicitPluginTarget(targets, hint);
    }
    const taskText = normalizedArgs.slice(splitIndex).join(' ').trim();
    if (targets.length === 0) {
      return messageResponse([
        this.t('coordinator.plugins.notFound', { value: String(normalizedArgs[0] ?? '').trim() || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    if (!taskText) {
      return this.handleHelpsCommand(event, ['use']);
    }
    const targetedEvent = withExplicitPluginTargetHints({
      ...event,
      text: taskText,
    }, targets);
    return this.handleConversationTurn(targetedEvent, options);
  }

  async handlePluginsCommand(event, args = []) {
    const scopeRef = toScopeRef(event);
    const normalizedArgs = Array.isArray(args) ? args.map((value) => String(value ?? '').trim()).filter(Boolean) : [];
    const session = this.resolveSessionForEvent(scopeRef, event);
    const providerProfile = session
      ? this.requireProviderProfile(session.providerProfileId)
      : this.resolveScopeProviderProfile(scopeRef);
    try {
      const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
      if (typeof providerPlugin.listPlugins !== 'function' || typeof providerPlugin.readPlugin !== 'function') {
        return messageResponse([
          this.t('coordinator.plugins.unsupported'),
        ], session ? buildSessionMeta(session) : this.buildScopedSessionMeta(event));
      }

      const subcommand = String(normalizedArgs[0] ?? '').trim().toLowerCase();
      if (!subcommand || subcommand === 'default' || subcommand === 'featured') {
        return await this.handlePluginsFeaturedCommand(event, providerProfile);
      }
      if (subcommand === 'reload') {
        return await this.handlePluginsReloadCommand(event, providerProfile);
      }
      if (subcommand === 'alias' || subcommand === 'aliases') {
        return await this.handlePluginsAliasCommand(event, providerProfile, normalizedArgs.slice(1));
      }
      if (subcommand === 'list') {
        const categoryToken = String(normalizedArgs[1] ?? '').trim();
        const pageToken = String(normalizedArgs[2] ?? '').trim();
        return categoryToken
          ? await this.handlePluginsCategoryItemsCommand(event, providerProfile, categoryToken, pageToken)
          : await this.handlePluginsCategorySummaryCommand(event, providerProfile);
      }
      if (subcommand === 'search' || subcommand === 'find') {
        return await this.handlePluginsSearchCommand(event, providerProfile, normalizedArgs.slice(1));
      }
      if (subcommand === 'show') {
        return await this.handlePluginsShowCommand(event, providerProfile, normalizedArgs.slice(1).join(' '));
      }
      if (subcommand === 'add' || subcommand === 'install') {
        return await this.handlePluginsInstallCommand(event, providerProfile, normalizedArgs.slice(1).join(' '));
      }
      if (subcommand === 'del' || subcommand === 'uninstall' || subcommand === 'remove' || subcommand === 'rm') {
        return await this.handlePluginsUninstallCommand(event, providerProfile, normalizedArgs.slice(1).join(' '));
      }
      return await this.handleHelpsCommand(event, ['plugins']);
    } catch (error) {
      return messageResponse([
        this.t('coordinator.plugins.failed', { error: formatUserError(error) }),
      ], session ? buildSessionMeta(session) : this.buildScopedSessionMeta(event));
    }
  }

  async handlePluginsAliasCommand(event, providerProfile, args = []) {
    if (!this.pluginAliases) {
      return messageResponse([
        this.t('coordinator.plugins.aliasUnsupported'),
      ], this.buildScopedSessionMeta(event));
    }
    const normalizedArgs = Array.isArray(args) ? args.map((value) => String(value ?? '').trim()).filter(Boolean) : [];
    const subcommand = String(normalizedArgs[0] ?? '').trim().toLowerCase();
    if (!subcommand) {
      const aliases = this.listPluginAliases(event, providerProfile);
      return messageResponse(
        renderPluginAliasListLines({
          i18n: this.currentI18n,
          aliases,
        }),
        this.buildScopedSessionMeta(event),
      );
    }
    if (subcommand === 'confirm') {
      return await this.handlePluginsAliasConfirmCommand(event, providerProfile);
    }
    if (subcommand === 'clear' || subcommand === 'del' || subcommand === 'rm') {
      const token = normalizedArgs.slice(1).join(' ');
      const resolved = await this.resolvePluginSelection(event, providerProfile, token);
      if (!resolved) {
        return messageResponse([
          this.t('coordinator.plugins.notFound', { value: token || '?' }),
        ], this.buildScopedSessionMeta(event));
      }
      const draft: PendingPluginAliasDraft = {
        action: 'clear',
        createdAt: this.now(),
        platform: event.platform,
        externalScopeId: event.externalScopeId,
        providerProfileId: providerProfile.id,
        plugin: resolved.plugin,
        alias: null,
      };
      this.pendingPluginAliasDraftsByScope.set(formatPlatformScopeKey(event.platform, event.externalScopeId), draft);
      return messageResponse([
        this.t('coordinator.plugins.aliasClearPending', {
          name: getPluginDisplayName(resolved.plugin),
        }),
        this.t('coordinator.plugins.aliasConfirmHint'),
      ], this.buildScopedSessionMeta(event));
    }

    if (normalizedArgs.length < 2) {
      return messageResponse([
        this.t('coordinator.plugins.aliasUsage'),
      ], this.buildScopedSessionMeta(event));
    }
    const alias = normalizedArgs.at(-1) ?? '';
    const token = normalizedArgs.slice(0, -1).join(' ');
    const resolved = await this.resolvePluginSelection(event, providerProfile, token);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.plugins.notFound', { value: token || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    const validation = validatePluginAliasChange({
      alias,
      pluginId: resolved.plugin.id,
      existingAliases: this.listPluginAliases(event, providerProfile),
      i18n: this.currentI18n,
    });
    if (validation.ok === false) {
      return messageResponse([
        validation.message,
      ], this.buildScopedSessionMeta(event));
    }
    const draft: PendingPluginAliasDraft = {
      action: 'set',
      createdAt: this.now(),
      platform: event.platform,
      externalScopeId: event.externalScopeId,
      providerProfileId: providerProfile.id,
      plugin: resolved.plugin,
      alias: validation.alias,
    };
    this.pendingPluginAliasDraftsByScope.set(formatPlatformScopeKey(event.platform, event.externalScopeId), draft);
    return messageResponse([
      this.t('coordinator.plugins.aliasSetPending', {
        alias: validation.alias,
        name: getPluginDisplayName(resolved.plugin),
      }),
      this.t('coordinator.plugins.aliasConfirmHint'),
    ], this.buildScopedSessionMeta(event));
  }

  async handlePluginsAliasConfirmCommand(event, providerProfile) {
    const scopeKey = formatPlatformScopeKey(event.platform, event.externalScopeId);
    const draft = this.pendingPluginAliasDraftsByScope.get(scopeKey) ?? null;
    if (!draft || draft.providerProfileId !== providerProfile.id) {
      return messageResponse([
        this.t('coordinator.plugins.aliasNoPending'),
      ], this.buildScopedSessionMeta(event));
    }

    const result = await this.fetchPluginsForEvent(event, providerProfile);
    const plugin = findMatchingPluginSummary(result.allPlugins, draft.plugin);
    if (!plugin) {
      return messageResponse([
        this.t('coordinator.plugins.notFound', { value: draft.plugin.name }),
      ], this.buildScopedSessionMeta(event));
    }

    if (draft.action === 'clear') {
      const existingAliases = this.listPluginAliases(event, providerProfile);
      for (const existing of existingAliases.filter((entry) => entry.pluginId === plugin.id)) {
        this.pluginAliases.delete(event.platform, event.externalScopeId, providerProfile.id, existing.alias);
      }
      this.pendingPluginAliasDraftsByScope.delete(scopeKey);
      return messageResponse([
        this.t('coordinator.plugins.aliasCleared', { name: getPluginDisplayName(plugin) }),
      ], this.buildScopedSessionMeta(event));
    }

    const validation = validatePluginAliasChange({
      alias: draft.alias,
      pluginId: plugin.id,
      existingAliases: this.listPluginAliases(event, providerProfile),
      i18n: this.currentI18n,
    });
    if (validation.ok === false) {
      return messageResponse([
        validation.message,
      ], this.buildScopedSessionMeta(event));
    }

    for (const existing of this.listPluginAliases(event, providerProfile).filter((entry) => entry.pluginId === plugin.id)) {
      this.pluginAliases.delete(event.platform, event.externalScopeId, providerProfile.id, existing.alias);
    }
    this.pluginAliases.save(buildPluginAliasRecord({
      event,
      providerProfileId: providerProfile.id,
      plugin,
      alias: validation.alias,
      updatedAt: this.now(),
    }));
    this.pendingPluginAliasDraftsByScope.delete(scopeKey);
    await this.refreshPluginBrowserState(event, providerProfile);
    return messageResponse([
      this.t('coordinator.plugins.aliasSet', {
        alias: validation.alias,
        name: getPluginDisplayName(plugin),
      }),
    ], this.buildScopedSessionMeta(event));
  }

  async handlePluginsFeaturedCommand(event, providerProfile) {
    const result = await this.fetchPluginsForEvent(event, providerProfile);
    const featured = selectFeaturedPlugins(result.catalog);
    const aliases = this.resolveDisplayPluginAliases(event, providerProfile, result.allPlugins);
    this.pluginBrowserStates.set(formatPlatformScopeKey(event.platform, event.externalScopeId), {
      providerProfileId: providerProfile.id,
      cwd: result.cwd,
      mode: 'featured',
      categoryKey: null,
      items: featured,
      updatedAt: this.now(),
    });
    return messageResponse(
      renderPluginFeaturedLines({
        i18n: this.currentI18n,
        cwd: result.cwd,
        items: featured,
        aliases,
        totalCount: result.allPlugins.length,
        hasExplicitFeatured: result.catalog.featuredPluginIds.length > 0,
      }),
      this.buildScopedSessionMeta(event),
    );
  }

  async handlePluginsReloadCommand(event, providerProfile) {
    const result = await this.fetchPluginsForEvent(event, providerProfile);
    const featured = selectFeaturedPlugins(result.catalog);
    const aliases = this.resolveDisplayPluginAliases(event, providerProfile, result.allPlugins);
    this.pluginBrowserStates.set(formatPlatformScopeKey(event.platform, event.externalScopeId), {
      providerProfileId: providerProfile.id,
      cwd: result.cwd,
      mode: 'featured',
      categoryKey: null,
      items: featured,
      updatedAt: this.now(),
    });
    const lines = [
      this.t('coordinator.plugins.reloadSuccess'),
      ...renderPluginFeaturedLines({
        i18n: this.currentI18n,
        cwd: result.cwd,
        items: featured,
        aliases,
        totalCount: result.allPlugins.length,
        hasExplicitFeatured: result.catalog.featuredPluginIds.length > 0,
      }),
    ];
    return messageResponse(lines, this.buildScopedSessionMeta(event));
  }

  async handlePluginsCategorySummaryCommand(event, providerProfile) {
    const result = await this.fetchPluginsForEvent(event, providerProfile);
    const details = await this.readPluginDetailsForSummaries(providerProfile, result.allPlugins);
    const buckets = buildPluginCategoryBuckets(details, this.currentI18n);
    return messageResponse(
      renderPluginCategorySummaryLines({
        i18n: this.currentI18n,
        cwd: result.cwd,
        buckets,
      }),
      this.buildScopedSessionMeta(event),
    );
  }

  async handlePluginsCategoryItemsCommand(event, providerProfile, token, pageToken = '') {
    const result = await this.fetchPluginsForEvent(event, providerProfile);
    const details = await this.readPluginDetailsForSummaries(providerProfile, result.allPlugins);
    const aliases = this.resolveDisplayPluginAliases(event, providerProfile, result.allPlugins);
    const buckets = buildPluginCategoryBuckets(details, this.currentI18n);
    const resolved = resolvePluginCategorySelection(token, buckets);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.plugins.categoryNotFound', { value: String(token ?? '').trim() || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    const requestedPage = Number.parseInt(String(pageToken ?? '').trim(), 10);
    const pageCount = Math.max(1, Math.ceil(resolved.bucket.items.length / PLUGIN_CATEGORY_PAGE_SIZE));
    const pageNumber = Number.isInteger(requestedPage) && requestedPage >= 1
      ? Math.min(requestedPage, pageCount)
      : 1;
    const offset = (pageNumber - 1) * PLUGIN_CATEGORY_PAGE_SIZE;
    const pageItems = resolved.bucket.items.slice(offset, offset + PLUGIN_CATEGORY_PAGE_SIZE);
    this.pluginBrowserStates.set(formatPlatformScopeKey(event.platform, event.externalScopeId), {
      providerProfileId: providerProfile.id,
      cwd: result.cwd,
      mode: 'category',
      categoryKey: resolved.bucket.key,
      items: pageItems.map((detail) => detail.summary),
      updatedAt: this.now(),
    });
    return messageResponse(
      renderPluginCategoryItemsLines({
        i18n: this.currentI18n,
        cwd: result.cwd,
        categoryIndex: resolved.index,
        bucket: resolved.bucket,
        pageItems,
        aliases,
        pageNumber,
        pageCount,
      }),
      this.buildScopedSessionMeta(event),
    );
  }

  async handlePluginsSearchCommand(event, providerProfile, args = []) {
    const parsed = parsePluginSearchArgs(args);
    if (!parsed.searchTerm) {
      return await this.handleHelpsCommand(event, ['plugins']);
    }
    const result = await this.fetchPluginsForEvent(event, providerProfile);
    const details = await this.readPluginDetailsForSummaries(providerProfile, result.allPlugins);
    const aliases = this.resolveDisplayPluginAliases(event, providerProfile, result.allPlugins);
    const matches = searchPluginDetails(details, parsed.searchTerm);
    const pageCount = Math.max(1, Math.ceil(matches.length / PLUGIN_CATEGORY_PAGE_SIZE));
    const pageNumber = Math.min(parsed.pageNumber ?? 1, pageCount);
    const offset = (pageNumber - 1) * PLUGIN_CATEGORY_PAGE_SIZE;
    const pageItems = matches.slice(offset, offset + PLUGIN_CATEGORY_PAGE_SIZE);
    this.pluginBrowserStates.set(formatPlatformScopeKey(event.platform, event.externalScopeId), {
      providerProfileId: providerProfile.id,
      cwd: result.cwd,
      mode: 'search',
      categoryKey: null,
      searchTerm: parsed.searchTerm,
      pageNumber,
      items: pageItems.map((match) => match.detail.summary),
      updatedAt: this.now(),
    });
    return messageResponse(
      renderPluginSearchLines({
        i18n: this.currentI18n,
        cwd: result.cwd,
        searchTerm: parsed.searchTerm,
        pageItems,
        aliases,
        pageNumber,
        pageCount,
        totalCount: matches.length,
      }),
      this.buildScopedSessionMeta(event),
    );
  }

  async handlePluginsShowCommand(event, providerProfile, token) {
    const resolved = await this.resolvePluginSelection(event, providerProfile, token);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.plugins.notFound', { value: String(token ?? '').trim() || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    const detailContext = await this.loadPluginDetailContext(providerProfile, resolved.plugin);
    if (!detailContext.detail) {
      return messageResponse([
        this.t('coordinator.plugins.notFound', { value: String(token ?? '').trim() || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    const aliases = this.resolveDisplayPluginAliases(
      event,
      providerProfile,
      (await this.fetchPluginsForEvent(event, providerProfile)).allPlugins,
    );
    return messageResponse(
      renderPluginDetailLines({
        i18n: this.currentI18n,
        index: resolved.index,
        cwd: resolved.cwd,
        detail: detailContext.detail,
        aliases,
        apps: detailContext.apps,
        mcpServers: detailContext.mcpServers,
      }),
      this.buildScopedSessionMeta(event),
    );
  }

  async handlePluginsInstallCommand(event, providerProfile, token) {
    const resolved = await this.resolvePluginSelection(event, providerProfile, token);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.plugins.notFound', { value: String(token ?? '').trim() || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (typeof providerPlugin.installPlugin !== 'function') {
      return messageResponse([
        this.t('coordinator.plugins.unsupported'),
      ], this.buildScopedSessionMeta(event));
    }

    const targetPlugin = resolved.plugin;
    if (targetPlugin.installed) {
      const detailContext = await this.loadPluginDetailContext(providerProfile, targetPlugin);
      const aliases = this.resolveDisplayPluginAliases(
        event,
        providerProfile,
        (await this.fetchPluginsForEvent(event, providerProfile)).allPlugins,
      );
      return messageResponse([
        this.t('coordinator.plugins.installAlready', { name: getPluginDisplayName(targetPlugin) }),
        ...renderPluginDetailLines({
          i18n: this.currentI18n,
          index: resolved.index,
          cwd: resolved.cwd,
          detail: detailContext.detail,
          aliases,
          apps: detailContext.apps,
          mcpServers: detailContext.mcpServers,
        }),
      ], this.buildScopedSessionMeta(event));
    }

    const installResult = await providerPlugin.installPlugin({
      providerProfile,
      pluginName: targetPlugin.name,
      marketplaceName: targetPlugin.marketplaceName,
      marketplacePath: targetPlugin.marketplacePath,
    });
    const detailContext = await this.refreshPluginAfterMutation(event, providerProfile, targetPlugin);
    const aliases = this.resolveDisplayPluginAliases(
      event,
      providerProfile,
      (await this.fetchPluginsForEvent(event, providerProfile)).allPlugins,
    );
    const lines = [
      this.t('coordinator.plugins.installSuccess', { name: getPluginDisplayName(detailContext.detail.summary) }),
      ...renderPluginInstallFollowupLines(installResult, this.currentI18n),
      ...renderPluginDetailLines({
        i18n: this.currentI18n,
        index: resolved.index,
        cwd: detailContext.cwd,
        detail: detailContext.detail,
        aliases,
        apps: detailContext.apps,
        mcpServers: detailContext.mcpServers,
      }),
    ];
    return messageResponse(lines, this.buildScopedSessionMeta(event));
  }

  async handlePluginsUninstallCommand(event, providerProfile, token) {
    const resolved = await this.resolvePluginSelection(event, providerProfile, token);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.plugins.notFound', { value: String(token ?? '').trim() || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (typeof providerPlugin.uninstallPlugin !== 'function') {
      return messageResponse([
        this.t('coordinator.plugins.unsupported'),
      ], this.buildScopedSessionMeta(event));
    }

    const targetPlugin = resolved.plugin;
    if (!targetPlugin.installed) {
      const detailContext = await this.loadPluginDetailContext(providerProfile, targetPlugin);
      const aliases = this.resolveDisplayPluginAliases(
        event,
        providerProfile,
        (await this.fetchPluginsForEvent(event, providerProfile)).allPlugins,
      );
      return messageResponse([
        this.t('coordinator.plugins.uninstallAlready', { name: getPluginDisplayName(targetPlugin) }),
        ...renderPluginDetailLines({
          i18n: this.currentI18n,
          index: resolved.index,
          cwd: resolved.cwd,
          detail: detailContext.detail,
          aliases,
          apps: detailContext.apps,
          mcpServers: detailContext.mcpServers,
        }),
      ], this.buildScopedSessionMeta(event));
    }

    await providerPlugin.uninstallPlugin({
      providerProfile,
      pluginId: targetPlugin.id,
    });
    const detailContext = await this.refreshPluginAfterMutation(event, providerProfile, targetPlugin);
    const aliases = this.resolveDisplayPluginAliases(
      event,
      providerProfile,
      (await this.fetchPluginsForEvent(event, providerProfile)).allPlugins,
    );
    return messageResponse([
      this.t('coordinator.plugins.uninstallSuccess', { name: getPluginDisplayName(targetPlugin) }),
      ...renderPluginDetailLines({
        i18n: this.currentI18n,
        index: resolved.index,
        cwd: detailContext.cwd,
        detail: detailContext.detail,
        aliases,
        apps: detailContext.apps,
        mcpServers: detailContext.mcpServers,
      }),
    ], this.buildScopedSessionMeta(event));
  }

  async handleMcpCommand(event, args = []) {
    const scopeRef = toScopeRef(event);
    const normalizedArgs = Array.isArray(args) ? args.map((value) => String(value ?? '').trim()).filter(Boolean) : [];
    const session = this.resolveSessionForEvent(scopeRef, event);
    const providerProfile = session
      ? this.requireProviderProfile(session.providerProfileId)
      : this.resolveScopeProviderProfile(scopeRef);
    try {
      const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
      if (typeof providerPlugin.listMcpServerStatuses !== 'function') {
        return messageResponse([
          this.t('coordinator.mcp.unsupported'),
        ], session ? buildSessionMeta(session) : this.buildScopedSessionMeta(event));
      }

      const subcommand = String(normalizedArgs[0] ?? '').trim().toLowerCase();
      if (!subcommand || subcommand === 'default' || subcommand === 'list') {
        return await this.handleMcpListCommand(event, providerProfile);
      }
      if (subcommand === 'on') {
        return await this.handleMcpSetEnabledCommand(event, providerProfile, normalizedArgs.slice(1).join(' '), true);
      }
      if (subcommand === 'off') {
        return await this.handleMcpSetEnabledCommand(event, providerProfile, normalizedArgs.slice(1).join(' '), false);
      }
      if (subcommand === 'auth') {
        return await this.handleMcpAuthCommand(event, providerProfile, normalizedArgs.slice(1).join(' '));
      }
      if (subcommand === 'reload') {
        return await this.handleMcpReloadCommand(event, providerProfile);
      }
      return await this.handleHelpsCommand(event, ['mcp']);
    } catch (error) {
      return messageResponse([
        this.t('coordinator.mcp.failed', { error: formatUserError(error) }),
      ], session ? buildSessionMeta(session) : this.buildScopedSessionMeta(event));
    }
  }

  async handleMcpListCommand(event, providerProfile) {
    const items = await this.fetchMcpServersForEvent(event, providerProfile);
    return messageResponse(
      renderMcpServerListLines({
        i18n: this.currentI18n,
        items,
      }),
      this.buildScopedSessionMeta(event),
    );
  }

  async handleMcpSetEnabledCommand(event, providerProfile, token, enabled) {
    const resolved = await this.resolveMcpSelection(event, providerProfile, token);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.mcp.notFound', { value: String(token ?? '').trim() || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (typeof providerPlugin.setMcpServerEnabled !== 'function') {
      return messageResponse([
        this.t('coordinator.mcp.unsupported'),
      ], this.buildScopedSessionMeta(event));
    }
    await providerPlugin.setMcpServerEnabled({
      providerProfile,
      name: resolved.server.name,
      enabled,
    });
    const items = await this.fetchMcpServersForEvent(event, providerProfile);
    return messageResponse([
      enabled
        ? this.t('coordinator.mcp.enableSuccess', { name: resolved.server.name })
        : this.t('coordinator.mcp.disableSuccess', { name: resolved.server.name }),
      ...renderMcpServerListLines({
        i18n: this.currentI18n,
        items,
      }),
    ], this.buildScopedSessionMeta(event));
  }

  async handleMcpAuthCommand(event, providerProfile, token) {
    const resolved = await this.resolveMcpSelection(event, providerProfile, token);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.mcp.notFound', { value: String(token ?? '').trim() || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    if ((resolved.server.authStatus ?? 'notLoggedIn') !== 'notLoggedIn') {
      return messageResponse([
        this.t('coordinator.mcp.authNonePending', { name: resolved.server.name }),
      ], this.buildScopedSessionMeta(event));
    }
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (typeof providerPlugin.startMcpServerOauthLogin !== 'function') {
      return messageResponse([
        this.t('coordinator.mcp.authUnsupported', { name: resolved.server.name }),
      ], this.buildScopedSessionMeta(event));
    }
    try {
      const result = await providerPlugin.startMcpServerOauthLogin({
        providerProfile,
        name: resolved.server.name,
      });
      return messageResponse([
        this.t('coordinator.mcp.authUrl', {
          name: resolved.server.name,
          url: result.authorizationUrl,
        }),
        this.t('coordinator.mcp.authFollowupHint'),
      ], this.buildScopedSessionMeta(event));
    } catch (error) {
      return messageResponse([
        this.t('coordinator.mcp.authFailed', {
          name: resolved.server.name,
          error: formatUserError(error),
        }),
      ], this.buildScopedSessionMeta(event));
    }
  }

  async handleMcpReloadCommand(event, providerProfile) {
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    let reloadError = null;
    if (typeof providerPlugin.reloadMcpServers === 'function') {
      try {
        await providerPlugin.reloadMcpServers({ providerProfile });
      } catch (error) {
        reloadError = formatUserError(error);
      }
    }
    const items = await this.fetchMcpServersForEvent(event, providerProfile);
    return messageResponse([
      reloadError
        ? this.t('coordinator.mcp.reloadPartial', { error: reloadError })
        : this.t('coordinator.mcp.reloadSuccess'),
      ...renderMcpServerListLines({
        i18n: this.currentI18n,
        items,
      }),
    ], this.buildScopedSessionMeta(event));
  }

  async renderThreadsPage(event, {
    providerProfileId,
    cursor,
    previousCursors,
    searchTerm,
    pageNumber,
    includeArchived,
    onlyPinned,
  }) {
    const scopeRef = toScopeRef(event);
    const current = this.bridgeSessions.resolveScopeSession(scopeRef);
    const providerProfile = this.requireProviderProfile(providerProfileId);
    const result = await this.bridgeSessions.listProviderThreads(providerProfile.id, {
      limit: THREAD_PAGE_SIZE,
      cursor,
      searchTerm,
      includeArchived,
      onlyPinned,
    });
    if (result.items.length === 0 && previousCursors.length > 0) {
      const fallbackPreviousCursors = previousCursors.slice(0, -1);
      const fallbackCursor = previousCursors.at(-1) ?? null;
      return this.renderThreadsPage(event, {
        providerProfileId,
        cursor: fallbackCursor,
        previousCursors: fallbackPreviousCursors,
        searchTerm,
        pageNumber: Math.max(1, pageNumber - 1),
        includeArchived,
        onlyPinned,
      });
    }
    if (result.items.length === 0) {
      if (searchTerm) {
        return textResponse([
          this.t('coordinator.threadList.title', { providerProfileId: providerProfile.id }),
          this.t('coordinator.threadList.search', { term: searchTerm }),
          ...(includeArchived ? [this.t('coordinator.threadList.includeArchived')] : []),
          ...(onlyPinned ? [this.t('coordinator.threadList.onlyPinned')] : []),
          '',
          this.t('coordinator.threadList.noMatch'),
          this.t('coordinator.threadList.viewAll'),
        ].join('\n'), current ? buildSessionMeta(current) : undefined);
      }
      return textResponse([
        this.t('coordinator.threadList.title', { providerProfileId: providerProfile.id }),
        ...(includeArchived ? [this.t('coordinator.threadList.includeArchived')] : []),
        ...(onlyPinned ? [this.t('coordinator.threadList.onlyPinned')] : []),
        '',
        onlyPinned ? this.t('coordinator.threadList.emptyPinned') : this.t('coordinator.threadList.empty'),
        this.t('coordinator.threadList.emptyAction'),
      ].join('\n'), current ? buildSessionMeta(current) : undefined);
    }

    this.setThreadBrowserState(event, {
      providerProfileId: providerProfile.id,
      cursor,
      previousCursors,
      nextCursor: result.nextCursor,
      searchTerm,
      pageNumber,
      items: result.items,
      includeArchived,
      onlyPinned,
      updatedAt: this.now(),
    });
    return textResponse(renderThreadsPageMessage({
      i18n: this.currentI18n,
      providerProfile,
      currentSession: current,
      items: result.items,
      pageNumber,
      searchTerm,
      includeArchived,
      onlyPinned,
      hasPreviousPage: previousCursors.length > 0,
      hasNextPage: Boolean(result.nextCursor),
    }), current ? buildSessionMeta(current) : undefined);
  }

  buildScopedSessionMeta(event) {
    const session = this.resolveSessionForEvent(toScopeRef(event), event);
    return session ? buildSessionMeta(session) : undefined;
  }

  async fetchSkillsForEvent(event, providerProfile, {
    forceReload = false,
    searchTerm = null,
  }: {
    forceReload?: boolean;
    searchTerm?: string | null;
  } = {}) {
    const scopeKey = formatPlatformScopeKey(event.platform, event.externalScopeId);
    const session = this.resolveSessionForEvent(toScopeRef(event), event);
    const cwd = normalizeCwd(session?.cwd) ?? this.resolveEventCwd(event) ?? this.defaultCwd ?? null;
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const result: ProviderSkillsListResult = await providerPlugin.listSkills({
      providerProfile,
      cwd,
      forceReload,
    });
    const filteredSkills = filterSkillsBySearchTerm(result.skills, searchTerm);
    this.skillBrowserStates.set(scopeKey, {
      cwd: result.cwd ?? cwd,
      searchTerm: normalizeNullableString(searchTerm),
      items: filteredSkills,
      errors: result.errors,
      updatedAt: this.now(),
    });
    return {
      cwd: result.cwd ?? cwd,
      skills: filteredSkills,
      errors: result.errors,
    };
  }

  async fetchAppsForEvent(event, providerProfile) {
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    return (await providerPlugin.listApps({ providerProfile }))
      .slice()
      .sort(compareAppsForDisplay);
  }

  async listInstalledPluginLookupsForApps(event, providerProfile): Promise<Set<string> | null> {
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (typeof providerPlugin.listPlugins !== 'function') {
      return null;
    }
    try {
      const result = await this.fetchPluginsForEvent(event, providerProfile);
      return buildInstalledPluginLookupSet(result.allPlugins);
    } catch {
      return null;
    }
  }

  getAppBrowserState(event, providerProfile) {
    const scopeKey = formatPlatformScopeKey(event.platform, event.externalScopeId);
    const state = this.appBrowserStates.get(scopeKey) ?? null;
    if (state && state.providerProfileId !== providerProfile.id) {
      this.appBrowserStates.delete(scopeKey);
      return null;
    }
    return state;
  }

  storeAppBrowserPage(event, providerProfile, allItems, {
    mode = 'default',
    searchTerm = null,
    requestedPage = 1,
    installedPluginLookups = null,
  }: {
    mode?: 'default' | 'all' | 'search';
    searchTerm?: string | null;
    requestedPage?: number;
    installedPluginLookups?: Set<string> | null;
  } = {}) {
    const scopeKey = formatPlatformScopeKey(event.platform, event.externalScopeId);
    const filteredItems = filterAppsForBrowserView(allItems, {
      mode,
      searchTerm,
      installedPluginLookups,
    });
    const pageCount = Math.max(1, Math.ceil(filteredItems.length / APP_PAGE_SIZE));
    const pageNumber = Number.isInteger(requestedPage) && requestedPage >= 1
      ? Math.min(requestedPage, pageCount)
      : 1;
    const offset = (pageNumber - 1) * APP_PAGE_SIZE;
    const items = filteredItems.slice(offset, offset + APP_PAGE_SIZE);
    this.appBrowserStates.set(scopeKey, {
      providerProfileId: providerProfile.id,
      mode,
      searchTerm: normalizeNullableString(searchTerm),
      items,
      pageNumber,
      pageCount,
      totalCount: filteredItems.length,
      updatedAt: this.now(),
    });
    return {
      items,
      mode,
      searchTerm: normalizeNullableString(searchTerm),
      pageNumber,
      pageCount,
      totalCount: filteredItems.length,
    };
  }

  async resolveSkillSelection(event, providerProfile, token) {
    const rawToken = String(token ?? '').trim();
    const scopeKey = formatPlatformScopeKey(event.platform, event.externalScopeId);
    let state = this.skillBrowserStates.get(scopeKey) ?? null;
    if (!state) {
      await this.fetchSkillsForEvent(event, providerProfile, {
        forceReload: false,
        searchTerm: null,
      });
      state = this.skillBrowserStates.get(scopeKey) ?? null;
    }
    if (!state) {
      return null;
    }
    const numeric = Number.parseInt(rawToken, 10);
    if (rawToken && Number.isInteger(numeric) && numeric >= 1 && numeric <= state.items.length) {
      return {
        index: numeric,
        cwd: state.cwd,
        skill: state.items[numeric - 1],
      };
    }
    const normalized = normalizeSkillLookupToken(rawToken);
    if (!normalized) {
      if (state.items.length === 1) {
        return {
          index: 1,
          cwd: state.cwd,
          skill: state.items[0],
        };
      }
      return null;
    }
    const byExact = state.items.find((entry) => {
      const candidates = [
        entry.name,
        entry.displayName ?? '',
        path.basename(entry.path),
      ];
      return candidates.some((candidate) => normalizeSkillLookupToken(candidate) === normalized);
    });
    if (byExact) {
      return {
        index: state.items.indexOf(byExact) + 1,
        cwd: state.cwd,
        skill: byExact,
      };
    }
    const byPartial = state.items.find((entry) => {
      const haystack = [
        entry.name,
        entry.displayName ?? '',
        entry.description,
        entry.shortDescription ?? '',
      ].map((candidate) => normalizeSkillLookupToken(candidate)).join(' ');
      return haystack.includes(normalized);
    });
    if (!byPartial) {
      return null;
    }
    return {
      index: state.items.indexOf(byPartial) + 1,
      cwd: state.cwd,
      skill: byPartial,
    };
  }

  async resolveAppSelection(event, providerProfile, token) {
    const rawToken = String(token ?? '').trim();
    let state = this.getAppBrowserState(event, providerProfile);
    if (!state) {
      const items = await this.fetchAppsForEvent(event, providerProfile);
      this.storeAppBrowserPage(event, providerProfile, items, {
        mode: 'default',
        requestedPage: 1,
      });
      state = this.getAppBrowserState(event, providerProfile);
      if (!state) {
        return null;
      }
    }
    const numeric = parsePositiveIntegerToken(rawToken);
    if (numeric !== null && numeric <= state.items.length) {
      return {
        index: numeric,
        app: state.items[numeric - 1],
      };
    }
    if (numeric !== null) {
      return null;
    }
    const normalized = normalizeAppLookupToken(rawToken);
    if (!normalized) {
      if (state.items.length === 1) {
        return {
          index: 1,
          app: state.items[0],
        };
      }
      return null;
    }
    const pageMatch = findAppLookupMatch(state.items, normalized);
    if (pageMatch) {
      return {
        index: state.items.indexOf(pageMatch) + 1,
        app: pageMatch,
      };
    }
    const allItems = await this.fetchAppsForEvent(event, providerProfile);
    const allMatch = findAppLookupMatch(allItems, normalized);
    if (!allMatch) {
      return null;
    }
    return {
      index: null,
      app: allMatch,
    };
  }

  listPluginAliases(event, providerProfile): PluginAlias[] {
    if (!this.pluginAliases) {
      return [];
    }
    return this.pluginAliases
      .listByScope(event.platform, event.externalScopeId, providerProfile.id)
      .sort((left, right) => left.alias.localeCompare(right.alias));
  }

  resolveDisplayPluginAliases(event, providerProfile, allPlugins: ProviderPluginSummary[]): ResolvedPluginAlias[] {
    return buildResolvedPluginAliases({
      plugins: allPlugins,
      userAliases: this.listPluginAliases(event, providerProfile),
    });
  }

  async fetchPluginsForEvent(event, providerProfile) {
    const session = this.resolveSessionForEvent(toScopeRef(event), event);
    const cwd = normalizeCwd(session?.cwd) ?? this.resolveEventCwd(event) ?? this.defaultCwd ?? null;
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const catalog: ProviderPluginsListResult = await providerPlugin.listPlugins({
      providerProfile,
      cwd,
    });
    return {
      cwd,
      catalog,
      allPlugins: flattenPluginMarketplaces(catalog.marketplaces),
    };
  }

  async fetchMcpServersForEvent(event, providerProfile) {
    const scopeKey = formatPlatformScopeKey(event.platform, event.externalScopeId);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const statuses = await providerPlugin.listMcpServerStatuses({ providerProfile });
    const items = [...statuses].sort(compareMcpServersForDisplay);
    this.mcpBrowserStates.set(scopeKey, {
      providerProfileId: providerProfile.id,
      items,
      updatedAt: this.now(),
    });
    return items;
  }

  async readPluginDetailsForSummaries(providerProfile, items: ProviderPluginSummary[]) {
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const results = await Promise.all(items.map(async (summary) => {
      try {
        return await providerPlugin.readPlugin({
          providerProfile,
          pluginName: summary.name,
          marketplaceName: summary.marketplaceName,
          marketplacePath: summary.marketplacePath,
        });
      } catch {
        return null;
      }
    }));
    return results.map((detail, index) => detail ?? createFallbackPluginDetail(items[index])).filter(Boolean);
  }

  async resolvePluginSelection(event, providerProfile, token) {
    const rawToken = String(token ?? '').trim();
    const scopeKey = formatPlatformScopeKey(event.platform, event.externalScopeId);
    let state = this.pluginBrowserStates.get(scopeKey) ?? null;
    if (state && state.providerProfileId !== providerProfile.id) {
      this.pluginBrowserStates.delete(scopeKey);
      state = null;
    }
    if (!state) {
      const result = await this.fetchPluginsForEvent(event, providerProfile);
      const featured = selectFeaturedPlugins(result.catalog);
      state = {
        providerProfileId: providerProfile.id,
        cwd: result.cwd,
        mode: 'featured',
        categoryKey: null,
        items: featured,
        updatedAt: this.now(),
      };
      this.pluginBrowserStates.set(scopeKey, state);
    }
    const numeric = Number.parseInt(rawToken, 10);
    if (rawToken && Number.isInteger(numeric) && numeric >= 1 && numeric <= state.items.length) {
      return {
        index: numeric,
        cwd: state.cwd,
        plugin: state.items[numeric - 1],
      };
    }
    const result = await this.fetchPluginsForEvent(event, providerProfile);
    const allPlugins = result.allPlugins;
    const resolvedAliases = this.resolveDisplayPluginAliases(event, providerProfile, allPlugins);
    const normalized = normalizePluginLookupToken(rawToken);
    if (!normalized) {
      if (state.items.length === 1) {
        return {
          index: 1,
          cwd: state.cwd,
          plugin: state.items[0],
        };
      }
      return null;
    }
    const normalizedAlias = normalizePluginAliasValue(rawToken);
    const aliasMatch = normalizedAlias
      ? resolvedAliases.find((entry) => entry.alias === normalizedAlias) ?? null
      : null;
    if (aliasMatch) {
      const aliasedPlugin = allPlugins.find((entry) => entry.id === aliasMatch.pluginId) ?? null;
      if (aliasedPlugin) {
        return {
          index: state.items.findIndex((entry) => entry.id === aliasedPlugin.id) + 1 || 0,
          cwd: state.cwd,
          plugin: aliasedPlugin,
        };
      }
    }
    const byExact = allPlugins.find((entry) => {
      const candidates = [
        entry.id,
        entry.name,
        entry.displayName ?? '',
      ];
      return candidates.some((candidate) => normalizePluginLookupToken(candidate) === normalized);
    });
    if (byExact) {
      return {
        index: state.items.findIndex((entry) => entry.id === byExact.id) + 1 || 0,
        cwd: state.cwd,
        plugin: byExact,
      };
    }
    const byPartial = allPlugins.find((entry) => {
      const haystack = [
        entry.id,
        entry.name,
        entry.displayName ?? '',
        entry.shortDescription ?? '',
        entry.longDescription ?? '',
        entry.marketplaceName,
      ].map((candidate) => normalizePluginLookupToken(candidate)).join(' ');
      return haystack.includes(normalized);
    });
    if (!byPartial) {
      return null;
    }
    return {
      index: state.items.findIndex((entry) => entry.id === byPartial.id) + 1 || 0,
      cwd: state.cwd,
      plugin: byPartial,
    };
  }

  async resolveMcpSelection(event, providerProfile, token) {
    const rawToken = String(token ?? '').trim();
    const scopeKey = formatPlatformScopeKey(event.platform, event.externalScopeId);
    let state = this.mcpBrowserStates.get(scopeKey) ?? null;
    if (state && state.providerProfileId !== providerProfile.id) {
      this.mcpBrowserStates.delete(scopeKey);
      state = null;
    }
    if (!state) {
      const items = await this.fetchMcpServersForEvent(event, providerProfile);
      state = {
        providerProfileId: providerProfile.id,
        items,
        updatedAt: this.now(),
      };
      this.mcpBrowserStates.set(scopeKey, state);
    }
    const numeric = Number.parseInt(rawToken, 10);
    if (rawToken && Number.isInteger(numeric) && numeric >= 1 && numeric <= state.items.length) {
      return {
        index: numeric,
        server: state.items[numeric - 1],
      };
    }
    const normalized = normalizeMcpLookupToken(rawToken);
    if (!normalized) {
      if (state.items.length === 1) {
        return {
          index: 1,
          server: state.items[0],
        };
      }
      return null;
    }
    const byExact = state.items.find((entry) => normalizeMcpLookupToken(entry.name) === normalized) ?? null;
    if (byExact) {
      return {
        index: state.items.indexOf(byExact) + 1,
        server: byExact,
      };
    }
    const byPartial = state.items.find((entry) => normalizeMcpLookupToken(entry.name).includes(normalized)) ?? null;
    if (!byPartial) {
      return null;
    }
    return {
      index: state.items.indexOf(byPartial) + 1,
      server: byPartial,
    };
  }

  async rewriteConversationEventForExplicitPluginTarget(event, providerProfile) {
    if (resolveExplicitPluginTargetHints(event).length > 0) {
      return event;
    }
    const parsed = parseConversationPluginInvocation(event?.text ?? '');
    if (!parsed) {
      return this.rewriteConversationEventForInlinePluginMentions(event, providerProfile);
    }
    return (await this.buildExplicitPluginTargetEvent({
      event,
      providerProfile,
      token: parsed.token,
      taskText: parsed.taskText,
      syntax: parsed.syntax,
      aliasOnly: true,
    })) ?? this.rewriteConversationEventForInlinePluginMentions(event, providerProfile);
  }

  async buildExplicitPluginTargetEvent({
    event,
    providerProfile,
    token,
    taskText,
    syntax,
    aliasOnly = false,
  }: {
    event: InboundTextEvent;
    providerProfile: ProviderProfile;
    token: string;
    taskText: string;
    syntax: ExplicitPluginTargetHint['syntax'];
    aliasOnly?: boolean;
  }): Promise<InboundTextEvent | null> {
    const normalizedTaskText = String(taskText ?? '').trim();
    if (!normalizedTaskText) {
      return null;
    }
    const catalog = await this.fetchPluginsForEvent(event, providerProfile);
    const aliases = this.resolveDisplayPluginAliases(event, providerProfile, catalog.allPlugins);
    const hint = resolvePluginTargetHintFromCatalog({
      token,
      allPlugins: catalog.allPlugins,
      aliases,
      syntax,
      aliasOnly,
    });
    if (!hint) {
      return null;
    }
    return withExplicitPluginTargetHints({
      ...event,
      text: normalizedTaskText,
    }, [hint]);
  }

  async rewriteConversationEventForInlinePluginMentions(event, providerProfile) {
    const rawText = String(event?.text ?? '');
    if (!rawText.includes('@')) {
      return event;
    }
    const catalog = await this.fetchPluginsForEvent(event, providerProfile);
    const aliases = this.resolveDisplayPluginAliases(event, providerProfile, catalog.allPlugins);
    const targets: ExplicitPluginTargetHint[] = [];
    const rewritten = rawText.replace(/(^|[^A-Za-z0-9._%+-])@([a-z0-9][a-z0-9_-]{0,31})(?=$|[^A-Za-z0-9._-])/gu, (fullMatch, prefix, token) => {
      const hint = resolvePluginTargetHintFromCatalog({
        token,
        allPlugins: catalog.allPlugins,
        aliases,
        syntax: 'inline_at_alias',
        aliasOnly: true,
      });
      if (!hint) {
        return fullMatch;
      }
      pushUniqueExplicitPluginTarget(targets, hint);
      return `${prefix}${hint.pluginDisplayName || hint.pluginName || hint.alias || token}`;
    });
    if (targets.length === 0) {
      return event;
    }
    return withExplicitPluginTargetHints({
      ...event,
      text: rewritten.replace(/\s{2,}/gu, ' ').trim(),
    }, targets);
  }

  async loadPluginDetailContext(providerProfile, plugin) {
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const detail = await providerPlugin.readPlugin({
      providerProfile,
      pluginName: plugin.name,
      marketplaceName: plugin.marketplaceName,
      marketplacePath: plugin.marketplacePath,
    }) ?? createFallbackPluginDetail(plugin);
    const [apps, mcpServers] = await Promise.all([
      typeof providerPlugin.listApps === 'function'
        ? providerPlugin.listApps({ providerProfile }).catch(() => [])
        : Promise.resolve([]),
      typeof providerPlugin.listMcpServerStatuses === 'function'
        ? providerPlugin.listMcpServerStatuses({ providerProfile }).catch(() => [])
        : Promise.resolve([]),
    ]);
    return {
      detail,
      apps,
      mcpServers,
    };
  }

  async buildExplicitPluginIssueResponse(event, providerProfile) {
    const targets = resolveExplicitPluginTargetHints(event);
    if (targets.length === 0) {
      return null;
    }
    const catalog = await this.fetchPluginsForEvent(event, providerProfile);
    const issues: ExplicitPluginTargetIssue[] = [];
    for (const target of targets) {
      const plugin = catalog.allPlugins.find((entry) => entry.id === target.pluginId) ?? null;
      if (!plugin) {
        continue;
      }
      const issue = await this.inspectExplicitPluginTargetIssue(providerProfile, target, plugin);
      if (issue) {
        issues.push(issue);
      }
    }
    if (issues.length === 0) {
      return null;
    }
    return messageResponse(
      renderExplicitPluginIssueLines({
        issues,
        i18n: this.currentI18n,
      }),
      this.buildScopedSessionMeta(event),
    );
  }

  async inspectExplicitPluginTargetIssue(providerProfile, target, plugin): Promise<ExplicitPluginTargetIssue | null> {
    if (!plugin.installed) {
      return {
        kind: 'plugin_not_installed',
        target,
        plugin,
      };
    }
    const detailContext = await this.loadPluginDetailContext(providerProfile, plugin);
    if (
      hasReadyPluginApp(detailContext.detail, detailContext.apps, plugin)
      || hasReadyPluginMcp(detailContext.detail, detailContext.mcpServers)
    ) {
      return null;
    }
    const appIssue = resolvePluginAppIssue(detailContext.detail, detailContext.apps, target);
    if (appIssue) {
      return {
        ...appIssue,
        plugin,
      };
    }
    const mcpIssue = resolvePluginMcpIssue(detailContext.detail, detailContext.mcpServers, target);
    if (mcpIssue) {
      return {
        ...mcpIssue,
        plugin,
      };
    }
    return null;
  }

  async refreshPluginAfterMutation(event, providerProfile, plugin) {
    await this.refreshPluginBrowserState(event, providerProfile);
    const refreshed = await this.fetchPluginsForEvent(event, providerProfile);
    const refreshedPlugin = findMatchingPluginSummary(refreshed.allPlugins, plugin) ?? plugin;
    const detailContext = await this.loadPluginDetailContext(providerProfile, refreshedPlugin);
    return {
      cwd: refreshed.cwd,
      detail: detailContext.detail,
      apps: detailContext.apps,
      mcpServers: detailContext.mcpServers,
    };
  }

  async refreshPluginBrowserState(event, providerProfile) {
    const scopeKey = formatPlatformScopeKey(event.platform, event.externalScopeId);
    const previous = this.pluginBrowserStates.get(scopeKey) ?? null;
    if (!previous) {
      return;
    }
    if (previous.providerProfileId !== providerProfile.id) {
      this.pluginBrowserStates.delete(scopeKey);
      return;
    }
    const result = await this.fetchPluginsForEvent(event, providerProfile);
    if (previous.mode === 'category' && previous.categoryKey) {
      const details = await this.readPluginDetailsForSummaries(providerProfile, result.allPlugins);
      const buckets = buildPluginCategoryBuckets(details, this.currentI18n);
      const bucket = buckets.find((entry) => entry.key === previous.categoryKey) ?? null;
      if (bucket) {
        this.pluginBrowserStates.set(scopeKey, {
          providerProfileId: providerProfile.id,
          cwd: result.cwd,
          mode: 'category',
          categoryKey: bucket.key,
          items: bucket.items.map((detail) => detail.summary),
          updatedAt: this.now(),
        });
        return;
      }
    }
    if (previous.mode === 'search' && previous.searchTerm) {
      const details = await this.readPluginDetailsForSummaries(providerProfile, result.allPlugins);
      const matches = searchPluginDetails(details, previous.searchTerm);
      const pageCount = Math.max(1, Math.ceil(matches.length / PLUGIN_CATEGORY_PAGE_SIZE));
      const pageNumber = Math.min(previous.pageNumber ?? 1, pageCount);
      const offset = (pageNumber - 1) * PLUGIN_CATEGORY_PAGE_SIZE;
      const pageItems = matches.slice(offset, offset + PLUGIN_CATEGORY_PAGE_SIZE);
      this.pluginBrowserStates.set(scopeKey, {
        providerProfileId: providerProfile.id,
        cwd: result.cwd,
        mode: 'search',
        categoryKey: null,
        searchTerm: previous.searchTerm,
        pageNumber,
        items: pageItems.map((match) => match.detail.summary),
        updatedAt: this.now(),
      });
      return;
    }
    this.pluginBrowserStates.set(scopeKey, {
      providerProfileId: providerProfile.id,
      cwd: result.cwd,
      mode: 'featured',
      categoryKey: null,
      items: selectFeaturedPlugins(result.catalog),
      updatedAt: this.now(),
    });
  }

  resolveScopedSessionMeta(scopeRef) {
    return this.bridgeSessions.resolveScopeSession(scopeRef)
      ? buildSessionMeta(this.bridgeSessions.resolveScopeSession(scopeRef))
      : undefined;
  }

  resolveScopeProviderProfile(scopeRef) {
    const current = this.bridgeSessions.resolveScopeSession(scopeRef);
    const providerProfileId = current?.providerProfileId ?? this.resolveDefaultProviderProfileId();
    return this.requireProviderProfile(providerProfileId);
  }

  resolveSessionForEvent(scopeRef, event) {
    const overrideSessionId = resolveOverrideBridgeSessionId(event);
    if (overrideSessionId) {
      return this.bridgeSessions.getSessionById?.(overrideSessionId) ?? null;
    }
    return this.bridgeSessions.resolveScopeSession(scopeRef);
  }

  async handleAutomationCommand(event, args = []) {
    if (!this.automationJobs) {
      return messageResponse([
        this.t('coordinator.auto.unsupported'),
      ], this.buildScopedSessionMeta(event));
    }
    const scopeRef = toScopeRef(event);
    const normalizedArgs = Array.isArray(args) ? args.map((value) => String(value ?? '').trim()) : [];
    const subcommand = String(normalizedArgs[0] ?? '').trim().toLowerCase();
    if (!subcommand) {
      const pendingDraft = this.getPendingAutomationDraft(scopeRef);
      if (pendingDraft) {
        return this.renderAutomationDraftResponse(event, pendingDraft);
      }
      return this.handleAutomationListCommand(event);
    }
    if (['confirm'].includes(subcommand)) {
      return this.handleAutomationConfirmCommand(event);
    }
    if (['edit'].includes(subcommand)) {
      return this.handleAutomationEditCommand(event);
    }
    if (['cancel'].includes(subcommand)) {
      return this.handleAutomationCancelCommand(event);
    }
    if (['list'].includes(subcommand)) {
      return this.handleAutomationListCommand(event);
    }
    if (['show'].includes(subcommand)) {
      return this.handleAutomationShowCommand(event, normalizedArgs[1] ?? '');
    }
    if (['pause'].includes(subcommand)) {
      return this.handleAutomationPauseCommand(event, normalizedArgs[1] ?? '');
    }
    if (['resume'].includes(subcommand)) {
      return this.handleAutomationResumeCommand(event, normalizedArgs[1] ?? '');
    }
    if (['delete', 'del'].includes(subcommand)) {
      return this.handleAutomationDeleteCommand(event, normalizedArgs[1] ?? '');
    }
    if (['rename'].includes(subcommand)) {
      return this.handleAutomationRenameCommand(event, normalizedArgs[1] ?? '', extractAutomationRenameTitle(event.text));
    }
    if (['add'].includes(subcommand)) {
      return this.handleAutomationAddCommand(event);
    }
    return this.handleHelpsCommand(event, ['automation']);
  }

  async handleWeiboCommand(event, args = []) {
    if (!this.weiboHotSearch) {
      return messageResponse([
        this.t('coordinator.weibo.unsupported'),
      ], this.buildScopedSessionMeta(event));
    }
    const parsed = parseWeiboCommandArgs(args);
    if (!parsed) {
      return this.handleHelpsCommand(event, ['weibo']);
    }
    try {
      const snapshot = await this.weiboHotSearch.getTop({ limit: parsed.limit });
      const lines = [
        this.t('coordinator.weibo.title', {
          count: snapshot.items.length,
          fetchedAt: formatCommandTimestamp(snapshot.fetchedAt, this.currentI18n.locale),
        }),
      ];
      for (const item of snapshot.items) {
        lines.push(formatWeiboHotSearchLine(item, this.currentI18n));
      }
      return messageResponse(lines, this.buildScopedSessionMeta(event));
    } catch (error) {
      return messageResponse([
        this.t('coordinator.weibo.failed', { error: formatErrorMessage(error) }),
      ], this.buildScopedSessionMeta(event));
    }
  }

  handleAutomationListCommand(event) {
    const scopeRef = toScopeRef(event);
    const jobs = this.automationJobs.listForScope(scopeRef);
    if (jobs.length === 0) {
      return messageResponse([
        this.t('coordinator.auto.listTitle', { count: 0 }),
        this.t('coordinator.auto.empty'),
        this.t('coordinator.auto.emptyHint'),
      ], this.buildScopedSessionMeta(event));
    }
    const lines = [
      this.t('coordinator.auto.listTitle', { count: jobs.length }),
    ];
    for (const [index, job] of jobs.entries()) {
      lines.push(this.t('coordinator.auto.item', {
        index: index + 1,
        title: job.title,
      }));
      lines.push(this.t('coordinator.auto.mode', {
        value: formatAutomationMode(job.mode, this.currentI18n),
      }));
      lines.push(this.t('coordinator.auto.schedule', { value: job.schedule.label }));
      lines.push(this.t('coordinator.auto.status', {
        value: formatAutomationStatusLabel(job.status, job.running, this.currentI18n),
      }));
      lines.push(this.t('coordinator.auto.nextRun', {
        value: formatRelativeTimeLocalized(job.nextRunAt, this.currentI18n.locale, this.now()),
      }));
    }
    lines.push(this.t('coordinator.auto.actionsHint'));
    return messageResponse(lines, this.buildScopedSessionMeta(event));
  }

  handleAutomationShowCommand(event, token) {
    const normalizedToken = String(token ?? '').trim();
    let resolved = this.resolveAutomationJobForScope(event, normalizedToken);
    if (!resolved && !normalizedToken) {
      const scopeRef = toScopeRef(event);
      const jobs = this.automationJobs.listForScope(scopeRef);
      if (jobs.length === 1) {
        resolved = {
          job: jobs[0],
          index: 1,
        };
      } else if (jobs.length > 1) {
        return messageResponse([
          this.t('coordinator.auto.specifyIndex'),
        ], this.buildScopedSessionMeta(event));
      }
    }
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.auto.notFound', { value: normalizedToken || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    const job = resolved.job;
    const lines = [
      this.t('coordinator.auto.detailTitle', { title: job.title }),
      this.t('coordinator.auto.mode', { value: formatAutomationMode(job.mode, this.currentI18n) }),
      this.t('coordinator.auto.schedule', { value: job.schedule.label }),
      this.t('coordinator.auto.status', { value: formatAutomationStatusLabel(job.status, job.running, this.currentI18n) }),
      this.t('coordinator.auto.providerProfile', { value: job.providerProfileId }),
      this.t('coordinator.auto.workingDirectory', { value: job.cwd ?? this.t('common.notSet') }),
      this.t('coordinator.auto.prompt', { value: job.prompt }),
      this.t('coordinator.auto.nextRun', { value: formatRelativeTimeLocalized(job.nextRunAt, this.currentI18n.locale, this.now()) }),
      this.t('coordinator.auto.lastRun', {
        value: job.lastRunAt ? formatRelativeTimeLocalized(job.lastRunAt, this.currentI18n.locale, this.now()) : this.t('common.none'),
      }),
    ];
    if (job.lastResultPreview) {
      lines.push(this.t('coordinator.auto.lastResult', { value: job.lastResultPreview }));
    }
    if (job.lastError) {
      lines.push(this.t('coordinator.auto.lastError', { value: job.lastError }));
    }
    lines.push(this.t('coordinator.auto.detailActions', { index: resolved.index }));
    return messageResponse(lines, this.buildScopedSessionMeta(event));
  }

  handleAutomationPauseCommand(event, token) {
    const resolved = this.resolveAutomationJobForScope(event, token);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.auto.notFound', { value: token || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    const job = this.automationJobs.pauseJob(resolved.job.id);
    return messageResponse([
      this.t('coordinator.auto.paused'),
      this.t('coordinator.auto.title', { value: job.title }),
    ], this.buildScopedSessionMeta(event));
  }

  handleAutomationResumeCommand(event, token) {
    const resolved = this.resolveAutomationJobForScope(event, token);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.auto.notFound', { value: token || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    const job = this.automationJobs.resumeJob(resolved.job.id);
    return messageResponse([
      this.t('coordinator.auto.resumed'),
      this.t('coordinator.auto.title', { value: job.title }),
      this.t('coordinator.auto.nextRun', {
        value: formatRelativeTimeLocalized(job.nextRunAt, this.currentI18n.locale, this.now()),
      }),
    ], this.buildScopedSessionMeta(event));
  }

  handleAutomationDeleteCommand(event, token) {
    const resolved = this.resolveAutomationJobForScope(event, token);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.auto.notFound', { value: token || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    this.automationJobs.deleteJob(resolved.job.id);
    return messageResponse([
      this.t('coordinator.auto.deleted'),
      this.t('coordinator.auto.title', { value: resolved.job.title }),
    ], this.buildScopedSessionMeta(event));
  }

  handleAutomationRenameCommand(event, token, title) {
    const resolved = this.resolveAutomationJobForScope(event, token);
    if (!resolved) {
      return messageResponse([
        this.t('coordinator.auto.notFound', { value: token || '?' }),
      ], this.buildScopedSessionMeta(event));
    }
    if (!title) {
      return this.handleHelpsCommand(event, ['automation']);
    }
    const job = this.automationJobs.renameJob(resolved.job.id, title);
    return messageResponse([
      this.t('coordinator.auto.renamed'),
      this.t('coordinator.auto.title', { value: job.title }),
    ], this.buildScopedSessionMeta(event));
  }

  async handleAutomationAddCommand(event) {
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'automation');
    if (activeResponse) {
      return activeResponse;
    }
    const scopeRef = toScopeRef(event);
    const rawInput = extractAutomationAddBody(event.text);
    if (!rawInput) {
      return this.handleHelpsCommand(event, ['automation']);
    }
    let draft = await this.normalizeAutomationDraftFromNaturalLanguage(event, scopeRef, rawInput);
    if (!draft) {
      const parsed = parseAutomationAddSpec(event.text);
      draft = parsed ? this.buildPendingAutomationDraft(event, scopeRef, parsed, rawInput, 'explicit') : null;
    }
    if (draft?.mode === 'thread' && !this.bridgeSessions.resolveScopeSession(scopeRef)) {
      return messageResponse([
        this.t('coordinator.auto.threadModeNeedsSession'),
      ], this.buildScopedSessionMeta(event));
    }
    if (!draft) {
      return messageResponse([
        this.t('coordinator.auto.parseFailed'),
      ], this.buildScopedSessionMeta(event));
    }
    this.setPendingAutomationDraft(scopeRef, draft);
    return this.renderAutomationDraftResponse(event, draft);
  }

  async handleAutomationConfirmCommand(event) {
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'automation');
    if (activeResponse) {
      return activeResponse;
    }
    const scopeRef = toScopeRef(event);
    const draft = this.getPendingAutomationDraft(scopeRef);
    if (!draft) {
      return messageResponse([
        this.t('coordinator.auto.noDraft'),
      ], this.buildScopedSessionMeta(event));
    }
    let threadTargetSession = null;
    if (draft.mode === 'thread') {
      threadTargetSession = draft.threadBridgeSessionId
        ? this.bridgeSessions.getSessionById?.(draft.threadBridgeSessionId) ?? null
        : null;
      if (!threadTargetSession) {
        this.clearPendingAutomationDraft(scopeRef);
        return messageResponse([
          this.t('coordinator.auto.threadModeNeedsSession'),
        ], this.buildScopedSessionMeta(event));
      }
    }
    const schedules = getAutomationDraftSchedules(draft);
    const jobs = [];
    for (const schedule of schedules) {
      const targetSession = draft.mode === 'thread'
        ? threadTargetSession
        : await this.bridgeSessions.createDetachedSession({
          providerProfileId: draft.providerProfileId,
          cwd: draft.cwd,
          title: schedules.length > 1
            ? `Automation | ${draft.title} | ${schedule.label}`
            : `Automation | ${draft.title}`,
          initialSettings: {
            ...draft.initialSettings,
          },
          providerStartOptions: {
            sourcePlatform: event.platform,
            source: 'automation',
          },
        });
      const jobTitle = schedules.length > 1
        ? `${draft.title} (${schedule.label})`
        : draft.title;
      jobs.push(this.automationJobs.createJob({
        scopeRef,
        title: jobTitle,
        mode: draft.mode,
        providerProfileId: draft.providerProfileId,
        bridgeSessionId: targetSession.id,
        cwd: draft.cwd,
        prompt: draft.prompt,
        locale: draft.locale,
        schedule,
      }));
    }
    this.clearPendingAutomationDraft(scopeRef);
    const firstJob = jobs[0];
    return messageResponse([
      jobs.length > 1
        ? this.t('coordinator.auto.addedMultiple', { count: jobs.length })
        : this.t('coordinator.auto.added'),
      this.t('coordinator.auto.title', { value: draft.title }),
      this.t('coordinator.auto.mode', { value: formatAutomationMode(draft.mode, this.currentI18n) }),
      this.t('coordinator.auto.schedule', { value: formatAutomationDraftSchedules(draft) }),
      this.t('coordinator.auto.nextRun', {
        value: firstJob ? formatRelativeTimeLocalized(firstJob.nextRunAt, this.currentI18n.locale, this.now()) : this.t('common.none'),
      }),
      this.t('coordinator.auto.deliveryTarget'),
    ], this.buildScopedSessionMeta(event));
  }

  async handleAutomationEditCommand(event) {
    const activeResponse = await this.rejectIfActiveTurnForCommand(event, 'automation');
    if (activeResponse) {
      return activeResponse;
    }
    const instruction = extractAutomationEditBody(event.text);
    if (!instruction) {
      return this.handleHelpsCommand(event, ['automation']);
    }
    const scopeRef = toScopeRef(event);
    const draft = this.getPendingAutomationDraft(scopeRef);
    if (!draft) {
      return messageResponse([
        this.t('coordinator.auto.noDraft'),
      ], this.buildScopedSessionMeta(event));
    }
    const updatedDraft = await this.normalizeAutomationDraftEdit(event, scopeRef, draft, instruction);
    if (updatedDraft?.mode === 'thread' && !updatedDraft.threadBridgeSessionId) {
      return messageResponse([
        this.t('coordinator.auto.threadModeNeedsSession'),
      ], this.buildScopedSessionMeta(event));
    }
    if (!updatedDraft) {
      return messageResponse([
        this.t('coordinator.auto.parseFailed'),
      ], this.buildScopedSessionMeta(event));
    }
    this.setPendingAutomationDraft(scopeRef, updatedDraft);
    return this.renderAutomationDraftResponse(event, updatedDraft);
  }

  handleAutomationCancelCommand(event) {
    const scopeRef = toScopeRef(event);
    const draft = this.getPendingAutomationDraft(scopeRef);
    if (!draft) {
      return messageResponse([
        this.t('coordinator.auto.noDraft'),
      ], this.buildScopedSessionMeta(event));
    }
    this.clearPendingAutomationDraft(scopeRef);
    return messageResponse([
      this.t('coordinator.auto.draftCancelled'),
    ], this.buildScopedSessionMeta(event));
  }

  renderAutomationDraftResponse(event, draft: PendingAutomationDraft) {
    return messageResponse([
      this.t('coordinator.auto.draftTitle', { title: draft.title }),
      this.t('coordinator.auto.mode', { value: formatAutomationMode(draft.mode, this.currentI18n) }),
      this.t('coordinator.auto.schedule', { value: formatAutomationDraftSchedules(draft) }),
      this.t('coordinator.auto.prompt', { value: draft.prompt }),
      this.t('coordinator.auto.deliveryTarget'),
      this.t('coordinator.auto.draftNotice'),
      this.t('coordinator.auto.confirmHint'),
      this.t('coordinator.auto.editHint'),
      this.t('coordinator.auto.cancelHint'),
    ], this.buildScopedSessionMeta(event));
  }

  buildPendingAutomationDraft(
    event,
    scopeRef: PlatformScopeRef,
    candidate: AutomationDraftCandidate,
    rawInput: string,
    normalizedBy: 'explicit' | 'codex' | 'agents-sdk',
  ): PendingAutomationDraft | null {
    const boundSession = this.bridgeSessions.resolveScopeSession(scopeRef);
    const providerProfile = boundSession
      ? this.requireProviderProfile(boundSession.providerProfileId)
      : this.resolveScopeProviderProfile(scopeRef);
    const schedules = getAutomationCandidateSchedules(candidate);
    if (schedules.length === 0) {
      return null;
    }
    const inheritedSettings = boundSession
      ? this.bridgeSessions.getSessionSettings(boundSession.id)
      : null;
    const locale = inheritedSettings?.locale ?? this.resolveScopeLocale(scopeRef, event);
    const cwd = normalizeCwd(boundSession?.cwd) ?? this.resolveEventCwd(event) ?? null;
    return {
      createdAt: this.now(),
      rawInput,
      normalizedBy,
      title: candidate.title,
      mode: candidate.mode,
      schedule: cloneAutomationSchedule(schedules[0]),
      schedules: schedules.map((schedule) => cloneAutomationSchedule(schedule)),
      prompt: candidate.prompt,
      providerProfileId: providerProfile.id,
      locale,
      cwd,
      initialSettings: {
        locale,
        model: inheritedSettings?.model ?? null,
        reasoningEffort: inheritedSettings?.reasoningEffort ?? null,
        serviceTier: inheritedSettings?.serviceTier ?? null,
        personality: inheritedSettings?.personality ?? null,
        accessPreset: inheritedSettings?.accessPreset ?? null,
        approvalPolicy: inheritedSettings?.approvalPolicy ?? null,
        sandboxMode: inheritedSettings?.sandboxMode ?? null,
      },
      threadBridgeSessionId: candidate.mode === 'thread' ? boundSession?.id ?? null : null,
    };
  }

  async normalizeAutomationDraftFromNaturalLanguage(event, scopeRef: PlatformScopeRef, rawInput: string): Promise<PendingAutomationDraft | null> {
    const boundSession = this.bridgeSessions.resolveScopeSession(scopeRef);
    const providerProfile = boundSession
      ? this.requireProviderProfile(boundSession.providerProfileId)
      : this.resolveScopeProviderProfile(scopeRef);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (!providerPlugin || typeof providerPlugin.startThread !== 'function' || typeof providerPlugin.startTurn !== 'function') {
      const agentsCandidate = await normalizeAutomationDraftWithOpenAIAgents(rawInput, this.resolveScopeLocale(scopeRef, event)).catch(() => null);
      return agentsCandidate ? this.buildPendingAutomationDraft(event, scopeRef, agentsCandidate, rawInput, 'agents-sdk') : null;
    }
    const inheritedSettings = boundSession
      ? this.bridgeSessions.getSessionSettings(boundSession.id)
      : null;
    const locale = inheritedSettings?.locale ?? this.resolveScopeLocale(scopeRef, event);
    const cwd = normalizeCwd(boundSession?.cwd) ?? this.resolveEventCwd(event) ?? null;
    const thread = await providerPlugin.startThread({
      providerProfile,
      cwd,
      title: 'Automation Draft Parser',
      metadata: {
        sourcePlatform: event.platform,
        source: 'automation-draft',
      },
    });
    const parserSession = {
      id: crypto.randomUUID(),
      providerProfileId: providerProfile.id,
      codexThreadId: thread.threadId,
      cwd: thread.cwd ?? cwd,
      title: thread.title ?? 'Automation Draft Parser',
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    const parserPrompt = buildAutomationDraftPrompt(rawInput, locale);
    const parserEvent = {
      ...event,
      text: parserPrompt,
      cwd: parserSession.cwd ?? null,
      locale,
      attachments: [],
    };
    const result = await providerPlugin.startTurn({
      providerProfile,
      bridgeSession: parserSession,
      sessionSettings: {
        bridgeSessionId: parserSession.id,
        model: inheritedSettings?.model ?? null,
        reasoningEffort: inheritedSettings?.reasoningEffort ?? null,
        serviceTier: inheritedSettings?.serviceTier ?? null,
        personality: null,
        accessPreset: 'read-only',
        approvalPolicy: 'never',
        sandboxMode: 'read-only',
        locale,
        metadata: {},
        updatedAt: this.now(),
      },
      event: parserEvent,
      inputText: parserPrompt,
    });
    const candidate = parseAutomationDraftCandidate(result.outputText);
    if (candidate) {
      return this.buildPendingAutomationDraft(event, scopeRef, candidate, rawInput, 'codex');
    }
    const agentsCandidate = await normalizeAutomationDraftWithOpenAIAgents(rawInput, locale).catch(() => null);
    return agentsCandidate ? this.buildPendingAutomationDraft(event, scopeRef, agentsCandidate, rawInput, 'agents-sdk') : null;
  }

  async normalizeAutomationDraftEdit(
    event,
    scopeRef: PlatformScopeRef,
    draft: PendingAutomationDraft,
    instruction: string,
  ): Promise<PendingAutomationDraft | null> {
    const locale = draft.locale ?? this.resolveScopeLocale(scopeRef, event);
    const providerProfile = this.requireProviderProfile(draft.providerProfileId);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const prompt = buildAutomationDraftEditPrompt(draft, instruction, normalizeLocale(locale) ?? 'zh-CN');
    if (providerPlugin && typeof providerPlugin.startThread === 'function' && typeof providerPlugin.startTurn === 'function') {
      const thread = await providerPlugin.startThread({
        providerProfile,
        cwd: draft.cwd,
        title: 'Automation Draft Editor',
        metadata: {
          sourcePlatform: event.platform,
          source: 'automation-draft-editor',
        },
      });
      const parserSession = {
        id: crypto.randomUUID(),
        providerProfileId: providerProfile.id,
        codexThreadId: thread.threadId,
        cwd: thread.cwd ?? draft.cwd,
        title: thread.title ?? 'Automation Draft Editor',
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      const result = await providerPlugin.startTurn({
        providerProfile,
        bridgeSession: parserSession,
        sessionSettings: {
          bridgeSessionId: parserSession.id,
          model: draft.initialSettings.model ?? null,
          reasoningEffort: draft.initialSettings.reasoningEffort ?? null,
          serviceTier: draft.initialSettings.serviceTier ?? null,
          collaborationMode: null,
          personality: null,
          accessPreset: 'read-only',
          approvalPolicy: 'never',
          sandboxMode: 'read-only',
          locale,
          metadata: {},
          updatedAt: this.now(),
        },
        event: {
          ...event,
          text: prompt,
          cwd: parserSession.cwd ?? null,
          locale,
          attachments: [],
        },
        inputText: prompt,
      });
      const candidate = parseAutomationDraftCandidate(result.outputText);
      if (candidate) {
        return this.buildEditedPendingAutomationDraft(draft, instruction, candidate, 'codex');
      }
    }
    const agentsCandidate = await normalizeAutomationDraftEditWithOpenAIAgents(draft, instruction, locale).catch(() => null);
    return agentsCandidate ? this.buildEditedPendingAutomationDraft(draft, instruction, agentsCandidate, 'agents-sdk') : null;
  }

  buildEditedPendingAutomationDraft(
    draft: PendingAutomationDraft,
    instruction: string,
    candidate: AutomationDraftCandidate,
    normalizedBy: 'codex' | 'agents-sdk',
  ): PendingAutomationDraft | null {
    const schedules = getAutomationCandidateSchedules(candidate);
    if (schedules.length === 0) {
      return null;
    }
    return {
      ...draft,
      createdAt: this.now(),
      rawInput: appendAutomationDraftEditInput(draft.rawInput, instruction),
      normalizedBy,
      title: candidate.title,
      mode: candidate.mode,
      schedule: cloneAutomationSchedule(schedules[0]),
      schedules: schedules.map((schedule) => cloneAutomationSchedule(schedule)),
      prompt: candidate.prompt,
      threadBridgeSessionId: candidate.mode === 'thread' ? draft.threadBridgeSessionId : null,
    };
  }

  resolveAutomationJobForScope(event, token) {
    const scopeRef = toScopeRef(event);
    const job = this.automationJobs.resolveForScope(scopeRef, token);
    if (!job) {
      return null;
    }
    const jobs = this.automationJobs.listForScope(scopeRef);
    const index = jobs.findIndex((entry) => entry.id === job.id);
    return {
      job,
      index: index >= 0 ? index + 1 : null,
    };
  }

  renderModelLines(models) {
    return models.map((model) => {
      const modelId = String(model.model ?? model.id ?? '').trim();
      const displayName = String(model.displayName ?? '').trim();
      const reasonings = Array.isArray(model.supportedReasoningEfforts) && model.supportedReasoningEfforts.length > 0
        ? ` (${model.supportedReasoningEfforts.join(', ')})`
        : '';
      const description = this.resolveModelDescription(model, modelId);
      const defaultMarker = model.isDefault ? ` ${this.t('coordinator.models.defaultSuffix')}` : '';
      if (!displayName || displayName === modelId) {
        return `- ${modelId}${defaultMarker}${reasonings}${description ? ` - ${description}` : ''}`;
      }
      return `- ${modelId}${defaultMarker} ${displayName}${reasonings}${description ? ` - ${description}` : ''}`;
    });
  }

  resolveModelDescription(model, modelId) {
    const resolvedModelId = String(modelId ?? model?.model ?? model?.id ?? '').trim();
    if (!resolvedModelId) {
      return String(model?.description ?? '').trim();
    }
    const key = `coordinator.models.description.${resolvedModelId}`;
    const localized = this.t(key);
    if (localized === key) {
      return String(model?.description ?? '').trim();
    }
    return localized;
  }

  async resolveProviderUsage(providerProfile) {
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (typeof providerPlugin?.getUsage !== 'function') {
      return null;
    }
    try {
      return await providerPlugin.getUsage({
        providerProfile,
      });
    } catch {
      return null;
    }
  }

  renderUsageSummaryLines(report) {
    if (!report) {
      return [];
    }
    const [primaryWindow, weeklyWindow] = selectUsageWindows(report);
    return [
      this.t('coordinator.status.account', { value: this.formatUsageAccount(report) }),
      this.t('coordinator.status.usage5h', { value: this.formatUsageWindowValue(primaryWindow) }),
      this.t('coordinator.status.usageWeek', { value: this.formatUsageWindowValue(weeklyWindow) }),
    ];
  }

  renderUsageDetailLines(report) {
    return this.renderUsageSummaryLines(report);
  }

  async reconcileActiveTurn(scopeRef) {
    const activeTurn = this.activeTurns?.resolveScopeTurn(scopeRef) ?? null;
    if (!activeTurn) {
      return null;
    }
    if (!activeTurn.providerProfileId || !activeTurn.threadId || !activeTurn.turnId) {
      return activeTurn;
    }
    try {
      const providerProfile = this.requireProviderProfile(activeTurn.providerProfileId);
      const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
      if (typeof providerPlugin?.readThread !== 'function') {
        return activeTurn;
      }
      const thread = await providerPlugin.readThread({
        providerProfile,
        threadId: activeTurn.threadId,
        includeTurns: true,
      });
      const threadTurns = Array.isArray(thread?.turns) ? thread.turns : [];
      const turn = threadTurns.find((entry) => entry.id === activeTurn.turnId) ?? null;
      if (turn && isProviderTurnTerminal(turn.status)) {
        this.activeTurns?.endScopeTurn(scopeRef);
        return null;
      }
      if (!turn) {
        const pendingTurnIds = Array.isArray(activeTurn.pendingApprovals)
          ? activeTurn.pendingApprovals
            .map((entry) => String(entry?.turnId ?? '').trim())
            .filter(Boolean)
          : [];
        const runningTurns = threadTurns.filter((entry) => !isProviderTurnTerminal(entry?.status));
        const reboundTurn = runningTurns.find((entry) => pendingTurnIds.includes(String(entry?.id ?? '').trim()))
          ?? (runningTurns.length === 1 ? runningTurns[0] : null);
        if (reboundTurn?.id) {
          const updated = this.activeTurns?.updateScopeTurn(scopeRef, {
            turnId: reboundTurn.id,
            interruptDispatched: false,
          }) ?? null;
          debugCoordinator('active_turn_rebound', {
            platform: scopeRef.platform,
            scopeId: scopeRef.externalScopeId,
            previousTurnId: activeTurn.turnId,
            reboundTurnId: reboundTurn.id,
          });
          return updated ?? activeTurn;
        }
        if (runningTurns.length === 0 && !hasPendingApproval(activeTurn)) {
          this.activeTurns?.endScopeTurn(scopeRef);
          return null;
        }
      }
    } catch {
      return activeTurn;
    }
    return this.activeTurns?.resolveScopeTurn(scopeRef) ?? null;
  }

  async releaseActiveTurnIfStillRunning(scopeRef) {
    const activeTurn = await this.reconcileActiveTurn(scopeRef);
    if (!activeTurn) {
      return;
    }
    if (activeTurn.turnId || hasPendingApproval(activeTurn)) {
      return;
    }
    this.activeTurns?.endScopeTurn(scopeRef);
  }

  async resolveStatusModelValue(providerProfile, settings) {
    if (typeof settings?.model === 'string' && settings.model.trim()) {
      return settings.model.trim();
    }
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (typeof providerPlugin?.listModels === 'function') {
      try {
        const models = await providerPlugin.listModels({
          providerProfile,
        });
        const defaultModel = models.find((model) => model?.isDefault)
          ?? models[0]
          ?? null;
        const modelValue = String(defaultModel?.model ?? defaultModel?.id ?? '').trim();
        if (modelValue) {
          return modelValue;
        }
      } catch {
        // Ignore provider model lookup failures in status output.
      }
    }
    return this.t('common.default');
  }

  formatUsageAccount(report) {
    const base = String(
      report?.email
      ?? report?.accountId
      ?? report?.userId
      ?? this.t('common.unknown'),
    ).trim() || this.t('common.unknown');
    const plan = typeof report?.plan === 'string' && report.plan.trim()
      ? report.plan.trim()
      : null;
    return plan ? `${base} (${plan})` : base;
  }

  formatUsageWindowValue(window) {
    if (!window) {
      return this.t('common.unknown');
    }
    const usedPercent = Number(window.usedPercent ?? 0);
    const remaining = Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
    const value = `${remaining}%`;
    const reset = this.formatUsageResetPhrase(window.resetAfterSeconds ?? 0);
    if (!reset) {
      return value;
    }
    return this.t('coordinator.usage.remainingWithReset', { value, reset });
  }

  formatUsageResetPhrase(seconds) {
    const numericSeconds = Math.max(0, Math.floor(Number(seconds ?? 0)));
    if (numericSeconds <= 0) {
      return this.t('coordinator.usage.resetSoon');
    }
    return this.t('coordinator.usage.resetIn', {
      value: this.formatUsageDuration(numericSeconds),
    });
  }

  formatUsageDuration(seconds) {
    const locale = this.currentI18n.locale;
    const totalSeconds = Math.max(0, Math.floor(Number(seconds ?? 0)));
    const days = Math.floor(totalSeconds / 86_400);
    const hours = Math.floor((totalSeconds % 86_400) / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const parts = [];
    if (days > 0) {
      parts.push(locale === 'zh-CN' ? `${days} 天` : `${days}d`);
    }
    if (hours > 0) {
      parts.push(locale === 'zh-CN' ? `${hours} 小时` : `${hours}h`);
    }
    if (minutes > 0 && parts.length < 2) {
      parts.push(locale === 'zh-CN' ? `${minutes} 分钟` : `${minutes}m`);
    }
    if (parts.length === 0) {
      parts.push(locale === 'zh-CN' ? '1 分钟' : '1m');
    }
    return parts.slice(0, 2).join(' ');
  }

  buildActiveTurnBlockedResponse(event, activeTurn) {
    if (hasPendingApproval(activeTurn)) {
      return messageResponse([
        this.t('coordinator.allow.pending'),
        this.t('coordinator.allow.pendingHint'),
      ], buildActiveTurnMeta(activeTurn) ?? this.buildScopedSessionMeta(event));
    }
    return messageResponse([
      this.t('coordinator.blocked.active'),
      activeTurn.interruptRequested
        ? this.t('coordinator.blocked.interruptRequested')
        : this.t('coordinator.blocked.waitOrStop'),
    ], buildActiveTurnMeta(activeTurn) ?? this.buildScopedSessionMeta(event));
  }

  async rejectIfActiveTurnForCommand(event, commandName = 'generic') {
    const activeTurn = await this.reconcileActiveTurn(toScopeRef(event));
    if (!activeTurn) {
      return null;
    }
    if (hasPendingApproval(activeTurn)) {
      return messageResponse([
        this.t('coordinator.allow.pendingForAction', {
          action: renderCommandBlockedMessage(commandName, activeTurn.interruptRequested, this.currentI18n),
        }),
        this.t('coordinator.allow.pendingHint'),
      ], buildActiveTurnMeta(activeTurn) ?? this.buildScopedSessionMeta(event));
    }
    return messageResponse([
      renderCommandBlockedMessage(commandName, activeTurn.interruptRequested, this.currentI18n),
    ], buildActiveTurnMeta(activeTurn) ?? this.buildScopedSessionMeta(event));
  }

  getThreadBrowserState(event) {
    return this.threadBrowserStates.get(buildThreadBrowserKey(event)) ?? null;
  }

  setThreadBrowserState(event, state) {
    this.threadBrowserStates.set(buildThreadBrowserKey(event), state);
  }

  patchThreadBrowserTitle(event, providerProfileId, threadId, title) {
    const state = this.getThreadBrowserState(event);
    if (!state || state.providerProfileId !== providerProfileId) {
      return;
    }
    state.items = state.items.map((item) => (
      item.threadId === threadId
        ? { ...item, title }
        : item
    ));
    state.updatedAt = this.now();
  }

  patchThreadBrowserArchiveStatus(event, providerProfileId, threadId, archived) {
    const state = this.getThreadBrowserState(event);
    if (!state || state.providerProfileId !== providerProfileId) {
      return;
    }
    if (archived && !state.includeArchived) {
      state.items = state.items.filter((item) => item.threadId !== threadId);
      state.updatedAt = this.now();
      return;
    }
    state.items = state.items.map((item) => (
      item.threadId === threadId
        ? { ...item, archivedAt: archived ? this.now() : null }
        : item
    ));
    state.updatedAt = this.now();
  }

  patchThreadBrowserPinStatus(event, providerProfileId, threadId, pinned) {
    const state = this.getThreadBrowserState(event);
    if (!state || state.providerProfileId !== providerProfileId) {
      return;
    }
    if (!pinned && state.onlyPinned) {
      state.items = state.items.filter((item) => item.threadId !== threadId);
      state.updatedAt = this.now();
      return;
    }
    state.items = state.items.map((item) => (
      item.threadId === threadId
        ? { ...item, pinnedAt: pinned ? this.now() : null }
        : item
    ));
    state.items.sort((left, right) => {
      const leftPinned = typeof left.pinnedAt === 'number';
      const rightPinned = typeof right.pinnedAt === 'number';
      if (leftPinned && !rightPinned) {
        return -1;
      }
      if (!leftPinned && rightPinned) {
        return 1;
      }
      const leftUpdatedAt = Number(left.updatedAt ?? 0);
      const rightUpdatedAt = Number(right.updatedAt ?? 0);
      if (leftUpdatedAt !== rightUpdatedAt) {
        return rightUpdatedAt - leftUpdatedAt;
      }
      return String(left.threadId).localeCompare(String(right.threadId));
    });
    state.updatedAt = this.now();
  }

  resolveRequestedThread(event, requested, options: { stateOverride?: any } = {}) {
    const value = String(requested ?? '').trim();
    if (!value) {
      return {
        ok: false,
        message: this.t('coordinator.thread.requestTarget'),
      };
    }
    const state = options.stateOverride ?? this.getThreadBrowserState(event);
    if (/^\d+$/u.test(value)) {
      if (!state) {
        return {
          ok: false,
          message: this.t('coordinator.thread.noContext'),
        };
      }
      const index = Number(value);
      const item = state.items[index - 1] ?? null;
      if (!item) {
        return {
          ok: false,
          message: this.t('coordinator.thread.noSuchIndex', { index }),
        };
      }
      return {
        ok: true,
        providerProfileId: state.providerProfileId,
        threadId: item.threadId,
        archivedAt: typeof item.archivedAt === 'number' ? item.archivedAt : null,
        pinnedAt: typeof item.pinnedAt === 'number' ? item.pinnedAt : null,
      };
    }
    const scopeRef = toScopeRef(event);
    const current = this.bridgeSessions.resolveScopeSession(scopeRef);
    const providerProfileId = state?.providerProfileId ?? current?.providerProfileId ?? this.resolveDefaultProviderProfileId();
    const metadata = this.bridgeSessions.getThreadMetadata(providerProfileId, value);
    return {
      ok: true,
      providerProfileId,
      threadId: value,
      archivedAt: typeof metadata?.archivedAt === 'number' ? metadata.archivedAt : null,
      pinnedAt: typeof metadata?.pinnedAt === 'number' ? metadata.pinnedAt : null,
    };
  }

  resolveRequestedThreads(event, requestedValues) {
    const state = this.getThreadBrowserState(event);
    const stateSnapshot = state
      ? {
        ...state,
        items: [...state.items],
      }
      : null;
    return requestedValues.map((requested) => this.resolveRequestedThread(event, requested, { stateOverride: stateSnapshot }));
  }

  resolveDefaultProviderProfileId() {
    if (this.defaultProviderProfileId) {
      return this.defaultProviderProfileId;
    }
    const first = this.providerProfiles.list()[0] ?? null;
    if (!first) {
      throw new NotFoundError(this.t('coordinator.provider.noneConfigured'));
    }
    return first.id;
  }

  requireProviderProfile(providerProfileId) {
    const profile = this.providerProfiles.get(providerProfileId);
    if (!profile) {
      throw new NotFoundError(this.t('coordinator.provider.unknownProfile', { id: providerProfileId }));
    }
    return profile;
  }

  resolveProviderProfile(value) {
    const normalized = value.trim().toLowerCase();
    return this.providerProfiles.list().find((profile) =>
      profile.id.toLowerCase() === normalized
      || profile.displayName.toLowerCase() === normalized
      || profile.providerKind.toLowerCase() === normalized,
    ) ?? null;
  }

  resolveEventCwd(event) {
    return normalizeCwd(event.cwd) ?? this.defaultCwd ?? null;
  }

  async readThreadForSession(session) {
    const providerProfile = this.requireProviderProfile(session.providerProfileId);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const thread = await providerPlugin.readThread({
      providerProfile,
      threadId: session.codexThreadId,
      includeTurns: true,
    });
    return {
      providerProfile,
      providerPlugin,
      thread,
    };
  }

  async waitForThreadToStop(scopeRef, session, waitForSettleMs = 10_000) {
    const deadline = this.now() + Math.max(0, waitForSettleMs);
    while (this.now() < deadline) {
      const active = await this.reconcileActiveTurn(scopeRef);
      let runningTurns = [];
      try {
        const snapshot = await this.readThreadForSession(session);
        runningTurns = Array.isArray(snapshot.thread?.turns)
          ? snapshot.thread.turns.filter((entry) => !isProviderTurnTerminal(entry?.status))
          : [];
      } catch {
        if (!active) {
          return true;
        }
      }
      if (runningTurns.length === 0 && !active) {
        return true;
      }
      await sleep(250);
    }
    return (await this.reconcileActiveTurn(scopeRef)) === null;
  }

  async stopThreadForSession(
    scopeRef,
    session,
    {
      waitForSettleMs = 0,
    }: {
      waitForSettleMs?: number;
    } = {},
  ) {
    const active = await this.reconcileActiveTurn(scopeRef);
    const pendingApprovalCount = Array.isArray(active?.pendingApprovals) ? active.pendingApprovals.length : 0;
    const requestedWhileStarting = Boolean(active && !active.turnId);
    if (active && !active.interruptRequested) {
      this.activeTurns?.requestInterrupt(scopeRef);
    }
    if (pendingApprovalCount > 0) {
      this.activeTurns?.clearPendingApprovals(scopeRef);
    }

    let providerProfile = null;
    let providerPlugin = null;
    let runningTurnIds: string[] = [];
    try {
      const snapshot = await this.readThreadForSession(session);
      providerProfile = snapshot.providerProfile;
      providerPlugin = snapshot.providerPlugin;
      runningTurnIds = Array.isArray(snapshot.thread?.turns)
        ? snapshot.thread.turns
          .filter((entry) => !isProviderTurnTerminal(entry?.status))
          .map((entry) => String(entry?.id ?? '').trim())
          .filter(Boolean)
        : [];
    } catch {
      // Fall back to the tracked active turn below when thread reads fail.
    }

    if (active?.turnId && !runningTurnIds.includes(active.turnId)) {
      runningTurnIds.push(active.turnId);
    }
    const interruptedTurnIds = [...new Set(runningTurnIds)];
    const interruptErrors: string[] = [];

    if (interruptedTurnIds.length > 0) {
      providerProfile ??= this.requireProviderProfile(session.providerProfileId);
      providerPlugin ??= this.providerRegistry.getProvider(providerProfile.providerKind);
      if (typeof providerPlugin?.interruptTurn !== 'function') {
        interruptErrors.push(this.t('coordinator.turn.providerNoInterrupt', { kind: providerProfile.providerKind }));
      } else {
        for (const turnId of interruptedTurnIds) {
          if (active?.turnId === turnId) {
            this.activeTurns?.noteInterruptDispatched(scopeRef, true);
          }
          try {
            await providerPlugin.interruptTurn({
              providerProfile,
              threadId: session.codexThreadId,
              turnId,
            });
          } catch (error) {
            if (active?.turnId === turnId) {
              this.activeTurns?.noteInterruptDispatched(scopeRef, false);
            }
            interruptErrors.push(formatUserError(error));
          }
        }
      }
    }

    const settled = waitForSettleMs > 0
      ? await this.waitForThreadToStop(scopeRef, session, waitForSettleMs)
      : false;
    const checkpoint: StopCheckpointSnapshot = {
      threadId: session.codexThreadId,
      stoppedAt: this.now(),
      interruptedTurnIds,
      pendingApprovalCount,
      interruptErrors,
      requestedWhileStarting,
      settled,
    };
    this.storeStopCheckpoint(session.id, checkpoint);
    return checkpoint;
  }

  async startTurnWithRecovery(scopeRef, session, event, options: StartTurnOptions = {}) {
    const stopCheckpoint = session ? this.resolveStopCheckpoint(session.id) : null;
    const shouldLazyResumeStoppedThread = Boolean(
      stopCheckpoint
      && session?.codexThreadId
      && stopCheckpoint.threadId === session.codexThreadId,
    );
    debugCoordinator('turn_recovery_start', {
      platform: scopeRef.platform,
      scopeId: scopeRef.externalScopeId,
      bridgeSessionId: session?.id ?? null,
      threadId: session?.codexThreadId ?? null,
      textPreview: truncateCoordinatorText(event?.text, 160),
      stopCheckpointThreadId: stopCheckpoint?.threadId ?? null,
      lazyResumeStoppedThread: shouldLazyResumeStoppedThread,
    });
    try {
      return await this.startTurnOnSession(session, event, options);
    } catch (error) {
      debugCoordinator('turn_recovery_error', {
        platform: scopeRef.platform,
        scopeId: scopeRef.externalScopeId,
        bridgeSessionId: session?.id ?? null,
        threadId: session?.codexThreadId ?? null,
        error: error instanceof Error ? error.message : String(error),
        resumeRetryable: isResumeRetryableError(error),
        staleThread: isStaleThreadError(error),
        stopCheckpointThreadId: stopCheckpoint?.threadId ?? null,
        lazyResumeStoppedThread: shouldLazyResumeStoppedThread,
      });
      if (isResumeRetryableError(error)) {
        if (shouldLazyResumeStoppedThread) {
          return this.resumeTurnOnSameSession(session, event, options, error);
        }
        return this.retryTurnOnSameSession(session, event, options, error);
      }
      if (!isStaleThreadError(error)) {
        throw error;
      }
      return this.resumeTurnOnSameSession(session, event, options, error);
    }
  }

  async normalizeTurnArtifactIntent(
    event,
    scopeRef: PlatformScopeRef,
    session,
    providerProfile,
    providerPlugin,
    sessionSettings,
  ): Promise<TurnArtifactIntent> {
    const locale = sessionSettings?.locale ?? this.resolveScopeLocale(scopeRef, event);
    const timezone = extractEventTimezone(event);
    const cwd = normalizeCwd(session?.cwd) ?? this.resolveEventCwd(event) ?? null;
    const codexIntent = await this.normalizeTurnArtifactIntentWithCodex(
      event,
      providerProfile,
      providerPlugin,
      sessionSettings,
      session,
      locale,
      timezone,
      cwd,
    ).catch(() => null);
    if (codexIntent) {
      return codexIntent;
    }
    const agentsIntent = await normalizeTurnArtifactIntentWithOpenAIAgents(
      event.text,
      locale,
      this.now(),
      timezone,
    ).catch(() => null);
    if (agentsIntent) {
      return agentsIntent;
    }
    return buildEmptyTurnArtifactIntent();
  }

  async normalizeTurnArtifactIntentWithCodex(
    event,
    providerProfile,
    providerPlugin,
    sessionSettings,
    session,
    locale: string | null,
    timezone: string | null,
    cwd: string | null,
  ): Promise<TurnArtifactIntent | null> {
    if (!providerPlugin || typeof providerPlugin.startThread !== 'function' || typeof providerPlugin.startTurn !== 'function') {
      return null;
    }
    const thread = await providerPlugin.startThread({
      providerProfile,
      cwd,
      title: 'Artifact Delivery Intent Parser',
      metadata: {
        sourcePlatform: event.platform,
        source: 'turn-artifact-intent',
      },
    });
    const parserSession = {
      id: crypto.randomUUID(),
      providerProfileId: providerProfile.id,
      codexThreadId: thread.threadId,
      cwd: thread.cwd ?? cwd,
      title: thread.title ?? 'Artifact Delivery Intent Parser',
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    const prompt = buildTurnArtifactIntentPrompt(event.text, locale, this.now(), timezone);
    const result = await providerPlugin.startTurn({
      providerProfile,
      bridgeSession: parserSession,
      sessionSettings: {
        bridgeSessionId: parserSession.id,
        model: sessionSettings?.model ?? null,
        reasoningEffort: sessionSettings?.reasoningEffort ?? null,
        serviceTier: sessionSettings?.serviceTier ?? null,
        collaborationMode: null,
        personality: null,
        accessPreset: 'read-only',
        approvalPolicy: 'never',
        sandboxMode: 'read-only',
        locale,
        metadata: {},
        updatedAt: this.now(),
      },
      event: {
        ...event,
        text: prompt,
        cwd: parserSession.cwd ?? null,
        locale,
        attachments: [],
      },
      inputText: prompt,
    });
    return parseTurnArtifactIntentCandidate(result.outputText, event.text, 'codex');
  }

  async startTurnOnSession(session, event, options: StartTurnOptions = {}) {
    const scopeRef = toScopeRef(event);
    const providerProfile = this.requireProviderProfile(session.providerProfileId);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const sessionSettings = this.bridgeSessions.getSessionSettings(session.id);
    const artifactIntent = await this.normalizeTurnArtifactIntent(
      event,
      scopeRef,
      session,
      providerProfile,
      providerPlugin,
      sessionSettings,
    );
    const turnArtifactContext = createTurnArtifactContext({
      bridgeSessionId: session.id,
      cwd: normalizeCwd(session.cwd) ?? this.resolveEventCwd(event),
      intent: artifactIntent,
    });
    const pendingArtifactDelivery = createPendingTurnArtifactDeliveryState(turnArtifactContext);
    ensureTurnArtifactDirectories(turnArtifactContext);
    const turnEvent = withTurnArtifactContext(event, turnArtifactContext);
    this.activeTurns?.updateScopeTurn(scopeRef, {
      bridgeSessionId: session.id,
      providerProfileId: session.providerProfileId,
      threadId: session.codexThreadId,
      artifactDelivery: pendingArtifactDelivery,
    });
    debugCoordinator('turn_start_on_session', {
      platform: scopeRef.platform,
      scopeId: scopeRef.externalScopeId,
      bridgeSessionId: session.id,
      providerProfileId: session.providerProfileId,
      threadId: session.codexThreadId,
      cwd: session.cwd ?? null,
      textPreview: truncateCoordinatorText(event?.text, 160),
      attachmentCount: Array.isArray(event?.attachments) ? event.attachments.length : 0,
      artifactContext: turnArtifactContext
        ? {
          bridgeSessionId: turnArtifactContext.bridgeSessionId ?? null,
          turnId: turnArtifactContext.turnId ?? null,
          artifactDir: turnArtifactContext.artifactDir ?? null,
          spoolDir: turnArtifactContext.spoolDir ?? null,
          intent: turnArtifactContext.intent,
        }
        : {
          intent: artifactIntent,
        },
    });
    const result = await providerPlugin.startTurn({
      providerProfile,
      bridgeSession: session,
      sessionSettings,
      event: turnEvent,
      inputText: event.text,
      onProgress: options.onProgress ?? null,
      onTurnStarted: async (meta: { turnId?: string | null; threadId?: string | null } = {}) => {
        debugCoordinator('turn_started', {
          platform: scopeRef.platform,
          scopeId: scopeRef.externalScopeId,
          bridgeSessionId: session.id,
          providerProfileId: session.providerProfileId,
          threadId: meta.threadId ?? session.codexThreadId,
          turnId: meta.turnId ?? null,
        });
        if (turnArtifactContext) {
          turnArtifactContext.turnId = meta.turnId ?? null;
        }
        const active = this.activeTurns?.updateScopeTurn(scopeRef, {
          bridgeSessionId: session.id,
          providerProfileId: session.providerProfileId,
          threadId: meta.threadId ?? session.codexThreadId,
          turnId: meta.turnId ?? null,
          artifactDelivery: pendingArtifactDelivery
            ? {
              ...pendingArtifactDelivery,
              turnId: meta.turnId ?? null,
            }
            : null,
        }) ?? null;
        if (typeof options.onTurnStarted === 'function') {
          await options.onTurnStarted({
            turnId: meta.turnId ?? null,
            threadId: meta.threadId ?? session.codexThreadId,
            bridgeSessionId: session.id,
            providerProfileId: session.providerProfileId,
          });
        }
        if (active?.interruptRequested && active.turnId && !active.interruptDispatched) {
          await this.dispatchInterruptForActiveTurn(active);
        }
      },
      onApprovalRequest: async (request: ProviderApprovalRequest) => {
        this.activeTurns?.addPendingApproval(scopeRef, request);
        if (typeof options.onApprovalRequest === 'function') {
          await options.onApprovalRequest(request);
        }
      },
    });
    const finalizedResult = finalizeTurnArtifacts({
      result,
      context: turnArtifactContext,
    });
    debugCoordinator('turn_result_finalized', {
      platform: scopeRef.platform,
      scopeId: scopeRef.externalScopeId,
      bridgeSessionId: session.id,
      threadId: finalizedResult?.threadId ?? session.codexThreadId,
      turnId: finalizedResult?.turnId ?? null,
      outputState: finalizedResult?.outputState ?? null,
      finalSource: finalizedResult?.finalSource ?? null,
      errorMessage: finalizedResult?.errorMessage ?? null,
      outputTextPreview: truncateCoordinatorText(finalizedResult?.outputText, 160),
      previewTextPreview: truncateCoordinatorText(finalizedResult?.previewText, 160),
      outputArtifactCount: Array.isArray(finalizedResult?.outputArtifacts) ? finalizedResult.outputArtifacts.length : 0,
      artifactDelivery: finalizedResult?.artifactDelivery ?? null,
    });
    this.activeTurns?.updateScopeTurn(scopeRef, {
      artifactDelivery: finalizedResult.artifactDelivery ?? pendingArtifactDelivery ?? null,
    });
    const nextSession = this.bridgeSessions.updateSession(session.id, {
      codexThreadId: finalizedResult.threadId ?? session.codexThreadId,
      title: this.bridgeSessions.resolveThreadDisplayTitle({
        providerProfileId: session.providerProfileId,
        threadId: finalizedResult.threadId ?? session.codexThreadId,
        providerTitle: finalizedResult.title ?? null,
        fallbackTitle: session.title,
      }),
      cwd: normalizeCwd(session.cwd) ?? this.resolveEventCwd(event),
    });
    this.bridgeSessions.upsertSessionSettings(session.id, {
      metadata: {
        lastArtifactDelivery: finalizedResult.artifactDelivery ?? null,
      },
    });
    if (this.resolveStopCheckpoint(session.id)) {
      this.clearStopCheckpoint(session.id);
    }
    return { result: finalizedResult, session: nextSession };
  }

  async dispatchInterruptForActiveTurn(activeTurn) {
    if (!activeTurn?.providerProfileId || !activeTurn?.threadId || !activeTurn?.turnId) {
      throw new Error(this.t('coordinator.turn.noInterruptId'));
    }
    if (activeTurn.interruptDispatched) {
      return;
    }
    const providerProfile = this.requireProviderProfile(activeTurn.providerProfileId);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (typeof providerPlugin.interruptTurn !== 'function') {
      throw new Error(this.t('coordinator.turn.providerNoInterrupt', { kind: providerProfile.providerKind }));
    }
    this.activeTurns?.noteInterruptDispatched(activeTurn.scopeRef, true);
    try {
      await providerPlugin.interruptTurn({
        providerProfile,
        threadId: activeTurn.threadId,
        turnId: activeTurn.turnId,
      });
    } catch (error) {
      this.activeTurns?.noteInterruptDispatched(activeTurn.scopeRef, false);
      throw error;
    }
  }

  async retryTurnOnSameSession(session, event, options: StartTurnOptions = {}, originalError) {
    let lastError = originalError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await sleep(750);
      try {
        return await this.startTurnOnSession(session, event, options);
      } catch (error) {
        if (!isResumeRetryableError(error)) {
          throw error;
        }
        lastError = error;
      }
    }
    if (shouldAutoRebindAfterRecoveryFailure(lastError)) {
      return this.startTurnOnReplacementSession(toScopeRef(event), session, event, options, 'retry-recovery-failed');
    }
    throw lastError;
  }

  async resumeTurnOnSameSession(session, event, options: StartTurnOptions = {}, originalError) {
    const scopeRef = toScopeRef(event);
    const providerProfile = this.requireProviderProfile(session.providerProfileId);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (typeof providerPlugin.resumeThread !== 'function') {
      return this.startTurnOnReplacementSession(scopeRef, session, event, options, 'resume-unsupported');
    }
    let lastError = originalError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await providerPlugin.resumeThread({
          providerProfile,
          threadId: session.codexThreadId,
        });
        return await this.startTurnOnSession(session, event, options);
      } catch (error) {
        lastError = error;
        await sleep(500);
      }
    }
    if (shouldAutoRebindAfterRecoveryFailure(lastError)) {
      return this.startTurnOnReplacementSession(scopeRef, session, event, options, 'resume-recovery-failed');
    }
    throw enrichSessionRecoveryError(lastError, session, 'resumeThread failed', this.currentI18n);
  }

  async startTurnOnReplacementSession(scopeRef, session, event, options: StartTurnOptions = {}, trigger = 'auto-rebind-recovery') {
    const currentSettings = this.bridgeSessions.getSessionSettings(session.id);
    const locale = currentSettings?.locale ?? this.resolveScopeLocale(scopeRef, event);
    const nextSession = await this.bridgeSessions.createSessionForScope(scopeRef, {
      providerProfileId: session.providerProfileId,
      cwd: normalizeCwd(session.cwd) ?? this.resolveEventCwd(event) ?? this.defaultCwd ?? null,
      title: session.title ?? null,
      initialSettings: this.buildReboundSessionSettings(currentSettings, { locale }),
      providerStartOptions: {
        sourcePlatform: event.platform,
        trigger,
        previousBridgeSessionId: session.id,
        previousThreadId: session.codexThreadId,
      },
    });
    if (!isAutomationEvent(event)) {
      this.storeRetryableRequest(nextSession.id, event);
    }
    debugCoordinator('turn_recovery_auto_rebind', {
      platform: scopeRef.platform,
      scopeId: scopeRef.externalScopeId,
      previousBridgeSessionId: session.id,
      previousThreadId: session.codexThreadId,
      nextBridgeSessionId: nextSession.id,
      nextThreadId: nextSession.codexThreadId,
      trigger,
    });
    return this.startTurnOnSession(nextSession, event, options);
  }

  async runAgentJob(job: AgentJob, options: StartTurnOptions = {}): Promise<CoordinatorResponse> {
    if (!this.agentJobs) {
      return messageResponse([
        this.t('coordinator.agent.unsupported'),
      ]);
    }
    const current = this.agentJobs.getById(job.id) ?? job;
    const scopeRef = {
      platform: current.platform,
      externalScopeId: current.externalScopeId,
    };
    const session = this.agentJobs.getSession(current);
    if (!session) {
      this.agentJobs.failJob(current.id, {
        error: this.t('coordinator.agent.sessionMissing'),
      });
      return messageResponse([
        this.t('coordinator.agent.failed'),
        this.t('coordinator.agent.lastError', { value: this.t('coordinator.agent.sessionMissing') }),
      ], this.buildScopedSessionMeta({
        platform: current.platform,
        externalScopeId: current.externalScopeId,
      }));
    }

    let lastResult = null;
    let lastSession = session;
    let lastVerification: AgentVerificationResult | null = null;
    for (let attempt = Math.max(1, current.attemptCount + 1); attempt <= current.maxAttempts; attempt += 1) {
      const live = this.agentJobs.getById(current.id) ?? current;
      if (live.stopRequested || live.status === 'stopped') {
        this.agentJobs.requestStop(current.id);
        return messageResponse([
          this.t('coordinator.agent.stopped'),
          this.t('coordinator.agent.title', { value: live.title }),
        ], buildSessionMeta(lastSession));
      }
      this.agentJobs.markRunning(current.id);
      await emitProgressUpdate(
        options.onProgress ?? null,
        this.t('coordinator.agent.progressRunning', {
          title: current.title,
          attempt,
          max: current.maxAttempts,
        }),
        'commentary',
      );
      const agentEvent = {
        platform: current.platform,
        externalScopeId: current.externalScopeId,
        text: buildAgentExecutionPrompt(current, {
          attempt,
          previousVerification: lastVerification,
          previousResultPreview: lastResult?.result ? summarizeAgentResult(lastResult.result) : null,
          locale: current.locale ?? this.currentI18n.locale,
        }),
        cwd: current.cwd,
        locale: current.locale,
        attachments: [],
        metadata: {
          codexbridge: {
            overrideBridgeSessionId: current.bridgeSessionId,
            agentJobId: current.id,
            agentAttempt: attempt,
          },
        },
      };
      this.activeTurns?.beginScopeTurn(scopeRef, {
        bridgeSessionId: lastSession.id,
        providerProfileId: lastSession.providerProfileId,
        threadId: lastSession.codexThreadId,
      });
      try {
        const turnResult = await this.startTurnWithRecovery(scopeRef, lastSession, agentEvent, options);
        lastResult = turnResult;
        lastSession = turnResult.session;
      } catch (error) {
        await this.releaseActiveTurnIfStillRunning(scopeRef);
        const message = formatUserError(error);
        this.agentJobs.failJob(current.id, {
          error: message,
        });
        return messageResponse([
          this.t('coordinator.agent.failed'),
          this.t('coordinator.agent.lastError', { value: message }),
        ], buildSessionMeta(lastSession));
      } finally {
        await this.releaseActiveTurnIfStillRunning(scopeRef);
      }

      this.agentJobs.markVerifying(current.id, attempt);
      await emitProgressUpdate(
        options.onProgress ?? null,
        this.t('coordinator.agent.progressVerifying', {
          title: current.title,
        }),
        'commentary',
      );
      lastVerification = await this.verifyAgentJob(current, lastResult.result, lastSession).catch((error) => ({
        pass: false,
        summary: this.t('coordinator.agent.verifyFailed', { error: formatUserError(error) }),
        issues: [formatUserError(error)],
        nextAction: 'retry' as const,
      }));
      const resultPreview = summarizeAgentResult(lastResult.result);
      if (lastVerification.pass || lastVerification.nextAction === 'complete') {
        const resultArtifacts = normalizeAgentArtifactsForStorage(normalizeArtifactsForResponse(lastResult.result));
        const response = turnResponse(lastResult.result, this.currentI18n, buildSessionMeta(lastSession));
        const resultText = extractCoordinatorResponseText(response) || resultPreview;
        this.agentJobs.completeJob(current.id, {
          resultPreview,
          resultText,
          resultArtifacts,
          verificationSummary: lastVerification.summary,
        });
        const artifactMessages = response.messages.filter((message) => message.artifact || message.mediaPath);
        const completionLines = [
          this.t('coordinator.agent.completed'),
          this.t('coordinator.agent.title', { value: current.title }),
          this.t('coordinator.agent.verification', { value: truncateText(lastVerification.summary, 180) }),
        ];
        if (resultArtifacts.length > 0) {
          completionLines.push(this.t('coordinator.agent.attachmentSending', { count: resultArtifacts.length }));
        } else {
          if (resultText) {
            completionLines.push('');
            completionLines.push(resultText);
          }
        }
        response.messages = [
          {
            text: completionLines.filter((line) => line !== '').join('\n'),
          },
          ...artifactMessages,
        ];
        response.meta = {
          ...(response.meta ?? {}),
          codexTurn: {
            outputState: lastResult.result.outputState ?? 'complete',
            previewText: lastResult.result.previewText ?? '',
            finalSource: lastResult.result.finalSource ?? 'agent_job',
            errorMessage: lastResult.result.errorMessage ?? '',
          },
        };
        return response;
      }
      if (attempt < current.maxAttempts && lastVerification.nextAction === 'retry') {
        this.agentJobs.markRepairing(current.id, lastVerification.summary);
        await emitProgressUpdate(
          options.onProgress ?? null,
          this.t('coordinator.agent.progressRetrying', {
            title: current.title,
          }),
          'commentary',
        );
        continue;
      }
      this.agentJobs.failJob(current.id, {
        error: lastVerification.summary,
        resultPreview,
        verificationSummary: lastVerification.summary,
      });
      return messageResponse([
        this.t('coordinator.agent.failed'),
        this.t('coordinator.agent.title', { value: current.title }),
        this.t('coordinator.agent.verification', { value: lastVerification.summary }),
        ...(lastVerification.issues.length > 0
          ? [
            this.t('coordinator.agent.issuesTitle'),
            ...lastVerification.issues.map((issue) => `- ${issue}`),
          ]
          : []),
        this.t('coordinator.agent.retryHint'),
      ], buildSessionMeta(lastSession));
    }
    const fallbackSummary = this.t('coordinator.agent.maxAttemptsReached');
    this.agentJobs.failJob(current.id, {
      error: fallbackSummary,
      resultPreview: lastResult?.result ? summarizeAgentResult(lastResult.result) : null,
      verificationSummary: lastVerification?.summary ?? fallbackSummary,
    });
    return messageResponse([
      this.t('coordinator.agent.failed'),
      this.t('coordinator.agent.lastError', { value: fallbackSummary }),
    ], buildSessionMeta(lastSession));
  }

  async verifyAgentJob(job: AgentJob, result, session): Promise<AgentVerificationResult> {
    const hardFailure = resolveAgentHardFailure(result);
    if (hardFailure) {
      return {
        pass: false,
        summary: hardFailure,
        issues: [hardFailure],
        nextAction: 'retry',
      };
    }
    const codexVerification = await this.verifyAgentResultWithCodex(job, result, session).catch(() => null);
    if (codexVerification) {
      return codexVerification;
    }
    const semantic = await verifyAgentResultWithOpenAIAgents(job, result, this.currentI18n.locale).catch(() => null);
    if (semantic) {
      return semantic;
    }
    return {
      pass: true,
      summary: this.t('coordinator.agent.verifyFallbackPass'),
      issues: [],
      nextAction: 'complete',
    };
  }

  async verifyAgentResultWithCodex(job: AgentJob, result, session): Promise<AgentVerificationResult | null> {
    const providerProfile = this.requireProviderProfile(job.providerProfileId);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const thread = await providerPlugin.startThread({
      providerProfile,
      cwd: job.cwd,
      title: 'Agent Verifier',
      metadata: {
        sourcePlatform: job.platform,
        source: 'agent-verifier',
        agentJobId: job.id,
      },
    });
    const verifierSession = {
      id: crypto.randomUUID(),
      providerProfileId: providerProfile.id,
      codexThreadId: thread.threadId,
      cwd: thread.cwd ?? job.cwd,
      title: thread.title ?? 'Agent Verifier',
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    const prompt = buildAgentVerifierPrompt(job, result, this.currentI18n.locale);
    const verifierResult = await providerPlugin.startTurn({
      providerProfile,
      bridgeSession: verifierSession,
      sessionSettings: {
        bridgeSessionId: verifierSession.id,
        model: null,
        reasoningEffort: null,
        serviceTier: null,
        collaborationMode: null,
        personality: null,
        accessPreset: 'read-only',
        approvalPolicy: 'never',
        sandboxMode: 'read-only',
        locale: job.locale ?? this.currentI18n.locale,
        metadata: {},
        updatedAt: this.now(),
      },
      event: {
        platform: job.platform,
        externalScopeId: job.externalScopeId,
        text: prompt,
        cwd: session?.cwd ?? job.cwd,
        locale: job.locale ?? this.currentI18n.locale,
        attachments: [],
      },
      inputText: prompt,
    });
    return parseAgentVerificationResult(verifierResult.outputText);
  }

  buildReboundSessionSettings(
    currentSettings: SessionSettings | null,
    overrides: Partial<SessionSettings> = {},
  ): Partial<SessionSettings> {
    return {
      locale: currentSettings?.locale ?? null,
      model: currentSettings?.model ?? null,
      reasoningEffort: currentSettings?.reasoningEffort ?? null,
      serviceTier: currentSettings?.serviceTier ?? null,
      collaborationMode: currentSettings?.collaborationMode ?? null,
      personality: currentSettings?.personality ?? null,
      accessPreset: currentSettings?.accessPreset ?? null,
      approvalPolicy: currentSettings?.approvalPolicy ?? null,
      sandboxMode: currentSettings?.sandboxMode ?? null,
      metadata: {
        ...(currentSettings?.metadata ?? {}),
      },
      ...overrides,
    };
  }
}

function toScopeRef(event) {
  return {
    platform: event.platform,
    externalScopeId: event.externalScopeId,
  };
}

function buildSessionMeta(session) {
  return {
    bridgeSessionId: session.id,
    providerProfileId: session.providerProfileId,
    codexThreadId: session.codexThreadId,
  };
}

function buildActiveTurnMeta(activeTurn) {
  if (!activeTurn?.bridgeSessionId || !activeTurn?.providerProfileId || !activeTurn?.threadId) {
    return null;
  }
  return {
    bridgeSessionId: activeTurn.bridgeSessionId,
    providerProfileId: activeTurn.providerProfileId,
    codexThreadId: activeTurn.threadId,
  };
}

function renderCommandBlockedMessage(commandName, interruptRequested, i18n: Translator) {
  const action = {
    automation: i18n.t('coordinator.action.automation'),
    weibo: i18n.t('coordinator.action.weibo'),
    new: i18n.t('coordinator.action.new'),
    uploads: i18n.t('coordinator.action.uploads'),
    review: i18n.t('coordinator.action.review'),
    open: i18n.t('coordinator.action.open'),
    models: i18n.t('coordinator.action.models'),
    model: i18n.t('coordinator.action.model'),
    personality: i18n.t('coordinator.action.personality'),
    instructions: i18n.t('coordinator.action.instructions'),
    fast: i18n.t('coordinator.action.fast'),
    rename: i18n.t('coordinator.action.rename'),
    provider: i18n.t('coordinator.action.provider'),
    reconnect: i18n.t('coordinator.action.reconnect'),
    retry: i18n.t('coordinator.action.retry'),
    restart: i18n.t('coordinator.action.restart'),
    permissions: i18n.t('coordinator.action.permissions'),
  }[commandName] ?? i18n.t('coordinator.action.generic');
  if (interruptRequested) {
    return i18n.t('coordinator.blocked.waitThenAction', { action });
  }
  return i18n.t('coordinator.blocked.cannotAction', { action });
}

function hasPendingApproval(activeTurn): boolean {
  return Array.isArray(activeTurn?.pendingApprovals) && activeTurn.pendingApprovals.length > 0;
}

function selectUsageWindows(report) {
  for (const bucket of report?.buckets ?? []) {
    if (!Array.isArray(bucket?.windows) || bucket.windows.length === 0) {
      continue;
    }
    let primaryWindow = null;
    let weeklyWindow = null;
    for (const window of bucket.windows) {
      if (!primaryWindow && Number(window?.windowSeconds ?? 0) === 18_000) {
        primaryWindow = window;
      }
      if (!weeklyWindow && Number(window?.windowSeconds ?? 0) === 604_800) {
        weeklyWindow = window;
      }
    }
    primaryWindow ??= bucket.windows[0] ?? null;
    weeklyWindow ??= bucket.windows[1] ?? null;
    if (primaryWindow || weeklyWindow) {
      return [primaryWindow, weeklyWindow];
    }
  }
  return [null, null];
}

function normalizeCwd(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function renderPlatformStatusLines(platformId, status, i18n: Translator, { details = false } = {}) {
  if (!status || platformId !== 'weixin') {
    return [];
  }
  const accountId = typeof status.accountId === 'string' && status.accountId.trim()
    ? status.accountId.trim()
    : i18n.t('common.notSet');
  const sessionPaused = Boolean(status.sessionPaused);
  const lines = [
    i18n.t('platform.weixin.status.session', {
      value: sessionPaused
        ? i18n.t('platform.weixin.status.sessionPaused')
        : i18n.t('platform.weixin.status.sessionActive'),
    }),
  ];
  if (!details) {
    return lines;
  }
  lines.unshift(i18n.t('platform.weixin.status.account', { value: accountId }));
  lines.push(i18n.t('platform.weixin.status.contextToken', {
    value: status.hasContextToken
      ? i18n.t('platform.weixin.status.contextTokenPresent')
      : i18n.t('platform.weixin.status.contextTokenAbsent'),
  }));
  if (sessionPaused) {
    lines.push(i18n.t('platform.weixin.status.sessionRemaining', {
      minutes: Number(status.remainingPauseMinutes ?? 0),
    }));
  }
  const matchedAccountIds = Array.isArray(status.contextTokenMatchedAccountIds)
    ? status.contextTokenMatchedAccountIds
      .map((value) => typeof value === 'string' ? value.trim() : '')
      .filter(Boolean)
    : [];
  if (matchedAccountIds.length > 0) {
    lines.push(i18n.t('platform.weixin.status.contextTokenMatches', {
      value: matchedAccountIds.join(', '),
    }));
  }
  return lines;
}

function formatActiveTurnValue(activeTurn, i18n: Translator) {
  if (!activeTurn) {
    return i18n.t('common.none');
  }
  return activeTurn.turnId ?? i18n.t('common.starting');
}

function formatActiveTurnState(activeTurn, i18n: Translator) {
  if (!activeTurn) {
    return i18n.t('coordinator.turnState.idle');
  }
  if (activeTurn.interruptRequested) {
    return i18n.t('coordinator.turnState.interruptRequested');
  }
  return activeTurn.turnId ? i18n.t('coordinator.turnState.running') : i18n.t('coordinator.turnState.starting');
}

function resolveStoredArtifactDelivery(settings): TurnArtifactDeliveryState | null {
  const metadata = settings?.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }
  const lastArtifactDelivery = metadata.lastArtifactDelivery;
  return lastArtifactDelivery && typeof lastArtifactDelivery === 'object'
    ? lastArtifactDelivery as TurnArtifactDeliveryState
    : null;
}

function renderArtifactDeliveryNotice(artifactDelivery: TurnArtifactDeliveryState | null, i18n: Translator): string {
  if (!artifactDelivery?.noticeCode) {
    return '';
  }
  const rejectedCount = Array.isArray(artifactDelivery.rejectedArtifacts) ? artifactDelivery.rejectedArtifacts.length : 0;
  const deliveredCount = Array.isArray(artifactDelivery.deliveredArtifacts) ? artifactDelivery.deliveredArtifacts.length : 0;
  const sizeLimit = formatBinarySize(artifactDelivery.maxArtifactSizeBytes);
  switch (artifactDelivery.noticeCode) {
    case 'count_and_size_limited':
      return i18n.t('coordinator.artifact.notice.countAndSizeLimited', {
        delivered: deliveredCount,
        rejected: rejectedCount,
        size: sizeLimit,
      });
    case 'count_limited':
      return i18n.t('coordinator.artifact.notice.countLimited', {
        delivered: deliveredCount,
        rejected: rejectedCount,
      });
    case 'size_limited':
      return i18n.t('coordinator.artifact.notice.sizeLimited', {
        rejected: rejectedCount,
        size: sizeLimit,
      });
    case 'ambiguous_candidates':
      return i18n.t('coordinator.artifact.notice.ambiguousCandidates', {
        count: artifactDelivery.scannedCandidateCount || rejectedCount || 2,
      });
    case 'missing_deliverable':
      return i18n.t('coordinator.artifact.notice.missingDeliverable', {
        format: artifactDelivery.requestedFormat ?? i18n.t('common.notSet'),
      });
    default:
      return '';
  }
}

function renderArtifactDeliveryStatusLines(
  artifactDelivery: TurnArtifactDeliveryState | null,
  i18n: Translator,
): string[] {
  if (!artifactDelivery) {
    return [];
  }
  const lines = [
    i18n.t('coordinator.status.artifactStage', { value: formatArtifactDeliveryStage(artifactDelivery.stage, i18n) }),
    i18n.t('coordinator.status.artifactFormat', {
      value: artifactDelivery.requestedFormat ?? i18n.t('common.notSet'),
    }),
    i18n.t('coordinator.status.artifactPolicy', {
      count: artifactDelivery.maxArtifactCount,
      size: formatBinarySize(artifactDelivery.maxArtifactSizeBytes),
    }),
    i18n.t('coordinator.status.artifactCounts', {
      selected: artifactDelivery.deliveredArtifacts.length,
      rejected: artifactDelivery.rejectedArtifacts.length,
      candidates: artifactDelivery.scannedCandidateCount,
    }),
    i18n.t('coordinator.status.artifactDir', { value: artifactDelivery.artifactDir }),
    i18n.t('coordinator.status.artifactSpoolDir', { value: artifactDelivery.spoolDir }),
  ];
  const notice = renderArtifactDeliveryNotice(artifactDelivery, i18n);
  if (notice) {
    lines.push(i18n.t('coordinator.status.artifactNotice', { value: notice }));
  }
  return lines;
}

function formatArtifactDeliveryStage(stage: TurnArtifactDeliveryState['stage'], i18n: Translator): string {
  switch (stage) {
    case 'pending':
      return i18n.t('coordinator.artifact.stage.pending');
    case 'ready':
      return i18n.t('coordinator.artifact.stage.ready');
    case 'fallback_ready':
      return i18n.t('coordinator.artifact.stage.fallbackReady');
    case 'limited':
      return i18n.t('coordinator.artifact.stage.limited');
    case 'ambiguous':
      return i18n.t('coordinator.artifact.stage.ambiguous');
    case 'missing':
      return i18n.t('coordinator.artifact.stage.missing');
    default:
      return i18n.t('common.unknown');
  }
}

function formatBinarySize(value: unknown): string {
  const bytes = Number(value ?? NaN);
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let size = bytes;
  let unitIndex = -1;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const digits = size >= 10 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[Math.max(unitIndex, 0)]}`;
}

function messageResponse(lines, session = undefined): CoordinatorResponse {
  return {
    type: 'message',
    messages: lines.map((text) => ({ text })),
    session: session ?? null,
  };
}

function textResponse(text, session = undefined) {
  return messageResponse([text], session);
}

function turnResponse(result, i18n: Translator, session = undefined): CoordinatorResponse {
  const messages: Array<{
    text?: string | null;
    artifact?: OutputArtifact | null;
    mediaPath?: string | null;
    caption?: string | null;
  }> = [];
  const outputText = String(result?.outputText ?? '');
  const previewText = String(result?.previewText ?? '');
  if (outputText) {
    messages.push({ text: outputText });
  } else if ((result?.outputState ?? 'complete') === 'partial' && previewText) {
    messages.push({ text: previewText });
  }
  const artifactNotice = renderArtifactDeliveryNotice(result?.artifactDelivery ?? null, i18n);
  if (artifactNotice) {
    messages.push({ text: artifactNotice });
  }
  const artifacts = normalizeArtifactsForResponse(result);
  for (const artifact of artifacts) {
    const mediaPath = String(artifact?.path ?? '').trim();
    if (!mediaPath) {
      continue;
    }
    messages.push({
      artifact,
      mediaPath,
      caption: typeof artifact?.caption === 'string' ? artifact.caption : null,
    });
  }
  return {
    type: 'message',
    messages,
    session: session ?? null,
  };
}

function buildReviewResponse({
  result,
  target,
  i18n,
  session = undefined,
}: {
  result: {
    outputText?: string;
    outputState?: string;
    previewText?: string;
  };
  target: ProviderReviewTarget;
  i18n: Translator;
  session?: Record<string, unknown> | undefined;
}): CoordinatorResponse {
  const title = formatReviewTargetTitle(target, i18n);
  const outputText = String(result?.outputText ?? '').trim();
  const previewText = String(result?.previewText ?? '').trim();
  if (outputText) {
    return textResponse(`${title}\n\n${outputText}`, session);
  }
  if ((result?.outputState ?? 'complete') === 'partial' && previewText) {
    return textResponse(`${title}\n\n${previewText}`, session);
  }
  if ((result?.outputState ?? '') === 'interrupted') {
    return messageResponse([i18n.t('runtime.error.interrupted')], session);
  }
  return messageResponse([
    i18n.t('coordinator.review.empty'),
  ], session);
}

function extractCoordinatorResponseText(response: CoordinatorResponse): string {
  const messages = Array.isArray(response?.messages) ? response.messages : [];
  return messages
    .map((message) => String(message?.text ?? '').trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

async function emitProgressUpdate(
  handler: ProgressHandler,
  text: string,
  outputKind = 'commentary',
): Promise<void> {
  if (typeof handler !== 'function') {
    return;
  }
  const normalized = String(text ?? '').trim();
  if (!normalized) {
    return;
  }
  await handler({
    text: normalized,
    delta: normalized,
    outputKind,
  });
}

function startProgressHeartbeat(
  handler: ProgressHandler,
  getText: () => string,
  intervalMs: number,
  options: {
    maxRuns?: number;
  } = {},
): () => void {
  if (typeof handler !== 'function' || intervalMs <= 0) {
    return () => {};
  }
  const maxRuns = Number.isFinite(options.maxRuns) ? Math.max(0, Number(options.maxRuns)) : Number.POSITIVE_INFINITY;
  if (maxRuns === 0) {
    return () => {};
  }
  let running = false;
  let runCount = 0;
  const timer = setInterval(() => {
    if (runCount >= maxRuns) {
      clearInterval(timer);
      return;
    }
    if (running) {
      return;
    }
    running = true;
    Promise.resolve(emitProgressUpdate(handler, getText(), 'commentary'))
      .catch(() => {})
      .finally(() => {
        runCount += 1;
        running = false;
        if (runCount >= maxRuns) {
          clearInterval(timer);
        }
      });
  }, intervalMs);
  return () => {
    clearInterval(timer);
  };
}

function formatReviewTargetTitle(target: ProviderReviewTarget, i18n: Translator): string {
  switch (target.type) {
    case 'uncommittedChanges':
      return i18n.t('coordinator.review.target.uncommitted');
    case 'baseBranch':
      return i18n.t('coordinator.review.target.base', { branch: target.branch });
    case 'commit':
      return i18n.t('coordinator.review.target.commit', { sha: target.sha });
    case 'custom':
      return i18n.t('coordinator.review.target.custom');
    default:
      return i18n.t('coordinator.review.target.uncommitted');
  }
}

function parseReviewTargetArgs(args: readonly string[]): ProviderReviewTarget | null {
  if (!Array.isArray(args) || args.length === 0) {
    return { type: 'uncommittedChanges' };
  }
  const action = String(args[0] ?? '').trim().toLowerCase();
  if (!action) {
    return { type: 'uncommittedChanges' };
  }
  if (action === 'base') {
    const branch = args.slice(1).join(' ').trim();
    return branch
      ? {
        type: 'baseBranch',
        branch,
      }
      : null;
  }
  if (action === 'commit') {
    const sha = String(args[1] ?? '').trim();
    return sha
      ? {
        type: 'commit',
        sha,
      }
      : null;
  }
  return null;
}

async function normalizeAgentDraftWithOpenAIAgents(rawInput: string, locale: string | null): Promise<AgentDraftCandidate | null> {
  if (!resolveOpenAIAgentRuntimeConfig().apiKey) {
    return null;
  }
  const output = await runOpenAIAgentJson({
    name: 'CodexBridge Intent Planner',
    instructions: buildOpenAIAgentPlannerInstructions(locale),
    input: rawInput,
  });
  return parseAgentDraftCandidate(output);
}

async function normalizeAgentDraftEditWithOpenAIAgents(
  draft: PendingAgentDraft,
  instruction: string,
  locale: string | null,
): Promise<AgentDraftCandidate | null> {
  if (!resolveOpenAIAgentRuntimeConfig().apiKey) {
    return null;
  }
  const normalizedLocale = normalizeLocale(locale) ?? 'zh-CN';
  const output = await runOpenAIAgentJson({
    name: 'CodexBridge Agent Draft Editor',
    instructions: 'Merge agent draft edit instructions into the existing draft as strict JSON only. Do not use markdown.',
    input: buildAgentDraftEditPrompt(draft, instruction, normalizedLocale),
  });
  return parseAgentDraftCandidate(output);
}

async function verifyAgentResultWithOpenAIAgents(job: AgentJob, result, locale: string | null): Promise<AgentVerificationResult | null> {
  if (!resolveOpenAIAgentRuntimeConfig().apiKey) {
    return null;
  }
  const output = await runOpenAIAgentJson({
    name: 'CodexBridge Agent Verifier',
    instructions: buildOpenAIAgentVerifierInstructions(locale),
    input: JSON.stringify({
      goal: job.goal,
      expectedOutput: job.expectedOutput,
      plan: job.plan,
      outputState: result?.outputState ?? null,
      outputText: truncateText(String(result?.outputText ?? result?.previewText ?? ''), 6000),
      artifactCount: Array.isArray(result?.outputArtifacts) ? result.outputArtifacts.length : 0,
      mediaCount: Array.isArray(result?.outputMedia) ? result.outputMedia.length : 0,
    }),
  });
  return parseAgentVerificationResult(output);
}

async function normalizeAssistantRecordDraftWithOpenAIAgents(
  rawInput: string,
  forcedType: AssistantRecordType | null,
  locale: string | null,
  now: number,
  fallbackDraft: AssistantRecordDraft,
  timezone: string | null,
): Promise<AssistantRecordDraft | null> {
  if (!resolveOpenAIAgentRuntimeConfig().apiKey) {
    return null;
  }
  const output = await runOpenAIAgentJson({
    name: 'CodexBridge Assistant Record Classifier',
    instructions: 'Classify assistant records as strict JSON only. Do not use markdown.',
    input: buildAssistantRecordDraftPrompt(rawInput, forcedType, locale, now, timezone),
  });
  return parseAssistantRecordDraftCandidate(output, rawInput, forcedType, fallbackDraft, 'agents-sdk');
}

async function normalizeTurnArtifactIntentWithOpenAIAgents(
  rawInput: string,
  locale: string | null,
  now: number,
  timezone: string | null,
): Promise<TurnArtifactIntent | null> {
  if (!resolveOpenAIAgentRuntimeConfig().apiKey) {
    return null;
  }
  const output = await runOpenAIAgentJson({
    name: 'CodexBridge Artifact Intent Classifier',
    instructions: 'Classify artifact delivery intent as strict JSON only. Do not use markdown.',
    input: buildTurnArtifactIntentPrompt(rawInput, locale, now, timezone),
  });
  return parseTurnArtifactIntentCandidate(output, rawInput, 'agents-sdk');
}

async function normalizeAutomationDraftWithOpenAIAgents(
  rawInput: string,
  locale: string | null,
): Promise<AutomationDraftCandidate | null> {
  if (!resolveOpenAIAgentRuntimeConfig().apiKey) {
    return null;
  }
  const normalizedLocale = normalizeLocale(locale) ?? 'zh-CN';
  const output = await runOpenAIAgentJson({
    name: 'CodexBridge Automation Draft Normalizer',
    instructions: 'Normalize automation requests as strict JSON only. Do not use markdown.',
    input: buildAutomationDraftPrompt(rawInput, normalizedLocale),
  });
  return parseAutomationDraftCandidate(output ?? '');
}

async function normalizeAutomationDraftEditWithOpenAIAgents(
  draft: PendingAutomationDraft,
  instruction: string,
  locale: string | null,
): Promise<AutomationDraftCandidate | null> {
  if (!resolveOpenAIAgentRuntimeConfig().apiKey) {
    return null;
  }
  const normalizedLocale = normalizeLocale(locale) ?? 'zh-CN';
  const output = await runOpenAIAgentJson({
    name: 'CodexBridge Automation Draft Editor',
    instructions: 'Merge automation draft edit instructions into the existing draft as strict JSON only. Do not use markdown.',
    input: buildAutomationDraftEditPrompt(draft, instruction, normalizedLocale),
  });
  return parseAutomationDraftCandidate(output ?? '');
}

async function normalizeAssistantRecordUpdateWithOpenAIAgents(
  record: AssistantRecord,
  instructions: string[],
  locale: string | null,
  now: number,
  timezone: string | null,
): Promise<{ record: AssistantRecord; normalizedBy: 'agents-sdk'; changeSummary: string | null } | null> {
  if (!resolveOpenAIAgentRuntimeConfig().apiKey) {
    return null;
  }
  const output = await runOpenAIAgentJson({
    name: 'CodexBridge Assistant Record Rewriter',
    instructions: 'Rewrite assistant records as strict JSON only. Do not use markdown.',
    input: buildAssistantRecordRewritePrompt(record, instructions, locale, now, timezone ?? record.timezone),
  });
  const candidate = parseAssistantRecordRewriteCandidate(output, record);
  if (!candidate) {
    return null;
  }
  const rewritten = applyAssistantRecordRewriteCandidate(record, candidate, instructions, 'agents-sdk', now);
  if (!rewritten) {
    return null;
  }
  return {
    record: rewritten,
    normalizedBy: 'agents-sdk',
    changeSummary: candidate.changeSummary || null,
  };
}

async function resolveAssistantRecordRouteWithOpenAIAgents(
  rawInput: string,
  records: AssistantRecord[],
  locale: string | null,
  now: number,
): Promise<AssistantRecordRouteDecision | null> {
  if (!resolveOpenAIAgentRuntimeConfig().apiKey) {
    return null;
  }
  const output = await runOpenAIAgentJson({
    name: 'CodexBridge Assistant Record Router',
    instructions: 'Route assistant record requests as strict JSON only. Do not use markdown.',
    input: buildAssistantRecordRoutePrompt(rawInput, records, locale, now),
  });
  return parseAssistantRecordRouteDecision(output, records);
}

async function runOpenAIAgentJson({ name, instructions, input }: {
  name: string;
  instructions: string;
  input: string;
}): Promise<string | null> {
  const runtimeConfig = resolveOpenAIAgentRuntimeConfig();
  if (!runtimeConfig.apiKey) {
    return null;
  }
  const { Agent, OpenAIProvider, Runner } = await import('@openai/agents');
  const modelProvider = new OpenAIProvider({
    apiKey: runtimeConfig.apiKey,
    baseURL: runtimeConfig.baseURL ?? undefined,
    useResponses: runtimeConfig.useResponses,
  });
  const runner = new Runner({
    modelProvider,
    tracingDisabled: true,
  });
  const agent = new Agent({
    name,
    instructions,
    model: runtimeConfig.model,
  });
  const result = await runner.run(agent, input, { maxTurns: 2 });
  return typeof result.finalOutput === 'string'
    ? result.finalOutput
    : JSON.stringify(result.finalOutput ?? null);
}

export function resolveOpenAIAgentRuntimeConfig(env: NodeJS.ProcessEnv = process.env): OpenAIAgentRuntimeConfig {
  const apiKey = firstNonEmptyString(
    env.CODEXBRIDGE_AGENT_API_KEY,
    env.OPENAI_API_KEY,
    env.MINIMAX_API_KEY,
  );
  const baseURL = firstNonEmptyString(
    env.CODEXBRIDGE_AGENT_BASE_URL,
    env.OPENAI_BASE_URL,
    env.OPENAI_API_BASE_URL,
  );
  const apiMode = compactWhitespace(env.CODEXBRIDGE_AGENT_API ?? '').toLowerCase();
  const useResponses = apiMode === 'responses'
    ? true
    : apiMode === 'chat_completions' || baseURL
      ? false
      : undefined;
  return {
    apiKey,
    baseURL,
    model: firstNonEmptyString(env.CODEXBRIDGE_AGENT_MODEL, env.OPENAI_MODEL) ?? 'gpt-5.5',
    useResponses,
  };
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = compactWhitespace(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function buildOpenAIAgentPlannerInstructions(locale: string | null): string {
  const language = normalizeLocale(locale) === 'zh-CN' ? 'Chinese' : 'English';
  return [
    `You are the intent and planning agent for CodexBridge. Respond in ${language}.`,
    'Normalize the user request into strict JSON only, without markdown.',
    'Schema:',
    '{"title":"short title","goal":"clear goal","expectedOutput":"final deliverable","plan":["step 1","step 2"],"category":"code|research|ops|doc|media|mixed","riskLevel":"low|medium|high","mode":"codex|agents|hybrid"}',
    'Prefer mode=hybrid for multi-step tasks, mode=codex for code/repo tasks, and mode=agents for pure research/planning.',
    'Keep plan to 3-6 concrete steps.',
  ].join('\n');
}

function buildOpenAIAgentVerifierInstructions(locale: string | null): string {
  const language = normalizeLocale(locale) === 'zh-CN' ? 'Chinese' : 'English';
  return [
    `You are the verifier for a CodexBridge background agent job. Respond in ${language}.`,
    'Judge whether the output satisfies the goal and expected deliverable.',
    'Return strict JSON only, without markdown.',
    'Schema:',
    '{"pass":true,"summary":"short verdict","issues":[],"nextAction":"complete|retry|fail"}',
    'Use nextAction=retry when one more automated fix attempt is likely useful. Use fail when the task needs user input or cannot be judged.',
  ].join('\n');
}

function buildAgentDraftPrompt(rawInput: string, locale: string | null): string {
  const language = normalizeLocale(locale) === 'zh-CN' ? '中文' : 'English';
  return [
    `请把下面的微信 /agent 请求整理成严格 JSON，只返回 JSON，不要 Markdown。输出语言：${language}。`,
    'Schema:',
    '{"title":"短标题","goal":"明确目标","expectedOutput":"最终交付物","plan":["步骤1","步骤2"],"category":"code|research|ops|doc|media|mixed","riskLevel":"low|medium|high","mode":"codex|agents|hybrid"}',
    '要求：多步骤任务优先 hybrid；代码仓库任务用 codex；纯研究/计划可用 agents；plan 保持 3-6 步。',
    '',
    '用户请求：',
    rawInput,
  ].join('\n');
}

function buildAgentDraftEditPrompt(draft: PendingAgentDraft, instruction: string, locale: SupportedLocale): string {
  const currentDraft = {
    title: draft.title,
    goal: draft.goal,
    expectedOutput: draft.expectedOutput,
    plan: draft.plan,
    category: draft.category,
    riskLevel: draft.riskLevel,
    mode: draft.mode,
  };
  const localizedInstruction = locale === 'zh-CN'
    ? `你是 CodexBridge 的 agent 草案编辑器。请把用户的“修改提示”合并到“当前草案”里，输出更新后的完整 agent 草案 JSON。
只返回 JSON，不要 Markdown，不要解释。

这是编辑已有草案，不是重新新建草案。

返回格式：
{"title":"短标题","goal":"明确目标","expectedOutput":"最终交付物","plan":["步骤1","步骤2"],"category":"code|research|ops|doc|media|mixed","riskLevel":"low|medium|high","mode":"codex|agents|hybrid"}

编辑规则：
- 修改提示只覆盖它明确提到的字段；没有提到的 title / goal / expectedOutput / plan / category / riskLevel / mode 必须从当前草案保留。
- 如果用户说“只改计划”“只补一步”“任务目标不变”，必须保留未被明确修改的字段。
- 如果用户只改执行边界，例如“只做方案，不改代码”，要在 mode / expectedOutput / plan 上反映这个变化，但不要丢掉原目标上下文。
- plan 保持 3-6 步，步骤要具体。
- 不要把当前草案丢掉后仅按修改提示重新生成。
- 如果无法可靠合并，返回一个最接近当前草案且已应用明确修改的完整 JSON。

当前草案 JSON：
${JSON.stringify(currentDraft, null, 2)}

修改提示：
${instruction}`
    : `You are the CodexBridge agent draft editor. Merge the user's edit instruction into the current draft and output the updated full agent draft JSON.
Return JSON only. Do not use markdown or explanations.

This edits an existing draft. It is not a new draft.

Return format:
{"title":"short title","goal":"clear goal","expectedOutput":"final deliverable","plan":["step 1","step 2"],"category":"code|research|ops|doc|media|mixed","riskLevel":"low|medium|high","mode":"codex|agents|hybrid"}

Edit rules:
- Only override fields explicitly mentioned by the edit instruction. Preserve title / goal / expectedOutput / plan / category / riskLevel / mode from the current draft when not mentioned.
- If the user says to only adjust part of the draft, preserve everything else.
- If the user only changes execution boundaries, such as "only write the plan and do not change code", reflect that in mode / expectedOutput / plan without dropping the original task context.
- Keep plan to 3-6 concrete steps.
- Do not discard the current draft and regenerate only from the edit instruction.
- If the edit cannot be merged reliably, return the closest full JSON draft that preserves the current draft and applies the explicit changes.

Current draft JSON:
${JSON.stringify(currentDraft, null, 2)}

Edit instruction:
${instruction}`;
  return localizedInstruction.trim();
}

function buildAgentExecutionPrompt(job: AgentJob, params: {
  attempt: number;
  previousVerification: AgentVerificationResult | null;
  previousResultPreview: string | null;
  locale: string | null;
}): string {
  const language = normalizeLocale(params.locale) === 'zh-CN' ? '中文' : 'English';
  const lines = [
    `你正在执行 CodexBridge 后台 Agent 任务。请用${language}回复最终结果。`,
    '',
    `任务标题：${job.title}`,
    `目标：${job.goal}`,
    `最终交付物：${job.expectedOutput}`,
    `执行模式：${job.mode}`,
    `当前尝试：${params.attempt}/${job.maxAttempts}`,
    '',
    '计划：',
    ...job.plan.map((line, index) => `${index + 1}. ${line}`),
    '',
    '执行要求：',
    '- 你有 full-access 配置；除非确实必须，不要向用户请求审批。',
    '- 如果需要修改代码，请直接修改、测试并说明结果。',
    '- 如果是研究或文档任务，请给出可直接使用的结构化结果。',
    '- 最终回复必须包含：完成内容、验证结果、未完成风险。',
  ];
  if (params.previousVerification) {
    lines.push(
      '',
      '上一轮 verifier 未通过：',
      params.previousVerification.summary,
      ...params.previousVerification.issues.map((issue) => `- ${issue}`),
    );
  }
  if (params.previousResultPreview) {
    lines.push('', `上一轮输出摘要：${params.previousResultPreview}`);
  }
  return lines.join('\n');
}

function buildAgentVerifierPrompt(job: AgentJob, result, locale: string | null): string {
  const language = normalizeLocale(locale) === 'zh-CN' ? '中文' : 'English';
  return [
    `你是 CodexBridge 后台 Agent 的 verifier。请用${language}判断任务是否通过。`,
    '只返回严格 JSON，不要 Markdown。',
    'Schema:',
    '{"pass":true,"summary":"简短结论","issues":[],"nextAction":"complete|retry|fail"}',
    '',
    `目标：${job.goal}`,
    `最终交付物：${job.expectedOutput}`,
    `计划：${job.plan.join(' / ')}`,
    `输出状态：${result?.outputState ?? 'complete'}`,
    `附件数量：${Array.isArray(result?.outputArtifacts) ? result.outputArtifacts.length : 0}`,
    '',
    '输出内容：',
    truncateText(String(result?.outputText ?? result?.previewText ?? ''), 6000),
  ].join('\n');
}

function parseAgentDraftCandidate(value: unknown): AgentDraftCandidate | null {
  const parsed = parseJsonObject(value);
  if (!parsed) {
    return null;
  }
  const title = compactWhitespace(parsed.title ?? '');
  const goal = compactWhitespace(parsed.goal ?? '');
  const expectedOutput = compactWhitespace(parsed.expectedOutput ?? parsed.expected_output ?? '');
  if (!title || !goal || !expectedOutput) {
    return null;
  }
  if (isAgentDraftSchemaPlaceholder(title, goal, expectedOutput)) {
    return null;
  }
  const plan = Array.isArray(parsed.plan)
    ? parsed.plan.map((line) => compactWhitespace(line)).filter(Boolean).slice(0, 8)
    : [];
  return {
    title: truncateText(title, 40),
    goal,
    expectedOutput,
    plan: plan.length > 0 ? plan : buildLocalAgentPlan(goal),
    category: normalizeAgentCategory(parsed.category),
    riskLevel: normalizeAgentRisk(parsed.riskLevel ?? parsed.risk_level),
    mode: normalizeAgentMode(parsed.mode),
  };
}

function parseAgentVerificationResult(value: unknown): AgentVerificationResult | null {
  const parsed = parseJsonObject(value);
  if (!parsed) {
    return null;
  }
  const summary = compactWhitespace(parsed.summary ?? parsed.reason ?? '');
  const nextAction = normalizeAgentNextAction(parsed.nextAction ?? parsed.next_action);
  if (isAgentVerificationSchemaPlaceholder(summary)) {
    return null;
  }
  const issues = Array.isArray(parsed.issues)
    ? parsed.issues.map((issue) => compactWhitespace(issue)).filter(Boolean).slice(0, 8)
    : [];
  return {
    pass: Boolean(parsed.pass),
    summary: summary || (Boolean(parsed.pass) ? 'Verifier passed.' : 'Verifier did not pass.'),
    issues,
    nextAction: Boolean(parsed.pass) ? 'complete' : nextAction,
  };
}

function buildAssistantRecordRoutePrompt(
  rawInput: string,
  records: AssistantRecord[],
  locale: string | null,
  now: number,
): string {
  const language = normalizeLocale(locale) === 'zh-CN' ? '中文' : 'English';
  const candidates = records.map((record, index) => ({
    index: index + 1,
    id: record.id,
    type: record.type,
    title: record.title,
    content: truncateText(record.content, 700),
    status: record.status,
    priority: record.priority,
    dueAt: record.dueAt,
    remindAt: record.remindAt,
    recurrence: record.recurrence,
    tags: record.tags,
    updatedAt: record.updatedAt,
  }));
  return [
    `你是 CodexBridge 助理记录路由器。请用${language}判断这条 /as 自然语言输入是在“新建一条记录”，还是在“管理已有记录”。`,
    '只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    'Schema:',
    '{"action":"create|update|complete|cancel|archive|none","targetRecordId":null,"targetIndex":null,"type":"log|todo|reminder|note|uncategorized|null","reason":"简短判断理由","confidence":0.0}',
    '',
    '核心原则：',
    '- /as 是统一助理入口，用户不需要自己选择分类。你要按语义管理 log、todo、reminder、note 四类内容。',
    '- 如果用户是在描述一件新的事情要记录、提醒、待办或保存，action 必须是 create。',
    '- 只有用户明确在说已有记录的进展、完成、取消、删除、修正，且能和候选记录里的具体事项唯一对应时，才选择 update/complete/cancel/archive。',
    '- 不能因为“发票、账单、项目、今天、明天”等通用词相同就匹配旧记录。',
    '- 如果候选记录和用户输入只是同一大类但不是同一件事，必须 create。',
    '- 如果用户说“设置为提醒、remind、提醒我、给我发消息提醒”，且没有明确指向某条已有记录，必须 create，type 用 reminder。',
    '- 如果用户说“已经完成/做完/处理完”并明确指向候选记录，action 用 complete。',
    '- 如果用户说“不用了/取消/作废”并明确指向候选记录，action 用 cancel。',
    '- 如果用户说“删除/删掉/归档”并明确指向候选记录，action 用 archive。',
    '- 不确定时宁可 create，不要错误合并到旧记录。',
    '',
    `当前时间：${new Date(now).toISOString()}`,
    '',
    '候选已有记录 JSON：',
    JSON.stringify(candidates, null, 2),
    '',
    '用户输入：',
    rawInput,
  ].join('\n');
}

function parseAssistantRecordRouteDecision(value: unknown, records: AssistantRecord[]): AssistantRecordRouteDecision | null {
  const parsed = parseJsonObject(value);
  if (!parsed) {
    return null;
  }
  const action = normalizeAssistantRecordRouteAction(parsed.action);
  if (!action) {
    return null;
  }
  const confidence = clampAssistantConfidence(Number(parsed.confidence ?? 0.8));
  const targetRecordId = resolveAssistantRouteTargetRecordId(parsed, records);
  if (['update', 'complete', 'cancel', 'archive'].includes(action) && !targetRecordId) {
    return null;
  }
  return {
    action,
    targetRecordId: action === 'create' || action === 'none' ? null : targetRecordId,
    confidence,
    reason: truncateText(compactWhitespace(parsed.reason ?? ''), 120),
    type: normalizeAssistantRecordType(parsed.type),
  };
}

function resolveAssistantRouteTargetRecordId(parsed: Record<string, unknown>, records: AssistantRecord[]): string | null {
  const recordIds = new Set(records.map((record) => record.id));
  const targetId = compactWhitespace(parsed.targetRecordId ?? parsed.target_record_id ?? parsed.recordId ?? parsed.record_id ?? '');
  if (targetId && recordIds.has(targetId)) {
    return targetId;
  }
  const rawIndex = Number(parsed.targetIndex ?? parsed.target_index ?? parsed.index);
  if (Number.isInteger(rawIndex) && rawIndex > 0) {
    return records[rawIndex - 1]?.id ?? null;
  }
  return null;
}

function buildAssistantRecordRewritePrompt(
  record: AssistantRecord,
  instructions: string[],
  locale: string | null,
  now: number,
  timezone: string | null,
): string {
  const language = normalizeLocale(locale) === 'zh-CN' ? '中文' : 'English';
  const sourceRecord = {
    id: record.id,
    type: record.type,
    title: record.title,
    content: record.content,
    status: record.status,
    priority: record.priority,
    project: record.project,
    tags: record.tags,
    dueAt: record.dueAt,
    remindAt: record.remindAt,
    recurrence: record.recurrence,
    timezone: record.timezone,
  };
  return [
    `你是 CodexBridge 助理记录更新规范化器。请用${language}理解用户的修改意图，把“原记录”和“修改提示”合并成一条完整记录。`,
    '只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    '关键规则：',
    '- content 必须是完整合并后的记录内容，不能只返回增量。',
    '- 保留原记录里没有被用户否定的事实。',
    '- 如果用户说“不是 A，是 B”，必须把 A 修正为 B。',
    '- 删除“帮我记一下、这个东西要记一下、帮我整理、之后还得记一下”等对 AI 的元指令，不要写进 content。',
    '- 如果用户给了安排、步骤、列表，请整理成清晰的多行内容。',
    '- 所有相对时间都必须改写成绝对本地日期或绝对本地时间，不能把“昨天/今天/明天/下周四”原样保留在最终 content 里。',
    '- 如果用户修改了时间，content、dueAt、remindAt、recurrence 要保持一致。',
    '- title 要短，不能直接复制整段正文。',
    '- 不确定时保守更新，不要编造新事实。',
    '',
    'Schema:',
    '{"action":"update","type":"log|todo|reminder|note|uncategorized","title":"短标题","content":"完整合并后的内容","status":"pending|active|done|cancelled|archived","priority":"low|normal|high","dueAt":null,"remindAt":null,"recurrence":null,"project":null,"tags":[],"changeSummary":"这次具体改了什么","confidence":0.0}',
    '',
    ...buildAssistantPromptTimeContext(now, timezone ?? record.timezone),
    '',
    '原记录 JSON：',
    JSON.stringify(sourceRecord, null, 2),
    '',
    '修改提示：',
    ...instructions.map((instruction, index) => `${index + 1}. ${instruction}`),
  ].join('\n');
}

function parseAssistantRecordRewriteCandidate(value: unknown, fallbackRecord: AssistantRecord): AssistantRecordRewriteCandidate | null {
  const parsed = parseJsonObject(value);
  if (!parsed) {
    return null;
  }
  const content = normalizeMultilineText(parsed.content ?? parsed.updatedContent ?? parsed.updated_content);
  if (!content || isAssistantRecordRewriteSchemaPlaceholder(content)) {
    return null;
  }
  const type = normalizeAssistantRecordType(parsed.type) ?? fallbackRecord.type;
  const title = truncateText(compactWhitespace(parsed.title ?? '') || compactWhitespace(content), 80);
  return {
    action: normalizeAssistantRecordUpdateAction(parsed.action) ?? 'update',
    type,
    title: title || fallbackRecord.title,
    content,
    status: normalizeAssistantRecordStatus(parsed.status) ?? fallbackRecord.status,
    priority: normalizeAssistantRecordPriority(parsed.priority) ?? fallbackRecord.priority,
    dueAt: readAssistantTimestampField(parsed, ['dueAt', 'due_at'], fallbackRecord.dueAt),
    remindAt: readAssistantTimestampField(parsed, ['remindAt', 'remind_at'], fallbackRecord.remindAt),
    recurrence: readAssistantNullableStringField(parsed, ['recurrence'], fallbackRecord.recurrence),
    project: readAssistantNullableStringField(parsed, ['project'], fallbackRecord.project),
    tags: readAssistantStringArrayField(parsed, ['tags'], fallbackRecord.tags),
    changeSummary: truncateText(compactWhitespace(parsed.changeSummary ?? parsed.change_summary ?? ''), 120),
    confidence: clampAssistantConfidence(Number(parsed.confidence ?? fallbackRecord.confidence ?? 0.8)),
  };
}

function applyAssistantRecordRewriteCandidate(
  record: AssistantRecord,
  candidate: AssistantRecordRewriteCandidate,
  instructions: string[],
  source: 'codex' | 'agents-sdk',
  now: number,
): AssistantRecord | null {
  if (!candidate.content.trim()) {
    return null;
  }
  const inputText = instructions.join('\n');
  const parsedJson = {
    ...(record.parsedJson ?? {}),
    lastNaturalAction: {
      action: candidate.action,
      instruction: inputText,
      appliedAt: now,
      parser: `${source}-assistant-record-rewrite`,
      changeSummary: candidate.changeSummary || null,
    },
  };
  const next: AssistantRecord = {
    ...record,
    type: candidate.type,
    title: candidate.title || record.title,
    content: candidate.content,
    status: candidate.status,
    priority: candidate.priority,
    project: candidate.project,
    tags: candidate.tags,
    dueAt: candidate.dueAt,
    remindAt: candidate.remindAt,
    recurrence: candidate.recurrence,
    originalText: appendAssistantActionOriginalText(record.originalText, inputText),
    confidence: Math.max(record.confidence, candidate.confidence),
    parsedJson,
    parseStatus: 'edited',
    attachments: record.attachments.map((attachment) => ({ ...attachment })),
    updatedAt: now,
  };
  return normalizeAssistantRecordForStorage({
    ...next,
    completedAt: candidate.status === 'done' ? (record.completedAt ?? now) : record.completedAt,
    cancelledAt: candidate.status === 'cancelled' ? (record.cancelledAt ?? now) : record.cancelledAt,
    archivedAt: candidate.status === 'archived' ? (record.archivedAt ?? now) : record.archivedAt,
  }, { now });
}

function cloneAssistantRecord(record: AssistantRecord): AssistantRecord {
  return {
    ...record,
    tags: [...record.tags],
    attachments: record.attachments.map((attachment) => ({ ...attachment })),
    parsedJson: record.parsedJson ? { ...record.parsedJson } : null,
  };
}

function normalizeMultilineText(value: unknown): string {
  return String(value ?? '')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function isAssistantRecordRewriteSchemaPlaceholder(content: string): boolean {
  const normalized = compactWhitespace(content).toLowerCase();
  return normalized === '完整合并后的内容'
    || normalized === 'complete merged content';
}

function normalizeAssistantRecordUpdateAction(value: unknown): AssistantRecordUpdateAction | null {
  const normalized = compactWhitespace(value).toLowerCase();
  if (normalized === 'update' || normalized === 'complete' || normalized === 'cancel' || normalized === 'archive') {
    return normalized;
  }
  return null;
}

function normalizeAssistantRecordRouteAction(value: unknown): AssistantRecordRouteAction | null {
  const normalized = compactWhitespace(value).toLowerCase();
  if (
    normalized === 'create'
    || normalized === 'update'
    || normalized === 'complete'
    || normalized === 'cancel'
    || normalized === 'archive'
    || normalized === 'none'
  ) {
    return normalized;
  }
  return null;
}

function normalizeAssistantRecordType(value: unknown): AssistantRecordType | null {
  const normalized = compactWhitespace(value).toLowerCase();
  if (
    normalized === 'log'
    || normalized === 'todo'
    || normalized === 'reminder'
    || normalized === 'note'
    || normalized === 'uncategorized'
  ) {
    return normalized;
  }
  return null;
}

function normalizeAssistantRecordStatus(value: unknown): AssistantRecordStatus | null {
  const normalized = compactWhitespace(value).toLowerCase();
  if (
    normalized === 'pending'
    || normalized === 'active'
    || normalized === 'done'
    || normalized === 'cancelled'
    || normalized === 'archived'
  ) {
    return normalized;
  }
  return null;
}

function normalizeAssistantRecordPriority(value: unknown): AssistantRecordPriority | null {
  const normalized = compactWhitespace(value).toLowerCase();
  if (normalized === 'low' || normalized === 'normal' || normalized === 'high') {
    return normalized;
  }
  return null;
}

function readAssistantTimestampField(
  parsed: Record<string, any>,
  keys: string[],
  fallback: number | null,
): number | null {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) {
      continue;
    }
    return normalizeAssistantTimestamp(parsed[key]);
  }
  return fallback;
}

function normalizeAssistantTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function readAssistantNullableStringField(
  parsed: Record<string, any>,
  keys: string[],
  fallback: string | null,
): string | null {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) {
      continue;
    }
    const normalized = String(parsed[key] ?? '').trim();
    return normalized || null;
  }
  return fallback;
}

function readAssistantStringArrayField(
  parsed: Record<string, any>,
  keys: string[],
  fallback: string[],
): string[] {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) {
      continue;
    }
    if (!Array.isArray(parsed[key])) {
      return [];
    }
    const values = new Set<string>();
    for (const value of parsed[key]) {
      const normalized = compactWhitespace(value);
      if (normalized) {
        values.add(normalized.replace(/^#/u, ''));
      }
    }
    return [...values];
  }
  return [...fallback];
}

function clampAssistantConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.8;
  }
  return Math.max(0, Math.min(1, value));
}

function isAgentDraftSchemaPlaceholder(title: string, goal: string, expectedOutput: string): boolean {
  const normalized = [title, goal, expectedOutput].join('|').toLowerCase();
  return normalized.includes('短标题|明确目标|最终交付物')
    || normalized.includes('short title|clear goal|final deliverable');
}

function isAgentVerificationSchemaPlaceholder(summary: string): boolean {
  const normalized = summary.toLowerCase();
  return normalized === '简短结论' || normalized === 'short verdict';
}

function parseJsonObject(value: unknown): Record<string, any> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1]?.trim();
  const candidate = fenced || text.match(/\{[\s\S]*\}/u)?.[0] || text;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function buildLocalAgentDraftCandidate(rawInput: string): AgentDraftCandidate {
  const normalized = compactWhitespace(rawInput);
  const title = truncateText(normalized || 'Agent', 40);
  return {
    title,
    goal: normalized,
    expectedOutput: '完成任务并把最终结果、验证结果和风险说明返回到当前微信会话。',
    plan: buildLocalAgentPlan(normalized),
    category: inferAgentCategory(normalized),
    riskLevel: inferAgentRisk(normalized),
    mode: inferAgentMode(normalized),
  };
}

function buildLocalAgentPlan(goal: string): string[] {
  const base = compactWhitespace(goal);
  return [
    '澄清目标并确认执行范围',
    base.includes('代码') || /code|test|build|repo|仓库|修复|实现/u.test(base)
      ? '读取相关代码并制定最小改动方案'
      : '收集相关上下文并拆解执行步骤',
    '执行任务并保留关键过程记录',
    '运行可用验证并根据结果修复一次',
    '把最终结果和风险说明发回微信',
  ];
}

function inferAgentCategory(text: string): AgentJobCategory {
  const normalized = text.toLowerCase();
  if (/代码|修复|实现|测试|构建|repo|code|test|build|typescript|ts/u.test(normalized)) {
    return 'code';
  }
  if (/部署|重启|服务|日志|系统|deploy|restart|service|log/u.test(normalized)) {
    return 'ops';
  }
  if (/文档|总结|方案|readme|doc|markdown|md/u.test(normalized)) {
    return 'doc';
  }
  if (/图片|视频|音频|media|image|video|audio/u.test(normalized)) {
    return 'media';
  }
  if (/研究|搜索|分析|research|search|compare/u.test(normalized)) {
    return 'research';
  }
  return 'mixed';
}

function inferAgentRisk(text: string): AgentJobRiskLevel {
  if (/删除|上线|生产|数据库|支付|权限|delete|prod|database|payment|credential/u.test(text.toLowerCase())) {
    return 'high';
  }
  if (/修改|部署|重启|commit|push|deploy|restart|write/u.test(text.toLowerCase())) {
    return 'medium';
  }
  return 'low';
}

function inferAgentMode(text: string): AgentJobMode {
  const category = inferAgentCategory(text);
  if (category === 'code' || category === 'ops') {
    return 'codex';
  }
  if (category === 'research') {
    return 'agents';
  }
  return 'hybrid';
}

function normalizeAgentCategory(value: unknown): AgentJobCategory {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['code', 'research', 'ops', 'doc', 'media', 'mixed'].includes(normalized)) {
    return normalized as AgentJobCategory;
  }
  return 'mixed';
}

function normalizeAgentRisk(value: unknown): AgentJobRiskLevel {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }
  return 'medium';
}

function normalizeAgentMode(value: unknown): AgentJobMode {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'agents' || normalized === 'hybrid') {
    return normalized;
  }
  return 'hybrid';
}

function normalizeAgentNextAction(value: unknown): 'complete' | 'retry' | 'fail' {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'complete' || normalized === 'retry' || normalized === 'fail') {
    return normalized;
  }
  return 'retry';
}

function resolveAgentHardFailure(result): string | null {
  const state = String(result?.outputState ?? 'complete').toLowerCase();
  if (['failed', 'error', 'timed_out', 'timeout', 'interrupted', 'cancelled', 'canceled', 'aborted'].includes(state)) {
    return `Provider turn did not complete: ${state}`;
  }
  const text = compactWhitespace(result?.outputText ?? result?.previewText ?? '');
  const artifacts = Array.isArray(result?.outputArtifacts) ? result.outputArtifacts : [];
  const media = Array.isArray(result?.outputMedia) ? result.outputMedia : [];
  if (!text && artifacts.length === 0 && media.length === 0) {
    return 'Provider returned no text or attachments.';
  }
  return null;
}

function summarizeAgentResult(result): string {
  const text = compactWhitespace(result?.outputText ?? result?.previewText ?? '');
  if (text) {
    return truncateText(text, 180);
  }
  const artifacts = Array.isArray(result?.outputArtifacts) ? result.outputArtifacts.length : 0;
  const media = Array.isArray(result?.outputMedia) ? result.outputMedia.length : 0;
  if (artifacts || media) {
    return `attachments: ${artifacts + media}`;
  }
  return '';
}

function extractLastAssistantThreadText(thread): string {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const text = joinTurnRoleRawText(turns[index]?.items, 'assistant');
    if (text) {
      return text;
    }
  }
  return '';
}

function isAgentResultPreviewOnly(job: AgentJob, text: unknown): boolean {
  const normalized = stripAgentArtifactProtocol(text).trim();
  if (!normalized) {
    return false;
  }
  const preview = stripAgentArtifactProtocol(job.lastResultPreview ?? '').trim();
  if (preview) {
    if (normalized === preview && looksLikeTruncatedPreview(preview)) {
      return true;
    }
    const normalizedPrefix = normalized.replace(/…$/u, '');
    if (
      normalized.endsWith('…')
      && normalized.length <= preview.length
      && preview.startsWith(normalizedPrefix)
      && looksLikeTruncatedPreview(preview)
    ) {
      return true;
    }
    return false;
  }
  return looksLikeTruncatedPreview(normalized);
}

function looksLikeTruncatedPreview(text: string): boolean {
  const normalized = String(text ?? '').trim();
  return normalized.length >= 100 && normalized.endsWith('…');
}

function readCodexRolloutLastAgentMessage(threadId: string): string {
  const normalizedThreadId = compactWhitespace(threadId);
  if (!normalizedThreadId) {
    return '';
  }
  const codexHome = compactWhitespace(process.env.CODEX_HOME) || path.join(os.homedir(), '.codex');
  const sessionsDir = path.join(codexHome, 'sessions');
  const files = findCodexRolloutFilesByThreadId(sessionsDir, normalizedThreadId);
  let recovered = '';
  for (const filePath of files) {
    const message = extractCodexRolloutLastAgentMessage(filePath);
    if (message) {
      recovered = message;
    }
  }
  return recovered;
}

function findCodexRolloutFilesByThreadId(rootDir: string, threadId: string): string[] {
  const results: string[] = [];
  const stack = [rootDir];
  let visited = 0;
  while (stack.length > 0 && visited < 5000) {
    const dir = stack.pop();
    if (!dir) {
      continue;
    }
    visited += 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(filePath);
        continue;
      }
      if (entry.isFile() && entry.name.includes(threadId) && entry.name.endsWith('.jsonl')) {
        results.push(filePath);
      }
    }
  }
  return results.sort((left, right) => {
    try {
      return fs.statSync(left).mtimeMs - fs.statSync(right).mtimeMs;
    } catch {
      return left.localeCompare(right);
    }
  });
}

function extractCodexRolloutLastAgentMessage(filePath: string): string {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
  let recovered = '';
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let record: any;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (record?.type === 'event_msg' && record?.payload?.type === 'task_complete') {
      const message = stripAgentArtifactProtocol(record.payload.last_agent_message ?? '');
      if (message) {
        recovered = message;
      }
      continue;
    }
    if (record?.type === 'response_item') {
      const message = extractAssistantResponseItemText(record.payload);
      if (message) {
        recovered = stripAgentArtifactProtocol(message);
      }
    }
  }
  return recovered.trim();
}

function extractAssistantResponseItemText(payload: unknown): string {
  const item = payload as any;
  if (item?.type !== 'message' || item?.role !== 'assistant' || !Array.isArray(item?.content)) {
    return '';
  }
  return item.content
    .map((contentItem) => {
      if (contentItem?.type === 'output_text' || contentItem?.type === 'text') {
        return String(contentItem?.text ?? '').trim();
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function stripAgentArtifactProtocol(text: unknown): string {
  return String(text ?? '')
    .replace(/\n?```codexbridge-artifacts\s*[\s\S]*?```\n?/giu, '\n')
    .trim();
}

function joinTurnRoleRawText(items, role): string {
  if (!Array.isArray(items)) {
    return '';
  }
  return items
    .filter((item) => item?.role === role)
    .map((item) => String(item?.text ?? '').trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function paginateTextByUtf8(text: string, maxBytes: number): string[] {
  const normalized = String(text ?? '').trim();
  if (!normalized) {
    return [];
  }
  const pages: string[] = [];
  let remaining = normalized;
  while (remaining) {
    const chunk = sliceTextByUtf8Boundary(remaining, maxBytes).trim();
    if (!chunk) {
      break;
    }
    pages.push(chunk);
    remaining = remaining.slice(chunk.length).replace(/^[\s\n]+/u, '');
  }
  return pages.length > 0 ? pages : [normalized];
}

function sliceTextByUtf8Boundary(text: string, maxBytes: number): string {
  const normalized = String(text ?? '');
  if (Buffer.byteLength(normalized, 'utf8') <= maxBytes) {
    return normalized;
  }
  let bytes = 0;
  let lastWhitespaceIndex = -1;
  let lastPunctuationIndex = -1;
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    bytes += Buffer.byteLength(character, 'utf8');
    if (/\s/u.test(character)) {
      lastWhitespaceIndex = index;
    }
    if (/[。！？；，、.!?;,]/u.test(character)) {
      lastPunctuationIndex = index + 1;
    }
    if (bytes > maxBytes) {
      const splitAt = lastPunctuationIndex > 0
        ? lastPunctuationIndex
        : lastWhitespaceIndex > 0
          ? lastWhitespaceIndex
          : index;
      return normalized.slice(0, Math.max(1, splitAt));
    }
  }
  return normalized;
}

function sanitizeFilename(value: string): string {
  const normalized = String(value ?? '').trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_')
    .replace(/\s+/gu, ' ')
    .slice(0, 80)
    .trim();
  return normalized || 'agent-result';
}

function normalizeAgentArtifactsForStorage(artifacts: OutputArtifact[]): TurnArtifactDeliveredItem[] {
  return normalizeAgentArtifacts(artifacts);
}

function normalizeAgentArtifacts(value: unknown): TurnArtifactDeliveredItem[] {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => {
      const pathValue = String(item?.path ?? '').trim();
      if (!pathValue) {
        return null;
      }
      const kind = normalizeAgentArtifactKind(item?.kind);
      if (!kind) {
        return null;
      }
      return {
        kind,
        path: pathValue,
        displayName: normalizeNullableDisplayString(item?.displayName),
        mimeType: normalizeNullableDisplayString(item?.mimeType),
        sizeBytes: normalizeNullableArtifactSize(item?.sizeBytes),
        caption: normalizeNullableDisplayString(item?.caption),
        source: normalizeAgentArtifactSource(item?.source),
        turnId: normalizeNullableDisplayString(item?.turnId),
      };
    })
    .filter(Boolean) as TurnArtifactDeliveredItem[];
}

function normalizeAgentArtifactKind(value: unknown): TurnArtifactDeliveredItem['kind'] | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'image' || normalized === 'file' || normalized === 'video' || normalized === 'audio') {
    return normalized;
  }
  return null;
}

function normalizeAgentArtifactSource(value: unknown): TurnArtifactDeliveredItem['source'] {
  const normalized = String(value ?? '').trim();
  if (normalized === 'provider_native' || normalized === 'bridge_declared' || normalized === 'bridge_fallback') {
    return normalized;
  }
  return 'provider_native';
}

function normalizeNullableDisplayString(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized : null;
}

function normalizeNullableArtifactSize(value: unknown): number | null {
  const normalized = Number(value ?? NaN);
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : null;
}

function formatAgentArtifactSummary(artifacts: TurnArtifactDeliveredItem[], i18n: Translator): string {
  const count = artifacts.length;
  const names = artifacts
    .slice(0, 2)
    .map((artifact) => artifact.displayName || path.basename(artifact.path))
    .filter(Boolean);
  if (names.length === 0) {
    return i18n.t('coordinator.agent.attachmentCount', { count });
  }
  const suffix = count > names.length ? ` +${count - names.length}` : '';
  return `${i18n.t('coordinator.agent.attachmentCount', { count })}（${names.join('、')}${suffix}）`;
}

function formatAgentArtifactLine(
  artifact: TurnArtifactDeliveredItem,
  index: number,
  i18n: Translator,
): string {
  const name = artifact.displayName || path.basename(artifact.path) || i18n.t('common.unknown');
  const size = artifact.sizeBytes == null ? '' : `，${formatBinarySize(artifact.sizeBytes)}`;
  return `${index + 1}. ${name}（${artifact.kind}${size}）\n${artifact.path}`;
}

function extractAgentBody(text: string): string {
  const normalized = String(text ?? '').trim();
  return compactWhitespace(normalized.replace(/^\/\S+\s*/u, ''));
}

function extractAgentAddBody(text: string): string {
  const normalized = String(text ?? '').trim();
  const match = normalized.match(/^\/\S+\s+add\s+([\s\S]+)$/iu);
  return compactWhitespace(match?.[1] ?? '');
}

function extractAgentEditBody(text: string): string {
  const normalized = String(text ?? '').trim();
  const match = normalized.match(/^\/\S+\s+edit\s+([\s\S]+)$/iu);
  return compactWhitespace(match?.[1] ?? '');
}

function extractAgentRenameTitle(text: string): string {
  const normalized = String(text ?? '').trim();
  const match = normalized.match(/^\/\S+\s+rename\s+\S+\s+([\s\S]+)$/iu);
  return compactWhitespace(match?.[1] ?? '');
}

function formatAgentNormalizer(value: string, i18n: Translator): string {
  if (value === 'agents-sdk') {
    return i18n.t('coordinator.agent.normalizer.agents');
  }
  if (value === 'codex') {
    return i18n.t('coordinator.agent.normalizer.codex');
  }
  return i18n.t('coordinator.agent.normalizer.local');
}

function formatAgentMode(value: string, i18n: Translator): string {
  if (value === 'codex') {
    return i18n.t('coordinator.agent.mode.codex');
  }
  if (value === 'agents') {
    return i18n.t('coordinator.agent.mode.agents');
  }
  return i18n.t('coordinator.agent.mode.hybrid');
}

function formatAgentCategory(value: string, i18n: Translator): string {
  return i18n.t(`coordinator.agent.category.${value}`) === `coordinator.agent.category.${value}`
    ? value
    : i18n.t(`coordinator.agent.category.${value}`);
}

function formatAgentRisk(value: string, i18n: Translator): string {
  return i18n.t(`coordinator.agent.risk.${value}`) === `coordinator.agent.risk.${value}`
    ? value
    : i18n.t(`coordinator.agent.risk.${value}`);
}

function formatAgentStatusLabel(status: string, running: boolean, i18n: Translator): string {
  if (running) {
    return i18n.t('coordinator.agent.status.running');
  }
  const key = `coordinator.agent.status.${status}`;
  const localized = i18n.t(key);
  return localized === key ? status : localized;
}

function parseAutomationAddSpec(text: string) {
  const input = String(text ?? '').trim();
  const match = input.match(/^\/\S+\s+add\s+(.+)$/iu);
  if (!match) {
    return null;
  }
  const rawBody = String(match[1] ?? '').trim();
  if (!rawBody) {
    return null;
  }
  const separatorIndex = rawBody.indexOf('|');
  if (separatorIndex < 0) {
    return null;
  }
  const left = rawBody.slice(0, separatorIndex).trim();
  const prompt = rawBody.slice(separatorIndex + 1).trim();
  if (!left || !prompt) {
    return null;
  }

  let mode: 'standalone' | 'thread' = 'standalone';
  let scheduleSpec = left;
  const modeMatch = left.match(/^(standalone|thread)\b\s*(.*)$/iu);
  if (modeMatch) {
    mode = modeMatch[1].toLowerCase() === 'thread' ? 'thread' : 'standalone';
    scheduleSpec = String(modeMatch[2] ?? '').trim();
  }
  if (!scheduleSpec) {
    return null;
  }

  const intervalMatch = scheduleSpec.match(/^every\s+(.+)$/iu);
  if (intervalMatch) {
    const everySeconds = parseAutomationIntervalSeconds(intervalMatch[1]);
    if (!everySeconds) {
      return null;
    }
    const label = `every ${formatAutomationIntervalLabel(everySeconds)}`;
    return {
      mode,
      prompt,
      title: deriveAutomationTitle(prompt),
      schedule: {
        kind: 'interval' as const,
        everySeconds,
        label,
      },
    };
  }

  const dailyMatch = scheduleSpec.match(/^daily\s+(\d{1,2}):(\d{2})$/iu);
  if (dailyMatch) {
    const hour = Number(dailyMatch[1]);
    const minute = Number(dailyMatch[2]);
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return null;
    }
    return {
      mode,
      prompt,
      title: deriveAutomationTitle(prompt),
      schedule: {
        kind: 'daily' as const,
        hour,
        minute,
        timeZone: 'UTC',
        label: `daily ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} UTC`,
      },
    };
  }

  const cronMatch = scheduleSpec.match(/^cron\s+(.+)$/iu);
  if (cronMatch) {
    const expression = String(cronMatch[1] ?? '').trim();
    if (expression.split(/\s+/u).length !== 5) {
      return null;
    }
    return {
      mode,
      prompt,
      title: deriveAutomationTitle(prompt),
      schedule: {
        kind: 'cron' as const,
        expression,
        timeZone: 'UTC',
        label: `cron ${expression} UTC`,
      },
    };
  }

  return null;
}

function extractAutomationAddBody(text: string): string {
  const normalized = String(text ?? '').trim();
  const match = normalized.match(/^\/\S+\s+add\s+([\s\S]+)$/iu);
  return compactWhitespace(match?.[1] ?? '');
}

function buildAutomationDraftKey(scopeRef: PlatformScopeRef): string {
  return formatPlatformScopeKey(scopeRef.platform, scopeRef.externalScopeId);
}

function buildAssistantUpdateDraftKey(scopeRef: PlatformScopeRef): string {
  return formatPlatformScopeKey(scopeRef.platform, scopeRef.externalScopeId);
}

function buildAssistantPromptTimeContext(now: number, timezone: string | null): string[] {
  const resolvedTimezone = normalizeAssistantPromptTimezone(timezone);
  return [
    `当前 UTC 时间：${new Date(now).toISOString()}`,
    `当前本地时区：${resolvedTimezone}`,
    `当前本地时间：${formatAssistantPromptLocalDateTime(now, resolvedTimezone)}`,
  ];
}

function formatAssistantPromptLocalDateTime(timestamp: number, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return `${formatter.format(new Date(timestamp))} ${timezone === 'Etc/UTC' ? 'UTC' : timezone}`;
}

function normalizeAssistantPromptTimezone(timezone: string | null): string {
  const normalized = String(timezone ?? '').trim();
  return normalized || 'Etc/UTC';
}

function buildTurnArtifactIntentPrompt(
  rawInput: string,
  locale: string | null,
  now: number,
  timezone: string | null,
): string {
  const language = normalizeLocale(locale) === 'zh-CN' ? '中文' : 'English';
  const resolvedTimezone = normalizeAssistantPromptTimezone(timezone);
  return [
    `你是 CodexBridge 的附件交付意图分类器。请用${language}判断用户这条消息是否真的要求“返回一个附件/文件/图片/媒体交付物”。`,
    '只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    'Schema:',
    '{"action":"none|deliver_file|deliver_image|deliver_video|deliver_audio|clarify","preferredKind":"file|image|video|audio|null","requestedFormat":null,"requestedFileName":null,"textOnly":false,"explicit":false,"confidence":0.0,"reason":"简短理由"}',
    '',
    '判断规则：',
    '- 只有当用户明确要求“导出/整理成某种文件/做成附件/返回图片或文件/发送给我附件”时，action 才能是 deliver_*。',
    '- 只是提到文件、抱怨附件、讨论“为什么又发文件”、说“不要文件/不要附件/直接文本回复”、分析现有文件、总结上传的文档，这些都必须是 action=none。',
    '- 如果用户明确要求纯文本回复，不要附件，则 action=none 且 textOnly=true。',
    '- 如果用户明确要求返回一个交付物，但格式没指定，也不要追问格式；直接用 action=deliver_file，requestedFormat=null。',
    '- requestedFileName 只有在用户明确给出具体文件名时才填写。',
    '- 如果用户只是要求“把结论发到微信/直接回复给我”，这仍然是普通文本回复，不是附件交付，action=none。',
    '- 不确定时宁可返回 none，不要误判成要附件。',
    '',
    `当前 UTC 时间：${new Date(now).toISOString()}`,
    `当前本地时区：${resolvedTimezone}`,
    '',
    '用户输入：',
    rawInput,
  ].join('\n');
}

function buildAssistantRecordDraftPrompt(
  rawInput: string,
  forcedType: AssistantRecordType | null,
  locale: string | null,
  now: number,
  timezone: string | null,
): string {
  const language = normalizeLocale(locale) === 'zh-CN' ? '中文' : 'English';
  const forcedTypeLine = forcedType
    ? `- 用户使用了强制分类命令，type 必须是 "${forcedType}"。`
    : '- 请根据语义自行选择 type。';
  const timeContextLines = buildAssistantPromptTimeContext(now, timezone);
  return [
    `你是 CodexBridge 助理记录分类器。请用${language}把用户输入转换成一条结构化助理记录。`,
    '只返回严格 JSON，不要 Markdown，不要解释。',
    '',
    'Schema:',
    '{"type":"log|todo|reminder|note|uncategorized","title":"短标题","content":"保存给用户看的完整内容","priority":"low|normal|high","dueAt":null,"remindAt":null,"recurrence":null,"project":null,"tags":[],"confidence":0.0}',
    '',
    '分类规则：',
    '- todo：用户要做、需要做、必须完成、要跟进、要处理、要测算/核算/报价/整理/提交的事情。',
    '- reminder：用户明确要求到某个时间提醒、叫他、通知他；有周期提醒时填写 recurrence。',
    '- log：已经发生的事实、当天记录、复盘、测试结果、完成记录。',
    '- note：长期保存的资料、想法、参考信息，不要求行动。',
    '- uncategorized：无法可靠判断。',
    forcedTypeLine,
    '',
    '内容规则：',
    '- content 要保留事实和要求，但删除“帮我记录/整理/列出来/放哪里合适/这个东西要记一下”等对 AI 的元指令。',
    '- “今天”本身不是 log 证据；如果用户说今天要做/必须做完，应归为 todo。',
    '- 用户说高优先级、重要、必须今天完成、紧急时 priority 用 high。',
    '- title 要短，不能直接复制一整段长文本。',
    '- tags 保留 #标签，但不要带 # 前缀。',
    '- 所有相对时间都必须换算成绝对本地日期或绝对本地时间，不能把“昨天/今天/明天/后天/下周四/本周五/今晚”原样写进 content。',
    '- content 里涉及时间时，直接写成“YYYY-MM-DD HH:mm 时区”或“YYYY-MM-DD 时区”。',
    '- 如果只有日期没有具体时分：todo 的 dueAt 默认用当天 23:59；reminder 不要编造 remindAt，可保留 null。',
    '- dueAt/remindAt 可返回 ISO 时间字符串或 null；没有明确时间就用 null，不要编造。',
    '- recurrence 可用简短自然语言或 null。',
    '- confidence 表示你对结构化结果的置信度，0 到 1。',
    '',
    ...timeContextLines,
    '',
    '用户输入：',
    rawInput,
  ].join('\n');
}

function parseTurnArtifactIntentCandidate(
  value: unknown,
  rawInput: string,
  source: 'codex' | 'agents-sdk',
): TurnArtifactIntent | null {
  const parsed = parseJsonObject(value);
  if (!parsed) {
    return null;
  }
  const action = normalizeTurnArtifactIntentAction(parsed.action ?? parsed.intent ?? parsed.result);
  if (!action) {
    return null;
  }
  const textOnly = Boolean(parsed.textOnly ?? parsed.text_only ?? parsed.preferTextOnly ?? parsed.prefer_text_only);
  const explicit = Boolean(parsed.explicit ?? parsed.isExplicit ?? parsed.is_explicit);
  const reason = truncateText(compactWhitespace(parsed.reason ?? parsed.summary ?? ''), 160);
  const confidence = clampAssistantConfidence(Number(parsed.confidence ?? 0.8));
  const requestedFileName = sanitizeRequestedArtifactFileName(
    parsed.requestedFileName
      ?? parsed.requested_filename
      ?? parsed.fileName
      ?? parsed.filename,
  );
  let requestedFormat = normalizeRequestedArtifactFormat(
    parsed.requestedFormat
      ?? parsed.requested_format
      ?? parsed.format,
  );
  if (!requestedFormat && requestedFileName) {
    requestedFormat = normalizeRequestedArtifactFormat(path.extname(requestedFileName));
  }
  let preferredKind = normalizeTurnArtifactIntentKind(parsed.preferredKind ?? parsed.preferred_kind ?? parsed.kind);
  if (!preferredKind && requestedFormat) {
    preferredKind = artifactKindForRequestedFormat(requestedFormat);
  }
  if (!preferredKind && action !== 'none' && action !== 'clarify') {
    preferredKind = artifactKindForTurnArtifactAction(action);
  }
  if (textOnly || action === 'none' || action === 'clarify') {
    return buildEmptyTurnArtifactIntent();
  }
  return {
    requested: true,
    preferredKind: preferredKind ?? 'file',
    requestedFormat,
    requestedExtension: requestedArtifactExtensionForFormat(requestedFormat),
    requestedFileName,
    userDescription: explicit ? rawInput : (reason || rawInput),
    requiresClarification: false,
  };
}

function parseAssistantRecordDraftCandidate(
  value: unknown,
  rawInput: string,
  forcedType: AssistantRecordType | null,
  fallbackDraft: AssistantRecordDraft,
  source: AssistantRecordDraftNormalizeSource,
): AssistantRecordDraft | null {
  const parsed = parseJsonObject(value);
  if (!parsed) {
    return null;
  }
  const content = normalizeMultilineText(parsed.content ?? parsed.text ?? parsed.body);
  if (!content || isAssistantRecordDraftSchemaPlaceholder(content)) {
    return null;
  }
  const parsedType = normalizeAssistantRecordType(parsed.type);
  const type = forcedType ?? parsedType ?? fallbackDraft.type;
  const title = truncateText(compactWhitespace(parsed.title ?? '') || compactWhitespace(content), 80) || fallbackDraft.title;
  const priority = normalizeAssistantRecordPriority(parsed.priority) ?? fallbackDraft.priority;
  const confidence = clampAssistantConfidence(Number(parsed.confidence ?? fallbackDraft.confidence ?? 0.8));
  return {
    type,
    title,
    content,
    originalText: rawInput,
    priority,
    project: readAssistantNullableStringField(parsed, ['project'], fallbackDraft.project),
    tags: readAssistantStringArrayField(parsed, ['tags'], fallbackDraft.tags),
    dueAt: type === 'todo'
      ? readAssistantTimestampField(parsed, ['dueAt', 'due_at'], fallbackDraft.dueAt)
      : null,
    remindAt: type === 'reminder'
      ? readAssistantTimestampField(parsed, ['remindAt', 'remind_at'], fallbackDraft.remindAt)
      : null,
    recurrence: type === 'reminder'
      ? readAssistantNullableStringField(parsed, ['recurrence'], fallbackDraft.recurrence)
      : null,
    confidence,
    parsedJson: {
      ...(fallbackDraft.parsedJson ?? {}),
      normalizer: source,
      modelConfidence: confidence,
      modelType: parsedType,
    },
  };
}

function isAssistantRecordDraftSchemaPlaceholder(content: string): boolean {
  const normalized = compactWhitespace(content).toLowerCase();
  return normalized === '保存给用户看的完整内容'
    || normalized === 'complete content to save for the user';
}

function buildAutomationDraftPrompt(rawInput: string, locale: SupportedLocale): string {
  const localizedModeHint = locale === 'zh-CN'
    ? '默认 mode 是 standalone；只有用户明确说“继续当前线程/当前对话/沿用当前上下文”时才用 thread。'
    : 'Default mode is standalone. Use thread only when the user explicitly asks to continue the current thread or reuse the current conversation context.';
  const localizedInstruction = locale === 'zh-CN'
    ? `你是 CodexBridge 的 automation 草案规范化器。请理解用户的自然语言意图，并转换成 JSON，仅返回 JSON，不要加解释。

支持的结果格式：
{
  "valid": true,
  "title": "简短标题",
  "mode": "standalone" | "thread",
  "schedules": [
    {
      "kind": "interval",
      "everySeconds": 1800
    }
  ],
  "task": "真正执行时要发送给 Codex 的任务文本"
}
或
{
  "valid": true,
  "title": "简短标题",
  "mode": "standalone" | "thread",
  "schedules": [
    {
      "kind": "daily",
      "hour": 7,
      "minute": 0
    }
  ],
  "task": "真正执行时要发送给 Codex 的任务文本"
}
或
{
  "valid": true,
  "title": "简短标题",
  "mode": "standalone" | "thread",
  "schedules": [
    {
      "kind": "cron",
      "expression": "0 18 * * 1-5"
    }
  ],
  "task": "真正执行时要发送给 Codex 的任务文本"
}
也兼容单个 schedule：
{
  "valid": true,
  "title": "简短标题",
  "mode": "standalone" | "thread",
  "schedule": {
    "kind": "interval",
    "everySeconds": 1800
  },
  "task": "真正执行时要发送给 Codex 的任务文本"
}

理解要求：
- 用户可以完全用自然语言描述时间和任务，不需要写 every/daily/cron。
- 只允许三种 schedule.kind：interval / daily / cron。
- interval 必须给 everySeconds，单位秒，且至少 60。
- daily 和 cron 按 UTC 理解。
- 如果用户给出多个独立时间点，例如“每天 8:00、13:00、17:30”，输出多个 schedules，不要返回 invalid。
- 多个每日时间点优先输出多个 daily schedule；多个工作日时间点优先输出多个 cron schedule。
- 用户提到“工作日/周一到周五”等规则时，优先输出 cron。
- ${localizedModeHint}
- 保留用户提到的 skill 名称到 task 里。
- 不要把“发送到微信/通知我/发给我”删掉，但 delivery 本身由桥接处理。
- task 应该是每次到点真正要发给 Codex 执行的完整任务，不要包含调度说明。
- 如果无法可靠解析，返回：
  {"valid": false, "reason": "简短原因"}

用户请求：
${rawInput}`
    : `You are the CodexBridge automation-draft normalizer. Understand the user's natural-language intent and convert it into JSON. Return JSON only with no explanation.

Supported result formats:
{
  "valid": true,
  "title": "short title",
  "mode": "standalone" | "thread",
  "schedules": [
    {
      "kind": "interval",
      "everySeconds": 1800
    }
  ],
  "task": "task text to run later"
}
or
{
  "valid": true,
  "title": "short title",
  "mode": "standalone" | "thread",
  "schedules": [
    {
      "kind": "daily",
      "hour": 7,
      "minute": 0
    }
  ],
  "task": "task text to run later"
}
or
{
  "valid": true,
  "title": "short title",
  "mode": "standalone" | "thread",
  "schedules": [
    {
      "kind": "cron",
      "expression": "0 18 * * 1-5"
    }
  ],
  "task": "task text to run later"
}
Single schedule is also accepted:
{
  "valid": true,
  "title": "short title",
  "mode": "standalone" | "thread",
  "schedule": {
    "kind": "interval",
    "everySeconds": 1800
  },
  "task": "task text to run later"
}

Requirements:
- The user may describe schedule and task entirely in natural language. They do not need to write every/daily/cron.
- Only use interval / daily / cron.
- interval requires everySeconds in seconds and must be at least 60.
- daily and cron are interpreted in UTC.
- If the user gives multiple independent times, such as "daily at 8:00, 13:00, and 17:30", return multiple schedules instead of invalid.
- Prefer multiple daily schedules for multiple daily times. Prefer multiple cron schedules for multiple weekday/workday times.
- Prefer cron when the user says weekdays / workdays / Monday-Friday.
- ${localizedModeHint}
- Preserve skill names in the task text.
- Do not remove "send to WeChat / notify me / send me" intent from the task text.
- The task should be the complete prompt to run at each scheduled time. Do not include schedule wording inside task.
- If the request cannot be parsed reliably, return:
  {"valid": false, "reason": "short reason"}

User request:
${rawInput}`;
  return localizedInstruction.trim();
}

function buildAutomationDraftEditPrompt(draft: PendingAutomationDraft, instruction: string, locale: SupportedLocale): string {
  const currentDraft = {
    title: draft.title,
    mode: draft.mode,
    schedules: getAutomationDraftSchedules(draft).map((schedule) => automationScheduleToModelJson(schedule)),
    task: draft.prompt,
  };
  const localizedInstruction = locale === 'zh-CN'
    ? `你是 CodexBridge 的 automation 草案编辑器。请把用户的“修改意见”合并到“当前草案”里，输出更新后的完整 automation 草案 JSON。
只返回 JSON，不要 Markdown，不要解释。

这是编辑已有草案，不是重新新建草案。

返回格式：
{
  "valid": true,
  "title": "简短标题",
  "mode": "standalone" | "thread",
  "schedules": [
    {
      "kind": "daily",
      "hour": 8,
      "minute": 0
    }
  ],
  "task": "每次到点真正要发送给 Codex 执行的完整任务文本"
}

编辑规则：
- 修改意见只覆盖它明确提到的字段；没有提到的 title / mode / schedules / task 必须从当前草案保留。
- 如果用户说“任务不变/内容不变/只改时间”，必须保留当前 task。
- 如果用户只改任务内容，必须保留当前 schedules。
- 如果用户给出多个独立时间点，例如“每天 8:00、13:00、17:30”，输出多个 schedules。
- task 不要包含调度说明；它只描述每次执行时要做什么。
- 不要把当前草案丢掉后仅按修改意见重新生成。
- 如果无法可靠合并，返回 {"valid": false, "reason": "简短原因"}。

当前草案 JSON：
${JSON.stringify(currentDraft, null, 2)}

修改意见：
${instruction}`
    : `You are the CodexBridge automation draft editor. Merge the user's edit instruction into the current draft and output the updated full automation draft JSON.
Return JSON only. Do not use markdown or explanations.

This edits an existing draft. It is not a new draft.

Return format:
{
  "valid": true,
  "title": "short title",
  "mode": "standalone" | "thread",
  "schedules": [
    {
      "kind": "daily",
      "hour": 8,
      "minute": 0
    }
  ],
  "task": "complete task text to send to Codex each time"
}

Edit rules:
- Only override fields explicitly mentioned by the edit instruction. Preserve title / mode / schedules / task from the current draft when not mentioned.
- If the user says the task/content should stay unchanged, preserve the current task.
- If the user only changes the task, preserve the current schedules.
- If the user gives multiple independent times, such as "daily at 8:00, 13:00, and 17:30", return multiple schedules.
- The task must not include schedule wording. It should only describe what to do on each run.
- Do not discard the current draft and regenerate only from the edit instruction.
- If the edit cannot be merged reliably, return {"valid": false, "reason": "short reason"}.

Current draft JSON:
${JSON.stringify(currentDraft, null, 2)}

Edit instruction:
${instruction}`;
  return localizedInstruction.trim();
}

function parseAutomationDraftCandidate(text: string): AutomationDraftCandidate | null {
  const payload = extractFirstJsonObject(text);
  if (!payload) {
    return null;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || parsed.valid === false) {
    return null;
  }
  const prompt = compactWhitespace(String(parsed.task ?? ''));
  if (!prompt) {
    return null;
  }
  const title = compactWhitespace(String(parsed.title ?? '')) || deriveAutomationTitle(prompt);
  const modeValue = String(parsed.mode ?? 'standalone').trim().toLowerCase();
  const mode: AutomationMode = modeValue === 'thread' ? 'thread' : 'standalone';
  const schedules = normalizeAutomationSchedules(parsed);
  if (schedules.length === 0) {
    return null;
  }
  return {
    title,
    mode,
    schedule: schedules[0],
    schedules,
    prompt,
  };
}

function normalizeAutomationSchedules(parsed: Record<string, any>): AutomationSchedule[] {
  const candidates = Array.isArray(parsed.schedules)
    ? parsed.schedules
    : Array.isArray(parsed.schedule)
      ? parsed.schedule
      : [parsed.schedule ?? null];
  const schedules = candidates
    .map((value) => normalizeAutomationSchedule(value))
    .filter((schedule): schedule is AutomationSchedule => Boolean(schedule));
  const seen = new Set<string>();
  const unique = [];
  for (const schedule of schedules) {
    const key = JSON.stringify(schedule);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(schedule);
  }
  return unique.slice(0, 12);
}

function normalizeAutomationSchedule(value: any): AutomationSchedule | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const kind = String(value.kind ?? '').trim().toLowerCase();
  if (kind === 'interval') {
    const everySeconds = Math.max(60, Math.floor(Number(value.everySeconds ?? 0)));
    if (!Number.isFinite(everySeconds) || everySeconds < 60) {
      return null;
    }
    return {
      kind: 'interval',
      everySeconds,
      label: `every ${formatAutomationIntervalLabel(everySeconds)}`,
    };
  }
  if (kind === 'daily') {
    const hour = Number(value.hour);
    const minute = Number(value.minute);
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return null;
    }
    return {
      kind: 'daily',
      hour,
      minute,
      timeZone: 'UTC',
      label: `daily ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} UTC`,
    };
  }
  if (kind === 'cron') {
    const expression = compactWhitespace(String(value.expression ?? ''));
    if (expression.split(/\s+/u).length !== 5) {
      return null;
    }
    return {
      kind: 'cron',
      expression,
      timeZone: 'UTC',
      label: `cron ${expression} UTC`,
    };
  }
  return null;
}

function cloneAutomationSchedule(schedule: AutomationSchedule): AutomationSchedule {
  if (schedule.kind === 'interval') {
    return {
      kind: 'interval',
      everySeconds: schedule.everySeconds,
      label: schedule.label,
    };
  }
  if (schedule.kind === 'daily') {
    return {
      kind: 'daily',
      hour: schedule.hour,
      minute: schedule.minute,
      timeZone: schedule.timeZone,
      label: schedule.label,
    };
  }
  return {
    kind: 'cron',
    expression: schedule.expression,
    timeZone: schedule.timeZone,
    label: schedule.label,
  };
}

function automationScheduleToModelJson(schedule: AutomationSchedule): Record<string, unknown> {
  if (schedule.kind === 'interval') {
    return {
      kind: 'interval',
      everySeconds: schedule.everySeconds,
    };
  }
  if (schedule.kind === 'daily') {
    return {
      kind: 'daily',
      hour: schedule.hour,
      minute: schedule.minute,
    };
  }
  return {
    kind: 'cron',
    expression: schedule.expression,
  };
}

function getAutomationCandidateSchedules(candidate: AutomationDraftCandidate): AutomationSchedule[] {
  const schedules = Array.isArray(candidate.schedules) && candidate.schedules.length > 0
    ? candidate.schedules
    : candidate.schedule
      ? [candidate.schedule]
      : [];
  return schedules.filter(Boolean).slice(0, 12);
}

function getAutomationDraftSchedules(draft: PendingAutomationDraft): AutomationSchedule[] {
  return Array.isArray(draft.schedules) && draft.schedules.length > 0
    ? draft.schedules
    : [draft.schedule];
}

function formatAutomationDraftSchedules(draft: PendingAutomationDraft): string {
  return getAutomationDraftSchedules(draft)
    .map((schedule) => schedule.label)
    .join('；');
}

function appendAutomationDraftEditInput(rawInput: string, instruction: string): string {
  const base = String(rawInput ?? '').trim();
  const edit = compactWhitespace(instruction);
  if (!base) {
    return edit;
  }
  return `${base}\nEdit: ${edit}`;
}

function appendAgentDraftEditInput(rawInput: string, instruction: string): string {
  const base = String(rawInput ?? '').trim();
  const edit = compactWhitespace(instruction);
  if (!base) {
    return edit;
  }
  return `${base}\nEdit: ${edit}`;
}

function extractFirstJsonObject(text: string): string | null {
  const raw = String(text ?? '').trim();
  if (!raw) {
    return null;
  }
  const fencedMatch = raw.match(/```json\s*([\s\S]+?)```/iu) ?? raw.match(/```\s*([\s\S]+?)```/iu);
  const candidate = String(fencedMatch?.[1] ?? raw).trim();
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return null;
  }
  return candidate.slice(firstBrace, lastBrace + 1);
}

function parseAutomationIntervalSeconds(value: string): number | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  const match = normalized.match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/u);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  if (!Number.isInteger(amount) || amount <= 0) {
    return null;
  }
  const unit = match[2];
  if (['s', 'sec', 'secs', 'second', 'seconds'].includes(unit)) {
    return amount;
  }
  if (['m', 'min', 'mins', 'minute', 'minutes'].includes(unit)) {
    return amount * 60;
  }
  if (['h', 'hr', 'hrs', 'hour', 'hours'].includes(unit)) {
    return amount * 3_600;
  }
  return amount * 86_400;
}

function formatAutomationIntervalLabel(seconds: number): string {
  const normalized = Math.max(60, Math.floor(Number(seconds ?? 0)));
  if (normalized % 86_400 === 0) {
    return `${normalized / 86_400}d`;
  }
  if (normalized % 3_600 === 0) {
    return `${normalized / 3_600}h`;
  }
  if (normalized % 60 === 0) {
    return `${normalized / 60}m`;
  }
  return `${normalized}s`;
}

function deriveAutomationTitle(prompt: string): string {
  const normalized = compactWhitespace(prompt);
  if (!normalized) {
    return 'Automation';
  }
  return normalized.length <= 28 ? normalized : `${normalized.slice(0, 28)}...`;
}

function extractAutomationRenameTitle(text: string): string {
  const normalized = String(text ?? '').trim();
  const match = normalized.match(/^\/\S+\s+rename\s+\S+\s+([\s\S]+)$/iu);
  return compactWhitespace(match?.[1] ?? '');
}

function extractAutomationEditBody(text: string): string {
  const normalized = String(text ?? '').trim();
  const match = normalized.match(/^\/\S+\s+edit\s+([\s\S]+)$/iu);
  return compactWhitespace(match?.[1] ?? '');
}

function resolveOverrideBridgeSessionId(event: InboundTextEvent | null | undefined): string | null {
  const metadata = event?.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }
  const codexbridge = (metadata as Record<string, unknown>).codexbridge;
  if (!codexbridge || typeof codexbridge !== 'object') {
    return null;
  }
  const overrideBridgeSessionId = (codexbridge as Record<string, unknown>).overrideBridgeSessionId;
  const normalized = typeof overrideBridgeSessionId === 'string' ? overrideBridgeSessionId.trim() : '';
  return normalized || null;
}

function isAutomationEvent(event: InboundTextEvent | null | undefined): boolean {
  const metadata = event?.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return false;
  }
  const codexbridge = (metadata as Record<string, unknown>).codexbridge;
  if (!codexbridge || typeof codexbridge !== 'object') {
    return false;
  }
  const automationJobId = (codexbridge as Record<string, unknown>).automationJobId;
  return typeof automationJobId === 'string' && automationJobId.trim().length > 0;
}

function formatAutomationMode(mode: string, i18n: Translator): string {
  if (mode === 'thread') {
    return i18n.t('coordinator.auto.mode.thread');
  }
  return i18n.t('coordinator.auto.mode.standalone');
}

function formatAutomationStatusLabel(status: string, running: boolean, i18n: Translator): string {
  if (running) {
    return i18n.t('coordinator.auto.status.running');
  }
  if (status === 'paused') {
    return i18n.t('coordinator.auto.status.paused');
  }
  return i18n.t('coordinator.auto.status.active');
}

function buildThreadBrowserKey(event) {
  return formatPlatformScopeKey(event.platform, event.externalScopeId);
}

function withTurnArtifactContext(event: InboundTextEvent, turnArtifactContext) {
  if (!turnArtifactContext) {
    return event;
  }
  return withCodexbridgeMetadata(event, {
    turnArtifactContext,
  });
}

function withRetryContext(event: InboundTextEvent, retryContext) {
  if (!retryContext || typeof retryContext !== 'object') {
    return event;
  }
  return withCodexbridgeMetadata(event, {
    retryContext,
  });
}

function withExplicitPluginTargetHints(event: InboundTextEvent, explicitPluginTargets: ExplicitPluginTargetHint[]) {
  const normalizedTargets = Array.isArray(explicitPluginTargets)
    ? explicitPluginTargets.filter((entry) => entry && typeof entry === 'object')
    : [];
  if (normalizedTargets.length === 0) {
    return event;
  }
  return withCodexbridgeMetadata(event, {
    explicitPluginTarget: normalizedTargets[0],
    explicitPluginTargets: normalizedTargets,
  });
}

function resolveExplicitPluginTargetHint(event: InboundTextEvent | null | undefined): ExplicitPluginTargetHint | null {
  const hints = resolveExplicitPluginTargetHints(event);
  return hints[0] ?? null;
}

function resolveExplicitPluginTargetHints(event: InboundTextEvent | null | undefined): ExplicitPluginTargetHint[] {
  const metadata = event?.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return [];
  }
  const codexbridge = (metadata as Record<string, unknown>).codexbridge;
  if (!codexbridge || typeof codexbridge !== 'object') {
    return [];
  }
  const hints = (codexbridge as Record<string, unknown>).explicitPluginTargets;
  if (Array.isArray(hints)) {
    return hints.filter((entry) => entry && typeof entry === 'object') as ExplicitPluginTargetHint[];
  }
  const hint = (codexbridge as Record<string, unknown>).explicitPluginTarget;
  if (!hint || typeof hint !== 'object') {
    return [];
  }
  return [hint as ExplicitPluginTargetHint];
}

function withCodexbridgeMetadata(event: InboundTextEvent, updates: Record<string, unknown>) {
  const metadata = event?.metadata && typeof event.metadata === 'object'
    ? event.metadata
    : {};
  const codexbridge = metadata?.codexbridge && typeof metadata.codexbridge === 'object'
    ? metadata.codexbridge
    : {};
  return {
    ...event,
    metadata: {
      ...metadata,
      codexbridge: {
        ...codexbridge,
        ...updates,
      },
    },
  };
}

function normalizeArtifactsForResponse(result): OutputArtifact[] {
  const outputArtifacts = Array.isArray(result?.outputArtifacts) ? result.outputArtifacts : [];
  if (outputArtifacts.length > 0) {
    return outputArtifacts;
  }
  const outputMedia = Array.isArray(result?.outputMedia) ? result.outputMedia : [];
  return outputMedia
    .map((media) => {
      const mediaPath = String(media?.path ?? '').trim();
      if (!mediaPath) {
        return null;
      }
      return {
        kind: 'image' as const,
        path: mediaPath,
        caption: typeof media?.caption === 'string' ? media.caption : null,
        source: 'provider_native' as const,
      };
    })
    .filter(Boolean) as OutputArtifact[];
}

function renderThreadsPageMessage({
  i18n,
  providerProfile,
  currentSession,
  items,
  pageNumber,
  searchTerm,
  includeArchived,
  onlyPinned,
  hasPreviousPage,
  hasNextPage,
}) {
  const currentItem = currentSession && currentSession.providerProfileId === providerProfile.id
    ? items.find((item) => item.threadId === currentSession.codexThreadId) ?? null
    : null;
  const currentTitle = currentSession && currentSession.providerProfileId === providerProfile.id
    ? formatCurrentBindingTitle(currentItem?.title ?? currentSession.title, currentSession.codexThreadId, i18n)
    : i18n.t('common.none');
  const lines = [
    i18n.t('coordinator.threadList.title', { providerProfileId: providerProfile.id }),
    i18n.t('coordinator.threadList.currentBinding', { title: currentTitle }),
    i18n.t('coordinator.threadList.page', { pageNumber }),
  ];
  if (includeArchived) {
    lines.push(i18n.t('coordinator.threadList.includeArchived'));
  }
  if (onlyPinned) {
    lines.push(i18n.t('coordinator.threadList.onlyPinned'));
  }
  if (searchTerm) {
    lines.push(i18n.t('coordinator.threadList.search', { term: searchTerm }));
  }
  lines.push('');
  for (const [index, item] of items.entries()) {
    const marker = currentSession?.providerProfileId === providerProfile.id && currentSession.codexThreadId === item.threadId
      ? '*'
      : ' ';
    const archivedTag = typeof item.archivedAt === 'number'
      ? ` ${i18n.t('coordinator.threadList.archivedTag')}`
      : '';
    const pinnedTag = typeof item.pinnedAt === 'number'
      ? ` ${i18n.t('coordinator.threadList.pinnedTag')}`
      : '';
    lines.push(`${marker} ${index + 1}. ${formatThreadTitle(item.title, item.preview, i18n)}${pinnedTag}${archivedTag}`);
    lines.push(`   ${i18n.t('coordinator.threadList.preview', { preview: normalizeThreadPreview(item.preview, i18n) })}`);
    lines.push(`   ${i18n.t('coordinator.threadList.updatedAt', { value: formatRelativeTime(item.updatedAt, i18n) })}`);
    lines.push('');
  }
  lines.push(buildThreadsFooter({
    i18n,
    includeArchived,
    onlyPinned,
    hasPreviousPage,
    hasNextPage,
    exampleIndex: Math.min(2, Math.max(1, items.length)),
    restoreIndex: includeArchived
      ? Math.max(1, items.findIndex((item) => typeof item.archivedAt === 'number') + 1 || 1)
      : null,
    pinnedIndex: Math.max(1, items.findIndex((item) => typeof item.pinnedAt === 'number') + 1 || 1),
  }));
  return lines.join('\n').trim();
}

function buildThreadsFooter({ i18n, includeArchived, onlyPinned, hasPreviousPage, hasNextPage, exampleIndex, restoreIndex, pinnedIndex }: {
  i18n: Translator;
  includeArchived: boolean;
  onlyPinned: boolean;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  exampleIndex: number;
  restoreIndex: number | null;
  pinnedIndex: number | null;
}) {
  const index = Number(exampleIndex || 1);
  const resolvedRestoreIndex = Number(restoreIndex || index || 1);
  const resolvedPinnedIndex = Number(pinnedIndex || index || 1);
  const commands = [
    `/open ${index}`,
    `/peek ${index}`,
    `/rename ${index} ${i18n.t('common.example.newName')}`,
    includeArchived ? `/threads restore ${resolvedRestoreIndex}` : `/threads del ${index}`,
    onlyPinned ? `/threads unpin ${resolvedPinnedIndex}` : `/threads pin ${index}`,
    includeArchived ? '/threads' : onlyPinned ? '/threads' : '/threads all',
    onlyPinned ? '/threads all' : '/threads pin',
    `/search ${i18n.t('common.example.keyword')}`,
  ];
  if (hasPreviousPage) {
    commands.push('/prev');
  }
  if (hasNextPage) {
    commands.push('/next');
  }
  return i18n.t('coordinator.threadList.actions', { commands: commands.join('  ') });
}

function formatCurrentBindingTitle(title, threadId, i18n: Translator) {
  const normalizedTitle = normalizeCwd(title);
  if (normalizedTitle) {
    return normalizedTitle;
  }
  const normalizedThreadId = normalizeCwd(threadId);
  if (normalizedThreadId) {
    return `${i18n.t('coordinator.thread.untitled')} (${normalizedThreadId})`;
  }
  return i18n.t('coordinator.thread.untitled');
}

function renderThreadPeek(thread, i18n: Translator) {
  const turns = extractRecentThreadTurns(thread.turns);
  const lines = [
    i18n.t('coordinator.threadPeek.title', { title: formatThreadTitle(thread.title, thread.preview, i18n) }),
    i18n.t('coordinator.threadPeek.thread', { threadId: thread.threadId }),
    i18n.t('coordinator.threadPeek.preview', { preview: normalizeThreadPreview(thread.preview, i18n) }),
  ];
  if (turns.length === 0) {
    lines.push('', i18n.t('coordinator.threadPeek.noTurns'));
    return lines.join('\n');
  }
  lines.push('', i18n.t('coordinator.threadPeek.recentTurns', { count: turns.length }));
  for (const [index, turn] of turns.entries()) {
    lines.push('');
    lines.push(i18n.t('coordinator.threadPeek.user', {
      index: index + 1,
      text: truncateText(turn.userText || i18n.t('common.empty'), 220),
    }));
    lines.push(formatAssistantTurnLine(turn.status, truncateText(turn.assistantText || i18n.t('common.empty'), 260), i18n));
  }
  return lines.join('\n');
}

function extractRecentThreadTurns(turns) {
  if (!Array.isArray(turns) || turns.length === 0) {
    return [];
  }
  const recent = [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const userText = joinTurnRoleText(turn?.items, 'user');
    const assistantText = joinTurnRoleText(turn?.items, 'assistant');
    if (!userText && !assistantText) {
      continue;
    }
    recent.unshift({
      userText,
      assistantText,
      status: classifyPreviewTurnStatus(turn?.status, assistantText),
    });
    if (recent.length >= THREAD_HISTORY_TURN_LIMIT) {
      break;
    }
  }
  return recent;
}

function joinTurnRoleText(items, role) {
  if (!Array.isArray(items)) {
    return '';
  }
  return compactWhitespace(items
    .filter((item) => item?.role === role)
    .map((item) => item?.text ?? '')
    .join(' '));
}

function classifyPreviewTurnStatus(status, assistantText) {
  const normalized = String(status ?? '').trim().toLowerCase();
  if (assistantText && ['completed', 'complete', 'succeeded', 'success', 'finished'].includes(normalized)) {
    return 'complete';
  }
  if (['interrupted', 'cancelled', 'canceled', 'aborted'].includes(normalized)) {
    return 'interrupted';
  }
  if (['failed', 'error'].includes(normalized)) {
    return 'failed';
  }
  return assistantText ? 'partial' : 'missing';
}

function isProviderTurnTerminal(status) {
  const normalized = String(status ?? '').trim().toLowerCase();
  return [
    'completed',
    'complete',
    'succeeded',
    'success',
    'finished',
    'failed',
    'error',
    'timed_out',
    'timeout',
    'interrupted',
    'cancelled',
    'canceled',
    'aborted',
  ].includes(normalized);
}

function formatAssistantTurnLine(status, text, i18n: Translator) {
  switch (status) {
    case 'interrupted':
      return i18n.t('coordinator.threadPeek.assistant.interrupted', { text });
    case 'failed':
      return i18n.t('coordinator.threadPeek.assistant.failed', { text });
    case 'partial':
      return i18n.t('coordinator.threadPeek.assistant.partial', { text });
    default:
      return i18n.t('coordinator.threadPeek.assistant.complete', { text });
  }
}

function formatThreadTitle(title, preview, i18n: Translator) {
  const resolved = compactWhitespace(title || '');
  if (resolved) {
    return truncateText(resolved, 48);
  }
  const fallback = compactWhitespace(preview || '');
  if (fallback) {
    return truncateText(fallback, 48);
  }
  return i18n.t('coordinator.thread.untitled');
}

function normalizeThreadPreview(preview, i18n: Translator) {
  const normalized = compactWhitespace(preview || '');
  return normalized ? truncateText(normalized, THREAD_PREVIEW_LIMIT) : i18n.t('coordinator.thread.emptyPreview');
}

function buildEmptyTurnArtifactIntent(): TurnArtifactIntent {
  return {
    requested: false,
    preferredKind: null,
    requestedFormat: null,
    requestedExtension: null,
    requestedFileName: null,
    userDescription: null,
    requiresClarification: false,
  };
}

function normalizeTurnArtifactIntentAction(value: unknown): 'none' | 'deliver_file' | 'deliver_image' | 'deliver_video' | 'deliver_audio' | 'clarify' | null {
  const normalized = compactWhitespace(value).toLowerCase();
  switch (normalized) {
    case 'none':
    case 'no':
    case 'text':
    case 'text_only':
      return 'none';
    case 'deliver_file':
    case 'file':
    case 'attachment':
      return 'deliver_file';
    case 'deliver_image':
    case 'image':
    case 'photo':
      return 'deliver_image';
    case 'deliver_video':
    case 'video':
      return 'deliver_video';
    case 'deliver_audio':
    case 'audio':
      return 'deliver_audio';
    case 'clarify':
    case 'ambiguous':
      return 'clarify';
    default:
      return null;
  }
}

function normalizeTurnArtifactIntentKind(value: unknown): TurnArtifactIntent['preferredKind'] {
  const normalized = compactWhitespace(value).toLowerCase();
  switch (normalized) {
    case 'image':
    case 'photo':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'file':
    case 'document':
    case 'attachment':
      return 'file';
    default:
      return null;
  }
}

function normalizeRequestedArtifactFormat(value: unknown): string | null {
  const normalized = compactWhitespace(value).toLowerCase().replace(/^\./u, '');
  if (!normalized) {
    return null;
  }
  const aliasMap: Record<string, string> = {
    jpeg: 'jpg',
    word: 'docx',
    doc: 'docx',
    xls: 'xlsx',
    markdown: 'md',
    htm: 'html',
  };
  const resolved = aliasMap[normalized] ?? normalized;
  return new Set([
    'png',
    'jpg',
    'webp',
    'docx',
    'pdf',
    'xlsx',
    'csv',
    'zip',
    'md',
    'txt',
    'json',
    'html',
    'mp4',
    'mov',
    'webm',
    'mp3',
    'wav',
    'ogg',
    'm4a',
  ]).has(resolved) ? resolved : null;
}

function requestedArtifactExtensionForFormat(format: string | null): string | null {
  if (!format) {
    return null;
  }
  return format.startsWith('.') ? format : `.${format}`;
}

function artifactKindForRequestedFormat(format: string | null): TurnArtifactIntent['preferredKind'] {
  switch (format) {
    case 'png':
    case 'jpg':
    case 'webp':
      return 'image';
    case 'mp4':
    case 'mov':
    case 'webm':
      return 'video';
    case 'mp3':
    case 'wav':
    case 'ogg':
    case 'm4a':
      return 'audio';
    case 'docx':
    case 'pdf':
    case 'xlsx':
    case 'csv':
    case 'zip':
    case 'md':
    case 'txt':
    case 'json':
    case 'html':
      return 'file';
    default:
      return null;
  }
}

function artifactKindForTurnArtifactAction(action: 'deliver_file' | 'deliver_image' | 'deliver_video' | 'deliver_audio'): TurnArtifactIntent['preferredKind'] {
  switch (action) {
    case 'deliver_image':
      return 'image';
    case 'deliver_video':
      return 'video';
    case 'deliver_audio':
      return 'audio';
    default:
      return 'file';
  }
}

function sanitizeRequestedArtifactFileName(value: unknown): string | null {
  const normalized = compactWhitespace(value);
  if (!normalized) {
    return null;
  }
  const baseName = path.basename(normalized);
  const sanitized = baseName.replace(/[\u0000-\u001f<>:"/\\|?*]+/gu, '-').trim();
  return sanitized || null;
}

function compactWhitespace(value) {
  return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

function truncateText(value, limit) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

function formatRelativeTime(value, i18n: Translator, now = Date.now()) {
  return formatRelativeTimeLocalized(value, i18n.locale, now);
}

function isHelpFlag(value) {
  return HELP_FLAG_SET.has(normalizeHelpFlag(value));
}

function parseExplicitLocale(value) {
  const normalized = normalizeLocale(value);
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || !['zh', 'zh-cn', 'zh-hans', 'en', 'en-us'].includes(raw)) {
    return null;
  }
  return normalized;
}

function normalizeCommandName(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return COMMAND_CANONICAL_NAME_MAP.get(normalized) ?? normalized;
}

function assistantCommandNameForType(type: AssistantRecordType | null): string {
  switch (type) {
    case 'log':
      return '/log';
    case 'todo':
      return '/todo';
    case 'reminder':
      return '/remind';
    case 'note':
      return '/note';
    default:
      return '/as';
  }
}

function renderAssistantRecordTimeLine(record: AssistantRecord, i18n: Translator): string {
  if (record.type === 'reminder' && record.remindAt) {
    return i18n.t('coordinator.assistant.remindAtLine', {
      value: formatDateTimeForAssistant(record.remindAt, record.timezone),
    });
  }
  if (record.type === 'todo' && record.dueAt) {
    return i18n.t('coordinator.assistant.dueAtLine', {
      value: formatDateTimeForAssistant(record.dueAt, record.timezone),
    });
  }
  if (record.recurrence) {
    return i18n.t('coordinator.assistant.recurrenceLine', {
      value: record.recurrence,
    });
  }
  return '';
}

function formatDateTimeForAssistant(timestamp: number, timezone: string | null = null): string {
  if (!Number.isFinite(timestamp)) {
    return '';
  }
  const resolvedTimezone = normalizeAssistantPromptTimezone(timezone);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolvedTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${formatter.format(new Date(timestamp))} ${resolvedTimezone === 'Etc/UTC' ? 'UTC' : resolvedTimezone}`;
}

function inferAssistantRecordNaturalAction(input: string): AssistantRecordUpdateAction | null {
  const value = compactWhitespace(input).toLowerCase();
  if (!value) {
    return null;
  }
  if (/(?:删除|删掉|移除|归档|清掉|清除)/u.test(value)) {
    return 'archive';
  }
  if (/(?:取消|不用了|不需要了|作废|撤销|先不做|不用做|不要了)/u.test(value)) {
    return 'cancel';
  }
  if (
    /(?:全部|全都|所有|这件事|这个事|这条|该事项|任务|提醒).{0,16}(?:完成|做完|搞定|办完|处理完|结束)/u.test(value)
    || /(?:已经|已)(?:完成|做完|搞定|办完|处理完|结束)/u.test(value)
    || /(?:已经|已).{0,10}(?:打了|打过|回复了|联系了|提交了|整理完|修好了)/u.test(value)
  ) {
    return 'complete';
  }
  if (
    /(?:还差|剩下|补充|更新|进展|状态|改成|改为|改到|改在|变成|换成|提前|推迟|延期|延后|已经|已拿|拿回|拿到|没有|还欠|少了|多了|加上|追加|改一下|变更)/u.test(value)
  ) {
    return 'update';
  }
  return null;
}

function isExplicitAssistantCreateRequest(input: string): boolean {
  const value = compactWhitespace(input);
  if (!value) {
    return false;
  }
  return /(?:^|[，,。；;\s])(?:新增|新建|添加|增加|记一条新的|记一个新的|新记一条|再记一条|再加一条|另记一条|另加一条).{0,24}(?:待办|todo|提醒|reminder|日志|log|笔记|note|事项|任务)/u.test(value)
    || /^(?:新增|新建|添加|增加)(?:一个|一条)?(?:待办|todo|提醒|reminder|日志|log|笔记|note)/u.test(value);
}

function shouldCreateAssistantRecordInsteadOfUpdating(input: string): boolean {
  const value = compactWhitespace(input);
  if (!value) {
    return false;
  }
  if (isExplicitAssistantCreateRequest(value)) {
    return true;
  }
  if (isDisavowingExistingAssistantMatch(value)) {
    return true;
  }
  if (hasAssistantRecordTypeCreateIntent(value) && !hasExplicitExistingAssistantRecordReference(value)) {
    return true;
  }
  return false;
}

function isDisavowingExistingAssistantMatch(input: string): boolean {
  return /(?:完全新的|全新的|新的内容|另一件事|另一个事项|跟.+?(?:没关系|无关|不相关)|不是(?:这个|那个|原来|之前|已有).{0,12}(?:todo|待办|记录|提醒|事项))/iu.test(input);
}

function hasAssistantRecordTypeCreateIntent(input: string): boolean {
  return /(?:设为|设置为|标记为|作为|做成|归为|类型(?:是|为)|这是(?:一个)?|这个是|我这是).{0,24}(?:提醒|remind|代办|todo|日志|log|笔记|note)/iu.test(input)
    || /(?:提醒我|给我.{0,16}提醒|发.{0,12}消息.{0,12}提醒|remind\s+me)/iu.test(input);
}

function hasExplicitExistingAssistantRecordReference(input: string): boolean {
  return /(?:记录|条目|事项)\s*#?\d+/iu.test(input)
    || /(?:第|#)\s*\d+\s*(?:条|个|项)?/iu.test(input)
    || /(?:刚才|上面|上一条|当前|这个|这条|该|原来|之前|已有).{0,10}(?:记录|条|事项|todo|待办|提醒|日志|笔记)/iu.test(input);
}

function findBestAssistantRecordMatch(records: AssistantRecord[], input: string): { record: AssistantRecord; score: number } | null {
  const scored = records
    .filter((record) => record.status !== 'archived')
    .map((record) => ({ record, score: scoreAssistantRecordMatch(record, input) }))
    .filter((entry) => entry.score >= 30)
    .sort((left, right) => right.score - left.score || right.record.updatedAt - left.record.updatedAt);
  return scored[0] ?? null;
}

function scoreAssistantRecordMatch(record: AssistantRecord, input: string): number {
  const haystack = normalizeAssistantMatchText([
    record.title,
    record.content,
    record.originalText,
    record.project ?? '',
    ...record.tags,
  ].join('\n'));
  const title = normalizeAssistantMatchText(record.title);
  const normalizedInput = normalizeAssistantMatchText(input);
  if (!haystack || !normalizedInput) {
    return 0;
  }
  let score = 0;
  if (title && (normalizedInput.includes(title) || title.includes(normalizedInput))) {
    score += 70;
  }
  if (haystack.includes(normalizedInput)) {
    score += 50;
  }
  const tokens = extractAssistantMatchTokens(input);
  const matchedTokens = new Set<string>();
  for (const token of tokens) {
    if (!haystack.includes(token)) {
      continue;
    }
    matchedTokens.add(token);
    score += token.length >= 4 ? 12 : 8;
    if (title.includes(token)) {
      score += 4;
    }
  }
  if (matchedTokens.has('发票') && /发票/u.test(haystack)) {
    score += 10;
  }
  if (record.status === 'done' || record.status === 'cancelled') {
    score -= 15;
  }
  return score;
}

function normalizeAssistantMatchText(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

function extractAssistantMatchTokens(input: string): string[] {
  const tokens = new Set<string>();
  for (const match of String(input ?? '').matchAll(/[\p{Script=Han}]+|[a-zA-Z0-9._-]+/gu)) {
    const raw = String(match[0] ?? '').toLowerCase();
    if (!raw || ASSISTANT_MATCH_STOPWORDS.has(raw)) {
      continue;
    }
    if (/^[\p{Script=Han}]+$/u.test(raw)) {
      if (raw.length <= 4) {
        addAssistantMatchToken(tokens, raw);
      }
      const maxLength = Math.min(4, raw.length);
      for (let size = 2; size <= maxLength; size += 1) {
        for (let index = 0; index + size <= raw.length; index += 1) {
          addAssistantMatchToken(tokens, raw.slice(index, index + size));
        }
      }
      continue;
    }
    addAssistantMatchToken(tokens, raw);
  }
  return [...tokens];
}

function addAssistantMatchToken(tokens: Set<string>, token: string): void {
  const normalized = normalizeAssistantMatchText(token);
  if (normalized.length < 2 || ASSISTANT_MATCH_STOPWORDS.has(normalized)) {
    return;
  }
  tokens.add(normalized);
}

const ASSISTANT_MATCH_STOPWORDS = new Set([
  '今天',
  '明天',
  '昨天',
  '已经',
  '完成',
  '做完',
  '搞定',
  '事情',
  '这个',
  '那个',
  '这件',
  '那件',
  '记录',
  '提醒',
  '帮我',
  '一下',
  '处理',
  '更新',
  '状态',
  '进展',
  '还有',
  '还差',
  '剩下',
  '取消',
  '删除',
  '拿回',
  '拿到',
  '需要',
  '不用',
  '任务',
  '修改',
  '改成',
  '改到',
]);

function shouldTreatAssistantCompletionAsPartialUpdate(record: AssistantRecord, input: string): boolean {
  const text = String(input ?? '');
  if (/(?:全部|全都|所有|都)(?:已经)?(?:拿到|拿回|完成|处理|搞定|办完)/u.test(text)) {
    return false;
  }
  if (/(?:还差|剩下|其中|部分|另外|其他|第[一二三四五六七八九十0-9]+|这张|那张|这个|那个)/u.test(text)) {
    return true;
  }
  if (/发票/u.test(text) && /发票/u.test(record.content) && hasListLikeAssistantContent(record.content)) {
    return true;
  }
  return false;
}

function hasListLikeAssistantContent(content: string): boolean {
  const lines = String(content ?? '').split(/\r?\n/u);
  const numbered = lines.filter((line) => /^\s*(?:\d+[\).、]|[-*])\s+/u.test(line)).length;
  return numbered >= 2;
}

function appendAssistantActionOriginalText(originalText: string, input: string): string {
  const normalizedInput = String(input ?? '').trim();
  if (!normalizedInput) {
    return String(originalText ?? '').trim();
  }
  const current = String(originalText ?? '').trim();
  const line = `自然语言更新：${normalizedInput}`;
  return current ? `${current}\n${line}` : line;
}

function extractEventTimezone(event: any): string | null {
  const metadata = event?.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const timezone = (metadata as Record<string, any>).timezone
      ?? (metadata as Record<string, any>).timeZone
      ?? ((metadata as Record<string, any>).weixin as Record<string, any> | undefined)?.timezone
      ?? ((metadata as Record<string, any>).weixin as Record<string, any> | undefined)?.timeZone;
    if (typeof timezone === 'string' && timezone.trim()) {
      return timezone.trim();
    }
  }
  return null;
}

function normalizeHelpTarget(value) {
  const normalized = normalizeCommandName(String(value ?? '').replace(/^\//u, ''));
  if (!normalized) {
    return '';
  }
  return isHelpFlag(normalized) ? 'helps' : normalized;
}

function resolveCommandHelpSpec(name, i18n: Translator) {
  const normalized = normalizeHelpTarget(name);
  if (!normalized) {
    return null;
  }
  const specs = getCommandHelpSpecs(i18n);
  const canonical = buildCommandCanonicalNameMap(specs, HIDDEN_COMMAND_ALIASES).get(normalized) ?? null;
  return canonical ? specs[canonical] ?? null : null;
}

function renderCommandCatalog(i18n: Translator) {
  const specs = getCommandHelpSpecs(i18n);
  const lines = [
    i18n.t('coordinator.help.catalogTitle'),
    '',
  ];
  for (const commandName of COMMAND_HELP_ORDER) {
    const spec = specs[commandName];
    const aliasLabel = spec.aliases.length > 0 ? ` (${spec.aliases.map((alias) => `/${alias}`).join(', ')})` : '';
    lines.push(`/${spec.name}${aliasLabel} ${spec.summary}`);
  }
  lines.push(i18n.t('coordinator.help.localPulseLine'));
  lines.push('');
  lines.push(i18n.t('coordinator.help.helpLabel'));
  lines.push(i18n.t('coordinator.help.exampleLabel'));
  lines.push(i18n.t('coordinator.help.noteLabel'));
  return lines.join('\n');
}

function renderCommandHelp(spec, i18n: Translator) {
  const lines = [
    i18n.t('coordinator.help.commandLabel', { name: spec.name }),
    i18n.t('coordinator.help.summaryLabel', { summary: spec.summary }),
  ];
  if (spec.aliases.length > 0) {
    lines.push(i18n.t('coordinator.help.aliasesLabel', { aliases: spec.aliases.map((alias) => `/${alias}`).join(' ') }));
  }
  lines.push('');
  lines.push(i18n.t('coordinator.help.usageLabel'));
  for (const usage of spec.usage) {
    lines.push(usage);
  }
  lines.push('');
  lines.push(i18n.t('coordinator.help.examplesLabel'));
  for (const example of spec.examples) {
    lines.push(example);
  }
  if (spec.notes.length > 0) {
    lines.push('');
    lines.push(i18n.t('coordinator.help.notesLabel'));
    for (const note of spec.notes) {
      lines.push(note);
    }
  }
  return lines.join('\n');
}

function getCommandHelpSpecs(i18n: Translator) {
  return Object.freeze({
  helps: freezeCommandHelp({
    name: 'helps',
    aliases: ['help', 'h'],
    summary: i18n.t('coordinator.help.summary.helps'),
    usage: [
      '/helps',
      i18n.t('coordinator.help.usage.command'),
      '/helps -h',
    ],
    examples: [
      '/helps',
      '/helps threads',
      '/help open',
    ],
    notes: [
      i18n.t('coordinator.help.note.helps'),
    ],
  }),
  status: freezeCommandHelp({
    name: 'status',
    aliases: ['where', 'st'],
    summary: i18n.t('coordinator.help.summary.status'),
    usage: [
      '/status',
      '/status details',
      '/where',
      '/status -h',
    ],
    examples: [
      '/status',
      '/status details',
      '/where',
    ],
    notes: [
      i18n.t('coordinator.help.note.status'),
    ],
  }),
  usage: freezeCommandHelp({
    name: 'usage',
    aliases: ['us'],
    summary: i18n.t('coordinator.help.summary.usage'),
    usage: [
      '/usage',
      '/us',
      '/usage -h',
    ],
    examples: [
      '/usage',
      '/us',
    ],
    notes: [
      i18n.t('coordinator.help.note.usage'),
    ],
  }),
  login: freezeCommandHelp({
    name: 'login',
    aliases: ['lg'],
    summary: i18n.t('coordinator.help.summary.login'),
    usage: [
      '/login',
      '/login list',
      '/login <index>',
      '/login cancel',
      '/login -h',
    ],
    examples: [
      '/login',
      '/login list',
      '/login 1',
      '/login cancel',
    ],
    notes: [
      i18n.t('coordinator.help.note.login'),
    ],
  }),
  stop: freezeCommandHelp({
    name: 'stop',
    aliases: ['sp'],
    summary: i18n.t('coordinator.help.summary.stop'),
    usage: [
      '/stop',
      '/sp',
      '/stop -h',
    ],
    examples: [
      '/stop',
      '/sp',
    ],
    notes: [
      i18n.t('coordinator.help.note.stop'),
    ],
  }),
  review: freezeCommandHelp({
    name: 'review',
    aliases: ['rv'],
    summary: i18n.t('coordinator.help.summary.review'),
    usage: [
      '/review',
      '/review base <branch>',
      '/review commit <sha>',
      '/review -h',
    ],
    examples: [
      '/review',
      '/review base main',
      '/review commit HEAD~1',
    ],
    notes: [
      i18n.t('coordinator.help.note.review'),
    ],
  }),
  agent: freezeCommandHelp({
    name: 'agent',
    aliases: ['ag'],
    summary: i18n.t('coordinator.help.summary.agent'),
    usage: [
      '/agent <任务>',
      '/agent confirm',
      '/agent edit <修改提示>',
      '/agent list',
      '/agent show <序号>',
      '/agent result <序号> [页码]',
      '/agent result <序号> file',
      '/agent send <序号>',
      '/agent stop <序号>',
      '/agent retry <序号>',
      '/agent rename <序号> <新标题>',
      '/agent del <序号>',
      '/agent -h',
    ],
    examples: [
      '/agent 检查当前项目测试并修复失败项',
      '/agent confirm',
      '/agent show 1',
      '/agent result 1',
      '/agent result 1 file',
      '/agent send 1',
      '/agent retry 1',
    ],
    notes: [
      i18n.t('coordinator.help.note.agent'),
    ],
  }),
  skills: freezeCommandHelp({
    name: 'skills',
    aliases: ['sk'],
    summary: i18n.t('coordinator.help.summary.skills'),
    usage: [
      '/skills',
      '/skills search <关键词>',
      '/skills show <序号|名称>',
      '/skills on <序号|名称>',
      '/skills off <序号|名称>',
      '/skills reload',
      '/skills -h',
    ],
    examples: [
      '/skills',
      '/skills search 新闻',
      '/skills show 1',
      '/skills on 2',
      '/skills off 2',
      '/skills reload',
    ],
    notes: [
      i18n.t('coordinator.help.note.skills'),
    ],
  }),
  plugins: freezeCommandHelp({
    name: 'plugins',
    aliases: ['pg'],
    summary: i18n.t('coordinator.help.summary.plugins'),
    usage: [
      '/plugins',
      '/pg reload',
      '/pg list',
      '/pg list <序号> [页码]',
      '/pg search <关键词> [页码]',
      '/pg show <序号|名称>',
      '/pg alias',
      '/pg alias <序号|名称> <短别名>',
      '/pg alias clear <序号|名称>',
      '/pg alias confirm',
      '/pg add <序号|名称>',
      '/pg del <序号|名称>',
      '/pg -h',
    ],
    examples: [
      '/plugins',
      '/pg reload',
      '/pg list',
      '/pg list 1',
      '/pg list 1 2',
      '/pg search 日记',
      '/pg search google drive',
      '/pg search todo 2',
      '/pg show 1',
      '/pg alias 1 gd',
      '/pg alias confirm',
      '/pg add 2',
    ],
    notes: [
      i18n.t('coordinator.help.note.plugins'),
    ],
  }),
  apps: freezeCommandHelp({
    name: 'apps',
    aliases: ['ap'],
    summary: i18n.t('coordinator.help.summary.apps'),
    usage: [
      '/apps',
      '/apps all [页码]',
      '/apps search <关键词>',
      '/apps list [页码]',
      '/apps show <序号|名称>',
      '/apps on <序号|名称>',
      '/apps off <序号|名称>',
      '/apps auth <序号|名称>',
      '/apps -h',
    ],
    examples: [
      '/apps',
      '/apps all',
      '/apps search 邮件',
      '/apps list 2',
      '/apps show 1',
      '/apps on 1',
      '/apps off github',
      '/apps auth google-drive',
    ],
    notes: [
      i18n.t('coordinator.help.note.apps'),
    ],
  }),
  mcp: freezeCommandHelp({
    name: 'mcp',
    aliases: [],
    summary: i18n.t('coordinator.help.summary.mcp'),
    usage: [
      '/mcp',
      '/mcp on <序号|名称>',
      '/mcp off <序号|名称>',
      '/mcp auth <序号|名称>',
      '/mcp reload',
      '/mcp -h',
    ],
    examples: [
      '/mcp',
      '/mcp on 1',
      '/mcp off google_workspace',
      '/mcp auth google_workspace',
      '/mcp reload',
    ],
    notes: [
      i18n.t('coordinator.help.note.mcp'),
    ],
  }),
  use: freezeCommandHelp({
    name: 'use',
    aliases: [],
    summary: i18n.t('coordinator.help.summary.use'),
    usage: [
      i18n.t('coordinator.use.usage'),
      '/use -h',
    ],
    examples: [
      '/use gm 查今天未读邮件',
      '/use gm gc 把重要事情都记录到谷歌日历中',
      '/use github 看这个仓库最近失败的 CI',
      '@gm 查今天未读邮件',
      '用@gm 查看最新的邮件，并用@gc把重要事情都记录到谷歌日历中',
      '用 gm 查今天未读邮件',
    ],
    notes: [
      i18n.t('coordinator.help.note.use'),
    ],
  }),
  automation: freezeCommandHelp({
    name: 'automation',
    aliases: ['auto'],
    summary: i18n.t('coordinator.help.summary.automation'),
    usage: [
      '/auto',
      '/auto add 每30分钟检查一次系统状态，有变化发送给我',
      '/auto add 每天早上7点调用 news skill 给我发送到微信',
      '/auto add 工作日晚上6点检查部署状态，异常时通知我',
      '/auto add 每天早上8点、中午13点、下午17点半，把待办事项整理后发到微信',
      '/auto confirm',
      '/auto edit 只把时间改成每小时，任务内容不变',
      '/auto cancel',
      '/auto list',
      '/auto show <index>',
      '/auto pause <index>',
      '/auto resume <index>',
      '/auto delete <index>',
      '/auto del <index>',
      '/auto rename <index> <新标题>',
      '/auto -h',
    ],
    examples: [
      '/auto add 每30分钟检查一次系统状态，有变化发送给我',
      '/auto add 每天早上8点、中午13点、下午17点半，把待办事项整理后发到微信',
      '/auto confirm',
      '/auto list',
      '/auto rename 1 晚间部署巡检',
      '/auto del 1',
    ],
    notes: [
      i18n.t('coordinator.help.note.automation'),
    ],
  }),
  weibo: freezeCommandHelp({
    name: 'weibo',
    aliases: ['wb'],
    summary: i18n.t('coordinator.help.summary.weibo'),
    usage: [
      '/weibo',
      '/weibo 10',
      '/weibo top 10',
      '/weibo -h',
    ],
    examples: [
      '/weibo',
      '/weibo top 10',
      '/auto add 每5分钟把微博热搜前10条发给我',
      '/auto confirm',
    ],
    notes: [
      i18n.t('coordinator.help.note.weibo'),
    ],
  }),
  new: freezeCommandHelp({
    name: 'new',
    aliases: ['n'],
    summary: i18n.t('coordinator.help.summary.new'),
    usage: [
      '/new',
      '/new /home/ubuntu/dev/CodexBridge',
      '/new -h',
    ],
    examples: [
      '/new',
      '/new /home/ubuntu/dev/dailywork',
    ],
    notes: [
      i18n.t('coordinator.help.note.new'),
    ],
  }),
  uploads: freezeCommandHelp({
    name: 'uploads',
    aliases: ['up', 'ul'],
    summary: i18n.t('coordinator.help.summary.uploads'),
    usage: [
      '/uploads',
      '/uploads status',
      '/uploads cancel',
      '/uploads -h',
    ],
    examples: [
      '/uploads',
      '/up status',
      '/up cancel',
    ],
    notes: [
      i18n.t('coordinator.help.note.uploads'),
    ],
  }),
  assistant: freezeCommandHelp({
    name: 'as',
    aliases: ['assistant'],
    summary: i18n.t('coordinator.help.summary.assistant'),
    usage: [
      '/as <自然语言>',
      '/as ok',
      '/as edit <修改提示>',
      '/as cancel',
      '/as search <关键词>',
      '/as show <序号|id>',
      '/as del <序号|id>',
      '/as -h',
    ],
    examples: [
      '/as 今天修复了 /pg search 日记召回太宽的问题 #CodexBridge',
      '/as 明天上午10点提醒我给王总回电话',
      '/as ok',
      '/as edit 把王总改成李总，时间改成明天上午11点',
      '/as 给王总回电话这件事已经完成了',
      '/as 修马桶发票已经拿回来了',
      '/as search CodexBridge',
      '/up 之后发送 /as 把这些资料记录为项目附件',
    ],
    notes: [
      i18n.t('coordinator.help.note.assistant'),
    ],
  }),
  log: freezeCommandHelp({
    name: 'log',
    aliases: [],
    summary: i18n.t('coordinator.help.summary.log'),
    usage: [
      '/log <自然语言>',
      '/log search <关键词>',
      '/log show <序号|id>',
      '/log del <序号|id>',
      '/log -h',
    ],
    examples: [
      '/log 今天测试微信桥接，发现插件搜索需要更高相关度',
      '/log search 微信桥接',
    ],
    notes: [
      i18n.t('coordinator.help.note.log'),
    ],
  }),
  todo: freezeCommandHelp({
    name: 'todo',
    aliases: ['td'],
    summary: i18n.t('coordinator.help.summary.todo'),
    usage: [
      '/todo <自然语言>',
      '/todo done <序号|id>',
      '/todo show <序号|id>',
      '/todo del <序号|id>',
      '/todo -h',
    ],
    examples: [
      '/todo 检查服务器磁盘空间',
      '/todo 下周五前整理 CodexBridge 视频脚本 p1',
      '/todo done 1',
    ],
    notes: [
      i18n.t('coordinator.help.note.todo'),
    ],
  }),
  remind: freezeCommandHelp({
    name: 'remind',
    aliases: ['rmd'],
    summary: i18n.t('coordinator.help.summary.remind'),
    usage: [
      '/remind <自然语言>',
      '/remind ok',
      '/remind edit <修改提示>',
      '/remind cancel',
      '/remind show <序号|id>',
      '/remind del <序号|id>',
      '/remind -h',
    ],
    examples: [
      '/remind 明天上午10点提醒我给王总回电话',
      '/remind edit 时间改成明天上午11点',
      '/remind 每周一早上9点提醒我看项目进度',
      '/remind cancel 1',
    ],
    notes: [
      i18n.t('coordinator.help.note.remind'),
    ],
  }),
  note: freezeCommandHelp({
    name: 'note',
    aliases: ['nt'],
    summary: i18n.t('coordinator.help.summary.note'),
    usage: [
      '/note <自然语言>',
      '/note search <关键词>',
      '/note show <序号|id>',
      '/note del <序号|id>',
      '/note -h',
    ],
    examples: [
      '/note Notion 适合结构化日志，Google Drive 适合导出归档',
      '/note search Notion',
    ],
    notes: [
      i18n.t('coordinator.help.note.note'),
    ],
  }),
  provider: freezeCommandHelp({
    name: 'provider',
    aliases: ['pd'],
    summary: i18n.t('coordinator.help.summary.provider'),
    usage: [
      '/provider',
      '/provider <profileId>',
      '/provider -h',
    ],
    examples: [
      '/provider',
      '/provider openai-default',
    ],
    notes: [
      i18n.t('coordinator.help.note.provider'),
    ],
  }),
  models: freezeCommandHelp({
    name: 'models',
    aliases: ['ms'],
    summary: i18n.t('coordinator.help.summary.models'),
    usage: [
      '/models',
      '/models -h',
    ],
    examples: [
      '/models',
      '/models -h',
    ],
    notes: [
      i18n.t('coordinator.help.note.models'),
    ],
  }),
  model: freezeCommandHelp({
    name: 'model',
    aliases: ['m'],
    summary: i18n.t('coordinator.help.summary.model'),
    usage: [
      '/model',
      '/model <modelId|effort|default|reset>',
      '/model <modelId> <effort>',
      '/model -h',
    ],
    examples: [
      '/model',
      '/model gpt-5.4',
      '/model high',
      '/model gpt-5.4 xhigh',
      '/model default',
    ],
    notes: [
      i18n.t('coordinator.help.note.model'),
    ],
  }),
  plan: freezeCommandHelp({
    name: 'plan',
    aliases: ['pl'],
    summary: i18n.t('coordinator.help.summary.plan'),
    usage: [
      '/plan',
      '/plan on',
      '/plan off',
      '/plan -h',
    ],
    examples: [
      '/plan',
      '/plan on',
      '/plan off',
    ],
    notes: [
      i18n.t('coordinator.help.note.plan'),
    ],
  }),
  personality: freezeCommandHelp({
    name: 'personality',
    aliases: ['psn'],
    summary: i18n.t('coordinator.help.summary.personality'),
    usage: [
      '/personality',
      '/personality <friendly|pragmatic|none>',
      '/personality -h',
    ],
    examples: [
      '/personality',
      '/personality pragmatic',
      '/personality none',
    ],
    notes: [
      i18n.t('coordinator.help.note.personality'),
    ],
  }),
  instructions: freezeCommandHelp({
    name: 'instructions',
    aliases: ['ins'],
    summary: i18n.t('coordinator.help.summary.instructions'),
    usage: [
      '/instructions',
      '/instructions set <text>',
      '/instructions edit',
      '/instructions clear',
      '/instructions cancel',
      '/instructions -h',
    ],
    examples: [
      '/instructions',
      '/instructions set Always explain the tradeoffs before editing.',
      '/instructions edit',
      '/instructions clear',
    ],
    notes: [
      i18n.t('coordinator.help.note.instructions'),
    ],
  }),
  fast: freezeCommandHelp({
    name: 'fast',
    aliases: [],
    summary: i18n.t('coordinator.help.summary.fast'),
    usage: [
      '/fast',
      '/fast off',
      '/fast -h',
    ],
    examples: [
      '/fast',
      '/fast off',
    ],
    notes: [
      i18n.t('coordinator.help.note.fast'),
    ],
  }),
  threads: freezeCommandHelp({
    name: 'threads',
    aliases: ['th'],
    summary: i18n.t('coordinator.help.summary.threads'),
    usage: [
      '/threads',
      '/th all',
      '/th pin',
      '/th del 2',
      '/th restore 2',
      '/th pin 2',
      '/th unpin 2',
      '/th -h',
    ],
    examples: [
      '/threads',
      '/th pin 2 3',
      '/th pin',
      '/th unpin 1',
      '/th del 2',
      '/th all',
      '/th restore 2',
      '/next',
      '/open 2',
      '/peek 2',
    ],
    notes: [
      i18n.t('coordinator.help.note.threads'),
    ],
  }),
  search: freezeCommandHelp({
    name: 'search',
    aliases: ['se'],
    summary: i18n.t('coordinator.help.summary.search'),
    usage: [
      i18n.t('coordinator.help.usage.search'),
      '/search -h',
    ],
    examples: [
      '/search bridge',
      `/search ${i18n.t('common.example.keyword')}`,
    ],
    notes: [
      i18n.t('coordinator.help.note.search'),
    ],
  }),
  next: freezeCommandHelp({
    name: 'next',
    aliases: ['nx'],
    summary: i18n.t('coordinator.help.summary.next'),
    usage: [
      '/next',
      '/next -h',
    ],
    examples: [
      '/threads',
      '/next',
    ],
    notes: [
      i18n.t('coordinator.help.note.nextPrev'),
    ],
  }),
  prev: freezeCommandHelp({
    name: 'prev',
    aliases: ['pv'],
    summary: i18n.t('coordinator.help.summary.prev'),
    usage: [
      '/prev',
      '/prev -h',
    ],
    examples: [
      '/threads',
      '/next',
      '/prev',
    ],
    notes: [
      i18n.t('coordinator.help.note.nextPrev'),
    ],
  }),
  open: freezeCommandHelp({
    name: 'open',
    aliases: ['o'],
    summary: i18n.t('coordinator.help.summary.open'),
    usage: [
      i18n.t('coordinator.help.usage.open'),
      '/open -h',
    ],
    examples: [
      '/open 2',
      '/open 019d95ad-7166-7ee3-89a3-3bbb50e0fd64',
    ],
    notes: [
      i18n.t('coordinator.help.note.open'),
    ],
  }),
  peek: freezeCommandHelp({
    name: 'peek',
    aliases: ['pk'],
    summary: i18n.t('coordinator.help.summary.peek'),
    usage: [
      i18n.t('coordinator.help.usage.peek'),
      '/peek -h',
    ],
    examples: [
      '/peek 1',
      '/peek 019d95ad-7166-7ee3-89a3-3bbb50e0fd64',
    ],
    notes: [
      i18n.t('coordinator.help.note.peek'),
    ],
  }),
  rename: freezeCommandHelp({
    name: 'rename',
    aliases: ['rn'],
    summary: i18n.t('coordinator.help.summary.rename'),
    usage: [
      i18n.t('coordinator.help.usage.rename'),
      '/rename -h',
    ],
    examples: [
      `/rename 2 ${i18n.t('common.example.aliasName')}`,
      '/rename 019d95ad-7166-7ee3-89a3-3bbb50e0fd64 CodexBridge',
    ],
    notes: [
      i18n.t('coordinator.help.note.rename'),
    ],
  }),
  permissions: freezeCommandHelp({
    name: 'permissions',
    aliases: ['perm'],
    summary: i18n.t('coordinator.help.summary.permissions'),
    usage: [
      '/permissions',
      '/permissions <read-only|default|full-access>',
      '/permissions -h',
    ],
    examples: [
      '/permissions',
      '/permissions full-access',
    ],
    notes: [
      i18n.t('coordinator.help.note.permissions'),
    ],
  }),
  allow: freezeCommandHelp({
    name: 'allow',
    aliases: ['al'],
    summary: i18n.t('coordinator.help.summary.allow'),
    usage: [
      '/allow',
      '/allow <1|2> [index]',
      '/allow -h',
    ],
    examples: [
      '/allow',
      '/allow 1',
      '/allow 2',
      '/allow 2 2',
      '/al 1',
    ],
    notes: [
      i18n.t('coordinator.help.note.allow'),
    ],
  }),
  deny: freezeCommandHelp({
    name: 'deny',
    aliases: ['dn'],
    summary: i18n.t('coordinator.help.summary.deny'),
    usage: [
      '/deny',
      '/deny [index]',
      '/deny -h',
    ],
    examples: [
      '/deny',
      '/deny 2',
      '/dn',
    ],
    notes: [
      i18n.t('coordinator.help.note.deny'),
    ],
  }),
  reconnect: freezeCommandHelp({
    name: 'reconnect',
    aliases: ['rc'],
    summary: i18n.t('coordinator.help.summary.reconnect'),
    usage: [
      '/reconnect',
      '/reconnect -h',
    ],
    examples: [
      '/reconnect',
    ],
    notes: [
      i18n.t('coordinator.help.note.reconnect'),
    ],
  }),
  retry: freezeCommandHelp({
    name: 'retry',
    aliases: ['rt'],
    summary: i18n.t('coordinator.help.summary.retry'),
    usage: [
      '/retry',
      '/rt',
      '/retry -h',
    ],
    examples: [
      '/retry',
      '/rt',
    ],
    notes: [
      i18n.t('coordinator.help.note.retry'),
    ],
  }),
  restart: freezeCommandHelp({
    name: 'restart',
    aliases: ['rs'],
    summary: i18n.t('coordinator.help.summary.restart'),
    usage: [
      '/restart',
      '/restart -h',
    ],
    examples: [
      '/restart',
    ],
    notes: [
      i18n.t('coordinator.help.note.restart'),
    ],
  }),
  lang: freezeCommandHelp({
    name: 'lang',
    aliases: [],
    summary: i18n.t('coordinator.help.summary.lang'),
    usage: [
      '/lang',
      '/lang <zh-CN|en>',
      '/lang -h',
    ],
    examples: [
      '/lang',
      '/lang zh',
      '/lang en',
    ],
    notes: [
      i18n.t('coordinator.help.note.lang'),
    ],
  }),
  });
}

const COMMAND_HELP_ORDER = Object.freeze([
  'helps',
  'status',
  'usage',
  'login',
  'stop',
  'review',
  'agent',
  'skills',
  'plugins',
  'apps',
  'mcp',
  'use',
  'automation',
  'weibo',
  'new',
  'uploads',
  'assistant',
  'log',
  'todo',
  'remind',
  'note',
  'provider',
  'models',
  'model',
  'plan',
  'personality',
  'instructions',
  'fast',
  'threads',
  'search',
  'next',
  'prev',
  'open',
  'peek',
  'rename',
  'permissions',
  'allow',
  'deny',
  'reconnect',
  'retry',
  'restart',
  'lang',
]);

const HIDDEN_COMMAND_ALIASES = Object.freeze({
  interrupt: 'stop',
});

const COMMAND_ALIAS_DEFINITIONS = Object.freeze({
  helps: ['help', 'h'],
  status: ['where', 'st'],
  usage: ['us'],
  login: ['lg'],
  stop: ['sp'],
  review: ['rv'],
  agent: ['ag'],
  skills: ['sk'],
  plugins: ['pg'],
  apps: ['ap'],
  mcp: [],
  use: [],
  automation: ['auto'],
  weibo: ['wb'],
  new: ['n'],
  uploads: ['up', 'ul'],
  assistant: ['as'],
  log: [],
  todo: ['td'],
  remind: ['rmd'],
  note: ['nt'],
  provider: ['pd'],
  models: ['ms'],
  model: ['m'],
  plan: ['pl'],
  personality: ['psn'],
  instructions: ['ins'],
  fast: [],
  threads: ['th'],
  search: ['se'],
  next: ['nx'],
  prev: ['pv'],
  open: ['o'],
  peek: ['pk'],
  rename: ['rn'],
  permissions: ['perm'],
  allow: ['al'],
  deny: ['dn'],
  reconnect: ['rc'],
  retry: ['rt'],
  restart: ['rs'],
  lang: [],
});

const COMMAND_CANONICAL_NAME_MAP = buildCommandCanonicalNameMapFromAliases(COMMAND_ALIAS_DEFINITIONS, HIDDEN_COMMAND_ALIASES);
const PLUGIN_ALIAS_RESERVED_TOKENS = new Set([
  ...COMMAND_CANONICAL_NAME_MAP.keys(),
  'add',
  'alias',
  'aliases',
  'auth',
  'clear',
  'confirm',
  'default',
  'del',
  'featured',
  'install',
  'list',
  'off',
  'on',
  'reload',
  'remove',
  'rm',
  'show',
  'uninstall',
]);

function createUploadBatchState(now: number): UploadBatchState {
  return {
    active: true,
    batchId: crypto.randomUUID(),
    startedAt: now,
    updatedAt: now,
    items: [],
  };
}

function normalizeUploadBatchState(value: unknown): UploadBatchState | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const batchId = normalizeNullableString(record.batchId);
  const items = Array.isArray(record.items)
    ? record.items
      .map(normalizeUploadBatchItem)
      .filter((item): item is UploadBatchItem => Boolean(item))
    : [];
  if (!batchId) {
    return null;
  }
  return {
    active: record.active !== false,
    batchId,
    startedAt: typeof record.startedAt === 'number' ? record.startedAt : Date.now(),
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : Date.now(),
    items,
  };
}

function normalizeUploadBatchItem(value: unknown): UploadBatchItem | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const kind = normalizeAttachmentKind(record.kind);
  const localPath = normalizeNullableString(record.localPath);
  const originalPath = normalizeNullableString(record.originalPath) ?? localPath;
  if (!kind || !localPath) {
    return null;
  }
  return {
    id: normalizeNullableString(record.id) ?? crypto.randomUUID(),
    kind,
    localPath,
    originalPath: originalPath ?? localPath,
    fileName: normalizeNullableString(record.fileName),
    mimeType: normalizeNullableString(record.mimeType),
    transcriptText: normalizeNullableString(record.transcriptText),
    durationSeconds: typeof record.durationSeconds === 'number' ? record.durationSeconds : null,
    sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : null,
    receivedAt: typeof record.receivedAt === 'number' ? record.receivedAt : Date.now(),
  };
}

function normalizeAttachmentKind(value: unknown): UploadBatchItem['kind'] | null {
  if (value === 'image' || value === 'voice' || value === 'file' || value === 'video') {
    return value;
  }
  return null;
}

function normalizeInboundAttachments(value: unknown): InboundAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((attachment): attachment is InboundAttachment =>
    Boolean(attachment)
    && typeof attachment === 'object'
    && typeof attachment.localPath === 'string'
    && normalizeAttachmentKind((attachment as InboundAttachment).kind) !== null);
}

function cloneInboundAttachments(attachments: InboundAttachment[]): InboundAttachment[] {
  return attachments.map((attachment) => ({
    kind: attachment.kind,
    localPath: attachment.localPath,
    fileName: normalizeNullableString(attachment.fileName),
    mimeType: normalizeNullableString(attachment.mimeType),
    transcriptText: normalizeNullableString(attachment.transcriptText),
    durationSeconds: typeof attachment.durationSeconds === 'number' ? attachment.durationSeconds : null,
  }));
}

function normalizeRetryableRequestSnapshot(value: unknown): RetryableRequestSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const text = String(record.text ?? '').trim();
  if (!text) {
    return null;
  }
  return {
    text,
    attachments: cloneInboundAttachments(normalizeInboundAttachments(record.attachments)),
    cwd: normalizeCwd(record.cwd),
    storedAt: typeof record.storedAt === 'number' ? record.storedAt : Date.now(),
  };
}

function normalizeStopCheckpointSnapshot(value: unknown): StopCheckpointSnapshot | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const threadId = normalizeNullableString(record.threadId);
  if (!threadId) {
    return null;
  }
  return {
    threadId,
    stoppedAt: typeof record.stoppedAt === 'number' ? record.stoppedAt : Date.now(),
    interruptedTurnIds: Array.isArray(record.interruptedTurnIds)
      ? record.interruptedTurnIds
        .map((entry) => normalizeNullableString(entry))
        .filter((entry): entry is string => Boolean(entry))
      : [],
    pendingApprovalCount: typeof record.pendingApprovalCount === 'number' ? record.pendingApprovalCount : 0,
    interruptErrors: Array.isArray(record.interruptErrors)
      ? record.interruptErrors
        .map((entry) => normalizeNullableString(entry))
        .filter((entry): entry is string => Boolean(entry))
      : [],
    requestedWhileStarting: record.requestedWhileStarting === true,
    settled: record.settled === true,
  };
}

function resolveUploadSubmissionText(event: InboundTextEvent, attachments: InboundAttachment[]): string {
  const text = String(event.text ?? '').trim();
  if (text) {
    return text;
  }
  for (const attachment of attachments) {
    const transcriptText = normalizeNullableString(attachment.transcriptText);
    if (attachment.kind === 'voice' && transcriptText) {
      return transcriptText;
    }
  }
  return '';
}

function containsVoiceWithoutTranscript(attachments: InboundAttachment[]): boolean {
  return attachments.some((attachment) => attachment.kind === 'voice' && !normalizeNullableString(attachment.transcriptText));
}

function buildUploadTurnEvent(event: InboundTextEvent, text: string, state: UploadBatchState): InboundTextEvent {
  return {
    ...event,
    text,
    attachments: state.items.map((item) => ({
      kind: item.kind,
      localPath: item.localPath,
      fileName: item.fileName,
      mimeType: item.mimeType,
      transcriptText: item.transcriptText,
      durationSeconds: item.durationSeconds,
    })),
    metadata: {
      ...(event.metadata ?? {}),
      uploadBatchId: state.batchId,
      uploadCount: state.items.length,
    },
  };
}

function truncateInlineText(value: string, limit = 120): string {
  const normalized = String(value ?? '').trim().replace(/\s+/gu, ' ');
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizeSkillLookupToken(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s/_-]+/gu, ' ');
}

function scoreSkillMatch(skill: ProviderSkillInfo, searchTerm: string): number {
  const normalizedQuery = normalizeSkillLookupToken(searchTerm);
  if (!normalizedQuery) {
    return 0;
  }
  const fields = [
    skill.name,
    skill.displayName ?? '',
    skill.description,
    skill.shortDescription ?? '',
    path.basename(skill.path),
  ].map((value) => normalizeSkillLookupToken(value));
  let score = 0;
  for (const field of fields) {
    if (!field) {
      continue;
    }
    if (field === normalizedQuery) {
      score += 200;
      continue;
    }
    if (field.startsWith(normalizedQuery)) {
      score += 120;
      continue;
    }
    if (field.includes(normalizedQuery)) {
      score += 80;
    }
  }
  const tokens = normalizedQuery.split(/\s+/u).filter(Boolean);
  for (const token of tokens) {
    for (const field of fields) {
      if (field.includes(token)) {
        score += token.length >= 3 ? 16 : 8;
      }
    }
  }
  return score;
}

function filterSkillsBySearchTerm(skills: ProviderSkillInfo[], searchTerm: string | null): ProviderSkillInfo[] {
  const normalizedQuery = normalizeNullableString(searchTerm);
  if (!normalizedQuery) {
    return [...skills].sort(compareSkillsForDisplay);
  }
  return skills
    .map((skill) => ({
      skill,
      score: scoreSkillMatch(skill, normalizedQuery),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return compareSkillsForDisplay(left.skill, right.skill);
    })
    .map((entry) => entry.skill);
}

function compareSkillsForDisplay(left: ProviderSkillInfo, right: ProviderSkillInfo): number {
  if (left.enabled !== right.enabled) {
    return left.enabled ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

function renderSkillsListLines({
  i18n,
  cwd,
  items,
  errors,
  searchTerm,
}: {
  i18n: Translator;
  cwd: string | null;
  items: ProviderSkillInfo[];
  errors: Array<{ path: string; message: string }>;
  searchTerm: string | null;
}) {
  const lines = [
    i18n.t('coordinator.skills.listTitle', {
      cwd: cwd ?? i18n.t('common.notSet'),
      count: items.length,
    }),
  ];
  if (searchTerm) {
    lines.push(i18n.t('coordinator.skills.searchLabel', { term: searchTerm }));
  }
  for (const [index, skill] of items.entries()) {
    const status = skill.enabled ? i18n.t('common.enabled') : i18n.t('common.disabled');
    lines.push(`${index + 1}. ${skill.displayName || skill.name} [${status}] [${skill.scope}]`);
    lines.push(`   ${truncateInlineText(skill.shortDescription || skill.description, 88)}`);
  }
  if (errors.length > 0) {
    lines.push(i18n.t('coordinator.skills.errorCount', { count: errors.length }));
  }
  lines.push(i18n.t('coordinator.skills.actionsHint'));
  return lines;
}

function renderSkillDetailLines({
  i18n,
  index,
  cwd,
  skill,
}: {
  i18n: Translator;
  index: number;
  cwd: string | null;
  skill: ProviderSkillInfo;
}) {
  const lines = [
    i18n.t('coordinator.skills.detailTitle', { index, name: skill.displayName || skill.name }),
    i18n.t('coordinator.skills.cwdLabel', { value: cwd ?? i18n.t('common.notSet') }),
    i18n.t('coordinator.skills.statusLabel', {
      value: skill.enabled ? i18n.t('common.enabled') : i18n.t('common.disabled'),
    }),
    i18n.t('coordinator.skills.scopeLabel', { value: skill.scope }),
    i18n.t('coordinator.skills.nameLabel', { value: skill.name }),
    i18n.t('coordinator.skills.pathLabel', { value: skill.path }),
    i18n.t('coordinator.skills.purposeLabel', { value: skill.description }),
  ];
  if (skill.shortDescription) {
    lines.push(i18n.t('coordinator.skills.shortDescriptionLabel', { value: skill.shortDescription }));
  }
  if (skill.defaultPrompt) {
    lines.push(i18n.t('coordinator.skills.defaultPromptLabel', { value: skill.defaultPrompt }));
  }
  if (skill.dependencies && skill.dependencies.length > 0) {
    lines.push(i18n.t('coordinator.skills.dependenciesLabel', {
      value: skill.dependencies.map((entry) => `${entry.type}:${entry.value}`).join(', '),
    }));
  }
  lines.push(i18n.t('coordinator.skills.detailActionsHint', { index }));
  return lines;
}

function flattenPluginMarketplaces(marketplaces: ProviderPluginsListResult['marketplaces']): ProviderPluginSummary[] {
  return Array.isArray(marketplaces)
    ? marketplaces.flatMap((marketplace) => Array.isArray(marketplace?.plugins) ? marketplace.plugins : [])
    : [];
}

function findMatchingPluginSummary(
  items: ProviderPluginSummary[],
  target: ProviderPluginSummary,
): ProviderPluginSummary | null {
  return items.find((entry) => entry.id === target.id)
    ?? items.find((entry) => (
      entry.name === target.name
      && entry.marketplaceName === target.marketplaceName
      && (entry.marketplacePath ?? null) === (target.marketplacePath ?? null)
    ))
    ?? null;
}

function selectFeaturedPlugins(catalog: ProviderPluginsListResult): ProviderPluginSummary[] {
  const allPlugins = flattenPluginMarketplaces(catalog.marketplaces);
  const byId = new Map(allPlugins.map((plugin) => [plugin.id, plugin]));
  const featured = Array.isArray(catalog.featuredPluginIds)
    ? catalog.featuredPluginIds.map((id) => byId.get(id) ?? null).filter(Boolean) as ProviderPluginSummary[]
    : [];
  return featured.length > 0 ? featured : allPlugins.slice(0, 12);
}

function createFallbackPluginDetail(summary: ProviderPluginSummary): ProviderPluginDetail {
  return {
    summary,
    marketplaceName: summary.marketplaceName,
    marketplacePath: summary.marketplacePath,
    description: summary.longDescription ?? summary.shortDescription ?? null,
    apps: [],
    mcpServers: [],
    skills: [],
  };
}

function classifyPluginDetail(detail: ProviderPluginDetail, i18n: Translator): { key: string; label: string; description: string } {
  const nativeCategory = String(detail.summary.category ?? '').trim();
  if (nativeCategory) {
    return {
      key: normalizePluginLookupToken(nativeCategory) || nativeCategory.toLowerCase(),
      label: nativeCategory,
      description: i18n.t('coordinator.plugins.categoryDescription.native', { name: nativeCategory }),
    };
  }
  const kinds = [
    detail.apps.length > 0 ? 'app' : null,
    detail.mcpServers.length > 0 ? 'mcp' : null,
    detail.skills.length > 0 ? 'skill' : null,
  ].filter(Boolean);
  if (kinds.length === 0) {
    const capabilityKinds = summarizePluginCapabilityKinds(detail.summary);
    kinds.push(...capabilityKinds);
  }
  if (kinds.length > 1) {
    return {
      key: 'mixed',
      label: i18n.t('coordinator.plugins.category.mixed'),
      description: i18n.t('coordinator.plugins.categoryDescription.mixed'),
    };
  }
  if (kinds[0] === 'app') {
    return {
      key: 'app',
      label: i18n.t('coordinator.plugins.category.app'),
      description: i18n.t('coordinator.plugins.categoryDescription.app'),
    };
  }
  if (kinds[0] === 'mcp') {
    return {
      key: 'mcp',
      label: i18n.t('coordinator.plugins.category.mcp'),
      description: i18n.t('coordinator.plugins.categoryDescription.mcp'),
    };
  }
  if (kinds[0] === 'skill') {
    return {
      key: 'skill',
      label: i18n.t('coordinator.plugins.category.skill'),
      description: i18n.t('coordinator.plugins.categoryDescription.skill'),
    };
  }
  return {
    key: 'other',
    label: i18n.t('coordinator.plugins.category.other'),
    description: i18n.t('coordinator.plugins.categoryDescription.other'),
  };
}

function summarizePluginCapabilityKinds(summary: ProviderPluginSummary): Array<'app' | 'mcp' | 'skill'> {
  const raw = [
    ...(Array.isArray(summary.capabilities) ? summary.capabilities : []),
    summary.category ?? '',
  ]
    .map((entry) => String(entry ?? '').trim().toLowerCase())
    .filter(Boolean);
  const kinds = new Set<'app' | 'mcp' | 'skill'>();
  for (const value of raw) {
    if (value.includes('mcp')) {
      kinds.add('mcp');
    }
    if (value.includes('skill')) {
      kinds.add('skill');
    }
    if (value.includes('app') || value.includes('connector')) {
      kinds.add('app');
    }
  }
  return Array.from(kinds);
}

function buildPluginCategoryBuckets(details: ProviderPluginDetail[], i18n: Translator): PluginCategoryBucket[] {
  const seed = new Map<string, PluginCategoryBucket>();
  for (const detail of details) {
    const info = classifyPluginDetail(detail, i18n);
    const bucket = seed.get(info.key) ?? {
      key: info.key,
      label: info.label,
      description: info.description,
      items: [],
    };
    bucket.items.push(detail);
    seed.set(info.key, bucket);
  }
  return Array.from(seed.values())
    .filter((bucket) => bucket.items.length > 0)
    .sort((left, right) => {
      if (right.items.length !== left.items.length) {
        return right.items.length - left.items.length;
      }
      return left.label.localeCompare(right.label);
    })
    .map((bucket) => ({
      ...bucket,
      items: [...bucket.items].sort((left, right) => comparePluginsForDisplay(left.summary, right.summary)),
    }));
}

function resolvePluginCategorySelection(token: string, buckets: PluginCategoryBucket[]): { index: number; bucket: PluginCategoryBucket } | null {
  const rawToken = String(token ?? '').trim();
  const numeric = Number.parseInt(rawToken, 10);
  if (rawToken && Number.isInteger(numeric) && numeric >= 1 && numeric <= buckets.length) {
    return {
      index: numeric,
      bucket: buckets[numeric - 1],
    };
  }
  const normalized = normalizePluginLookupToken(rawToken);
  if (!normalized) {
    return null;
  }
  const matched = buckets.find((bucket) => {
    const haystack = [
      bucket.key,
      bucket.label,
      bucket.description,
    ].map((candidate) => normalizePluginLookupToken(candidate)).join(' ');
    return haystack.includes(normalized);
  });
  if (!matched) {
    return null;
  }
  return {
    index: buckets.indexOf(matched) + 1,
    bucket: matched,
  };
}

function parsePluginSearchArgs(args: unknown[]): { searchTerm: string; pageNumber: number | null } {
  const tokens = Array.isArray(args)
    ? args.map((value) => String(value ?? '').trim()).filter(Boolean)
    : [];
  if (tokens.length === 0) {
    return { searchTerm: '', pageNumber: null };
  }
  const lastPage = tokens.length >= 2 ? parsePositiveIntegerToken(tokens.at(-1)) : null;
  const searchTokens = lastPage ? tokens.slice(0, -1) : tokens;
  return {
    searchTerm: searchTokens.join(' ').trim(),
    pageNumber: lastPage,
  };
}

const PLUGIN_SEARCH_SYNONYM_GROUPS = [
  ['todo', 'todos', 'task', 'tasks', 'checklist', '待办', '任务', '清单', '事项'],
  ['diary', 'journal', 'journals', 'notion', 'database', 'databases', 'workspace', '日记'],
  ['log', 'logs', 'record', 'records', '日志', '记录', '流水', '操作记录'],
  ['note', 'notes', 'notebook', 'memo', '笔记', '备注', '随手记'],
  ['daily', 'daily report', 'standup', '日报', '每日', '日更', '复盘'],
  ['notion', 'database', 'databases', 'wiki', 'workspace', 'knowledge', '知识库', '数据库', '文档库'],
  ['drive', 'google drive', 'docs', 'sheets', 'spreadsheet', 'google', '文档', '表格', '云盘', '网盘'],
  ['calendar', 'schedule', 'schedules', 'reminder', 'event', 'events', '日历', '日程', '提醒', '计划'],
  ['mail', 'email', 'gmail', 'inbox', '邮件', '邮箱', '收件箱'],
  ['github', 'git', 'repo', 'repository', 'repositories', 'pull request', 'issue', '代码', '仓库', '提交'],
  ['mcp', 'server', 'servers', 'tool', 'tools', '工具', '服务'],
  ['skill', 'skills', 'workflow', 'workflows', '技能', '工作流'],
  ['slack', 'chat', 'message', 'messages', 'team', '聊天', '消息', '团队'],
  ['linear', 'project', 'projects', 'ticket', 'tickets', 'issue', 'issues', '项目', '工单', '缺陷'],
] as const;

function splitPluginSearchTokens(value: unknown): string[] {
  const normalized = normalizePluginLookupToken(value)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized ? normalized.split(' ').filter(Boolean) : [];
}

function buildPluginSearchTokens(searchTerm: string): string[] {
  const normalizedQuery = normalizePluginLookupToken(searchTerm);
  const tokens = new Set(splitPluginSearchTokens(normalizedQuery));
  for (const group of PLUGIN_SEARCH_SYNONYM_GROUPS) {
    const normalizedGroup = group
      .flatMap((entry) => [normalizePluginLookupToken(entry), ...splitPluginSearchTokens(entry)])
      .filter(Boolean);
    if (normalizedGroup.some((entry) => tokens.has(entry) || (entry.length >= 2 && normalizedQuery.includes(entry)))) {
      for (const entry of normalizedGroup) {
        tokens.add(entry);
      }
    }
  }
  return Array.from(tokens).filter((token) => token.length > 0);
}

function collectPluginSearchFields(detail: ProviderPluginDetail): { primary: string[]; secondary: string[] } {
  const summary = detail.summary;
  const primary = [
    summary.id,
    summary.name,
    summary.displayName ?? '',
    summary.marketplaceName,
    summary.marketplaceDisplayName ?? '',
  ];
  const secondary = [
    summary.shortDescription ?? '',
    summary.longDescription ?? '',
    detail.description ?? '',
    summary.category ?? '',
    summary.developerName ?? '',
    summary.websiteUrl ?? '',
    summary.sourceType ?? '',
    summary.sourcePath ?? '',
    summary.sourceRemoteMarketplaceName ?? '',
    ...(Array.isArray(summary.capabilities) ? summary.capabilities : []),
    ...(Array.isArray(summary.defaultPrompts) ? summary.defaultPrompts : []),
    ...detail.apps.flatMap((app) => [
      app.id,
      app.name,
      app.description ?? '',
    ]),
    ...detail.mcpServers,
    ...detail.skills.flatMap((skill) => [
      skill.name,
      skill.displayName ?? '',
      skill.description ?? '',
      skill.path ?? '',
    ]),
  ];
  return {
    primary: primary.map((value) => String(value ?? '').trim()).filter(Boolean),
    secondary: secondary.map((value) => String(value ?? '').trim()).filter(Boolean),
  };
}

function isPluginSubsequenceMatch(needle: string, haystack: string): boolean {
  if (needle.length < 3 || haystack.length < 3 || needle.length > haystack.length + 2) {
    return false;
  }
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) {
      index += 1;
      if (index >= needle.length) {
        return true;
      }
    }
  }
  return false;
}

function pluginEditDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (!left) {
    return right.length;
  }
  if (!right) {
    return left.length;
  }
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + cost,
      );
    }
    for (let index = 0; index < previous.length; index += 1) {
      previous[index] = current[index];
    }
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

function isPluginFuzzyTokenMatch(token: string, fieldToken: string): boolean {
  if (token.length < 3 || fieldToken.length < 3) {
    return false;
  }
  if (isPluginSubsequenceMatch(token, fieldToken)) {
    return true;
  }
  const maxDistance = token.length <= 5 ? 1 : 2;
  return Math.abs(token.length - fieldToken.length) <= maxDistance
    && pluginEditDistance(token, fieldToken) <= maxDistance;
}

function scorePluginTokenAgainstField(token: string, normalizedField: string): number {
  if (!token || !normalizedField) {
    return 0;
  }
  if (normalizedField === token) {
    return 72;
  }
  if (normalizedField.startsWith(token)) {
    return 48;
  }
  if (normalizedField.includes(token)) {
    return token.length >= 3 ? 32 : 12;
  }
  const fieldTokens = splitPluginSearchTokens(normalizedField);
  let best = 0;
  for (const fieldToken of fieldTokens) {
    if (fieldToken === token) {
      best = Math.max(best, 64);
    } else if (fieldToken.startsWith(token)) {
      best = Math.max(best, 36);
    } else if (fieldToken.includes(token)) {
      best = Math.max(best, 24);
    } else if (token.length >= 3 && token.includes(fieldToken) && fieldToken.length >= 3) {
      best = Math.max(best, 18);
    } else if (isPluginFuzzyTokenMatch(token, fieldToken)) {
      best = Math.max(best, 16);
    }
  }
  return best;
}

function scorePluginMatch(detail: ProviderPluginDetail, searchTerm: string): number {
  const normalizedQuery = normalizePluginLookupToken(searchTerm);
  if (!normalizedQuery) {
    return 0;
  }
  const tokens = buildPluginSearchTokens(searchTerm);
  if (tokens.length === 0) {
    return 0;
  }
  const fields = collectPluginSearchFields(detail);
  const primary = fields.primary.map((field) => normalizePluginLookupToken(field)).filter(Boolean);
  const secondary = fields.secondary.map((field) => normalizePluginLookupToken(field)).filter(Boolean);
  let score = 0;
  for (const field of primary) {
    if (field === normalizedQuery) {
      score += 240;
    } else if (field.startsWith(normalizedQuery)) {
      score += 180;
    } else if (field.includes(normalizedQuery)) {
      score += 120;
    }
  }
  for (const field of secondary) {
    if (field === normalizedQuery) {
      score += 120;
    } else if (field.startsWith(normalizedQuery)) {
      score += 84;
    } else if (field.includes(normalizedQuery)) {
      score += 56;
    }
  }
  for (const token of tokens) {
    const primaryBest = primary.reduce((best, field) => Math.max(best, scorePluginTokenAgainstField(token, field)), 0);
    const secondaryBest = secondary.reduce((best, field) => Math.max(best, scorePluginTokenAgainstField(token, field)), 0);
    score += primaryBest * 2 + secondaryBest;
  }
  if (detail.summary.installed) {
    score += 4;
  }
  if (detail.summary.enabled) {
    score += 2;
  }
  return score;
}

function searchPluginDetails(details: ProviderPluginDetail[], searchTerm: string): PluginSearchMatch[] {
  return details
    .map((detail) => ({
      detail,
      score: scorePluginMatch(detail, searchTerm),
    }))
    .filter((entry) => entry.score >= PLUGIN_SEARCH_MIN_SCORE)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return comparePluginsForDisplay(left.detail.summary, right.detail.summary);
    });
}

function comparePluginsForDisplay(left: ProviderPluginSummary, right: ProviderPluginSummary): number {
  if (left.installed !== right.installed) {
    return left.installed ? -1 : 1;
  }
  return getPluginDisplayName(left).localeCompare(getPluginDisplayName(right));
}

function compareAppsForDisplay(left: ProviderAppInfo, right: ProviderAppInfo): number {
  if (left.isEnabled !== right.isEnabled) {
    return left.isEnabled ? -1 : 1;
  }
  if (left.isAccessible !== right.isAccessible) {
    return left.isAccessible ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

function scoreAppMatch(app: ProviderAppInfo, searchTerm: string): number {
  const normalizedQuery = normalizeAppLookupToken(searchTerm);
  if (!normalizedQuery) {
    return 0;
  }
  const tokens = normalizedQuery.split(' ').filter(Boolean);
  const primaryFields = [
    normalizeAppLookupToken(app.name),
    normalizeAppLookupToken(app.id),
    ...app.pluginDisplayNames.map((entry) => normalizeAppLookupToken(entry)),
  ].filter(Boolean);
  const secondaryFields = [
    normalizeAppLookupToken(app.description ?? ''),
    normalizeAppLookupToken(app.developer ?? ''),
    ...(Array.isArray(app.categories) ? app.categories.map((entry) => normalizeAppLookupToken(entry)) : []),
  ].filter(Boolean);
  let score = 0;
  for (const field of primaryFields) {
    if (field === normalizedQuery) {
      score += 120;
    } else if (field.startsWith(normalizedQuery)) {
      score += 80;
    } else if (field.includes(normalizedQuery)) {
      score += 48;
    }
  }
  for (const field of secondaryFields) {
    if (field === normalizedQuery) {
      score += 72;
    } else if (field.startsWith(normalizedQuery)) {
      score += 40;
    } else if (field.includes(normalizedQuery)) {
      score += 24;
    }
  }
  for (const token of tokens) {
    if (!token) {
      continue;
    }
    for (const field of [...primaryFields, ...secondaryFields]) {
      if (field.includes(token)) {
        score += token.length >= 3 ? 12 : 6;
      }
    }
  }
  return score;
}

function filterAppsBySearchTerm(apps: ProviderAppInfo[], searchTerm: string | null): ProviderAppInfo[] {
  const normalizedQuery = normalizeNullableString(searchTerm);
  if (!normalizedQuery) {
    return [...apps].sort(compareAppsForDisplay);
  }
  return apps
    .map((app) => ({
      app,
      score: scoreAppMatch(app, normalizedQuery),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return compareAppsForDisplay(left.app, right.app);
    })
    .map((entry) => entry.app);
}

function buildInstalledPluginLookupSet(plugins: ProviderPluginSummary[]): Set<string> {
  const lookups = new Set<string>();
  for (const plugin of plugins) {
    if (!plugin.installed) {
      continue;
    }
    const candidates = [
      plugin.name,
      plugin.displayName ?? '',
      plugin.id.split('@')[0] ?? '',
    ];
    for (const candidate of candidates) {
      const normalized = normalizeAppLookupToken(candidate);
      if (normalized) {
        lookups.add(normalized);
      }
    }
  }
  return lookups;
}

function isAppRelatedToInstalledPlugin(app: ProviderAppInfo, installedPluginLookups: Set<string> | null): boolean {
  if (!installedPluginLookups || installedPluginLookups.size === 0) {
    return false;
  }
  const candidates = [
    app.id,
    app.name,
    ...(Array.isArray(app.pluginDisplayNames) ? app.pluginDisplayNames : []),
  ];
  return candidates.some((candidate) => {
    const normalized = normalizeAppLookupToken(candidate);
    return normalized ? installedPluginLookups.has(normalized) : false;
  });
}

function filterAppsForBrowserView(
  apps: ProviderAppInfo[],
  {
    mode,
    searchTerm = null,
    installedPluginLookups = null,
  }: {
    mode: 'default' | 'all' | 'search';
    searchTerm?: string | null;
    installedPluginLookups?: Set<string> | null;
  },
): ProviderAppInfo[] {
  if (mode === 'all') {
    return [...apps].sort(compareAppsForDisplay);
  }
  if (mode === 'search') {
    return filterAppsBySearchTerm(apps, searchTerm);
  }
  return apps
    .filter((app) => app.isAccessible || app.isEnabled || isAppRelatedToInstalledPlugin(app, installedPluginLookups))
    .sort(compareAppsForDisplay);
}

function parsePositiveIntegerToken(value: unknown): number | null {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/u.test(normalized)) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

function pageNumberForItemIndex(index: number, pageSize: number): number {
  return Number.isInteger(index) && index >= 0
    ? Math.floor(index / pageSize) + 1
    : 1;
}

function findAppLookupMatch(items: ProviderAppInfo[], normalized: string): ProviderAppInfo | null {
  const byExact = items.find((entry) => {
    const candidates = [
      entry.id,
      entry.name,
      ...(Array.isArray(entry.pluginDisplayNames) ? entry.pluginDisplayNames : []),
    ];
    return candidates.some((candidate) => normalizeAppLookupToken(candidate) === normalized);
  }) ?? null;
  if (byExact) {
    return byExact;
  }
  return items.find((entry) => {
    const haystack = [
      entry.id,
      entry.name,
      entry.description ?? '',
      entry.developer ?? '',
      ...(Array.isArray(entry.pluginDisplayNames) ? entry.pluginDisplayNames : []),
      ...(Array.isArray(entry.categories) ? entry.categories : []),
    ].map((candidate) => normalizeAppLookupToken(candidate)).join(' ');
    return haystack.includes(normalized);
  }) ?? null;
}

function compareMcpServersForDisplay(left: ProviderMcpServerStatus, right: ProviderMcpServerStatus): number {
  if (left.isEnabled !== right.isEnabled) {
    return left.isEnabled ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

function getPluginDisplayName(plugin: ProviderPluginSummary): string {
  return plugin.displayName || plugin.name;
}

function getPluginDescription(plugin: ProviderPluginSummary): string {
  return plugin.shortDescription || plugin.longDescription || plugin.name;
}

function findPluginAliasForPlugin(aliases: ResolvedPluginAlias[], pluginId: string): ResolvedPluginAlias | null {
  return aliases.find((entry) => entry.pluginId === pluginId) ?? null;
}

function formatPluginAliasSuffix(plugin: ProviderPluginSummary, aliases: ResolvedPluginAlias[], i18n: Translator): string {
  const alias = findPluginAliasForPlugin(aliases, plugin.id);
  return alias ? ` [${i18n.t('coordinator.plugins.aliasShortLabel', { value: alias.alias })}]` : '';
}

function getPluginStatusLabel(plugin: ProviderPluginSummary, i18n: Translator): string {
  if (plugin.installed && plugin.enabled) {
    return i18n.t('coordinator.plugins.status.installedEnabled');
  }
  if (plugin.installed && !plugin.enabled) {
    return i18n.t('coordinator.plugins.status.installedDisabled');
  }
  return i18n.t('coordinator.plugins.status.notInstalled');
}

function summarizePluginKinds(detail: ProviderPluginDetail, i18n: Translator): string[] {
  const tags = [] as string[];
  if (detail.apps.length > 0) {
    tags.push(i18n.t('coordinator.plugins.kind.app'));
  }
  if (detail.mcpServers.length > 0) {
    tags.push(i18n.t('coordinator.plugins.kind.mcp'));
  }
  if (detail.skills.length > 0) {
    tags.push(i18n.t('coordinator.plugins.kind.skill'));
  }
  if (tags.length === 0) {
    for (const kind of summarizePluginCapabilityKinds(detail.summary)) {
      if (kind === 'app') {
        tags.push(i18n.t('coordinator.plugins.kind.app'));
      } else if (kind === 'mcp') {
        tags.push(i18n.t('coordinator.plugins.kind.mcp'));
      } else if (kind === 'skill') {
        tags.push(i18n.t('coordinator.plugins.kind.skill'));
      }
    }
  }
  if (tags.length === 0) {
    tags.push(i18n.t('coordinator.plugins.kind.other'));
  }
  return tags;
}

function renderPluginFeaturedLines({
  i18n,
  cwd,
  items,
  aliases = [],
  totalCount,
  hasExplicitFeatured,
}: {
  i18n: Translator;
  cwd: string | null;
  items: ProviderPluginSummary[];
  aliases?: ResolvedPluginAlias[];
  totalCount: number;
  hasExplicitFeatured: boolean;
}) {
  const lines = [
    i18n.t('coordinator.plugins.featuredTitle', {
      cwd: cwd ?? i18n.t('common.notSet'),
      count: items.length,
    }),
  ];
  if (!hasExplicitFeatured) {
    lines.push(i18n.t('coordinator.plugins.featuredFallback'));
  }
  if (items.length === 0) {
    lines.push(i18n.t('coordinator.plugins.empty'));
    return lines;
  }
  for (const [index, plugin] of items.entries()) {
    lines.push(`${index + 1}. ${getPluginDisplayName(plugin)} [${getPluginStatusLabel(plugin, i18n)}]${formatPluginAliasSuffix(plugin, aliases, i18n)}`);
    lines.push(`   ${truncateInlineText(getPluginDescription(plugin), 88)}`);
  }
  lines.push(i18n.t('coordinator.plugins.featuredFooter', { total: totalCount }));
  lines.push(i18n.t('coordinator.plugins.actionsHint'));
  return lines;
}

function renderPluginCategorySummaryLines({
  i18n,
  cwd,
  buckets,
}: {
  i18n: Translator;
  cwd: string | null;
  buckets: PluginCategoryBucket[];
}) {
  const lines = [
    i18n.t('coordinator.plugins.categoryTitle', {
      cwd: cwd ?? i18n.t('common.notSet'),
      count: buckets.length,
    }),
  ];
  if (buckets.length === 0) {
    lines.push(i18n.t('coordinator.plugins.empty'));
    return lines;
  }
  for (const [index, bucket] of buckets.entries()) {
    lines.push(`${index + 1}. ${bucket.label} | ${bucket.items.length}`);
    lines.push(`   ${bucket.description}`);
  }
  lines.push(i18n.t('coordinator.plugins.categoryActionsHint'));
  return lines;
}

function renderPluginAliasListLines({
  i18n,
  aliases,
}: {
  i18n: Translator;
  aliases: PluginAlias[];
}) {
  const lines = [
    i18n.t('coordinator.plugins.aliasListTitle', { count: aliases.length }),
  ];
  if (aliases.length === 0) {
    lines.push(i18n.t('coordinator.plugins.aliasListEmpty'));
  }
  for (const [index, alias] of aliases.entries()) {
    lines.push(`${index + 1}. ${alias.alias} -> ${alias.displayName || alias.pluginName}`);
  }
  lines.push(i18n.t('coordinator.plugins.aliasActionsHint'));
  return lines;
}

function renderPluginCategoryItemsLines({
  i18n,
  cwd,
  categoryIndex,
  bucket,
  pageItems,
  aliases = [],
  pageNumber,
  pageCount,
}: {
  i18n: Translator;
  cwd: string | null;
  categoryIndex: number;
  bucket: PluginCategoryBucket;
  pageItems: ProviderPluginDetail[];
  aliases?: ResolvedPluginAlias[];
  pageNumber: number;
  pageCount: number;
}) {
  const lines = [
    i18n.t('coordinator.plugins.categoryItemsTitle', {
      cwd: cwd ?? i18n.t('common.notSet'),
      category: bucket.label,
      count: bucket.items.length,
      page: pageNumber,
      pages: pageCount,
    }),
  ];
  for (const [index, detail] of pageItems.entries()) {
    const plugin = detail.summary;
    const kindTags = summarizePluginKinds(detail, i18n);
    const suffix = kindTags.length === 1 && kindTags[0] === i18n.t('coordinator.plugins.kind.other')
      ? ''
      : ` [${kindTags.join('/')}]`;
    lines.push(`${index + 1}. ${getPluginDisplayName(plugin)} [${getPluginStatusLabel(plugin, i18n)}]${suffix}${formatPluginAliasSuffix(plugin, aliases, i18n)}`);
    lines.push(`   ${truncateInlineText(getPluginDescription(plugin), 88)}`);
  }
  if (pageCount > 1) {
    const actions = [] as string[];
    if (pageNumber > 1) {
      actions.push(`/pg list ${categoryIndex} ${pageNumber - 1}`);
    }
    if (pageNumber < pageCount) {
      actions.push(`/pg list ${categoryIndex} ${pageNumber + 1}`);
    }
    lines.push(i18n.t('coordinator.plugins.categoryPageHint', {
      actions: actions.join('  '),
    }));
  }
  lines.push(i18n.t('coordinator.plugins.actionsHint'));
  return lines;
}

function renderPluginSearchLines({
  i18n,
  cwd,
  searchTerm,
  pageItems,
  aliases = [],
  pageNumber,
  pageCount,
  totalCount,
}: {
  i18n: Translator;
  cwd: string | null;
  searchTerm: string;
  pageItems: PluginSearchMatch[];
  aliases?: ResolvedPluginAlias[];
  pageNumber: number;
  pageCount: number;
  totalCount: number;
}) {
  const lines = [
    i18n.t('coordinator.plugins.searchTitle', {
      cwd: cwd ?? i18n.t('common.notSet'),
      term: searchTerm,
      count: totalCount,
      page: pageNumber,
      pages: pageCount,
    }),
  ];
  if (totalCount === 0) {
    lines.push(i18n.t('coordinator.plugins.noMatch'));
    lines.push(i18n.t('coordinator.plugins.searchActionsHint', { term: searchTerm }));
    return lines;
  }
  for (const [index, match] of pageItems.entries()) {
    const detail = match.detail;
    const plugin = detail.summary;
    const kindTags = summarizePluginKinds(detail, i18n);
    const suffix = kindTags.length === 1 && kindTags[0] === i18n.t('coordinator.plugins.kind.other')
      ? ''
      : ` [${kindTags.join('/')}]`;
    lines.push(`${index + 1}. ${getPluginDisplayName(plugin)} [${getPluginStatusLabel(plugin, i18n)}]${suffix}${formatPluginAliasSuffix(plugin, aliases, i18n)}`);
    lines.push(`   ${truncateInlineText(detail.description || getPluginDescription(plugin), 88)}`);
  }
  if (pageCount > 1) {
    const actions = [] as string[];
    if (pageNumber > 1) {
      actions.push(`/pg search ${searchTerm} ${pageNumber - 1}`);
    }
    if (pageNumber < pageCount) {
      actions.push(`/pg search ${searchTerm} ${pageNumber + 1}`);
    }
    lines.push(i18n.t('coordinator.plugins.searchPageHint', {
      actions: actions.join('  '),
    }));
  }
  lines.push(i18n.t('coordinator.plugins.searchActionsHint', { term: searchTerm }));
  return lines;
}

function renderPluginDetailLines({
  i18n,
  index,
  cwd,
  detail,
  aliases = [],
  apps,
  mcpServers,
}: {
  i18n: Translator;
  index: number;
  cwd: string | null;
  detail: ProviderPluginDetail;
  aliases?: ResolvedPluginAlias[];
  apps: ProviderAppInfo[];
  mcpServers: ProviderMcpServerStatus[];
}) {
  const plugin = detail.summary;
  void apps;
  void mcpServers;
  const lines = [
    i18n.t('coordinator.plugins.detailTitle', { index: index > 0 ? index : '?', name: getPluginDisplayName(plugin) }),
    i18n.t('coordinator.plugins.cwdLabel', { value: cwd ?? i18n.t('common.notSet') }),
    i18n.t('coordinator.plugins.marketplaceLabel', { value: plugin.marketplaceDisplayName || plugin.marketplaceName }),
    i18n.t('coordinator.plugins.statusLabel', { value: getPluginStatusLabel(plugin, i18n) }),
    i18n.t('coordinator.plugins.idLabel', { value: plugin.id }),
    i18n.t('coordinator.plugins.bundleKindsLabel', { value: summarizePluginKinds(detail, i18n).join(', ') }),
  ];
  const alias = findPluginAliasForPlugin(aliases, plugin.id);
  if (alias) {
    lines.push(i18n.t('coordinator.plugins.aliasLabel', { value: alias.alias }));
  }
  if (plugin.capabilities && plugin.capabilities.length > 0) {
    lines.push(i18n.t('coordinator.plugins.capabilitiesLabel', { value: plugin.capabilities.join(', ') }));
  }
  lines.push(i18n.t('coordinator.plugins.descriptionLabel', {
    value: detail.description || getPluginDescription(plugin),
  }));
  if (detail.apps.length > 0) {
    lines.push(i18n.t('coordinator.plugins.appsLabel', { count: detail.apps.length }));
    for (const pluginApp of detail.apps) {
      const runtimeApp = findMatchingProviderAppInfo(pluginApp, apps, plugin);
      const segments = [pluginApp.name];
      if (runtimeApp) {
        segments.push(runtimeApp.isEnabled ? i18n.t('common.enabled') : i18n.t('common.disabled'));
        segments.push(runtimeApp.isAccessible
          ? i18n.t('coordinator.plugins.appAccessible')
          : i18n.t('coordinator.plugins.appInaccessible'));
      } else if (pluginApp.needsAuth) {
        segments.push(i18n.t('coordinator.plugins.appNeedsAuth'));
      }
      lines.push(`- ${segments.join(' | ')}`);
    }
    lines.push(i18n.t('coordinator.plugins.appManageHint'));
  }
  if (detail.mcpServers.length > 0) {
    lines.push(i18n.t('coordinator.plugins.mcpLabel', { count: detail.mcpServers.length }));
    for (const name of detail.mcpServers) {
      lines.push(`- ${name}`);
    }
    lines.push(i18n.t('coordinator.plugins.mcpManageHint'));
  }
  if (detail.skills.length > 0) {
    lines.push(i18n.t('coordinator.plugins.skillsLabel', { count: detail.skills.length }));
    for (const skill of detail.skills) {
      lines.push(`- ${skill.displayName || skill.name} | ${skill.enabled ? i18n.t('common.enabled') : i18n.t('common.disabled')}`);
    }
    lines.push(i18n.t('coordinator.plugins.skillManageHint'));
  }
  lines.push(i18n.t('coordinator.plugins.detailActionsHint'));
  return lines;
}

function renderAppsListLines({
  i18n,
  items,
  totalCount,
  pageNumber,
  pageCount,
  mode,
  searchTerm,
}: {
  i18n: Translator;
  items: ProviderAppInfo[];
  totalCount: number;
  pageNumber: number;
  pageCount: number;
  mode: 'default' | 'all' | 'search';
  searchTerm: string | null;
}) {
  const lines = [
    i18n.t('coordinator.apps.title', {
      count: totalCount,
      page: pageNumber,
      pages: pageCount,
    }),
  ];
  lines.push(i18n.t('coordinator.apps.viewLabel', {
    value: mode === 'all'
      ? i18n.t('coordinator.apps.view.all')
      : mode === 'search'
        ? i18n.t('coordinator.apps.view.search')
        : i18n.t('coordinator.apps.view.default'),
  }));
  if (mode === 'search' && searchTerm) {
    lines.push(i18n.t('coordinator.apps.searchLabel', { term: searchTerm }));
  }
  if (totalCount === 0) {
    lines.push(mode === 'search'
      ? i18n.t('coordinator.apps.noMatch')
      : mode === 'default'
        ? i18n.t('coordinator.apps.emptyDefault')
        : i18n.t('coordinator.apps.empty'));
    return lines;
  }
  for (const [index, app] of items.entries()) {
    lines.push(`${index + 1}. ${app.name} [${app.isEnabled ? i18n.t('common.enabled') : i18n.t('common.disabled')}] [${app.isAccessible ? i18n.t('coordinator.plugins.appAccessible') : i18n.t('coordinator.plugins.appInaccessible')}]`);
    const pluginNames = Array.isArray(app.pluginDisplayNames) && app.pluginDisplayNames.length > 0
      ? app.pluginDisplayNames.join(', ')
      : i18n.t('common.unknown');
    lines.push(`   ${truncateInlineText(app.description || pluginNames, 88)}`);
  }
  if (pageCount > 1) {
    const actions = [] as string[];
    if (pageNumber > 1) {
      actions.push(`/apps list ${pageNumber - 1}`);
    }
    if (pageNumber < pageCount) {
      actions.push(`/apps list ${pageNumber + 1}`);
    }
    lines.push(i18n.t('coordinator.apps.pageHint', {
      actions: actions.join('  '),
    }));
  }
  lines.push(i18n.t('coordinator.apps.actionsHint'));
  return lines;
}

function renderAppDetailLines({
  i18n,
  index,
  app,
}: {
  i18n: Translator;
  index: number | null;
  app: ProviderAppInfo;
}) {
  const lines = [
    index !== null
      ? i18n.t('coordinator.apps.detailTitle', { index, name: app.name })
      : i18n.t('coordinator.apps.detailTitleNamed', { name: app.name }),
    i18n.t('coordinator.apps.statusLabel', { value: app.isEnabled ? i18n.t('common.enabled') : i18n.t('common.disabled') }),
    i18n.t('coordinator.apps.accessLabel', { value: app.isAccessible ? i18n.t('coordinator.plugins.appAccessible') : i18n.t('coordinator.plugins.appInaccessible') }),
    i18n.t('coordinator.apps.idLabel', { value: app.id }),
    i18n.t('coordinator.apps.descriptionLabel', { value: app.description || i18n.t('common.notSet') }),
  ];
  if (Array.isArray(app.pluginDisplayNames) && app.pluginDisplayNames.length > 0) {
    lines.push(i18n.t('coordinator.apps.pluginsLabel', { value: app.pluginDisplayNames.join(', ') }));
  }
  if (Array.isArray(app.categories) && app.categories.length > 0) {
    lines.push(i18n.t('coordinator.apps.categoriesLabel', { value: app.categories.join(', ') }));
  }
  if (normalizeNullableString(app.developer ?? null)) {
    lines.push(i18n.t('coordinator.apps.developerLabel', { value: app.developer }));
  }
  if (normalizeNullableString(app.installUrl ?? null)) {
    lines.push(i18n.t('coordinator.apps.authLinkLabel', { value: app.installUrl }));
  }
  lines.push(i18n.t('coordinator.apps.detailActionsHint'));
  return lines;
}

function renderMcpServerListLines({
  i18n,
  items,
}: {
  i18n: Translator;
  items: ProviderMcpServerStatus[];
}) {
  const lines = [
    i18n.t('coordinator.mcp.title', { count: items.length }),
  ];
  if (items.length === 0) {
    lines.push(i18n.t('coordinator.mcp.empty'));
    return lines;
  }
  for (const [index, server] of items.entries()) {
    const status = server.isEnabled ? i18n.t('coordinator.mcp.statusEnabled') : i18n.t('coordinator.mcp.statusDisabled');
    const auth = formatPluginMcpAuthStatusLabel(server.authStatus, i18n);
    lines.push(`${index + 1}. ${server.name} [${status}] [${auth}]`);
    lines.push(`   tools ${server.toolCount} | resources ${server.resourceCount} | templates ${server.resourceTemplateCount}`);
  }
  lines.push(i18n.t('coordinator.mcp.actionsHint'));
  return lines;
}

function renderPluginInstallFollowupLines(
  installResult: ProviderPluginInstallResult,
  i18n: Translator,
): string[] {
  if (!installResult.appsNeedingAuth.length) {
    return [];
  }
  const lines = [
    i18n.t('coordinator.plugins.installAuthNeeded', {
      count: installResult.appsNeedingAuth.length,
    }),
  ];
  for (const app of installResult.appsNeedingAuth) {
    lines.push(`- ${app.name} | /apps auth ${app.id || app.name}`);
  }
  return lines;
}

function renderExplicitPluginIssueLines({
  issues,
  i18n,
}: {
  issues: ExplicitPluginTargetIssue[];
  i18n: Translator;
}): string[] {
  const lines: string[] = [];
  for (const [index, issue] of issues.entries()) {
    if (index > 0) {
      lines.push('');
    }
    const pluginName = getPluginDisplayName(issue.plugin);
    lines.push(i18n.t('coordinator.use.pluginIssueTitle', { name: pluginName }));
    switch (issue.kind) {
      case 'plugin_not_installed':
        lines.push(i18n.t('coordinator.use.pluginIssueNotInstalled'));
        lines.push(i18n.t('coordinator.use.pluginIssueInstallAction', { value: issue.plugin.name }));
        break;
      case 'app_disabled':
        lines.push(i18n.t('coordinator.use.pluginIssueAppDisabled', { name: issue.appName }));
        lines.push(i18n.t('coordinator.use.pluginIssueAppEnableAction', { value: issue.appToken }));
        break;
      case 'app_auth_required':
        lines.push(i18n.t('coordinator.use.pluginIssueAppAuth', { name: issue.appName }));
        lines.push(i18n.t('coordinator.use.pluginIssueAppAuthAction', { value: issue.appToken }));
        break;
      case 'app_unavailable':
        lines.push(i18n.t('coordinator.use.pluginIssueAppUnavailable', { name: issue.appName }));
        lines.push(i18n.t('coordinator.use.pluginIssueAppAuthAction', { value: issue.appToken }));
        break;
      case 'mcp_disabled':
        lines.push(i18n.t('coordinator.use.pluginIssueMcpDisabled', { name: issue.serverName }));
        lines.push(i18n.t('coordinator.use.pluginIssueMcpEnableAction', { value: issue.serverName }));
        break;
      case 'mcp_auth_required':
        lines.push(i18n.t('coordinator.use.pluginIssueMcpAuth', { name: issue.serverName }));
        lines.push(i18n.t('coordinator.use.pluginIssueMcpAuthAction', { value: issue.serverName }));
        break;
      case 'mcp_unavailable':
        lines.push(i18n.t('coordinator.use.pluginIssueMcpUnavailable', { name: issue.serverName }));
        lines.push(i18n.t('coordinator.use.pluginIssueMcpAuthAction', { value: issue.serverName }));
        break;
      default:
        break;
    }
    lines.push(i18n.t('coordinator.use.pluginIssueDetailsAction', { value: issue.plugin.name }));
  }
  lines.push(i18n.t('coordinator.use.pluginIssueRetryHint'));
  return lines;
}

function resolvePluginAppIssue(
  detail: ProviderPluginDetail,
  apps: ProviderAppInfo[],
  target: ExplicitPluginTargetHint,
): Omit<Extract<ExplicitPluginTargetIssue, {
  kind: 'app_auth_required' | 'app_disabled' | 'app_unavailable';
}>, 'plugin'> | null {
  if (!Array.isArray(detail.apps) || detail.apps.length === 0) {
    return null;
  }
  const related = detail.apps.map((pluginApp) => buildPluginAppRelation(pluginApp, apps, detail.summary));
  if (related.some(({ app }) => app?.isEnabled !== false && app?.isAccessible === true)) {
    return null;
  }
  const disabled = related.find(({ app }) => app && app.isEnabled === false) ?? null;
  if (disabled) {
    return {
      kind: 'app_disabled',
      target,
      appToken: disabled.app.id || disabled.app.name,
      appName: disabled.app.name || disabled.pluginApp.name,
    };
  }
  const authRequired = related.find(({ pluginApp, app }) => pluginApp.needsAuth || app?.isAccessible === false) ?? null;
  if (authRequired) {
    return {
      kind: 'app_auth_required',
      target,
      appToken: authRequired.app?.id || authRequired.pluginApp.id || authRequired.pluginApp.name,
      appName: authRequired.app?.name || authRequired.pluginApp.name,
    };
  }
  const fallback = related[0] ?? null;
  if (!fallback) {
    return null;
  }
  return {
    kind: 'app_unavailable',
    target,
    appToken: fallback.app?.id || fallback.pluginApp.id || fallback.pluginApp.name,
    appName: fallback.app?.name || fallback.pluginApp.name,
  };
}

function resolvePluginMcpIssue(
  detail: ProviderPluginDetail,
  mcpServers: ProviderMcpServerStatus[],
  target: ExplicitPluginTargetHint,
): Omit<Extract<ExplicitPluginTargetIssue, {
  kind: 'mcp_auth_required' | 'mcp_disabled' | 'mcp_unavailable';
}>, 'plugin'> | null {
  if (!Array.isArray(detail.mcpServers) || detail.mcpServers.length === 0) {
    return null;
  }
  const related = detail.mcpServers.map((serverName) => buildPluginMcpRelation(serverName, mcpServers));
  if (related.some(({ server }) => server?.isEnabled === true && server.authStatus !== 'notLoggedIn')) {
    return null;
  }
  const disabled = related.find(({ server }) => server && server.isEnabled === false) ?? null;
  if (disabled) {
    return {
      kind: 'mcp_disabled',
      target,
      serverName: disabled.serverName,
    };
  }
  const authRequired = related.find(({ server }) => server?.authStatus === 'notLoggedIn') ?? null;
  if (authRequired) {
    return {
      kind: 'mcp_auth_required',
      target,
      serverName: authRequired.serverName,
    };
  }
  const fallback = related[0] ?? null;
  if (!fallback) {
    return null;
  }
  return {
    kind: 'mcp_unavailable',
    target,
    serverName: fallback.serverName,
  };
}

function hasReadyPluginApp(
  detail: ProviderPluginDetail,
  apps: ProviderAppInfo[],
  plugin: ProviderPluginSummary,
): boolean {
  if (!Array.isArray(detail.apps) || detail.apps.length === 0) {
    return false;
  }
  return detail.apps
    .map((pluginApp) => buildPluginAppRelation(pluginApp, apps, plugin))
    .some(({ app }) => app?.isEnabled !== false && app?.isAccessible === true);
}

function hasReadyPluginMcp(
  detail: ProviderPluginDetail,
  mcpServers: ProviderMcpServerStatus[],
): boolean {
  if (!Array.isArray(detail.mcpServers) || detail.mcpServers.length === 0) {
    return false;
  }
  return detail.mcpServers
    .map((serverName) => buildPluginMcpRelation(serverName, mcpServers))
    .some(({ server }) => server?.isEnabled === true && server.authStatus !== 'notLoggedIn');
}

function buildPluginAppRelation(
  pluginApp: ProviderPluginDetail['apps'][number],
  apps: ProviderAppInfo[],
  plugin: ProviderPluginSummary,
) {
  return {
    pluginApp,
    app: findMatchingProviderAppInfo(pluginApp, apps, plugin),
  };
}

function buildPluginMcpRelation(
  serverName: string,
  mcpServers: ProviderMcpServerStatus[],
) {
  return {
    serverName,
    server: mcpServers.find((entry) => entry.name === serverName) ?? null,
  };
}

function findMatchingProviderAppInfo(
  pluginApp: ProviderPluginDetail['apps'][number],
  apps: ProviderAppInfo[],
  plugin: ProviderPluginSummary,
): ProviderAppInfo | null {
  const pluginDisplayName = getPluginDisplayName(plugin);
  const normalizedId = normalizeAppLookupToken(pluginApp.id);
  const normalizedName = normalizeAppLookupToken(pluginApp.name);
  return apps.find((app) => {
    const pluginNames = Array.isArray(app.pluginDisplayNames) ? app.pluginDisplayNames : [];
    const normalizedPluginNames = pluginNames.map((entry) => normalizeAppLookupToken(entry));
    return (
      (normalizedId && normalizeAppLookupToken(app.id) === normalizedId)
      || (normalizedName && normalizeAppLookupToken(app.name) === normalizedName)
      || normalizedPluginNames.includes(normalizeAppLookupToken(plugin.name))
      || normalizedPluginNames.includes(normalizeAppLookupToken(pluginDisplayName))
    );
  }) ?? null;
}

function formatPluginMcpAuthStatusLabel(
  authStatus: ProviderMcpServerStatus['authStatus'] | null | undefined,
  i18n: Translator,
): string {
  switch (String(authStatus ?? '').trim()) {
    case 'notLoggedIn':
      return i18n.t('coordinator.plugins.mcpAuth.notLoggedIn');
    case 'bearerToken':
      return i18n.t('coordinator.plugins.mcpAuth.bearerToken');
    case 'oAuth':
      return i18n.t('coordinator.plugins.mcpAuth.oAuth');
    case 'unsupported':
      return i18n.t('coordinator.plugins.mcpAuth.unsupported');
    default:
      return String(authStatus ?? i18n.t('common.unknown'));
  }
}

function buildPluginAliasRecord({
  event,
  providerProfileId,
  plugin,
  alias,
  updatedAt,
}: {
  event: InboundTextEvent;
  providerProfileId: string;
  plugin: ProviderPluginSummary;
  alias: string;
  updatedAt: number;
}): PluginAlias {
  return {
    platform: event.platform,
    externalScopeId: event.externalScopeId,
    providerProfileId,
    alias,
    pluginId: plugin.id,
    pluginName: plugin.name,
    marketplaceName: plugin.marketplaceName,
    marketplacePath: plugin.marketplacePath ?? null,
    displayName: getPluginDisplayName(plugin),
    updatedAt,
  };
}

function buildResolvedPluginAliases({
  plugins,
  userAliases,
}: {
  plugins: ProviderPluginSummary[];
  userAliases: PluginAlias[];
}): ResolvedPluginAlias[] {
  const resolved = [] as ResolvedPluginAlias[];
  const reserved = new Set(PLUGIN_ALIAS_RESERVED_TOKENS);
  const byPluginId = new Map(plugins.map((plugin) => [plugin.id, plugin] as const));

  for (const alias of userAliases) {
    const plugin = byPluginId.get(alias.pluginId);
    if (!plugin) {
      continue;
    }
    const normalizedAlias = normalizePluginAliasValue(alias.alias);
    if (!normalizedAlias || reserved.has(normalizedAlias)) {
      continue;
    }
    resolved.push({
      pluginId: plugin.id,
      alias: normalizedAlias,
      source: 'user',
      pluginName: plugin.name,
      displayName: getPluginDisplayName(plugin),
    });
    reserved.add(normalizedAlias);
  }

  for (const plugin of plugins) {
    if (resolved.some((entry) => entry.pluginId === plugin.id)) {
      continue;
    }
    for (const candidate of generatePluginAliasCandidates(plugin)) {
      const normalizedCandidate = normalizePluginAliasValue(candidate);
      if (!normalizedCandidate || reserved.has(normalizedCandidate)) {
        continue;
      }
      resolved.push({
        pluginId: plugin.id,
        alias: normalizedCandidate,
        source: 'auto',
        pluginName: plugin.name,
        displayName: getPluginDisplayName(plugin),
      });
      reserved.add(normalizedCandidate);
      break;
    }
  }

  return resolved;
}

function generatePluginAliasCandidates(plugin: ProviderPluginSummary): string[] {
  const candidates = new Set<string>();
  const wordSets = [
    {
      words: tokenizePluginAliasWords(plugin.name),
      priority: tokenizePluginAliasWords(plugin.name).length > 1 ? 1 : 5,
    },
    {
      words: tokenizePluginAliasWords(plugin.displayName ?? ''),
      priority: tokenizePluginAliasWords(plugin.displayName ?? '').length > 1 ? 2 : 4,
    },
    {
      words: tokenizePluginAliasWords(plugin.id.split('@')[0] ?? ''),
      priority: tokenizePluginAliasWords(plugin.id.split('@')[0] ?? '').length > 1 ? 3 : 6,
    },
  ].sort((left, right) => left.priority - right.priority);
  for (const { words } of wordSets) {
    if (words.length === 0) {
      continue;
    }
    if (words.length >= 2) {
      candidates.add(words[0].slice(0, 1) + words[1].slice(0, 1));
      candidates.add(words[0].slice(0, 1) + words[1].slice(0, 2));
      candidates.add(words[0].slice(0, 2) + words[1].slice(0, 1));
      candidates.add(words.slice(0, 3).map((word) => word.slice(0, 1)).join(''));
    } else {
      candidates.add(words[0].slice(0, 2));
      candidates.add(words[0].slice(0, 3));
      candidates.add(words[0].slice(0, 4));
    }
  }
  return [...candidates].filter((candidate) => /^[a-z0-9][a-z0-9_-]{0,31}$/u.test(candidate));
}

function tokenizePluginAliasWords(value: string): string[] {
  return String(value ?? '')
    .replace(/@.*$/u, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function validatePluginAliasChange({
  alias,
  pluginId,
  existingAliases,
  i18n,
}: {
  alias: unknown;
  pluginId: string;
  existingAliases: PluginAlias[];
  i18n: Translator;
}): { ok: true; alias: string } | { ok: false; message: string } {
  const normalizedAlias = normalizePluginAliasValue(alias);
  if (!normalizedAlias || !/^[a-z0-9][a-z0-9_-]{0,31}$/u.test(normalizedAlias)) {
    return {
      ok: false,
      message: i18n.t('coordinator.plugins.aliasInvalid', { value: String(alias ?? '').trim() || '?' }),
    };
  }
  if (PLUGIN_ALIAS_RESERVED_TOKENS.has(normalizedAlias)) {
    return {
      ok: false,
      message: i18n.t('coordinator.plugins.aliasReserved', { value: normalizedAlias }),
    };
  }
  const conflict = existingAliases.find((entry) => entry.alias === normalizedAlias && entry.pluginId !== pluginId) ?? null;
  if (conflict) {
    return {
      ok: false,
      message: i18n.t('coordinator.plugins.aliasConflict', {
        alias: normalizedAlias,
        name: conflict.displayName || conflict.pluginName,
      }),
    };
  }
  return {
    ok: true,
    alias: normalizedAlias,
  };
}

function normalizePluginLookupToken(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(/[_/\\-]+/gu, ' ')
    .replace(/\s+/gu, ' ');
}

function normalizePluginAliasValue(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/^\/+/u, '')
    .toLowerCase();
}

function normalizeAppLookupToken(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s/_\\-]+/gu, ' ');
}

function normalizeMcpLookupToken(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s/_\\-]+/gu, ' ');
}

function pushUniqueExplicitPluginTarget(targets: ExplicitPluginTargetHint[], target: ExplicitPluginTargetHint): void {
  if (!target || typeof target !== 'object') {
    return;
  }
  if (targets.some((entry) => entry.pluginId === target.pluginId)) {
    return;
  }
  targets.push(target);
}

function resolvePluginTargetHintFromCatalog({
  token,
  allPlugins,
  aliases,
  syntax,
  aliasOnly = false,
}: {
  token: string;
  allPlugins: ProviderPluginSummary[];
  aliases: ResolvedPluginAlias[];
  syntax: ExplicitPluginTargetHint['syntax'];
  aliasOnly?: boolean;
}): ExplicitPluginTargetHint | null {
  const rawToken = String(token ?? '').trim();
  const normalizedAlias = normalizePluginAliasValue(rawToken);
  const alias = normalizedAlias
    ? aliases.find((entry) => entry.alias === normalizedAlias) ?? null
    : null;
  if (alias) {
    const plugin = allPlugins.find((entry) => entry.id === alias.pluginId) ?? null;
    if (!plugin) {
      return null;
    }
    return {
      pluginId: plugin.id,
      pluginName: plugin.name,
      pluginDisplayName: getPluginDisplayName(plugin),
      alias: alias.alias,
      source: alias.source,
      syntax,
    };
  }
  if (aliasOnly) {
    return null;
  }
  const normalized = normalizePluginLookupToken(rawToken);
  if (!normalized) {
    return null;
  }
  const byExact = allPlugins.find((entry) => {
    const candidates = [
      entry.id,
      entry.name,
      entry.displayName ?? '',
    ];
    return candidates.some((candidate) => normalizePluginLookupToken(candidate) === normalized);
  }) ?? null;
  if (!byExact) {
    return null;
  }
  const displayAlias = aliases.find((entry) => entry.pluginId === byExact.id) ?? null;
  return {
    pluginId: byExact.id,
    pluginName: byExact.name,
    pluginDisplayName: getPluginDisplayName(byExact),
    alias: displayAlias?.alias ?? null,
    source: displayAlias?.source ?? 'resolved',
    syntax,
  };
}

function parseConversationPluginInvocation(text: string): ParsedConversationPluginInvocation | null {
  const raw = String(text ?? '').trim();
  if (!raw) {
    return null;
  }
  const mentionMatch = raw.match(/^@([a-z0-9][a-z0-9_-]{0,31})\s+([\s\S]+)$/u);
  if (mentionMatch) {
    return {
      token: mentionMatch[1],
      taskText: mentionMatch[2].trim(),
      syntax: 'at_alias',
    };
  }
  const zhMatch = raw.match(/^用\s*([a-z0-9][a-z0-9_-]{0,31})(?:\s+|[,:：，]\s*)([\s\S]+)$/u);
  if (zhMatch) {
    return {
      token: zhMatch[1],
      taskText: zhMatch[2].trim(),
      syntax: 'zh_alias',
    };
  }
  return null;
}

function normalizeNullableString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

async function stageAttachmentFile(
  attachment: InboundAttachment,
  batchDir: string | null,
  index: number,
): Promise<string | null> {
  const originalPath = normalizeNullableString(attachment.localPath);
  if (!originalPath) {
    return null;
  }
  if (!batchDir) {
    return null;
  }
  const fileName = sanitizeUploadFileName(
    attachment.fileName
    ?? path.basename(originalPath)
    ?? `${attachment.kind}-${index + 1}`,
  );
  const targetPath = await ensureUniqueFilePath(batchDir, `${String(index + 1).padStart(2, '0')}-${fileName}`);
  try {
    await fs.promises.mkdir(batchDir, { recursive: true });
    if (path.resolve(originalPath) === path.resolve(targetPath)) {
      return targetPath;
    }
    await fs.promises.copyFile(originalPath, targetPath);
    return targetPath;
  } catch {
    return null;
  }
}

function sanitizeUploadFileName(value: string): string {
  const normalized = String(value ?? '').trim();
  const safe = normalized.replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, '_');
  return safe || 'attachment';
}

async function ensureUniqueFilePath(directory: string, baseName: string): Promise<string> {
  const parsed = path.parse(baseName);
  let attempt = 0;
  while (true) {
    const candidateName = attempt === 0
      ? baseName
      : `${parsed.name}-${attempt}${parsed.ext}`;
    const candidatePath = path.join(directory, candidateName);
    try {
      await fs.promises.access(candidatePath, fs.constants.F_OK);
      attempt += 1;
    } catch {
      return candidatePath;
    }
  }
}

async function readFileSize(filePath: string | null): Promise<number | null> {
  const normalizedPath = normalizeNullableString(filePath);
  if (!normalizedPath) {
    return null;
  }
  try {
    const stat = await fs.promises.stat(normalizedPath);
    return stat.size;
  } catch {
    return null;
  }
}

function buildCommandCanonicalNameMap(
  specs: Record<string, CommandHelpSpec>,
  hiddenAliases: Record<string, string> = {},
) {
  const map = new Map();
  for (const spec of Object.values(specs)) {
    map.set(spec.name, spec.name);
    for (const alias of spec.aliases) {
      map.set(alias, spec.name);
    }
  }
  for (const [alias, canonical] of Object.entries(hiddenAliases)) {
    map.set(alias, canonical);
  }
  return map;
}

function buildCommandCanonicalNameMapFromAliases(
  aliases: Record<string, readonly string[]>,
  hiddenAliases: Record<string, string> = {},
) {
  const map = new Map();
  for (const [canonical, aliasList] of Object.entries(aliases)) {
    map.set(canonical, canonical);
    for (const alias of aliasList) {
      map.set(alias, canonical);
    }
  }
  for (const [alias, canonical] of Object.entries(hiddenAliases)) {
    map.set(alias, canonical);
  }
  return map;
}

function freezeCommandHelp(spec: CommandHelpSpec): CommandHelpSpec {
  return Object.freeze({
    ...spec,
    aliases: Object.freeze([...(spec.aliases ?? [])]),
    usage: Object.freeze([...(spec.usage ?? [])]),
    examples: Object.freeze([...(spec.examples ?? [])]),
    notes: Object.freeze([...(spec.notes ?? [])]),
  });
}

function normalizeHelpFlag(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[—–－﹣]/gu, '-');
}

function isStaleThreadError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /thread not found/i.test(message);
}

function isResumeRetryableError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /failed to load rollout/i.test(message)
    || /empty session file/i.test(message)
    || /no rollout found/i.test(message);
}

function shouldAutoRebindAfterRecoveryFailure(error) {
  return isStaleThreadError(error) || isResumeRetryableError(error);
}

function isApprovedExecutionStallError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Approval was accepted, but the approved /i.test(message)
    && (
      /produced no follow-up signal/i.test(message)
      || /stopped making progress after/i.test(message)
    );
}

function classifyTurnFailure(error, i18n: Translator) {
  const message = error instanceof Error ? error.message : String(error);
  if ((error as RecoveryFailure)?.reasonCode === 'stale-session-recovery') {
    return {
      outputState: 'stale_session',
      errorMessage: readRecentCodexRuntimeError(undefined, i18n) || message,
    };
  }
  if (/Timed out waiting for Codex turn/i.test(message)) {
    return {
      outputState: 'timeout',
      errorMessage: readRecentCodexRuntimeError(undefined, i18n) || message,
    };
  }
  if (/without auto-rebinding/i.test(message)) {
    return {
      outputState: 'stale_session',
      errorMessage: message,
    };
  }
  if (isApprovedExecutionStallError(error)) {
    return {
      outputState: 'provider_error',
      errorMessage: i18n.t('runtime.error.approvalStalledWorkaround'),
    };
  }
  return {
    outputState: 'provider_error',
    errorMessage: message,
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function enrichSessionRecoveryError(error, session, reason, i18n = createI18n()) {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(
    i18n.t('coordinator.thread.recoveryError', {
      threadId: session.codexThreadId,
      reason,
      message,
    }),
  ) as RecoveryFailure;
  wrapped.reasonCode = 'stale-session-recovery';
  return wrapped;
}

function formatUserError(error) {
  return error instanceof Error ? error.message : String(error);
}

function formatAccountIdentity(identity) {
  if (!identity) {
    return '';
  }
  return identity.email
    || identity.name
    || identity.accountId
    || identity.authMode
    || '';
}

function formatCodexLoginAccountIdentity(account, i18n = createI18n()) {
  if (!account) {
    return i18n.t('common.unknown');
  }
  return String(
    account.email
    || account.name
    || account.accountId
    || account.id
    || i18n.t('common.unknown'),
  ).trim();
}

function formatLoginListItem(index, account, i18n = createI18n()) {
  const markers = [];
  if (account?.isActive) {
    markers.push(i18n.t('coordinator.login.activeMarker'));
  }
  const planType = account?.planType ?? account?.plan ?? null;
  if (planType) {
    markers.push(String(planType));
  }
  const suffix = markers.length > 0 ? ` | ${markers.join(' | ')}` : '';
  return `${index + 1}. ${formatCodexLoginAccountIdentity(account, i18n)}${suffix}`;
}

function formatCodexLoginError(error, i18n = createI18n()) {
  const message = formatUserError(error);
  if (/just a moment|cloudflare/iu.test(message) || /auth\.openai\.com\/oauth\/device\/code/iu.test(message)) {
    return i18n.t('coordinator.login.cloudflareBlocked');
  }
  return truncateCoordinatorText(message, 240);
}

function readRecentCodexRuntimeError(logPath = path.join(os.homedir(), '.codex', 'log', 'codex-tui.log'), i18n = createI18n()) {
  try {
    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw.trimEnd().split('\n').slice(-400);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line.includes('ERROR ')) {
        continue;
      }
      const next = lines[index + 1] ?? '';
      if (/refresh_token_reused/i.test(line) || /refresh_token_reused/i.test(next)) {
        return i18n.t('coordinator.codexAuth.refreshFailed');
      }
      if (/401 Unauthorized/i.test(line) || /401 Unauthorized/i.test(next)) {
        return i18n.t('coordinator.codexAuth.unauthorized');
      }
      const match = line.match(/ERROR\s+[^:]+:\s*(.+)$/);
      if (match?.[1]) {
        return truncateUserError(match[1]);
      }
      return truncateUserError(line);
    }
  } catch {
    return '';
  }
  return '';
}

function truncateUserError(message, limit = 180) {
  const normalized = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

const ACCESS_PRESETS = new Set(['read-only', 'default', 'full-access']);

function normalizeAccessPreset(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return ACCESS_PRESETS.has(normalized) ? normalized : null;
}

function resolveAccessPreset(settings) {
  return normalizeAccessPreset(settings?.accessPreset) ?? 'default';
}

function normalizeCodexPersonalityArg(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'friendly' || normalized === 'pragmatic' || normalized === 'none') {
    return normalized;
  }
  return null;
}

function normalizeServiceTier(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) {
    return null;
  }
  if (normalized === 'priority') {
    return 'fast';
  }
  if (normalized === 'default') {
    return 'flex';
  }
  return normalized;
}

function formatSpeedMode(serviceTier) {
  return normalizeServiceTier(serviceTier) === FAST_SERVICE_TIER ? 'fast' : 'normal';
}

function formatPlanMode(value, i18n: Translator) {
  return String(value ?? '').trim().toLowerCase() === 'plan'
    ? i18n.t('common.enabled')
    : i18n.t('common.default');
}

function formatPersonality(value, i18n: Translator) {
  const normalized = normalizeCodexPersonalityArg(value);
  if (!normalized) {
    return i18n.t('common.default');
  }
  return normalized;
}

function formatInstructionsStatus(hasInstructions: boolean, i18n: Translator) {
  return hasInstructions ? i18n.t('common.enabled') : i18n.t('common.notSet');
}

function resolveAccessModeForPreset(preset) {
  switch (preset) {
    case 'read-only':
      return {
        preset,
        approvalPolicy: 'on-request',
        sandboxMode: 'read-only',
      };
    case 'full-access':
      return {
        preset,
        approvalPolicy: 'never',
        sandboxMode: 'danger-full-access',
      };
    default:
      return {
        preset: 'default',
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
      };
  }
}

function resolveApprovalPolicy(settings) {
  return settings?.approvalPolicy ?? resolveAccessModeForPreset(resolveAccessPreset(settings)).approvalPolicy;
}

function resolveSandboxMode(settings) {
  return settings?.sandboxMode ?? resolveAccessModeForPreset(resolveAccessPreset(settings)).sandboxMode;
}

function formatAccessPreset(preset) {
  if (preset === 'read-only') return 'read-only';
  if (preset === 'full-access') return 'full-access';
  return 'default';
}

function buildInstructionsEditKey(event) {
  return formatPlatformScopeKey(event.platform, event.externalScopeId);
}

function extractInstructionsInlineContent(text: string) {
  const raw = String(text ?? '');
  const match = raw.match(/^\/instructions\s+set(?:\s+|$)([\s\S]*)$/iu);
  if (!match) {
    return '';
  }
  return match[1] ?? '';
}

function renderPermissionsLines(settings, i18n: Translator) {
  return [
    i18n.t('coordinator.permissions.current', { value: formatAccessPreset(resolveAccessPreset(settings)) }),
    i18n.t('coordinator.status.approvalPolicy', { value: resolveApprovalPolicy(settings) }),
    i18n.t('coordinator.status.sandboxMode', { value: resolveSandboxMode(settings) }),
    '',
    i18n.t('coordinator.permissions.availableCommands'),
    '- /permissions read-only',
    '- /permissions default',
    '- /permissions full-access',
    '',
    i18n.t('coordinator.permissions.notes'),
    i18n.t('coordinator.permissions.readOnlyDesc'),
    i18n.t('coordinator.permissions.defaultDesc'),
    i18n.t('coordinator.permissions.fullAccessDesc'),
    '',
    i18n.t('coordinator.permissions.applyNextTurn'),
  ];
}

function parseAllowCommandArgs(args): { option: 1 | 2 | 3 | null; requestIndex: number } {
  const option = normalizeAllowOption(args[0]);
  const parsedIndex = Number.parseInt(String(args[1] ?? ''), 10);
  return {
    option,
    requestIndex: Number.isFinite(parsedIndex) && parsedIndex > 0 ? parsedIndex : 1,
  };
}

function normalizeAllowOption(value): 1 | 2 | 3 | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['1', 'once', 'yes', 'y', 'approve'].includes(normalized)) {
    return 1;
  }
  if (['2', 'session', 'always', 'remember', 'allow'].includes(normalized)) {
    return 2;
  }
  if (['3', 'deny', 'no', 'n', 'reject'].includes(normalized)) {
    return 3;
  }
  return null;
}

function renderAllowLines(requests: ProviderApprovalRequest[], i18n: Translator) {
  const lines = [
    i18n.t('coordinator.allow.title', { count: requests.length }),
  ];
  if (requests.length > 1) {
    lines.push(i18n.t('coordinator.allow.requestIndexHint'));
  }
  const visibleRequests = requests.slice(0, 3);
  for (const [index, request] of visibleRequests.entries()) {
    if (lines.length > 1) {
      lines.push('');
    }
    lines.push(...renderApprovalRequestLines(request, index + 1, i18n));
  }
  if (requests.length > visibleRequests.length) {
    lines.push('');
    lines.push(i18n.t('coordinator.allow.moreRequests', { count: requests.length - visibleRequests.length }));
  }
  return lines;
}

function renderApprovalPromptLines(requests: ProviderApprovalRequest[], i18n: Translator) {
  const visibleRequest = requests[0] ?? null;
  const lines = [
    i18n.t('coordinator.allow.title', { count: requests.length }),
  ];
  if (visibleRequest) {
    lines.push(i18n.t('coordinator.allow.requestHeader', {
      index: 1,
      kind: formatApprovalKind(visibleRequest.kind, i18n),
    }));
    if (visibleRequest.reason) {
      lines.push(i18n.t('coordinator.allow.reason', {
        value: truncateInlineText(visibleRequest.reason, 160),
      }));
    }
  }
  lines.push(i18n.t('coordinator.allow.promptView'));
  if (requests.length > 1) {
    lines.push(i18n.t('coordinator.allow.promptDecisionsIndexed'));
  } else if (visibleRequest && !supportsSessionWideApproval(visibleRequest)) {
    lines.push(i18n.t('coordinator.allow.promptDecisionsSingleNoRemember'));
  } else {
    lines.push(i18n.t('coordinator.allow.promptDecisionsSingle'));
  }
  return lines;
}

function renderApprovalRequestLines(request: ProviderApprovalRequest, index: number, i18n: Translator) {
  const lines = [
    i18n.t('coordinator.allow.requestHeader', {
      index,
      kind: formatApprovalKind(request.kind, i18n),
    }),
  ];
  if (request.reason) {
    lines.push(i18n.t('coordinator.allow.reason', { value: request.reason }));
  }
  if (request.command) {
    lines.push(i18n.t('coordinator.allow.command', { value: request.command }));
  }
  if (request.cwd) {
    lines.push(i18n.t('coordinator.allow.cwd', { value: request.cwd }));
  }
  if (request.fileChanges?.length) {
    lines.push(i18n.t('coordinator.allow.files', { value: request.fileChanges.join(', ') }));
  }
  if (request.grantRoot) {
    lines.push(i18n.t('coordinator.allow.grantRoot', { value: request.grantRoot }));
  }
  if (request.networkPermission != null) {
    lines.push(i18n.t('coordinator.allow.network', {
      value: request.networkPermission ? i18n.t('common.enabled') : i18n.t('common.disabled'),
    }));
  }
  if (request.fileReadPermissions?.length) {
    lines.push(i18n.t('coordinator.allow.fileRead', { value: request.fileReadPermissions.join(', ') }));
  }
  if (request.fileWritePermissions?.length) {
    lines.push(i18n.t('coordinator.allow.fileWrite', { value: request.fileWritePermissions.join(', ') }));
  }
  lines.push(i18n.t('coordinator.allow.options'));
  lines.push(i18n.t('coordinator.allow.option1'));
  lines.push(supportsSessionWideApproval(request)
    ? i18n.t('coordinator.allow.option2')
    : i18n.t('coordinator.allow.option2Unavailable'));
  lines.push(i18n.t('coordinator.allow.option3'));
  lines.push(i18n.t('coordinator.allow.help'));
  return lines;
}

function renderAllowAcknowledgementLines(
  request: ProviderApprovalRequest,
  option: 1 | 2 | 3,
  i18n: Translator,
  activeTurnContinues = true,
) {
  const followUpLine = activeTurnContinues
    ? (option === 3 ? i18n.t('coordinator.allow.waitModel') : i18n.t('coordinator.allow.continue'))
    : i18n.t('coordinator.allow.noLongerActive');
  if (option === 1) {
    return [
      i18n.t('coordinator.allow.approvedOnce', { kind: formatApprovalKind(request.kind, i18n) }),
      followUpLine,
    ];
  }
  if (option === 2) {
    return [
      i18n.t('coordinator.allow.approvedSession', { kind: formatApprovalKind(request.kind, i18n) }),
      followUpLine,
    ];
  }
  return [
    i18n.t('coordinator.allow.denied', { kind: formatApprovalKind(request.kind, i18n) }),
    followUpLine,
  ];
}

function supportsSessionWideApproval(request: ProviderApprovalRequest): boolean {
  if (request.kind === 'permissions' || request.kind === 'file_change') {
    return true;
  }
  return Boolean(
    request.availableDecisionKeys?.includes('acceptForSession')
    || request.availableDecisionKeys?.includes('acceptWithExecpolicyAmendment')
    || (request.execPolicyAmendment && request.execPolicyAmendment.length > 0),
  );
}

function formatApprovalKind(kind: ProviderApprovalRequest['kind'], i18n: Translator) {
  if (kind === 'permissions') {
    return i18n.t('coordinator.allow.kind.permissions');
  }
  if (kind === 'file_change') {
    return i18n.t('coordinator.allow.kind.fileChange');
  }
  return i18n.t('coordinator.allow.kind.command');
}

function parseWeiboCommandArgs(args): HandleWeiboCommandResult | null {
  const normalizedArgs = Array.isArray(args)
    ? args.map((value) => String(value ?? '').trim()).filter(Boolean)
    : [];
  if (normalizedArgs.length === 0) {
    return { limit: 10 };
  }
  if (normalizedArgs.length === 1) {
    const limit = parseWeiboLimit(normalizedArgs[0]);
    return limit ? { limit } : null;
  }
  if (normalizedArgs.length === 2 && ['top', 'hot'].includes(normalizedArgs[0].toLowerCase())) {
    const limit = parseWeiboLimit(normalizedArgs[1]);
    return limit ? { limit } : null;
  }
  return null;
}

function parseWeiboLimit(value: string): number | null {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 20) {
    return null;
  }
  return parsed;
}

function formatWeiboHotSearchLine(
  item: { position: number; title: string; label: string | null; category: string | null; hotValue: number | null },
  i18n: Translator,
): string {
  const suffix: string[] = [];
  if (item.label) {
    suffix.push(item.label);
  }
  if (item.category) {
    suffix.push(item.category);
  }
  if (item.hotValue) {
    suffix.push(`${i18n.locale === 'zh-CN' ? '热度' : 'Heat'} ${formatCompactInteger(item.hotValue)}`);
  }
  return `${item.position}. ${item.title}${suffix.length > 0 ? ` (${suffix.join(' | ')})` : ''}`;
}

function formatCompactInteger(value: number): string {
  return new Intl.NumberFormat('en-US').format(Math.max(0, Math.round(Number(value) || 0)));
}

function formatCommandTimestamp(value: number, locale: SupportedLocale): string {
  return new Intl.DateTimeFormat(locale === 'zh-CN' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(new Date(value));
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  const fallback = String(error ?? '').trim();
  return fallback || 'Unknown error';
}

function debugCoordinator(event: string, payload: unknown) {
  writeSequencedDebugLog('bridge-coordinator', event, payload);
}

function truncateCoordinatorText(value: unknown, limit = 240): string {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (!text) {
    return '';
  }
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}
