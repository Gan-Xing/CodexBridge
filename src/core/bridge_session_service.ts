import crypto from 'node:crypto';
import { ConfigurationError, NotFoundError } from './errors.js';
import { createI18n, type Translator } from '../i18n/index.js';
import type { BridgeSession, PlatformScopeRef, SessionSettings, ThreadMetadata } from '../types/core.js';
import type {
  BridgeSessionRepository,
  ProviderProfileRepository,
  SessionSettingsRepository,
  ThreadMetadataRepository,
} from '../types/repository.js';
import type { ProviderPluginContract } from '../types/provider.js';

const DEFAULT_THREAD_TITLE_PREFIX = '新线程';

interface SessionCreationOptions {
  providerProfileId: string;
  cwd?: string | null;
  title?: string | null;
  initialSettings?: Partial<SessionSettings>;
  providerStartOptions?: Record<string, unknown>;
}

interface ScopeProviderSwitchOptions {
  nextProviderProfileId: string;
  cwd?: string | null;
  title?: string | null;
  initialSettings?: Partial<SessionSettings>;
  providerStartOptions?: Record<string, unknown>;
}

interface ProviderRegistryLike {
  getProvider(providerKind: string): ProviderPluginContract;
}

interface SessionRouterLike {
  resolveBoundSession(scopeRef: PlatformScopeRef): BridgeSession | null;
  requireBoundSession(scopeRef: PlatformScopeRef): BridgeSession;
  bindScope(scopeRef: PlatformScopeRef, bridgeSessionId: string, updatedAt: number): void;
}

interface BridgeSessionRepositoryLike extends BridgeSessionRepository {
  get(id: string): BridgeSession | null;
  getByProviderThread(providerProfileId: string, codexThreadId: string): BridgeSession | null;
  listByProviderProfileId(providerProfileId: string): BridgeSession[];
}

interface SessionSettingsRepositoryLike extends SessionSettingsRepository {
  get(bridgeSessionId: string): SessionSettings | null;
}

interface ThreadMetadataRepositoryLike extends ThreadMetadataRepository {
  get(providerProfileId: string, threadId: string): ThreadMetadata | null;
}

interface BridgeSessionServiceOptions {
  providerProfiles: ProviderProfileRepository & { get(id: string): any };
  bridgeSessions: BridgeSessionRepositoryLike;
  sessionSettings: SessionSettingsRepositoryLike;
  threadMetadata?: ThreadMetadataRepositoryLike | null;
  providerRegistry: ProviderRegistryLike;
  sessionRouter: SessionRouterLike;
  now?: () => number;
  locale?: string | null;
}

export class BridgeSessionService {
  private readonly providerProfiles: BridgeSessionServiceOptions['providerProfiles'];

  private readonly bridgeSessions: BridgeSessionRepositoryLike;

  private readonly sessionSettings: SessionSettingsRepositoryLike;

  private readonly threadMetadata: ThreadMetadataRepositoryLike | null;

  private readonly providerRegistry: ProviderRegistryLike;

  private readonly sessionRouter: SessionRouterLike;

  private readonly now: () => number;

  private readonly i18n: Translator;

  constructor({
    providerProfiles,
    bridgeSessions,
    sessionSettings,
    threadMetadata = null,
    providerRegistry,
    sessionRouter,
    now = () => Date.now(),
    locale = null,
  }: BridgeSessionServiceOptions) {
    this.providerProfiles = providerProfiles;
    this.bridgeSessions = bridgeSessions;
    this.sessionSettings = sessionSettings;
    this.threadMetadata = threadMetadata;
    this.providerRegistry = providerRegistry;
    this.sessionRouter = sessionRouter;
    this.now = now;
    this.i18n = createI18n(locale);
  }

  resolveScopeSession(scopeRef: PlatformScopeRef): BridgeSession | null {
    return this.sessionRouter.resolveBoundSession(scopeRef);
  }

  requireScopeSession(scopeRef: PlatformScopeRef): BridgeSession {
    return this.sessionRouter.requireBoundSession(scopeRef);
  }

