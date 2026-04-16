import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSlashCommand } from './command_parser.js';
import { NotFoundError } from './errors.js';

export class BridgeCoordinator {
  constructor({
    bridgeSessions,
    providerProfiles,
    providerRegistry,
    defaultProviderProfileId,
    restartBridge = null,
  }) {
    this.bridgeSessions = bridgeSessions;
    this.providerProfiles = providerProfiles;
    this.providerRegistry = providerRegistry;
    this.defaultProviderProfileId = defaultProviderProfileId;
    this.restartBridge = restartBridge;
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
    const session = await this.bridgeSessions.resolveOrCreateScopeSession(scopeRef, {
      providerProfileId: this.resolveDefaultProviderProfileId(),
      cwd: event.cwd ?? null,
      providerStartOptions: {
        sourcePlatform: event.platform,
      },
    });
    try {
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
      const response = messageResponse([''], buildSessionMeta(session));
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
    }
  }

  async handleCommand(event, command) {
    switch (command.name) {
      case 'status':
      case 'where':
        return this.handleStatusCommand(event);
      case 'new':
        return this.handleNewCommand(event, command.args);
      case 'threads':
        return this.handleThreadsCommand(event);
      case 'open':
        return this.handleOpenCommand(event, command.args);
      case 'provider':
        return this.handleProviderCommand(event, command.args);
      case 'restart':
        return this.handleRestartCommand(event);
      case 'reconnect':
        return this.handleReconnectCommand(event);
      case 'permissions':
        return this.handlePermissionsCommand(event, command.args);
      default:
        return messageResponse([`Unsupported command: /${command.name}`]);
    }
  }

  async handleStatusCommand(event) {
    const scopeRef = toScopeRef(event);
    const session = this.bridgeSessions.resolveScopeSession(scopeRef);
    if (!session) {
      return messageResponse([
        `No bridge session is bound to ${event.platform}:${event.externalScopeId}.`,
        `Default provider profile: ${this.resolveDefaultProviderProfileId()}`,
      ]);
    }
    const providerProfile = this.requireProviderProfile(session.providerProfileId);
    const settings = this.bridgeSessions.getSessionSettings(session.id);
    return messageResponse([
      `Scope: ${event.platform}:${event.externalScopeId}`,
      `Bridge session: ${session.id}`,
      `Provider profile: ${providerProfile.id}`,
      `Provider kind: ${providerProfile.providerKind}`,
      `Codex thread: ${session.codexThreadId}`,
      `Model: ${settings?.model ?? '(default)'}`,
      `Reasoning effort: ${settings?.reasoningEffort ?? '(default)'}`,
      `Service tier: ${settings?.serviceTier ?? '(default)'}`,
      `Access preset: ${formatAccessPreset(resolveAccessPreset(settings))}`,
      `Approval policy: ${resolveApprovalPolicy(settings)}`,
      `Sandbox mode: ${resolveSandboxMode(settings)}`,
    ], buildSessionMeta(session));
  }

  async handleNewCommand(event, args) {
    const scopeRef = toScopeRef(event);
    const existing = this.bridgeSessions.resolveScopeSession(scopeRef);
    const providerProfileId = existing?.providerProfileId ?? this.resolveDefaultProviderProfileId();
    const nextSession = await this.bridgeSessions.createSessionForScope(scopeRef, {
      providerProfileId,
      cwd: args.join(' ').trim() || existing?.cwd || event.cwd || null,
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
    const providerProfile = this.requireProviderProfile(
      current?.providerProfileId ?? this.resolveDefaultProviderProfileId(),
    );
    const threads = await this.bridgeSessions.listProviderThreads(providerProfile.id);
    if (threads.length === 0) {
      return messageResponse([`No threads are available for provider profile ${providerProfile.id}.`]);
    }
    const lines = [
      `Provider profile: ${providerProfile.id}`,
      'Available threads:',
      ...threads.map((thread) => {
        const marker = current?.codexThreadId === thread.threadId ? '*' : '-';
        const title = thread.title ?? '(untitled)';
        const sessionLabel = thread.bridgeSessionId ? ` | session ${thread.bridgeSessionId}` : '';
        return `${marker} ${thread.threadId} | ${title}${sessionLabel}`;
      }),
    ];
    return messageResponse(lines, current ? buildSessionMeta(current) : undefined);
  }

  async handleOpenCommand(event, args) {
    const requestedThreadId = args[0]?.trim() ?? '';
    if (!requestedThreadId) {
      return messageResponse(['Usage: /open <codex_thread_id>']);
    }
    const scopeRef = toScopeRef(event);
    const current = this.bridgeSessions.resolveScopeSession(scopeRef);
    const providerProfile = this.requireProviderProfile(
      current?.providerProfileId ?? this.resolveDefaultProviderProfileId(),
    );
    const session = await this.bridgeSessions.bindScopeToProviderThread(scopeRef, {
      providerProfileId: providerProfile.id,
      codexThreadId: requestedThreadId,
    });
    return messageResponse([
      `Opened Codex thread ${session.codexThreadId}.`,
      `Provider profile: ${providerProfile.id}`,
      `Bridge session: ${session.id}`,
    ], buildSessionMeta(session));
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
    const preset = normalizeAccessPreset(args[0]);
    if (!preset) {
      return messageResponse([
        '用法：/permissions [read-only|default|full-access]',
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
    });
    const nextSession = this.bridgeSessions.updateSession(session.id, {
      codexThreadId: result.threadId ?? session.codexThreadId,
      title: result.title ?? session.title,
      cwd: session.cwd ?? event.cwd ?? null,
    });
    return { result, session: nextSession };
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

function messageResponse(lines, session = undefined) {
  return {
    type: 'message',
    messages: lines.map((text) => ({ text })),
    session: session ?? null,
  };
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
