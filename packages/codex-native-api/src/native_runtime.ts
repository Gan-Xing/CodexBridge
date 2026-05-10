import crypto from 'node:crypto';
import {
  readCodexAccountIdentity,
  type CodexAuthIdentity,
} from './auth_state.js';
import type {
  CodexNativeInboundEvent,
  CodexNativeSession,
  CodexNativeSessionSettings,
} from './native_api_types.js';
import type {
  ProviderPluginContract,
  ProviderProfile,
  ProviderTurnProgress,
  ProviderTurnResult,
} from './provider.js';

export interface CodexNativeRuntimeReadiness {
  ready: boolean;
  runtimeReachable: boolean;
  accountIdentity: CodexAuthIdentity | null;
  modelCount: number | null;
  checkedAt: number;
  errorMessage: string | null;
}

export interface CodexNativeRuntimeTurnPreparation {
  event: CodexNativeInboundEvent;
  inputText: string;
  developerInstructions?: string | null;
  collaborationMode?: CodexNativeSessionSettings['collaborationMode'];
  personality?: CodexNativeSessionSettings['personality'];
  accessPreset?: CodexNativeSessionSettings['accessPreset'];
  approvalPolicy?: CodexNativeSessionSettings['approvalPolicy'];
  sandboxMode?: CodexNativeSessionSettings['sandboxMode'];
  locale?: CodexNativeSessionSettings['locale'];
  metadata?: CodexNativeSessionSettings['metadata'];
}

export interface CodexNativeRuntimeTurnResult {
  session: CodexNativeSession;
  result: ProviderTurnResult;
  request: CodexNativeRuntimeTurnPreparation;
}

export interface CodexNativeRuntimeTurnStartedMeta {
  threadId: string;
  turnId: string | null;
  bridgeSessionId: string;
}

export interface CodexNativeRuntimeTurnHooks {
  onProgress?: ((progress: ProviderTurnProgress) => Promise<void> | void) | null;
  onTurnStarted?: ((meta: CodexNativeRuntimeTurnStartedMeta) => Promise<void> | void) | null;
}

export interface CodexNativeRuntimeReconnectResult {
  connected: boolean;
  accountIdentity: CodexAuthIdentity | null;
  readiness: CodexNativeRuntimeReadiness;
}

export interface CodexNativeRuntimeReconnectSummaryEntry {
  providerProfileId: string;
  providerKind: string;
  connected: boolean;
  accountIdentity: CodexAuthIdentity | null;
  readiness: CodexNativeRuntimeReadiness;
}

export interface CodexNativeRuntimeReconnectSummary {
  refreshedCount: number;
  errors: string[];
  results: CodexNativeRuntimeReconnectSummaryEntry[];
}

export interface CodexNativeRuntimeContinuationTurnOptions extends CodexNativeRuntimeTurnHooks {
  providerProfile: ProviderProfile;
  providerPlugin: ProviderPluginContract;
  bridgeSession: CodexNativeSession;
  model?: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  prepareTurn: (session: CodexNativeSession) => CodexNativeRuntimeTurnPreparation;
}

export interface CodexNativeRuntimeRunTurnOptions extends CodexNativeRuntimeTurnHooks {
  providerProfile: ProviderProfile;
  providerPlugin: ProviderPluginContract;
  cwd?: string | null;
  title: string;
  metadata?: Record<string, unknown>;
  model?: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  prepareTurn: (session: CodexNativeSession) => CodexNativeRuntimeTurnPreparation;
}

export class CodexNativeRuntime {
  private readonly now: () => number;

  private readonly readAccountIdentity: typeof readCodexAccountIdentity;

  private readonly createSessionId: () => string;

  constructor({
    now = () => Date.now(),
    readAccountIdentity = readCodexAccountIdentity,
    createSessionId = () => crypto.randomUUID(),
  }: {
    now?: () => number;
    readAccountIdentity?: typeof readCodexAccountIdentity;
    createSessionId?: () => string;
  } = {}) {
    this.now = now;
    this.readAccountIdentity = readAccountIdentity;
    this.createSessionId = createSessionId;
  }

  getActiveAccountIdentity(
    authPathOrOptions: string | { authPath?: string; env?: NodeJS.ProcessEnv } = {},
  ): CodexAuthIdentity | null {
    return this.readAccountIdentity(authPathOrOptions);
  }