  getSessionById(bridgeSessionId: string): BridgeSession | null {
    return this.bridgeSessions.get(bridgeSessionId);
  }

  async resolveOrCreateScopeSession(scopeRef: PlatformScopeRef, options: SessionCreationOptions): Promise<BridgeSession> {
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

  async createSessionForScope(scopeRef: PlatformScopeRef, options: SessionCreationOptions): Promise<BridgeSession> {
    const {
      providerProfileId,
      cwd = null,
      title = null,
      initialSettings = {},
      providerStartOptions = {},
    } = options;
    const providerProfile = this.providerProfiles.get(providerProfileId);
    if (!providerProfile) {
      throw new NotFoundError(this.i18n.t('service.unknownProviderProfile', { id: providerProfileId }));
    }
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const startTitle = normalizeThreadTitle(title) ?? this.createDefaultThreadTitle(providerProfile.id);
    const thread = await providerPlugin.startThread({
      providerProfile,
      cwd,
      title: startTitle,
      metadata: providerStartOptions,
    });
    const resolvedTitle = normalizeThreadTitle(thread.title) ?? startTitle;
    const now = this.now();
    const session: BridgeSession = {
      id: crypto.randomUUID(),
      providerProfileId: providerProfile.id,
      codexThreadId: thread.threadId,
      cwd: thread.cwd ?? cwd,
      title: resolvedTitle,
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
      collaborationMode: initialSettings.collaborationMode ?? null,
      personality: initialSettings.personality ?? null,
      accessPreset: initialSettings.accessPreset ?? null,
      approvalPolicy: initialSettings.approvalPolicy ?? null,
      sandboxMode: initialSettings.sandboxMode ?? null,
      locale: initialSettings.locale ?? null,
      metadata: initialSettings.metadata ?? {},
      updatedAt: now,
    });
    return session;
  }

  async createDetachedSession(options: SessionCreationOptions): Promise<BridgeSession> {
    const {
      providerProfileId,
      cwd = null,
      title = null,
      initialSettings = {},
      providerStartOptions = {},
    } = options;
    const providerProfile = this.providerProfiles.get(providerProfileId);
    if (!providerProfile) {
      throw new NotFoundError(this.i18n.t('service.unknownProviderProfile', { id: providerProfileId }));
    }
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const startTitle = normalizeThreadTitle(title) ?? this.createDefaultThreadTitle(providerProfile.id);
    const thread = await providerPlugin.startThread({
      providerProfile,
      cwd,
      title: startTitle,
      metadata: providerStartOptions,
    });
    const resolvedTitle = normalizeThreadTitle(thread.title) ?? startTitle;
    const now = this.now();
    const session: BridgeSession = {
      id: crypto.randomUUID(),
      providerProfileId: providerProfile.id,
      codexThreadId: thread.threadId,
      cwd: thread.cwd ?? cwd,
      title: resolvedTitle,
      createdAt: now,
      updatedAt: now,
    };
    this.bridgeSessions.save(session);
    this.sessionSettings.save({
      bridgeSessionId: session.id,
      model: initialSettings.model ?? null,
      reasoningEffort: initialSettings.reasoningEffort ?? null,
      serviceTier: initialSettings.serviceTier ?? null,
      collaborationMode: initialSettings.collaborationMode ?? null,
      personality: initialSettings.personality ?? null,
      accessPreset: initialSettings.accessPreset ?? null,
      approvalPolicy: initialSettings.approvalPolicy ?? null,
      sandboxMode: initialSettings.sandboxMode ?? null,
      locale: initialSettings.locale ?? null,
      metadata: initialSettings.metadata ?? {},
      updatedAt: now,
    });
    return session;
  }

  bindScopeToExistingSession(scopeRef: PlatformScopeRef, bridgeSessionId: string): BridgeSession {
    const session = this.bridgeSessions.get(bridgeSessionId);
    if (!session) {
      throw new NotFoundError(this.i18n.t('service.unknownBridgeSession', { id: bridgeSessionId }));
    }
    this.sessionRouter.bindScope(scopeRef, bridgeSessionId, this.now());
    return session;
  }

