import crypto from 'node:crypto';
import { ConfigurationError, NotFoundError } from './errors.js';

export class BridgeSessionService {
  constructor({
    providerProfiles,
    bridgeSessions,
    sessionSettings,
    threadMetadata,
    providerRegistry,
    sessionRouter,
    now = () => Date.now(),
  }) {
    this.providerProfiles = providerProfiles;
    this.bridgeSessions = bridgeSessions;
    this.sessionSettings = sessionSettings;
    this.threadMetadata = threadMetadata;
    this.providerRegistry = providerRegistry;
    this.sessionRouter = sessionRouter;
    this.now = now;
  }

  resolveScopeSession(scopeRef) {
    return this.sessionRouter.resolveBoundSession(scopeRef);
  }

  requireScopeSession(scopeRef) {
    return this.sessionRouter.requireBoundSession(scopeRef);
  }

  async resolveOrCreateScopeSession(scopeRef, options) {
    const existing = this.resolveScopeSession(scopeRef);
    if (existing) {
      const resolvedCwd = normalizeCwd(options?.cwd);
      if (!existing.cwd && resolvedCwd) {
        return this.updateSession(existing.id, { cwd: resolvedCwd });
      }
      return existing;
    }
    return this.createSessionForScope(scopeRef, options);
  }

  async createSessionForScope(
    scopeRef,
    {
      providerProfileId,
      cwd = null,
      title = null,
      initialSettings = {},
      providerStartOptions = {},
    },
  ) {
    const providerProfile = this.providerProfiles.get(providerProfileId);
    if (!providerProfile) {
      throw new NotFoundError(`Unknown provider profile: ${providerProfileId}`);
    }
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const thread = await providerPlugin.startThread({
      providerProfile,
      cwd,
      title,
      metadata: providerStartOptions,
    });
    const now = this.now();
    const session = {
      id: crypto.randomUUID(),
      providerProfileId: providerProfile.id,
      codexThreadId: thread.threadId,
      cwd: thread.cwd ?? cwd,
      title: thread.title ?? title,
      createdAt: now,
      updatedAt: now,
    };
    this.bridgeSessions.save(session);
    this.sessionRouter.bindScope(scopeRef, session.id, now);
    this.sessionSettings.save({
      bridgeSessionId: session.id,
      model: initialSettings.model ?? null,
      reasoningEffort: initialSettings.reasoningEffort ?? null,
      serviceTier: initialSettings.serviceTier ?? null,
      accessPreset: initialSettings.accessPreset ?? null,
      approvalPolicy: initialSettings.approvalPolicy ?? null,
      sandboxMode: initialSettings.sandboxMode ?? null,
      locale: initialSettings.locale ?? null,
      metadata: initialSettings.metadata ?? {},
      updatedAt: now,
    });
    return session;
  }

  bindScopeToExistingSession(scopeRef, bridgeSessionId) {
    const session = this.bridgeSessions.get(bridgeSessionId);
    if (!session) {
      throw new NotFoundError(`Unknown bridge session: ${bridgeSessionId}`);
    }
    this.sessionRouter.bindScope(scopeRef, bridgeSessionId, this.now());
    return session;
  }

  updateSession(bridgeSessionId, updates) {
    const current = this.bridgeSessions.get(bridgeSessionId);
    if (!current) {
      throw new NotFoundError(`Unknown bridge session: ${bridgeSessionId}`);
    }
    const next = {
      ...current,
      ...updates,
      updatedAt: this.now(),
    };
    this.bridgeSessions.save(next);
    return next;
  }

  findSessionByProviderThread(providerProfileId, codexThreadId) {
    return this.bridgeSessions.getByProviderThread(providerProfileId, codexThreadId);
  }