  async checkReadiness({
    providerProfile,
    providerPlugin,
    authPathOrOptions = {},
  }: {
    providerProfile: ProviderProfile;
    providerPlugin: ProviderPluginContract | null | undefined;
    authPathOrOptions?: string | { authPath?: string; env?: NodeJS.ProcessEnv };
  }): Promise<CodexNativeRuntimeReadiness> {
    const accountIdentity = this.getActiveAccountIdentity(authPathOrOptions);
    const checkedAt = this.now();
    if (!providerPlugin) {
      return {
        ready: false,
        runtimeReachable: false,
        accountIdentity,
        modelCount: null,
        checkedAt,
        errorMessage: 'Codex provider plugin is unavailable.',
      };
    }
    if (typeof providerPlugin.startThread !== 'function' || typeof providerPlugin.startTurn !== 'function') {
      return {
        ready: false,
        runtimeReachable: false,
        accountIdentity,
        modelCount: null,
        checkedAt,
        errorMessage: 'Codex provider plugin does not expose isolated execution primitives.',
      };
    }
    if (typeof providerPlugin.listModels !== 'function') {
      return {
        ready: false,
        runtimeReachable: false,
        accountIdentity,
        modelCount: null,
        checkedAt,
        errorMessage: 'Codex provider plugin does not expose a readiness probe.',
      };
    }
    try {
      const models = await providerPlugin.listModels({ providerProfile });
      return {
        ready: Boolean(accountIdentity),
        runtimeReachable: true,
        accountIdentity,
        modelCount: Array.isArray(models) ? models.length : 0,
        checkedAt,
        errorMessage: accountIdentity ? null : 'Codex auth state is unavailable.',
      };
    } catch (error) {
      return {
        ready: false,
        runtimeReachable: false,
        accountIdentity,
        modelCount: null,
        checkedAt,
        errorMessage: formatNativeRuntimeError(error),
      };
    }
  }

  async reconnectProfile({
    providerProfile,
    providerPlugin,
    authPathOrOptions = {},
  }: {
    providerProfile: ProviderProfile;
    providerPlugin: ProviderPluginContract | null | undefined;
    authPathOrOptions?: string | { authPath?: string; env?: NodeJS.ProcessEnv };
  }): Promise<CodexNativeRuntimeReconnectResult | null> {
    if (!providerPlugin || typeof providerPlugin.reconnectProfile !== 'function') {
      return null;
    }
    const reconnectResult = await providerPlugin.reconnectProfile({ providerProfile });
    const readiness = await this.checkReadiness({
      providerProfile,
      providerPlugin,
      authPathOrOptions,
    });
    return {
      connected: reconnectResult.connected !== false,
      accountIdentity: reconnectResult.accountIdentity as CodexAuthIdentity | null | undefined
        ?? readiness.accountIdentity
        ?? this.getActiveAccountIdentity(authPathOrOptions),
      readiness,
    };
  }

  async reconnectProfiles({
    providerProfiles,
    resolveProviderPlugin,
    authPathOrOptions = {},
  }: {
    providerProfiles: ProviderProfile[];
    resolveProviderPlugin: (providerKind: string) => ProviderPluginContract | null | undefined;
    authPathOrOptions?: string | { authPath?: string; env?: NodeJS.ProcessEnv };
  }): Promise<CodexNativeRuntimeReconnectSummary> {
    const errors: string[] = [];
    const results: CodexNativeRuntimeReconnectSummaryEntry[] = [];
    let refreshedCount = 0;
    for (const providerProfile of providerProfiles) {
      const providerPlugin = resolveProviderPlugin(providerProfile.providerKind);
      if (!providerPlugin || typeof providerPlugin.reconnectProfile !== 'function') {
        continue;
      }
      try {
        const result = await this.reconnectProfile({
          providerProfile,
          providerPlugin,
          authPathOrOptions,
        });
        if (!result) {
          continue;
        }
        refreshedCount += 1;
        results.push({
          providerProfileId: providerProfile.id,
          providerKind: providerProfile.providerKind,
          connected: result.connected,
          accountIdentity: result.accountIdentity,
          readiness: result.readiness,
        });
      } catch (error) {
        errors.push(formatNativeRuntimeError(error));
      }
    }
    return {
      refreshedCount,
      errors,
      results,
    };
  }

  async runIsolatedTurn({
    providerProfile,
    providerPlugin,
    cwd = null,
    title,
    metadata = {},
    model = null,
    reasoningEffort = null,
    serviceTier = null,
    prepareTurn,
    onProgress = null,
    onTurnStarted = null,
  }: CodexNativeRuntimeRunTurnOptions): Promise<CodexNativeRuntimeTurnResult> {
    this.assertSupportsIsolatedTurns(providerPlugin);
    const session = await this.createIsolatedSession({
      providerProfile,
      providerPlugin,
      cwd,
      title,
      metadata,
    });
    return this.runTurnOnSession({
      providerProfile,
      providerPlugin,
      session,
      model,
      reasoningEffort,
      serviceTier,
      prepareTurn,
      onProgress,
      onTurnStarted,
    });
  }

