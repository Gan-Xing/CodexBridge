import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { formatPlatformScopeKey } from './contracts.js';
import { parseSlashCommand } from './command_parser.js';
import { NotFoundError } from './errors.js';
import {
  createI18n,
  formatRelativeTimeLocalized,
  normalizeLocale,
  type SupportedLocale,
  type Translator,
} from '../i18n/index.js';

const THREAD_PAGE_SIZE = 5;
const THREAD_PREVIEW_LIMIT = 72;
const THREAD_HISTORY_TURN_LIMIT = 3;
const HELP_FLAG_SET = new Set(['-h', '--help', '-help', '-helps']);

type CoordinatorResponse = {
  type: 'message';
  messages: Array<{ text: string }>;
  session: any;
  meta?: Record<string, any>;
};

type StartTurnOptions = {
  onProgress?: unknown;
  onTurnStarted?: (meta: {
    turnId: string | null;
    threadId: string | null;
    bridgeSessionId: string;
    providerProfileId: string;
  }) => Promise<void> | void;
};

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

export class BridgeCoordinator {
  bridgeSessions: any;
  activeTurns: any;
  providerProfiles: any;
  providerRegistry: any;
  defaultProviderProfileId: any;
  defaultCwd: any;
  restartBridge: any;
  now: any;
  threadBrowserStates: Map<any, any>;
  localeOverridesByScope: Map<string, SupportedLocale>;
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
    this.now = now;
    this.threadBrowserStates = new Map();
    this.localeOverridesByScope = new Map();
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
    const command = parseSlashCommand(event.text);
    if (command) {
      return this.handleCommand(event, command);
    }
    return this.handleConversationTurn(event, options);
  }

  async handleConversationTurn(event, options = {}) {
    const scopeRef = toScopeRef(event);
    const activeTurn = this.activeTurns?.resolveScopeTurn(scopeRef) ?? null;
    if (activeTurn) {
      return this.buildActiveTurnBlockedResponse(event, activeTurn);
    }
    this.activeTurns?.beginScopeTurn(scopeRef);
    let session = null;
    try {
      const locale = this.resolveScopeLocale(scopeRef, event);
      session = await this.bridgeSessions.resolveOrCreateScopeSession(scopeRef, {
        providerProfileId: this.resolveDefaultProviderProfileId(),
        cwd: this.resolveEventCwd(event),
        initialSettings: {
          locale,
        },
        providerStartOptions: {
          sourcePlatform: event.platform,
        },
      });
      this.activeTurns?.updateScopeTurn(scopeRef, {
        bridgeSessionId: session.id,
        providerProfileId: session.providerProfileId,
        threadId: session.codexThreadId,
      });
      const { result, session: nextSession } = await this.startTurnWithRecovery(scopeRef, session, event, options);
      const response = messageResponse([result.outputText], buildSessionMeta(nextSession));
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
      if (!failure) {
        throw error;
      }
      const response = messageResponse([''], session ? buildSessionMeta(session) : this.buildScopedSessionMeta(event));
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

  async handleCommand(event, command) {
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
        return this.handleStatusCommand(event);
      case 'new':
        return this.handleNewCommand(event, command.args);
      case 'stop':
      case 'interrupt':
        return this.handleStopCommand(event);
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
      case 'permissions':
        return this.handlePermissionsCommand(event, command.args);
      case 'models':
        return this.handleModelsCommand(event);
      case 'model':
        return this.handleModelCommand(event, command.args);
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

  async handleStatusCommand(event) {
    const scopeRef = toScopeRef(event);
    const session = this.bridgeSessions.resolveScopeSession(scopeRef);
    if (!session) {
      return messageResponse([
        this.t('coordinator.status.unboundScope', { scope: `${event.platform}:${event.externalScopeId}` }),
        this.t('coordinator.status.defaultProvider', { id: this.resolveDefaultProviderProfileId() }),
        this.t('coordinator.status.defaultCwd', { cwd: this.defaultCwd ?? this.t('common.notSet') }),
      ]);
    }
    const providerProfile = this.requireProviderProfile(session.providerProfileId);
    const settings = this.bridgeSessions.getSessionSettings(session.id);
    const activeTurn = this.activeTurns?.resolveScopeTurn(scopeRef) ?? null;
    return messageResponse([
      this.t('coordinator.status.scope', { scope: `${event.platform}:${event.externalScopeId}` }),
      this.t('coordinator.status.bridgeSession', { id: session.id }),
      this.t('coordinator.status.providerProfile', { id: providerProfile.id }),
      this.t('coordinator.status.providerKind', { kind: providerProfile.providerKind }),
      this.t('coordinator.status.codexThread', { id: session.codexThreadId }),
      this.t('coordinator.status.workingDirectory', { cwd: session.cwd ?? this.defaultCwd ?? this.t('common.notSet') }),
      this.t('coordinator.status.model', { value: settings?.model ?? this.t('common.default') }),
      this.t('coordinator.status.reasoningEffort', { value: settings?.reasoningEffort ?? this.t('common.default') }),
      this.t('coordinator.status.serviceTier', { value: settings?.serviceTier ?? this.t('common.default') }),
      this.t('coordinator.status.accessPreset', { value: formatAccessPreset(resolveAccessPreset(settings)) }),
      this.t('coordinator.status.approvalPolicy', { value: resolveApprovalPolicy(settings) }),
      this.t('coordinator.status.sandboxMode', { value: resolveSandboxMode(settings) }),
      this.t('coordinator.status.currentTurn', { value: formatActiveTurnValue(activeTurn, this.currentI18n) }),
      this.t('coordinator.status.turnState', { value: formatActiveTurnState(activeTurn, this.currentI18n) }),
      ...(activeTurn ? [this.t('coordinator.status.turnControl')] : []),
    ], buildSessionMeta(session));
  }

  async handleNewCommand(event, args) {
    const activeResponse = this.rejectIfActiveTurnForCommand(event, 'new');
    if (activeResponse) {
      return activeResponse;
    }
    const scopeRef = toScopeRef(event);
    const existing = this.bridgeSessions.resolveScopeSession(scopeRef);
    const providerProfileId = existing?.providerProfileId ?? this.resolveDefaultProviderProfileId();
    const nextSession = await this.bridgeSessions.createSessionForScope(scopeRef, {
      providerProfileId,
      cwd: args.join(' ').trim() || existing?.cwd || this.resolveEventCwd(event),
      initialSettings: {
        locale: this.resolveScopeLocale(scopeRef, event),
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
    const activeResponse = this.rejectIfActiveTurnForCommand(event, 'open');
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
    const activeResponse = this.rejectIfActiveTurnForCommand(event, 'model');
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
    const activeResponse = this.rejectIfActiveTurnForCommand(event, 'rename');
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
    const activeResponse = this.rejectIfActiveTurnForCommand(event, 'provider');
    if (activeResponse) {
      return activeResponse;
    }
    const switched = await this.bridgeSessions.switchScopeProvider(scopeRef, {
      nextProviderProfileId: profile.id,
      initialSettings: {
        locale: this.resolveScopeLocale(scopeRef, event),
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
    const activeResponse = this.rejectIfActiveTurnForCommand(event, 'restart');
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
    const activeResponse = this.rejectIfActiveTurnForCommand(event, 'reconnect');
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
    const activeResponse = this.rejectIfActiveTurnForCommand(event, 'permissions');
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

  async handleStopCommand(event) {
    const scopeRef = toScopeRef(event);
    const active = this.activeTurns?.resolveScopeTurn(scopeRef) ?? null;
    if (!active) {
      return messageResponse([this.t('coordinator.stop.none')], this.buildScopedSessionMeta(event));
    }
    if (active.interruptRequested) {
      return messageResponse([this.t('coordinator.stop.alreadyRequested')], buildActiveTurnMeta(active));
    }
    this.activeTurns?.requestInterrupt(scopeRef);
    if (!active.turnId) {
      return messageResponse([this.t('coordinator.stop.starting')], buildActiveTurnMeta(active));
    }
    try {
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

  buildActiveTurnBlockedResponse(event, activeTurn) {
    return messageResponse([
      this.t('coordinator.blocked.active'),
      activeTurn.interruptRequested
        ? this.t('coordinator.blocked.interruptRequested')
        : this.t('coordinator.blocked.waitOrStop'),
    ], buildActiveTurnMeta(activeTurn) ?? this.buildScopedSessionMeta(event));
  }

  rejectIfActiveTurnForCommand(event, commandName = 'generic') {
    const activeTurn = this.activeTurns?.resolveScopeTurn(toScopeRef(event)) ?? null;
    if (!activeTurn) {
      return null;
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

  async startTurnWithRecovery(scopeRef, session, event, options: StartTurnOptions = {}) {
    try {
      return await this.startTurnOnSession(session, event, options);
    } catch (error) {
      if (isResumeRetryableError(error)) {
        return this.retryTurnOnSameSession(session, event, options, error);
      }
      if (!isStaleThreadError(error)) {
        throw error;
      }
      return this.resumeTurnOnSameSession(session, event, options, error);
    }
  }

  async startTurnOnSession(session, event, options: StartTurnOptions = {}) {
    const providerProfile = this.requireProviderProfile(session.providerProfileId);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const sessionSettings = this.bridgeSessions.getSessionSettings(session.id);
    const result = await providerPlugin.startTurn({
      providerProfile,
      bridgeSession: session,
      sessionSettings,
      event,
      inputText: event.text,
      onProgress: options.onProgress ?? null,
      onTurnStarted: async (meta: { turnId?: string | null; threadId?: string | null } = {}) => {
        const scopeRef = toScopeRef(event);
        const active = this.activeTurns?.updateScopeTurn(scopeRef, {
          bridgeSessionId: session.id,
          providerProfileId: session.providerProfileId,
          threadId: meta.threadId ?? session.codexThreadId,
          turnId: meta.turnId ?? null,
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
    });
    const nextSession = this.bridgeSessions.updateSession(session.id, {
      codexThreadId: result.threadId ?? session.codexThreadId,
      title: this.bridgeSessions.resolveThreadDisplayTitle({
        providerProfileId: session.providerProfileId,
        threadId: result.threadId ?? session.codexThreadId,
        providerTitle: result.title ?? null,
        fallbackTitle: session.title,
      }),
      cwd: normalizeCwd(session.cwd) ?? this.resolveEventCwd(event),
    });
    return { result, session: nextSession };
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
    open: i18n.t('coordinator.action.open'),
    models: i18n.t('coordinator.action.models'),
    model: i18n.t('coordinator.action.model'),
    rename: i18n.t('coordinator.action.rename'),
    provider: i18n.t('coordinator.action.provider'),
    reconnect: i18n.t('coordinator.action.reconnect'),
    restart: i18n.t('coordinator.action.restart'),
    permissions: i18n.t('coordinator.action.permissions'),
  }[commandName] ?? i18n.t('coordinator.action.generic');
  if (interruptRequested) {
    return i18n.t('coordinator.blocked.waitThenAction', { action });
  }
  return i18n.t('coordinator.blocked.cannotAction', { action });
}

function normalizeCwd(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
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

function buildThreadBrowserKey(event) {
  return formatPlatformScopeKey(event.platform, event.externalScopeId);
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
  const currentTitle = currentSession && currentSession.providerProfileId === providerProfile.id
    ? currentSession.title ?? i18n.t('coordinator.thread.untitled')
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
      '/where',
      '/status -h',
    ],
    examples: [
      '/status',
      '/where',
    ],
    notes: [],
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
  'stop',
  'new',
  'provider',
  'models',
  'model',
  'threads',
  'search',
  'next',
  'prev',
  'open',
  'peek',
  'rename',
  'permissions',
  'reconnect',
  'restart',
  'lang',
]);

const HIDDEN_COMMAND_ALIASES = Object.freeze({
  interrupt: 'stop',
});

const COMMAND_ALIAS_DEFINITIONS = Object.freeze({
  helps: ['help', 'h'],
  status: ['where', 'st'],
  stop: ['sp'],
  new: ['n'],
  provider: ['pd'],
  models: ['ms'],
  model: ['m'],
  threads: ['th'],
  search: ['se'],
  next: ['nx'],
  prev: ['pv'],
  open: ['o'],
  peek: ['pk'],
  rename: ['rn'],
  permissions: ['perm'],
  reconnect: ['rc'],
  restart: ['rs'],
  lang: [],
});

const COMMAND_CANONICAL_NAME_MAP = buildCommandCanonicalNameMapFromAliases(COMMAND_ALIAS_DEFINITIONS, HIDDEN_COMMAND_ALIASES);

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
