import crypto from 'node:crypto';
import {
  readCodexAccountIdentity,
  type CodexAuthIdentity,
} from './auth_state.js';
import type { BridgeSession, SessionSettings } from '../../types/core.js';
import type { InboundTextEvent } from '../../types/platform.js';
import type {
  ProviderPluginContract,
  ProviderProfile,
  ProviderTurnResult,
} from '../../types/provider.js';

export interface CodexNativeRuntimeReadiness {
  ready: boolean;
  runtimeReachable: boolean;
  accountIdentity: CodexAuthIdentity | null;
  modelCount: number | null;
  checkedAt: number;
  errorMessage: string | null;
}

export interface CodexNativeRuntimeTurnPreparation {
  event: InboundTextEvent;
  inputText: string;
  collaborationMode?: SessionSettings['collaborationMode'];
  personality?: SessionSettings['personality'];
  accessPreset?: SessionSettings['accessPreset'];
  approvalPolicy?: SessionSettings['approvalPolicy'];
  sandboxMode?: SessionSettings['sandboxMode'];
  locale?: SessionSettings['locale'];
  metadata?: SessionSettings['metadata'];
}

export interface CodexNativeRuntimeTurnResult {
  session: BridgeSession;
  result: ProviderTurnResult;
  request: CodexNativeRuntimeTurnPreparation;
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
  }: {
    providerProfile: ProviderProfile;
    providerPlugin: ProviderPluginContract;
    cwd?: string | null;
    title: string;
    metadata?: Record<string, unknown>;
    model?: string | null;
    reasoningEffort?: string | null;
    serviceTier?: string | null;
    prepareTurn: (session: BridgeSession) => CodexNativeRuntimeTurnPreparation;
  }): Promise<CodexNativeRuntimeTurnResult> {
    this.assertSupportsIsolatedTurns(providerPlugin);
    const session = await this.createIsolatedSession({
      providerProfile,
      providerPlugin,
      cwd,
      title,
      metadata,
    });
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
  }): Promise<BridgeSession> {
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
    session: BridgeSession,
    overrides: Partial<SessionSettings> = {},
  ): SessionSettings {
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