  updateSession(bridgeSessionId: string, updates: Partial<BridgeSession>): BridgeSession {
    const current = this.bridgeSessions.get(bridgeSessionId);
    if (!current) {
      throw new NotFoundError(this.i18n.t('service.unknownBridgeSession', { id: bridgeSessionId }));
    }
    const next: BridgeSession = {
      ...current,
      ...updates,
      updatedAt: this.now(),
    };
    this.bridgeSessions.save(next);
    return next;
  }

  findSessionByProviderThread(providerProfileId: string, codexThreadId: string): BridgeSession | null {
    return this.bridgeSessions.getByProviderThread(providerProfileId, codexThreadId);
  }

  listSessionsForProviderProfile(providerProfileId: string): BridgeSession[] {
    return this.bridgeSessions
      .listByProviderProfileId(providerProfileId)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  createDefaultThreadTitle(providerProfileId: string): string {
    const titles = [
      ...this.bridgeSessions
        .listByProviderProfileId(providerProfileId)
        .map((session) => session.title),
      ...(this.threadMetadata?.listByProviderProfileId(providerProfileId) ?? [])
        .map((metadata) => metadata.alias),
    ];
    return createNextDefaultThreadTitle(titles);
  }

  async bindScopeToProviderThread(
    scopeRef: PlatformScopeRef,
    { providerProfileId, codexThreadId }: { providerProfileId: string; codexThreadId: string },
    { initialSettings = {} }: { initialSettings?: Partial<SessionSettings> } = {},
  ): Promise<BridgeSession> {
    const existing = this.findSessionByProviderThread(providerProfileId, codexThreadId);
    if (existing) {
      this.sessionRouter.bindScope(scopeRef, existing.id, this.now());
      return existing;
    }
    const providerProfile = this.providerProfiles.get(providerProfileId);
    if (!providerProfile) {
      throw new NotFoundError(this.i18n.t('service.unknownProviderProfile', { id: providerProfileId }));
    }
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const thread = await providerPlugin.readThread({
      providerProfile,
      threadId: codexThreadId,
      includeTurns: false,
    });
    if (!thread) {
      throw new NotFoundError(this.i18n.t('service.unknownProviderThread', {
        providerProfileId,
        threadId: codexThreadId,
      }));
    }
    const now = this.now();
    const session: BridgeSession = {
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
      personality: null,
      accessPreset: null,
      approvalPolicy: null,
      sandboxMode: null,
      locale: initialSettings.locale ?? null,
      metadata: {},
      ...initialSettings,
      updatedAt: now,
    });
    return session;
  }

