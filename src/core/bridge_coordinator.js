import { parseSlashCommand } from './command_parser.js';
import { NotFoundError } from './errors.js';

export class BridgeCoordinator {
  constructor({
    bridgeSessions,
    providerProfiles,
    providerRegistry,
    defaultProviderProfileId,
  }) {
    this.bridgeSessions = bridgeSessions;
    this.providerProfiles = providerProfiles;
    this.providerRegistry = providerRegistry;
    this.defaultProviderProfileId = defaultProviderProfileId;
  }

  async handleInboundEvent(event) {
    const command = parseSlashCommand(event.text);
    if (command) {
      return this.handleCommand(event, command);
    }
    return this.handleConversationTurn(event);
  }

  async handleConversationTurn(event) {
    const scopeRef = toScopeRef(event);
    const session = await this.bridgeSessions.resolveOrCreateScopeSession(scopeRef, {
      providerProfileId: this.resolveDefaultProviderProfileId(),
      cwd: event.cwd ?? null,
      providerStartOptions: {
        sourcePlatform: event.platform,
      },
    });
    const { result, session: nextSession } = await this.startTurnWithRecovery(scopeRef, session, event);
    return messageResponse([result.outputText], buildSessionMeta(nextSession));
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

  async startTurnWithRecovery(scopeRef, session, event) {
    try {
      return await this.startTurnOnSession(session, event);
    } catch (error) {
      if (!isStaleThreadError(error)) {
        throw error;
      }
      const recovered = await this.recreateScopeSession(scopeRef, session, event);
      return this.startTurnOnSession(recovered, event);
    }
  }

  async startTurnOnSession(session, event) {
    const providerProfile = this.requireProviderProfile(session.providerProfileId);
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const sessionSettings = this.bridgeSessions.getSessionSettings(session.id);
    const result = await providerPlugin.startTurn({
      providerProfile,
      bridgeSession: session,
      sessionSettings,
      event,
      inputText: event.text,
    });
    const nextSession = this.bridgeSessions.updateSession(session.id, {
      codexThreadId: result.threadId ?? session.codexThreadId,
      title: result.title ?? session.title,
      cwd: session.cwd ?? event.cwd ?? null,
    });
    return { result, session: nextSession };
  }

  async recreateScopeSession(scopeRef, session, event) {
    const sessionSettings = this.bridgeSessions.getSessionSettings(session.id);
    return this.bridgeSessions.createSessionForScope(scopeRef, {
      providerProfileId: session.providerProfileId,
      cwd: session.cwd ?? event.cwd ?? null,
      title: session.title ?? null,
      initialSettings: {
        model: sessionSettings?.model ?? null,
        reasoningEffort: sessionSettings?.reasoningEffort ?? null,
        serviceTier: sessionSettings?.serviceTier ?? null,
        locale: sessionSettings?.locale ?? null,
        metadata: sessionSettings?.metadata ?? {},
      },
      providerStartOptions: {
        sourcePlatform: event.platform,
        trigger: 'stale-thread-recovery',
      },
    });
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