  listSessionsForProviderProfile(providerProfileId) {
    return this.bridgeSessions
      .listByProviderProfileId(providerProfileId)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async bindScopeToProviderThread(scopeRef, { providerProfileId, codexThreadId }) {
    const existing = this.findSessionByProviderThread(providerProfileId, codexThreadId);
    if (existing) {
      this.sessionRouter.bindScope(scopeRef, existing.id, this.now());
      return existing;
    }
    const providerProfile = this.providerProfiles.get(providerProfileId);
    if (!providerProfile) {
      throw new NotFoundError(`Unknown provider profile: ${providerProfileId}`);
    }
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const thread = await providerPlugin.readThread({
      providerProfile,
      threadId: codexThreadId,
      includeTurns: false,
    });
    if (!thread) {
      throw new NotFoundError(`Unknown provider thread: ${providerProfileId}/${codexThreadId}`);
    }
    const now = this.now();
    const session = {
      id: crypto.randomUUID(),
      providerProfileId: providerProfile.id,
      codexThreadId: thread.threadId,
      cwd: thread.cwd ?? null,
      title: this.resolveThreadDisplayTitle({
        providerProfileId: providerProfile.id,
        threadId: thread.threadId,
        providerTitle: thread.title ?? null,
      }),
      createdAt: now,
      updatedAt: thread.updatedAt ?? now,
    };
    this.bridgeSessions.save(session);
    this.sessionRouter.bindScope(scopeRef, session.id, now);
    this.sessionSettings.save({
      bridgeSessionId: session.id,
      model: null,
      reasoningEffort: null,
      serviceTier: null,
      accessPreset: null,
      approvalPolicy: null,
      sandboxMode: null,
      locale: null,
      metadata: {},
      updatedAt: now,
    });
    return session;
  }

  async listProviderThreads(providerProfileId, {
    limit = 5,
    cursor = null,
    searchTerm = null,
  } = {}) {
    const providerProfile = this.providerProfiles.get(providerProfileId);
    if (!providerProfile) {
      throw new NotFoundError(`Unknown provider profile: ${providerProfileId}`);
    }
    const localSessions = this.listSessionsForProviderProfile(providerProfile.id);
    const localByThreadId = new Map(localSessions.map((session) => [session.codexThreadId, session]));
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const remoteResult = await providerPlugin.listThreads({
      providerProfile,
      limit,
      cursor,
      searchTerm,
    });
    const remoteThreads = Array.isArray(remoteResult)
      ? remoteResult
      : Array.isArray(remoteResult?.items)
        ? remoteResult.items
        : [];
    return {
      items: remoteThreads.map((remoteThread) => {
        const localSession = localByThreadId.get(remoteThread.threadId) ?? null;
        return {
          threadId: remoteThread.threadId,
          title: this.resolveThreadDisplayTitle({
            providerProfileId: providerProfile.id,
            threadId: remoteThread.threadId,
            providerTitle: remoteThread.title ?? null,
            fallbackTitle: localSession?.title ?? null,
          }),
          cwd: remoteThread.cwd ?? localSession?.cwd ?? null,
          updatedAt: remoteThread.updatedAt ?? localSession?.updatedAt ?? null,
          preview: remoteThread.preview ?? null,
          turns: Array.isArray(remoteThread.turns) ? remoteThread.turns : [],
          bridgeSessionId: localSession?.id ?? null,
        };
      }),
      nextCursor: typeof remoteResult?.nextCursor === 'string' ? remoteResult.nextCursor : null,
    };
  }

  async switchScopeProvider(
    scopeRef,
    {
      nextProviderProfileId,
      cwd = null,
      title = null,
      initialSettings = {},
      providerStartOptions = {},
    },
  ) {
    const current = this.resolveScopeSession(scopeRef);
    if (current && current.providerProfileId === nextProviderProfileId) {
      return current;
    }
    return this.createSessionForScope(scopeRef, {
      providerProfileId: nextProviderProfileId,
      cwd: cwd ?? current?.cwd ?? null,
      title: title ?? current?.title ?? null,
      initialSettings,
      providerStartOptions,
    });
  }

  getSessionSettings(bridgeSessionId) {
    return this.sessionSettings.get(bridgeSessionId);
  }

  getThreadMetadata(providerProfileId, threadId) {
    return this.threadMetadata?.get(providerProfileId, threadId) ?? null;
  }

  resolveThreadDisplayTitle({
    providerProfileId,
    threadId,
    providerTitle = null,
    fallbackTitle = null,
  }) {
    const alias = this.getThreadMetadata(providerProfileId, threadId)?.alias ?? null;
    return alias ?? providerTitle ?? fallbackTitle ?? null;
  }

  async readProviderThread(providerProfileId, threadId, { includeTurns = false } = {}) {
    const providerProfile = this.providerProfiles.get(providerProfileId);
    if (!providerProfile) {
      throw new NotFoundError(`Unknown provider profile: ${providerProfileId}`);
    }
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const thread = await providerPlugin.readThread({
      providerProfile,
      threadId,
      includeTurns,
    });
    if (!thread) {
      return null;
    }
    const localSession = this.findSessionByProviderThread(providerProfile.id, thread.threadId);
    return {
      threadId: thread.threadId,
      title: this.resolveThreadDisplayTitle({
        providerProfileId: providerProfile.id,
        threadId: thread.threadId,
        providerTitle: thread.title ?? null,
        fallbackTitle: localSession?.title ?? null,
      }),
      cwd: thread.cwd ?? localSession?.cwd ?? null,
      updatedAt: thread.updatedAt ?? localSession?.updatedAt ?? null,
      preview: thread.preview ?? null,
      turns: Array.isArray(thread.turns) ? thread.turns : [],
      bridgeSessionId: localSession?.id ?? null,
    };
  }

  renameProviderThread(providerProfileId, threadId, alias) {
    const normalizedAlias = String(alias ?? '').trim();
    const nextMetadata = {
      providerProfileId,
      threadId,
      alias: normalizedAlias || null,
      updatedAt: this.now(),
    };
    this.threadMetadata.save(nextMetadata);
    const session = this.findSessionByProviderThread(providerProfileId, threadId);
    if (session) {
      this.updateSession(session.id, {
        title: normalizedAlias || session.title,
      });
    }
    return nextMetadata;
  }

  upsertSessionSettings(bridgeSessionId, updates) {
    const session = this.bridgeSessions.get(bridgeSessionId);
    if (!session) {
      throw new NotFoundError(`Unknown bridge session: ${bridgeSessionId}`);
    }
    const current = this.sessionSettings.get(bridgeSessionId);
    if (!current) {
      throw new ConfigurationError(`Session settings are missing for session: ${bridgeSessionId}`);
    }
    const next = {
      ...current,
      ...updates,
      metadata: {
        ...current.metadata,
        ...(updates.metadata ?? {}),
      },
      updatedAt: this.now(),
    };
    this.sessionSettings.save(next);
    return next;
  }
}

function normalizeCwd(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}
