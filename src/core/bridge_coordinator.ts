import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { formatPlatformScopeKey } from './contracts.js';
import { parseSlashCommand } from './command_parser.js';
import { NotFoundError } from './errors.js';
import {
  createPendingTurnArtifactDeliveryState,
  createTurnArtifactContext,
  detectRequestedArtifactFormat,
  detectTurnArtifactIntent,
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
import type { TurnArtifactDeliveryState, UploadBatchItem, UploadBatchState } from '../types/core.js';
import type { InboundAttachment, InboundTextEvent } from '../types/platform.js';
import type {
  OutputArtifact,
  ProviderApprovalRequest,
  ProviderReviewTarget,
  ProviderTurnProgress,
} from '../types/provider.js';

const THREAD_PAGE_SIZE = 5;
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
  activeTurns: any;
  providerProfiles: any;
  providerRegistry: any;
  defaultProviderProfileId: any;
  defaultCwd: any;
  restartBridge: any;

  codexAuthManager: CodexAuthManagerLike | null;
  codexInstructionsManager: CodexInstructionsManagerLike;
  now: any;
  threadBrowserStates: Map<any, any>;
  localeOverridesByScope: Map<string, SupportedLocale>;
  pendingArtifactClarificationsByScope: Map<string, { originalText: string; askedAt: number }>;
  pendingInstructionsEditsByScope: Map<string, { startedAt: number }>;
  localeContext: AsyncLocalStorage<SupportedLocale>;
  i18n: Translator;

  constructor({
    bridgeSessions,
    activeTurns = null,
    providerProfiles,
    providerRegistry,
    defaultProviderProfileId,
    defaultCwd = null,
    restartBridge = null,
    codexAuthManager = null,
    codexInstructionsManager = null,
    now = () => Date.now(),
    locale = null,
  }) {
    this.bridgeSessions = bridgeSessions;
    this.activeTurns = activeTurns;
    this.providerProfiles = providerProfiles;
    this.providerRegistry = providerRegistry;
    this.defaultProviderProfileId = defaultProviderProfileId;
    this.defaultCwd = normalizeCwd(defaultCwd);
    this.restartBridge = restartBridge;
    this.codexAuthManager = codexAuthManager;
    this.codexInstructionsManager = codexInstructionsManager ?? new CodexInstructionsManager();
    this.now = now;
    this.threadBrowserStates = new Map();
    this.localeOverridesByScope = new Map();
    this.pendingArtifactClarificationsByScope = new Map();
    this.pendingInstructionsEditsByScope = new Map();
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
    const session = this.bridgeSessions.resolveScopeSession(scopeRef);
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
    debugCoordinator('conversation_turn_begin', {
      platform: scopeRef.platform,
      scopeId: scopeRef.externalScopeId,
      textPreview: truncateCoordinatorText(event?.text, 160),
      attachmentCount: Array.isArray(event?.attachments) ? event.attachments.length : 0,
    });
    const clarification = this.resolveArtifactClarification(scopeRef, event);
    if (clarification.response) {
      debugCoordinator('conversation_turn_clarification_requested', {
        platform: scopeRef.platform,
        scopeId: scopeRef.externalScopeId,
      });
      return clarification.response;
    }
    const effectiveEvent = clarification.event ?? event;
    const currentSession = this.bridgeSessions.resolveScopeSession(scopeRef);
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
    this.activeTurns?.beginScopeTurn(scopeRef);
    let session = null;
    try {
      const locale = this.resolveScopeLocale(scopeRef, effectiveEvent);
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
      this.storeRetryableRequest(session.id, effectiveEvent);
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
    const scopeKey = formatPlatformScopeKey(scopeRef.platform, scopeRef.externalScopeId);
    const pending = this.pendingArtifactClarificationsByScope.get(scopeKey) ?? null;
    if (pending) {
      this.pendingArtifactClarificationsByScope.delete(scopeKey);
      const resolvedFormat = detectRequestedArtifactFormat(event?.text ?? '');
      if (!resolvedFormat) {
        return { event };
      }
      return {
        event: {
          ...event,
          text: mergeArtifactClarificationAnswer(pending.originalText, resolvedFormat),
        },
      };
    }
    const intent = detectTurnArtifactIntent(event?.text ?? '');
    if (!intent.requested || !intent.requiresClarification) {
      return { event };
    }
    this.pendingArtifactClarificationsByScope.set(scopeKey, {
      originalText: String(event?.text ?? ''),
      askedAt: this.now(),
    });
    return {
      response: messageResponse([
        this.t('coordinator.artifact.clarifyFormat'),
      ], this.buildScopedSessionMeta(event)),
    };
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
      case 'stop':
      case 'interrupt':
        return this.handleStopCommand(event);
      case 'review':
        return this.handleReviewCommand(event, command.args, options);
      case 'threads':
        return this.handleThreadsCommand(event);
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
      initialSettings: {
        locale: this.resolveScopeLocale(scopeRef, event),
        personality: existingSettings?.personality ?? null,
      },
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

  async handleThreadsCommand(event) {
    const scopeRef = toScopeRef(event);
    const current = this.bridgeSessions.resolveScopeSession(scopeRef);
    const providerProfileId = current?.providerProfileId ?? this.resolveDefaultProviderProfileId();
    return this.renderThreadsPage(event, {
      providerProfileId,
      cursor: null,
      previousCursors: [],
      searchTerm: null,
      pageNumber: 1,
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
    });
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
        initialSettings: {
          locale: this.resolveScopeLocale(scopeRef, event),
        },
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
      initialSettings: {
        locale: this.resolveScopeLocale(scopeRef, event),
        personality: currentSettings?.personality ?? null,
      },
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

  async renderThreadsPage(event, {
    providerProfileId,
    cursor,
    previousCursors,
    searchTerm,
    pageNumber,
  }) {
    const scopeRef = toScopeRef(event);
    const current = this.bridgeSessions.resolveScopeSession(scopeRef);
    const providerProfile = this.requireProviderProfile(providerProfileId);
    const result = await this.bridgeSessions.listProviderThreads(providerProfile.id, {
      limit: THREAD_PAGE_SIZE,
      cursor,
      searchTerm,
    });
    if (result.items.length === 0) {
      if (searchTerm) {
        return textResponse([
          this.t('coordinator.threadList.title', { providerProfileId: providerProfile.id }),
          this.t('coordinator.threadList.search', { term: searchTerm }),
          '',
          this.t('coordinator.threadList.noMatch'),
          this.t('coordinator.threadList.viewAll'),
        ].join('\n'), current ? buildSessionMeta(current) : undefined);
      }
      return textResponse([
        this.t('coordinator.threadList.title', { providerProfileId: providerProfile.id }),
        '',
        this.t('coordinator.threadList.empty'),
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
      updatedAt: this.now(),
    });
    return textResponse(renderThreadsPageMessage({
      i18n: this.currentI18n,
      providerProfile,
      currentSession: current,
      items: result.items,
      pageNumber,
      searchTerm,
      hasPreviousPage: previousCursors.length > 0,
      hasNextPage: Boolean(result.nextCursor),
    }), current ? buildSessionMeta(current) : undefined);
  }

  buildScopedSessionMeta(event) {
    const session = this.bridgeSessions.resolveScopeSession(toScopeRef(event));
    return session ? buildSessionMeta(session) : undefined;
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

  resolveRequestedThread(event, requested) {
    const value = String(requested ?? '').trim();
    if (!value) {
        return {
          ok: false,
          message: this.t('coordinator.thread.requestTarget'),
        };
      }
      if (/^\d+$/u.test(value)) {
      const state = this.getThreadBrowserState(event);
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
      };
    }
    const scopeRef = toScopeRef(event);
    const current = this.bridgeSessions.resolveScopeSession(scopeRef);
    const state = this.getThreadBrowserState(event);
    return {
      ok: true,
      providerProfileId: state?.providerProfileId ?? current?.providerProfileId ?? this.resolveDefaultProviderProfileId(),
      threadId: value,
    };
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

  async startTurnOnSession(session, event, options: StartTurnOptions = {}) {
    const scopeRef = toScopeRef(event);
    const providerProfile = this.requireProviderProfile(session.providerProfileId);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const sessionSettings = this.bridgeSessions.getSessionSettings(session.id);
    const turnArtifactContext = createTurnArtifactContext({
      bridgeSessionId: session.id,
      cwd: normalizeCwd(session.cwd) ?? this.resolveEventCwd(event),
      text: event.text,
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
        }
        : null,
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
    throw lastError;
  }

  async resumeTurnOnSameSession(session, event, options: StartTurnOptions = {}, originalError) {
    const providerProfile = this.requireProviderProfile(session.providerProfileId);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (typeof providerPlugin.resumeThread !== 'function') {
      throw enrichSessionRecoveryError(originalError, session, 'provider has no resumeThread support', this.currentI18n);
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
    throw enrichSessionRecoveryError(lastError, session, 'resumeThread failed', this.currentI18n);
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

function mergeArtifactClarificationAnswer(originalText: string, format: string): string {
  const normalizedOriginal = String(originalText ?? '').trim();
  const normalizedFormat = String(format ?? '').trim().toUpperCase();
  if (!normalizedOriginal) {
    return `Export the final deliverable as ${normalizedFormat} and send it back as an attachment.`;
  }
  return `${normalizedOriginal}\n\nExport the final deliverable as ${normalizedFormat} and send it back as an attachment.`;
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
  if (searchTerm) {
    lines.push(i18n.t('coordinator.threadList.search', { term: searchTerm }));
  }
  lines.push('');
  for (const [index, item] of items.entries()) {
    const marker = currentSession?.providerProfileId === providerProfile.id && currentSession.codexThreadId === item.threadId
      ? '*'
      : ' ';
    lines.push(`${marker} ${index + 1}. ${formatThreadTitle(item.title, item.preview, i18n)}`);
    lines.push(`   ${i18n.t('coordinator.threadList.preview', { preview: normalizeThreadPreview(item.preview, i18n) })}`);
    lines.push(`   ${i18n.t('coordinator.threadList.updatedAt', { value: formatRelativeTime(item.updatedAt, i18n) })}`);
    lines.push('');
  }
  lines.push(buildThreadsFooter({
    i18n,
    hasPreviousPage,
    hasNextPage,
    exampleIndex: Math.min(2, Math.max(1, items.length)),
  }));
  return lines.join('\n').trim();
}

function buildThreadsFooter({ i18n, hasPreviousPage, hasNextPage, exampleIndex }: {
  i18n: Translator;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
  exampleIndex: number;
}) {
  const index = Number(exampleIndex || 1);
  const commands = [
    `/open ${index}`,
    `/peek ${index}`,
    `/rename ${index} ${i18n.t('common.example.newName')}`,
    `/search ${i18n.t('common.example.keyword')}`,
    '/threads',
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
      '/threads -h',
    ],
    examples: [
      '/threads',
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
  'new',
  'uploads',
  'provider',
  'models',
  'model',
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
  new: ['n'],
  uploads: ['up', 'ul'],
  provider: ['pd'],
  models: ['ms'],
  model: ['m'],
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
    || /empty session file/i.test(message);
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
