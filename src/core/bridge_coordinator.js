import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatPlatformScopeKey } from './contracts.js';
import { parseSlashCommand } from './command_parser.js';
import { NotFoundError } from './errors.js';

const THREAD_PAGE_SIZE = 5;
const THREAD_PREVIEW_LIMIT = 72;
const THREAD_HISTORY_TURN_LIMIT = 3;
const HELP_FLAG_SET = new Set(['-h', '--help', '-help', '-helps']);

export class BridgeCoordinator {
  constructor({
    bridgeSessions,
    activeTurns = null,
    providerProfiles,
    providerRegistry,
    defaultProviderProfileId,
    defaultCwd = null,
    restartBridge = null,
    now = () => Date.now(),
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
  }

  async handleInboundEvent(event, options = {}) {
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
      session = await this.bridgeSessions.resolveOrCreateScopeSession(scopeRef, {
        providerProfileId: this.resolveDefaultProviderProfileId(),
        cwd: this.resolveEventCwd(event),
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
      const failure = classifyTurnFailure(error);
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
      case 'restart':
        return this.handleRestartCommand(event);
      case 'reconnect':
        return this.handleReconnectCommand(event);
      case 'permissions':
        return this.handlePermissionsCommand(event, command.args);
      default:
        return messageResponse([
          `Unsupported command: /${command.name}`,
          '用 /helps 查看可用命令。',
        ], this.buildScopedSessionMeta(event));
    }
  }

  async handleHelpsCommand(event, args) {
    const requested = normalizeHelpTarget(args[0]);
    if (!requested) {
      return textResponse(renderCommandCatalog(), this.buildScopedSessionMeta(event));
    }
    const spec = resolveCommandHelpSpec(requested);
    if (!spec) {
      return messageResponse([
        `Unknown command: /${requested}`,
        '用 /helps 查看可用命令。',
      ], this.buildScopedSessionMeta(event));
    }
    return textResponse(renderCommandHelp(spec), this.buildScopedSessionMeta(event));
  }

  async handleStatusCommand(event) {
    const scopeRef = toScopeRef(event);
    const session = this.bridgeSessions.resolveScopeSession(scopeRef);
    if (!session) {
      return messageResponse([
        `No bridge session is bound to ${event.platform}:${event.externalScopeId}.`,
        `Default provider profile: ${this.resolveDefaultProviderProfileId()}`,
        `Default working directory: ${this.defaultCwd ?? '(none)'}`,
      ]);
    }
    const providerProfile = this.requireProviderProfile(session.providerProfileId);
    const settings = this.bridgeSessions.getSessionSettings(session.id);
    const activeTurn = this.activeTurns?.resolveScopeTurn(scopeRef) ?? null;
    return messageResponse([
      `Scope: ${event.platform}:${event.externalScopeId}`,
      `Bridge session: ${session.id}`,
      `Provider profile: ${providerProfile.id}`,
      `Provider kind: ${providerProfile.providerKind}`,
      `Codex thread: ${session.codexThreadId}`,
      `Working directory: ${session.cwd ?? this.defaultCwd ?? '(none)'}`,
      `Model: ${settings?.model ?? '(default)'}`,
      `Reasoning effort: ${settings?.reasoningEffort ?? '(default)'}`,
      `Service tier: ${settings?.serviceTier ?? '(default)'}`,
      `Access preset: ${formatAccessPreset(resolveAccessPreset(settings))}`,
      `Approval policy: ${resolveApprovalPolicy(settings)}`,
      `Sandbox mode: ${resolveSandboxMode(settings)}`,
      `Active turn: ${formatActiveTurnValue(activeTurn)}`,
      `Turn state: ${formatActiveTurnState(activeTurn)}`,
      ...(activeTurn ? ['Turn control: /stop'] : []),
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
      providerStartOptions: {
        sourcePlatform: event.platform,
        trigger: 'new-command',
      },
    });
    return messageResponse([
      'Started a new bridge session.',
      `Provider profile: ${nextSession.providerProfileId}`,
      `Codex thread: ${nextSession.codexThreadId}`,
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
        '用法：/search <关键词>',
        '帮助：/search -h',
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
      return messageResponse(['请先运行 /threads 或 /search，建立当前页后再翻页。']);
    }
    if (!state.nextCursor) {
      return messageResponse(['已经是最后一页了。'], this.buildScopedSessionMeta(event));
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
      return messageResponse(['请先运行 /threads 或 /search，建立当前页后再翻页。']);
    }
    if (state.previousCursors.length === 0) {
      return messageResponse(['已经是第一页了。'], this.buildScopedSessionMeta(event));
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
        '用法：/open <序号|codex_thread_id>',
        '帮助：/open -h',
      ], this.buildScopedSessionMeta(event));
    }
    const scopeRef = toScopeRef(event);
    const resolvedThread = this.resolveRequestedThread(event, requested);
    if (!resolvedThread.ok) {
      return messageResponse([resolvedThread.message], this.buildScopedSessionMeta(event));
    }
    const providerProfile = this.requireProviderProfile(resolvedThread.providerProfileId);
    const session = await this.bridgeSessions.bindScopeToProviderThread(scopeRef, {
      providerProfileId: providerProfile.id,
      codexThreadId: resolvedThread.threadId,
    });
    return messageResponse([
      `Opened Codex thread ${session.codexThreadId}.`,
      `Provider profile: ${providerProfile.id}`,
      `Bridge session: ${session.id}`,
    ], buildSessionMeta(session));
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
        '用法：/rename <序号|codex_thread_id> <新名字>',
        '帮助：/rename -h',
      ], this.buildScopedSessionMeta(event));
    }
    const resolvedThread = this.resolveRequestedThread(event, target);
    if (!resolvedThread.ok) {
      return messageResponse([resolvedThread.message], this.buildScopedSessionMeta(event));
    }
    this.bridgeSessions.renameProviderThread(resolvedThread.providerProfileId, resolvedThread.threadId, nextName);
    this.patchThreadBrowserTitle(event, resolvedThread.providerProfileId, resolvedThread.threadId, nextName);
    return textResponse([
      '已更新线程显示名。',
      `名称：${nextName}`,
      `Thread: ${resolvedThread.threadId}`,
      '操作：/threads  /open 1  /peek 1',
    ].join('\n'), this.buildScopedSessionMeta(event));
  }

  async handlePeekCommand(event, args) {
    const target = args[0]?.trim() ?? '';
    if (!target) {
      return messageResponse([
        '用法：/peek <序号|codex_thread_id>',
        '帮助：/peek -h',
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
      return messageResponse([`线程不存在：${resolvedThread.threadId}`], this.buildScopedSessionMeta(event));
    }
    return textResponse(renderThreadPeek(thread), this.buildScopedSessionMeta(event));
  }

  async handleProviderCommand(event, args) {
    const scopeRef = toScopeRef(event);
    if (args.length === 0) {
      const current = this.bridgeSessions.resolveScopeSession(scopeRef);
      const profiles = this.providerProfiles.list().map((profile) => `- ${profile.id} (${profile.providerKind})`);
      return messageResponse([
        `Current provider profile: ${current?.providerProfileId ?? this.resolveDefaultProviderProfileId()}`,
        'Available provider profiles:',
        ...profiles,
      ], current ? buildSessionMeta(current) : undefined);
    }
    const requested = args.join(' ').trim();
    const profile = this.resolveProviderProfile(requested);
    if (!profile) {
      return messageResponse([`Unknown provider profile: ${requested}`]);
    }
    const activeResponse = this.rejectIfActiveTurnForCommand(event, 'provider');
    if (activeResponse) {
      return activeResponse;
    }
    const switched = await this.bridgeSessions.switchScopeProvider(scopeRef, {
      nextProviderProfileId: profile.id,
      providerStartOptions: {
        sourcePlatform: event.platform,
        trigger: 'provider-command',
      },
    });
    return messageResponse([
      `Switched provider profile to ${profile.id}.`,
      `New bridge session: ${switched.id}`,
      `Codex thread: ${switched.codexThreadId}`,
    ], buildSessionMeta(switched));
  }

  async handleRestartCommand(event) {
    const activeResponse = this.rejectIfActiveTurnForCommand(event, 'restart');
    if (activeResponse) {
      return activeResponse;
    }
    if (typeof this.restartBridge !== 'function') {
      return messageResponse(['Current host does not support /restart.']);
    }
    const scopeRef = toScopeRef(event);
    const current = this.bridgeSessions.resolveScopeSession(scopeRef);
    const response = messageResponse([
      '桥接重启已排队。',
      '重启后直接继续发消息即可。',
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
      return messageResponse(['当前 provider 不支持 /reconnect。'], session ? buildSessionMeta(session) : undefined);
    }
    try {
      const result = await providerPlugin.reconnectProfile({ providerProfile });
      const identity = formatAccountIdentity(result?.accountIdentity ?? null);
      const lines = [
        '当前 Codex 会话已刷新。',
        ...(identity ? [`账号：${identity}`] : []),
        '直接继续发消息即可。',
      ];
      return messageResponse(lines, session ? buildSessionMeta(session) : undefined);
    } catch (error) {
      return messageResponse([
        `刷新 Codex 会话失败：${formatUserError(error)}`,
      ], session ? buildSessionMeta(session) : undefined);
    }
  }

  async handlePermissionsCommand(event, args) {
    const scopeRef = toScopeRef(event);
    const session = this.bridgeSessions.resolveScopeSession(scopeRef);
    if (!session) {
      return messageResponse([
        '当前还没有绑定会话。',
        '先直接发一条正常消息，或使用 /new 创建会话后再设置权限。',
      ]);
    }
    if (args.length === 0) {
      return messageResponse(renderPermissionsLines(this.bridgeSessions.getSessionSettings(session.id)), buildSessionMeta(session));
    }
    const activeResponse = this.rejectIfActiveTurnForCommand(event, 'permissions');
    if (activeResponse) {
      return activeResponse;
    }
    const preset = normalizeAccessPreset(args[0]);
    if (!preset) {
      return messageResponse([
        '用法：/permissions [read-only|default|full-access]',
        '帮助：/permissions -h',
      ], buildSessionMeta(session));
    }
    const access = resolveAccessModeForPreset(preset);
    this.bridgeSessions.upsertSessionSettings(session.id, {
      accessPreset: preset,
      approvalPolicy: access.approvalPolicy,
      sandboxMode: access.sandboxMode,
    });
    return messageResponse([
      `已切换权限预设：${formatAccessPreset(preset)}`,
      `审批策略：${access.approvalPolicy}`,
      `沙箱模式：${access.sandboxMode}`,
      '下一轮生效。',
    ], buildSessionMeta(session));
  }

  async handleStopCommand(event) {
    const scopeRef = toScopeRef(event);
    const active = this.activeTurns?.resolveScopeTurn(scopeRef) ?? null;
    if (!active) {
      return messageResponse(['当前没有进行中的回复。'], this.buildScopedSessionMeta(event));
    }
    if (active.interruptRequested) {
      return messageResponse(['已经请求过中断了，正在等待当前回复停止。'], buildActiveTurnMeta(active));
    }
    this.activeTurns?.requestInterrupt(scopeRef);
    if (!active.turnId) {
      return messageResponse(['已请求中断。当前回复仍在启动，拿到 turn id 后会自动中断。'], buildActiveTurnMeta(active));
    }
    try {
      await this.dispatchInterruptForActiveTurn(active);
      return messageResponse(['已请求中断当前回复。'], buildActiveTurnMeta(active));
    } catch (error) {
      this.activeTurns?.updateScopeTurn(scopeRef, {
        interruptRequested: false,
      });
      return messageResponse([
        `中断失败：${formatUserError(error)}`,
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
          `Threads | ${providerProfile.id}`,
          `搜索：${searchTerm}`,
          '',
          '没有找到匹配的线程。',
          '操作：/threads 重新查看全部线程',
        ].join('\n'), current ? buildSessionMeta(current) : undefined);
      }
      return textResponse([
        `Threads | ${providerProfile.id}`,
        '',
        '当前 provider 还没有可用线程。',
        '先直接发一条消息，或用 /new 新建会话。',
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

  buildActiveTurnBlockedResponse(event, activeTurn) {
    return messageResponse([
      '当前已有一轮回复在进行中。',
      activeTurn.interruptRequested
        ? '已请求中断，请等待当前回复停止。'
        : '请先等待，或使用 /stop 中断。',
    ], buildActiveTurnMeta(activeTurn) ?? this.buildScopedSessionMeta(event));
  }

  rejectIfActiveTurnForCommand(event, commandName = 'generic') {
    const activeTurn = this.activeTurns?.resolveScopeTurn(toScopeRef(event)) ?? null;
    if (!activeTurn) {
      return null;
    }
    return messageResponse([
      renderCommandBlockedMessage(commandName, activeTurn.interruptRequested),
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
        message: '请提供线程序号或 thread id。',
      };
    }
    if (/^\d+$/u.test(value)) {
      const state = this.getThreadBrowserState(event);
      if (!state) {
        return {
          ok: false,
          message: '当前没有可用的线程列表上下文。先运行 /threads 或 /search。',
        };
      }
      const index = Number(value);
      const item = state.items[index - 1] ?? null;
      if (!item) {
        return {
          ok: false,
          message: `当前页没有第 ${index} 项。`,
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
      throw new NotFoundError('No provider profiles are configured');
    }
    return first.id;
  }

  requireProviderProfile(providerProfileId) {
    const profile = this.providerProfiles.get(providerProfileId);
    if (!profile) {
      throw new NotFoundError(`Unknown provider profile: ${providerProfileId}`);
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

  async startTurnWithRecovery(scopeRef, session, event, options = {}) {
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

  async startTurnOnSession(session, event, options = {}) {
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
      onTurnStarted: async (meta = {}) => {
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
      throw new Error('当前回复尚未拿到可中断的 turn id。');
    }
    if (activeTurn.interruptDispatched) {
      return;
    }
    const providerProfile = this.requireProviderProfile(activeTurn.providerProfileId);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (typeof providerPlugin.interruptTurn !== 'function') {
      throw new Error(`当前 provider 不支持中断：${providerProfile.providerKind}`);
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

  async retryTurnOnSameSession(session, event, options = {}, originalError) {
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

  async resumeTurnOnSameSession(session, event, options = {}, originalError) {
    const providerProfile = this.requireProviderProfile(session.providerProfileId);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (typeof providerPlugin.resumeThread !== 'function') {
      throw enrichSessionRecoveryError(originalError, session, 'provider has no resumeThread support');
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
    throw enrichSessionRecoveryError(lastError, session, 'resumeThread failed');
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

function renderCommandBlockedMessage(commandName, interruptRequested) {
  const action = {
    new: '新建会话',
    open: '切换线程',
    rename: '重命名线程',
    provider: '切换 provider',
    reconnect: '刷新当前 Codex 会话',
    restart: '重启桥接',
    permissions: '切换权限预设',
  }[commandName] ?? '执行这个操作';
  if (interruptRequested) {
    return `已请求中断，请等待当前回复停止后再${action}。`;
  }
  return `当前有回复在进行中，暂时不能${action}。请先等待，或使用 /stop 中断。`;
}

function normalizeCwd(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function formatActiveTurnValue(activeTurn) {
  if (!activeTurn) {
    return 'none';
  }
  return activeTurn.turnId ?? '(starting)';
}

function formatActiveTurnState(activeTurn) {
  if (!activeTurn) {
    return 'idle';
  }
  if (activeTurn.interruptRequested) {
    return 'interrupt requested';
  }
  return activeTurn.turnId ? 'running' : 'starting';
}

function messageResponse(lines, session = undefined) {
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
  providerProfile,
  currentSession,
  items,
  pageNumber,
  searchTerm,
  hasPreviousPage,
  hasNextPage,
}) {
  const currentTitle = currentSession && currentSession.providerProfileId === providerProfile.id
    ? currentSession.title ?? '未命名线程'
    : '无';
  const lines = [
    `Threads | ${providerProfile.id}`,
    `当前绑定：${currentTitle}`,
    `第 ${pageNumber} 页`,
  ];
  if (searchTerm) {
    lines.push(`搜索：${searchTerm}`);
  }
  lines.push('');
  for (const [index, item] of items.entries()) {
    const marker = currentSession?.providerProfileId === providerProfile.id && currentSession.codexThreadId === item.threadId
      ? '*'
      : ' ';
    lines.push(`${marker} ${index + 1}. ${formatThreadTitle(item.title, item.preview)}`);
    lines.push(`   预览：${normalizeThreadPreview(item.preview)}`);
    lines.push(`   更新：${formatRelativeTime(item.updatedAt)}`);
    lines.push('');
  }
  lines.push(buildThreadsFooter({
    hasPreviousPage,
    hasNextPage,
    exampleIndex: Math.min(2, Math.max(1, items.length)),
  }));
  return lines.join('\n').trim();
}

function buildThreadsFooter({ hasPreviousPage, hasNextPage, exampleIndex }) {
  const index = Number(exampleIndex || 1);
  const commands = [`/open ${index}`, `/peek ${index}`, `/rename ${index} 新名字`, '/search 关键词', '/threads'];
  if (hasPreviousPage) {
    commands.push('/prev');
  }
  if (hasNextPage) {
    commands.push('/next');
  }
  return `操作：${commands.join('  ')}`;
}

function renderThreadPeek(thread) {
  const turns = extractRecentThreadTurns(thread.turns);
  const lines = [
    `线程预览：${formatThreadTitle(thread.title, thread.preview)}`,
    `Thread: ${thread.threadId}`,
    `预览：${normalizeThreadPreview(thread.preview)}`,
  ];
  if (turns.length === 0) {
    lines.push('', '最近还没有可展示的对话内容。');
    return lines.join('\n');
  }
  lines.push('', `最近 ${turns.length} 轮：`);
  for (const [index, turn] of turns.entries()) {
    lines.push('');
    lines.push(`${index + 1}. 你：${truncateText(turn.userText || '(空)', 220)}`);
    lines.push(`${formatAssistantTurnLabel(turn.status)}：${truncateText(turn.assistantText || '(空)', 260)}`);
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

function formatAssistantTurnLabel(status) {
  switch (status) {
    case 'interrupted':
      return 'Codex（已中断）';
    case 'failed':
      return 'Codex（失败）';
    case 'partial':
      return 'Codex（部分输出）';
    default:
      return 'Codex';
  }
}

function formatThreadTitle(title, preview) {
  const resolved = compactWhitespace(title || '');
  if (resolved) {
    return truncateText(resolved, 48);
  }
  const fallback = compactWhitespace(preview || '');
  if (fallback) {
    return truncateText(fallback, 48);
  }
  return '未命名线程';
}

function normalizeThreadPreview(preview) {
  const normalized = compactWhitespace(preview || '');
  return normalized ? truncateText(normalized, THREAD_PREVIEW_LIMIT) : '(空)';
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

function formatRelativeTime(value, now = Date.now()) {
  const updatedAt = normalizeEpochMs(value);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) {
    return '未知';
  }
  const diffMs = Math.max(0, now - updatedAt);
  const diffSeconds = Math.floor(diffMs / 1000);
  if (diffSeconds < 60) {
    return '刚刚';
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes} 分钟前`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 48) {
    return `${diffHours} 小时前`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) {
    return `${diffDays} 天前`;
  }
  return new Date(updatedAt).toISOString().slice(0, 10);
}

function normalizeEpochMs(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function isHelpFlag(value) {
  return HELP_FLAG_SET.has(normalizeHelpFlag(value));
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

function resolveCommandHelpSpec(name) {
  const normalized = normalizeHelpTarget(name);
  if (!normalized) {
    return null;
  }
  const canonical = COMMAND_HELP_ALIAS_MAP.get(normalized) ?? null;
  return canonical ? COMMAND_HELP_SPECS[canonical] ?? null : null;
}

function renderCommandCatalog() {
  const lines = [
    'Slash 命令',
    '',
  ];
  for (const commandName of COMMAND_HELP_ORDER) {
    const spec = COMMAND_HELP_SPECS[commandName];
    const aliasLabel = spec.aliases.length > 0 ? ` (${spec.aliases.map((alias) => `/${alias}`).join(', ')})` : '';
    lines.push(`/${spec.name}${aliasLabel} ${spec.summary}`);
  }
  lines.push('');
  lines.push('帮助：/helps <命令>');
  lines.push('示例：/helps threads  或  /threads -h');
  lines.push('说明：这不是严格的 shell CLI，而是借用 CLI 的帮助习惯做聊天命令。');
  return lines.join('\n');
}

function renderCommandHelp(spec) {
  const lines = [
    `命令：/${spec.name}`,
    `说明：${spec.summary}`,
  ];
  if (spec.aliases.length > 0) {
    lines.push(`别名：${spec.aliases.map((alias) => `/${alias}`).join(' ')}`);
  }
  lines.push('');
  lines.push('用法：');
  for (const usage of spec.usage) {
    lines.push(usage);
  }
  lines.push('');
  lines.push('示例：');
  for (const example of spec.examples) {
    lines.push(example);
  }
  if (spec.notes.length > 0) {
    lines.push('');
    lines.push('说明：');
    for (const note of spec.notes) {
      lines.push(note);
    }
  }
  return lines.join('\n');
}

const COMMAND_HELP_SPECS = Object.freeze({
  helps: freezeCommandHelp({
    name: 'helps',
    aliases: ['help', 'h'],
    summary: '查看所有斜杠命令，或查看某个命令的帮助',
    usage: [
      '/helps',
      '/helps <命令>',
      '/helps -h',
    ],
    examples: [
      '/helps',
      '/helps threads',
      '/help open',
    ],
    notes: [
      '所有斜杠命令都支持 -h / --help / -helps。',
    ],
  }),
  status: freezeCommandHelp({
    name: 'status',
    aliases: ['where', 'st'],
    summary: '查看当前 scope 绑定、provider、权限设置，以及 active turn 状态',
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
    summary: '请求中断当前正在执行的回复',
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
      '如果当前没有进行中的回复，会直接提示无可中断目标。',
    ],
  }),
  new: freezeCommandHelp({
    name: 'new',
    aliases: ['n'],
    summary: '创建一个新的 bridge session，可选指定 cwd',
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
      '不改 provider，只是在当前 scope 上切到一个新线程。',
    ],
  }),
  provider: freezeCommandHelp({
    name: 'provider',
    aliases: [],
    summary: '查看可用 provider，或切换当前 scope 的 provider profile',
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
      '切换 provider 会为当前 scope 创建新的 bridge session。',
    ],
  }),
  threads: freezeCommandHelp({
    name: 'threads',
    aliases: ['th'],
    summary: '查看当前 provider 的线程列表首页',
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
      '微信里推荐先 /threads，再用序号操作，不必复制 thread id。',
    ],
  }),
  search: freezeCommandHelp({
    name: 'search',
    aliases: [],
    summary: '按关键词搜索线程标题或 preview，并显示第一页',
    usage: [
      '/search <关键词>',
      '/search -h',
    ],
    examples: [
      '/search bridge',
      '/search 微信',
    ],
    notes: [
      '搜索结果也支持 /open 1、/peek 1、/rename 1。',
    ],
  }),
  next: freezeCommandHelp({
    name: 'next',
    aliases: [],
    summary: '翻到当前线程列表的下一页',
    usage: [
      '/next',
      '/next -h',
    ],
    examples: [
      '/threads',
      '/next',
    ],
    notes: [
      '先运行 /threads 或 /search，建立当前页上下文后才能翻页。',
    ],
  }),
  prev: freezeCommandHelp({
    name: 'prev',
    aliases: [],
    summary: '翻到当前线程列表的上一页',
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
      '先运行 /threads 或 /search，建立当前页上下文后才能翻页。',
    ],
  }),
  open: freezeCommandHelp({
    name: 'open',
    aliases: ['o'],
    summary: '把当前 scope 绑定到指定线程，可用序号或 thread id',
    usage: [
      '/open <序号|codex_thread_id>',
      '/open -h',
    ],
    examples: [
      '/open 2',
      '/open 019d95ad-7166-7ee3-89a3-3bbb50e0fd64',
    ],
    notes: [
      '序号来自当前页的 /threads 或 /search 结果。',
    ],
  }),
  peek: freezeCommandHelp({
    name: 'peek',
    aliases: ['pk'],
    summary: '查看某个线程最近几轮的对话摘要',
    usage: [
      '/peek <序号|codex_thread_id>',
      '/peek -h',
    ],
    examples: [
      '/peek 1',
      '/peek 019d95ad-7166-7ee3-89a3-3bbb50e0fd64',
    ],
    notes: [
      '适合先判断是不是你要打开的线程。',
    ],
  }),
  rename: freezeCommandHelp({
    name: 'rename',
    aliases: ['rn'],
    summary: '给线程设置本地显示名，不改 provider 原始 thread id',
    usage: [
      '/rename <序号|codex_thread_id> <新名字>',
      '/rename -h',
    ],
    examples: [
      '/rename 2 微信桥接排障',
      '/rename 019d95ad-7166-7ee3-89a3-3bbb50e0fd64 CodexBridge',
    ],
    notes: [
      '重命名是 bridge 本地 alias，会在 /threads 中优先显示。',
    ],
  }),
  permissions: freezeCommandHelp({
    name: 'permissions',
    aliases: ['perm'],
    summary: '查看或切换下一轮的权限预设',
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
      '权限变更在下一轮消息生效。',
    ],
  }),
  reconnect: freezeCommandHelp({
    name: 'reconnect',
    aliases: ['rc'],
    summary: '刷新当前 provider 的 Codex 会话',
    usage: [
      '/reconnect',
      '/reconnect -h',
    ],
    examples: [
      '/reconnect',
    ],
    notes: [
      '适合遇到鉴权或 session 异常时使用。',
    ],
  }),
  restart: freezeCommandHelp({
    name: 'restart',
    aliases: ['rs'],
    summary: '重启桥接服务',
    usage: [
      '/restart',
      '/restart -h',
    ],
    examples: [
      '/restart',
    ],
    notes: [
      '当前 host 不支持时会直接返回不可用。',
    ],
  }),
});

const COMMAND_HELP_ORDER = Object.freeze([
  'helps',
  'status',
  'stop',
  'new',
  'provider',
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
]);

const HIDDEN_COMMAND_ALIASES = Object.freeze({
  interrupt: 'stop',
});

const COMMAND_CANONICAL_NAME_MAP = buildCommandCanonicalNameMap(COMMAND_HELP_SPECS, HIDDEN_COMMAND_ALIASES);
const COMMAND_HELP_ALIAS_MAP = COMMAND_CANONICAL_NAME_MAP;

function buildCommandCanonicalNameMap(specs, hiddenAliases = {}) {
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

function freezeCommandHelp(spec) {
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

function classifyTurnFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/Timed out waiting for Codex turn/i.test(message)) {
    return {
      outputState: 'timeout',
      errorMessage: readRecentCodexRuntimeError() || message,
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

function enrichSessionRecoveryError(error, session, reason) {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `Bridge session stayed on existing thread ${session.codexThreadId} without auto-rebinding (${reason}): ${message}`,
  );
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

function readRecentCodexRuntimeError(logPath = path.join(os.homedir(), '.codex', 'log', 'codex-tui.log')) {
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
        return 'Codex 鉴权刷新失败：refresh token 已被复用，请刷新当前会话。';
      }
      if (/401 Unauthorized/i.test(line) || /401 Unauthorized/i.test(next)) {
        return 'Codex 鉴权失败：401 Unauthorized。';
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

function renderPermissionsLines(settings) {
  return [
    `当前权限预设：${formatAccessPreset(resolveAccessPreset(settings))}`,
    `审批策略：${resolveApprovalPolicy(settings)}`,
    `沙箱模式：${resolveSandboxMode(settings)}`,
    '',
    '可选命令：',
    '- /permissions read-only',
    '- /permissions default',
    '- /permissions full-access',
    '',
    '说明：',
    '- read-only：按需审批 + 只读',
    '- default：按需审批 + 工作区可写',
    '- full-access：不审批 + 完全访问',
    '',
    '变更将在下一轮生效。',
  ];
}
