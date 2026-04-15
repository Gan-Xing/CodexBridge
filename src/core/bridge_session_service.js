import crypto from 'node:crypto';
import { ConfigurationError, NotFoundError } from './errors.js';

export class BridgeSessionService {
  constructor({
    providerProfiles,
    bridgeSessions,
    sessionSettings,
    providerRegistry,
    sessionRouter,
    now = () => Date.now(),
  }) {
    this.providerProfiles = providerProfiles;
    this.bridgeSessions = bridgeSessions;
    this.sessionSettings = sessionSettings;
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
      title: thread.title ?? null,
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
      locale: null,
      metadata: {},
      updatedAt: now,
    });
    return session;
  }

  async listProviderThreads(providerProfileId) {
    const providerProfile = this.providerProfiles.get(providerProfileId);
    if (!providerProfile) {
      throw new NotFoundError(`Unknown provider profile: ${providerProfileId}`);
    }
    const localSessions = this.listSessionsForProviderProfile(providerProfile.id);
    const localByThreadId = new Map(localSessions.map((session) => [session.codexThreadId, session]));
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const remoteThreads = await providerPlugin.listThreads({ providerProfile });
    const merged = new Map();
    for (const remoteThread of remoteThreads) {
      const localSession = localByThreadId.get(remoteThread.threadId) ?? null;
      merged.set(remoteThread.threadId, {
        threadId: remoteThread.threadId,
        title: remoteThread.title ?? localSession?.title ?? null,
        cwd: remoteThread.cwd ?? localSession?.cwd ?? null,
        updatedAt: remoteThread.updatedAt ?? localSession?.updatedAt ?? null,
        bridgeSessionId: localSession?.id ?? null,
      });
    }
    for (const localSession of localSessions) {
      if (merged.has(localSession.codexThreadId)) {
        continue;
      }
      merged.set(localSession.codexThreadId, {
        threadId: localSession.codexThreadId,
        title: localSession.title ?? null,
        cwd: localSession.cwd ?? null,
        updatedAt: localSession.updatedAt,
        bridgeSessionId: localSession.id,
      });
    }
    return [...merged.values()].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
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