  async listProviderThreads(
    providerProfileId: string,
    {
      limit = 5,
      cursor = null,
      searchTerm = null,
      includeArchived = false,
      onlyPinned = false,
    }: { limit?: number; cursor?: string | null; searchTerm?: string | null; includeArchived?: boolean; onlyPinned?: boolean } = {},
  ) {
    const providerProfile = this.providerProfiles.get(providerProfileId);
    if (!providerProfile) {
      throw new NotFoundError(this.i18n.t('service.unknownProviderProfile', { id: providerProfileId }));
    }
    const localSessions = this.listSessionsForProviderProfile(providerProfile.id);
    const localByThreadId = new Map(localSessions.map((session) => [session.codexThreadId, session]));
    const metadataByThreadId = new Map(
      (this.threadMetadata?.listByProviderProfileId(providerProfile.id) ?? [])
        .map((metadata) => [metadata.threadId, metadata] as const),
    );
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const remoteItems: Array<{
      threadId: string;
      title: string | null;
      cwd: string | null;
      updatedAt: number | null;
      preview: string | null;
      turns: unknown[];
      bridgeSessionId: string | null;
      archivedAt: number | null;
      pinnedAt: number | null;
    }> = [];
    const seenThreadIds = new Set<string>();
    const remotePageLimit = Math.max(limit, 50);

    const appendRemoteThreads = async (remoteArchived: boolean) => {
      let providerCursor: string | null = null;
      while (true) {
        const remoteResult = await providerPlugin.listThreads({
          providerProfile,
          limit: remotePageLimit,
          cursor: providerCursor,
          searchTerm,
          archived: remoteArchived,
        });
        const remoteThreads = Array.isArray(remoteResult)
          ? remoteResult
          : Array.isArray(remoteResult?.items)
            ? remoteResult.items
            : [];

        for (const remoteThread of remoteThreads) {
          if (!remoteThread?.threadId || seenThreadIds.has(remoteThread.threadId)) {
            continue;
          }
          if (isBridgeInternalThread(remoteThread)) {
            continue;
          }
          seenThreadIds.add(remoteThread.threadId);
          const localSession = localByThreadId.get(remoteThread.threadId) ?? null;
          const metadata = metadataByThreadId.get(remoteThread.threadId) ?? null;
          const archivedAt = typeof metadata?.archivedAt === 'number'
            ? metadata.archivedAt
            : remoteArchived ? Number(remoteThread.updatedAt ?? this.now()) || this.now() : null;
          const pinnedAt = typeof metadata?.pinnedAt === 'number' ? metadata.pinnedAt : null;
          remoteItems.push({
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
            archivedAt,
            pinnedAt,
          });
        }

        const resolvedNextCursor = typeof remoteResult?.nextCursor === 'string' ? remoteResult.nextCursor : null;
        if (!resolvedNextCursor || resolvedNextCursor === providerCursor) {
          break;
        }
        providerCursor = resolvedNextCursor;
      }
    };

    await appendRemoteThreads(false);
    if (includeArchived) {
      await appendRemoteThreads(true);
    }

    for (const localSession of localSessions) {
      if (!localSession?.codexThreadId || seenThreadIds.has(localSession.codexThreadId)) {
        continue;
      }
      const metadata = metadataByThreadId.get(localSession.codexThreadId) ?? null;
      const archivedAt = typeof metadata?.archivedAt === 'number' ? metadata.archivedAt : null;
      const pinnedAt = typeof metadata?.pinnedAt === 'number' ? metadata.pinnedAt : null;
      if (!includeArchived && typeof archivedAt === 'number') {
        continue;
      }
      if (onlyPinned && typeof pinnedAt !== 'number') {
        continue;
      }
      seenThreadIds.add(localSession.codexThreadId);
      remoteItems.push({
        threadId: localSession.codexThreadId,
        title: this.resolveThreadDisplayTitle({
          providerProfileId: providerProfile.id,
          threadId: localSession.codexThreadId,
          fallbackTitle: localSession.title ?? null,
        }),
        cwd: localSession.cwd ?? null,
        updatedAt: localSession.updatedAt ?? null,
        preview: null,
        turns: [],
        bridgeSessionId: localSession.id,
        archivedAt,
        pinnedAt,
      });
    }

    const filteredItems = remoteItems
      .filter((item) => includeArchived || typeof item.archivedAt !== 'number')
      .filter((item) => !onlyPinned || typeof item.pinnedAt === 'number')
      .sort((left, right) => {
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

    const offset = Math.max(0, Number(cursor ? Number(cursor) : 0) || 0);
    const items = filteredItems.slice(offset, offset + limit);
    const nextCursor = offset + items.length < filteredItems.length
      ? String(offset + items.length)
      : null;

    return {
      items,
      nextCursor,
    };
  }

  async switchScopeProvider(scopeRef: PlatformScopeRef, options: ScopeProviderSwitchOptions): Promise<BridgeSession> {
    const {
      nextProviderProfileId,
      cwd = null,
      title = null,
      initialSettings = {},
      providerStartOptions = {},
    } = options;
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

  getSessionSettings(bridgeSessionId: string): SessionSettings | null {
    return this.sessionSettings.get(bridgeSessionId);
  }

  getThreadMetadata(providerProfileId: string, threadId: string): ThreadMetadata | null {
    return this.threadMetadata?.get(providerProfileId, threadId) ?? null;
  }

  resolveThreadDisplayTitle({
    providerProfileId,
    threadId,
    providerTitle = null,
    fallbackTitle = null,
  }: {
    providerProfileId: string;
    threadId: string;
    providerTitle?: string | null;
    fallbackTitle?: string | null;
  }): string | null {
    const alias = this.getThreadMetadata(providerProfileId, threadId)?.alias ?? null;
    return alias ?? providerTitle ?? fallbackTitle ?? null;
  }

  async readProviderThread(
    providerProfileId: string,
    threadId: string,
    { includeTurns = false }: { includeTurns?: boolean } = {},
  ) {
    const providerProfile = this.providerProfiles.get(providerProfileId);
    if (!providerProfile) {
      throw new NotFoundError(this.i18n.t('service.unknownProviderProfile', { id: providerProfileId }));
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

  renameProviderThread(providerProfileId: string, threadId: string, alias: string) {
    const normalizedAlias = String(alias ?? '').trim();
    const current = this.getThreadMetadata(providerProfileId, threadId);
    const nextMetadata: ThreadMetadata = {
      providerProfileId,
      threadId,
      alias: normalizedAlias || null,
      archivedAt: typeof current?.archivedAt === 'number' ? current.archivedAt : null,
      pinnedAt: typeof current?.pinnedAt === 'number' ? current.pinnedAt : null,
      updatedAt: this.now(),
    };
    this.threadMetadata?.save(nextMetadata);
    const session = this.findSessionByProviderThread(providerProfileId, threadId);
    if (session) {
      this.updateSession(session.id, {
        title: normalizedAlias || session.title,
      });
    }
    return nextMetadata;
  }

  setProviderThreadArchived(providerProfileId: string, threadId: string, archived: boolean) {
    const current = this.getThreadMetadata(providerProfileId, threadId);
    const nextMetadata: ThreadMetadata = {
      providerProfileId,
      threadId,
      alias: current?.alias ?? null,
      archivedAt: archived ? this.now() : null,
      pinnedAt: typeof current?.pinnedAt === 'number' ? current.pinnedAt : null,
      updatedAt: this.now(),
    };
    this.threadMetadata?.save(nextMetadata);
    return nextMetadata;
  }

  async updateProviderThreadArchiveState(providerProfileId: string, threadId: string, archived: boolean) {
    const providerProfile = this.providerProfiles.get(providerProfileId);
    if (!providerProfile) {
      throw new NotFoundError(this.i18n.t('service.unknownProviderProfile', { id: providerProfileId }));
    }
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    if (archived && typeof providerPlugin.archiveThread === 'function') {
      await providerPlugin.archiveThread({ providerProfile, threadId });
    } else if (!archived && typeof providerPlugin.unarchiveThread === 'function') {
      await providerPlugin.unarchiveThread({ providerProfile, threadId });
    }
    return this.setProviderThreadArchived(providerProfileId, threadId, archived);
  }

  async archiveInternalProviderThreads(
    providerProfileId: string,
    {
      limit = 100_000,
      dryRun = false,
    }: { limit?: number; dryRun?: boolean } = {},
  ) {
    const providerProfile = this.providerProfiles.get(providerProfileId);
    if (!providerProfile) {
      throw new NotFoundError(this.i18n.t('service.unknownProviderProfile', { id: providerProfileId }));
    }
    const providerPlugin = this.providerRegistry.getProvider(providerProfile.providerKind);
    const pageLimit = Math.max(50, Math.min(Number(limit) || 100_000, 100_000));
    let cursor: string | null = null;
    let scanned = 0;
    let matched = 0;
    let archived = 0;
    const failed: Array<{ threadId: string; error: string }> = [];
    const matches: Array<{ threadId: string; title: string | null; preview: string | null }> = [];

    while (scanned < pageLimit) {
      const remoteResult = await providerPlugin.listThreads({
        providerProfile,
        limit: Math.min(100, pageLimit - scanned),
        cursor,
        archived: false,
      });
      const remoteThreads = Array.isArray(remoteResult)
        ? remoteResult
        : Array.isArray(remoteResult?.items)
          ? remoteResult.items
          : [];
      if (remoteThreads.length === 0) {
        break;
      }
      for (const remoteThread of remoteThreads) {
        if (!remoteThread?.threadId || !isBridgeInternalThread(remoteThread)) {
          scanned += 1;
          continue;
        }
        scanned += 1;
        matched += 1;
        matches.push({
          threadId: remoteThread.threadId,
          title: remoteThread.title ?? null,
          preview: remoteThread.preview ?? null,
        });
      }
      const resolvedNextCursor = typeof remoteResult?.nextCursor === 'string' ? remoteResult.nextCursor : null;
      if (!resolvedNextCursor || resolvedNextCursor === cursor) {
        break;
      }
      cursor = resolvedNextCursor;
    }

    if (!dryRun) {
      for (const match of matches) {
        try {
          await this.updateProviderThreadArchiveState(providerProfile.id, match.threadId, true);
          archived += 1;
        } catch (error) {
          failed.push({
            threadId: match.threadId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return {
      providerProfileId: providerProfile.id,
      scanned,
      matched,
      archived,
      failed,
      matches,
    };
  }

  setProviderThreadPinned(providerProfileId: string, threadId: string, pinned: boolean) {
    const current = this.getThreadMetadata(providerProfileId, threadId);
    const nextMetadata: ThreadMetadata = {
      providerProfileId,
      threadId,
      alias: current?.alias ?? null,
      archivedAt: typeof current?.archivedAt === 'number' ? current.archivedAt : null,
      pinnedAt: pinned ? this.now() : null,
      updatedAt: this.now(),
    };
    this.threadMetadata?.save(nextMetadata);
    return nextMetadata;
  }

  upsertSessionSettings(bridgeSessionId: string, updates: Partial<SessionSettings>): SessionSettings {
    const session = this.bridgeSessions.get(bridgeSessionId);
    if (!session) {
      throw new NotFoundError(this.i18n.t('service.unknownBridgeSession', { id: bridgeSessionId }));
    }
    const current = this.sessionSettings.get(bridgeSessionId);
    if (!current) {
      throw new ConfigurationError(this.i18n.t('service.sessionSettingsMissing', {
        id: bridgeSessionId,
      }));
    }
    const next: SessionSettings = {
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

function isBridgeInternalThread(thread: { title?: string | null; preview?: string | null } | null | undefined): boolean {
  const title = String(thread?.title ?? '').trim();
  const preview = String(thread?.preview ?? '').trim();
  if (new Set([
    'Artifact Delivery Intent Parser',
    'Assistant Record Classifier',
    'Assistant Record Router',
    'Assistant Record Rewriter',
    'Assistant Record Command Skill',
    'Automation Draft Parser',
    'Automation Draft Editor',
    'Automation Command Skill',
    'Agent Draft Parser',
    'Agent Draft Editor',
    'Agent Command Skill',
    'Agent Verifier',
    'Review Command Skill',
    'Review Result Localizer',
    'Instructions Command Skill',
    'Thread Command Skill',
  ]).has(title)) {
    return true;
  }
  return [
    /^CodexBridge command skill invocation\./iu,
    /^CodexBridge review result localizer\./iu,
    /^CodexBridge agent result verifier\./iu,
    /^你是 CodexBridge .*(?:草案|解析|分类|改写|重写|路由|归一化|规范化器)/iu,
  ].some((pattern) => pattern.test(preview));
}

function normalizeCwd(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function normalizeThreadTitle(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function createNextDefaultThreadTitle(titles: Array<string | null | undefined>): string {
  let max = 0;
  const pattern = new RegExp(`^${escapeRegExp(DEFAULT_THREAD_TITLE_PREFIX)}(\\d{5})$`, 'u');
  for (const title of titles) {
    const match = normalizeThreadTitle(title)?.match(pattern);
    if (!match) {
      continue;
    }
    max = Math.max(max, Number(match[1]));
  }
  const next = max >= 99999 ? 1 : max + 1;
  return `${DEFAULT_THREAD_TITLE_PREFIX}${String(next).padStart(5, '0')}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