  async continueIsolatedTurn({
    providerProfile,
    providerPlugin,
    bridgeSession,
    model = null,
    reasoningEffort = null,
    serviceTier = null,
    prepareTurn,
    onProgress = null,
    onTurnStarted = null,
  }: CodexNativeRuntimeContinuationTurnOptions): Promise<CodexNativeRuntimeTurnResult> {
    this.assertSupportsIsolatedTurns(providerPlugin);
    const session: CodexNativeSession = {
      ...bridgeSession,
      providerProfileId: providerProfile.id,
      updatedAt: this.now(),
    };
    return this.runTurnOnSession({
      providerProfile,
      providerPlugin,
      session,
      model,
      reasoningEffort,
      serviceTier,
      prepareTurn,
      onProgress,
      onTurnStarted,
    });
  }

  private async runTurnOnSession({
    providerProfile,
    providerPlugin,
    session,
    model = null,
    reasoningEffort = null,
    serviceTier = null,
    prepareTurn,
    onProgress = null,
    onTurnStarted = null,
  }: {
    providerProfile: ProviderProfile;
    providerPlugin: ProviderPluginContract;
    session: CodexNativeSession;
    model?: string | null;
    reasoningEffort?: string | null;
    serviceTier?: string | null;
    prepareTurn: (session: CodexNativeSession) => CodexNativeRuntimeTurnPreparation;
    onProgress?: ((progress: ProviderTurnProgress) => Promise<void> | void) | null;
    onTurnStarted?: ((meta: CodexNativeRuntimeTurnStartedMeta) => Promise<void> | void) | null;
  }): Promise<CodexNativeRuntimeTurnResult> {
    const request = prepareTurn(session);
    const sessionSettings = this.buildIsolatedSessionSettings(session, {
      model,
      reasoningEffort,
      serviceTier,
      collaborationMode: request.collaborationMode ?? null,
      personality: request.personality ?? null,
      accessPreset: request.accessPreset ?? 'read-only',
      approvalPolicy: request.approvalPolicy ?? 'never',
      sandboxMode: request.sandboxMode ?? 'read-only',
      locale: request.locale ?? request.event.locale ?? null,
      metadata: request.metadata ?? {},
    });
    const result = await providerPlugin.startTurn({
      providerProfile,
      bridgeSession: session,
      sessionSettings,
      event: request.event,
      inputText: request.inputText,
      developerInstructions: request.developerInstructions ?? null,
      onProgress,
      onTurnStarted: typeof onTurnStarted === 'function'
        ? async (meta) => {
          const threadId = typeof meta?.threadId === 'string' && meta.threadId.trim()
            ? meta.threadId.trim()
            : session.codexThreadId;
          const turnId = typeof meta?.turnId === 'string' && meta.turnId.trim()
            ? meta.turnId.trim()
            : null;
          await onTurnStarted({
            threadId,
            turnId,
            bridgeSessionId: session.id,
          });
        }
        : null,
    });
    return {
      session,
      result,
      request,
    };
  }

  private async createIsolatedSession({
    providerProfile,
    providerPlugin,
    cwd = null,
    title,
    metadata = {},
  }: {
    providerProfile: ProviderProfile;
    providerPlugin: ProviderPluginContract;
    cwd?: string | null;
    title: string;
    metadata?: Record<string, unknown>;
  }): Promise<CodexNativeSession> {
    const thread = await providerPlugin.startThread({
      providerProfile,
      cwd,
      title,
      ephemeral: true,
      metadata,
    });
    const now = this.now();
    return {
      id: this.createSessionId(),
      providerProfileId: providerProfile.id,
      codexThreadId: thread.threadId,
      cwd: thread.cwd ?? cwd,
      title: thread.title ?? title,
      createdAt: now,
      updatedAt: now,
    };
  }

  private buildIsolatedSessionSettings(
    session: CodexNativeSession,
    overrides: Partial<CodexNativeSessionSettings> = {},
  ): CodexNativeSessionSettings {
    return {
      bridgeSessionId: session.id,
      model: overrides.model ?? null,
      reasoningEffort: overrides.reasoningEffort ?? null,
      serviceTier: overrides.serviceTier ?? null,
      collaborationMode: overrides.collaborationMode ?? null,
      personality: overrides.personality ?? null,
      accessPreset: overrides.accessPreset ?? 'read-only',
      approvalPolicy: overrides.approvalPolicy ?? 'never',
      sandboxMode: overrides.sandboxMode ?? 'read-only',
      locale: overrides.locale ?? null,
      metadata: overrides.metadata ?? {},
      updatedAt: this.now(),
    };
  }

  private assertSupportsIsolatedTurns(
    providerPlugin: ProviderPluginContract | null | undefined,
  ): asserts providerPlugin is ProviderPluginContract {
    if (!providerPlugin || typeof providerPlugin.startThread !== 'function' || typeof providerPlugin.startTurn !== 'function') {
      throw new Error('Codex native runtime requires provider plugins with startThread/startTurn support.');
    }
  }
}

function formatNativeRuntimeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return 'Unknown Codex native runtime error.';
}
