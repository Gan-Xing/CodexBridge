import type { BridgeSession, SessionSettings } from '../../types/core.js';
import type { InboundTextEvent } from '../../types/platform.js';
import type {
  ProviderProfile,
  ProviderThreadListResult,
  ProviderThreadStartResult,
  ProviderThreadSummary,
  ProviderTurnProgress,
  ProviderTurnResult,
} from '../../types/provider.js';
import { createI18n } from '../../i18n/index.js';

const i18n = createI18n();

export class MiniMaxViaCLIProxyProviderPlugin {
  kind: string;

  displayName: string;

  constructor() {
    this.kind = 'minimax-via-cliproxy';
    this.displayName = 'MiniMax via CLIProxyAPI';
  }

  async startThread(_params: {
    providerProfile: ProviderProfile;
    cwd?: string | null;
    title?: string | null;
  }): Promise<ProviderThreadStartResult> {
    throw new Error(i18n.t('provider.minimax.startThreadUnimplemented'));
  }

  async readThread(_params: {
    providerProfile: ProviderProfile;
    threadId: string;
    includeTurns?: boolean;
  }): Promise<ProviderThreadSummary | null> {
    throw new Error(i18n.t('provider.minimax.readThreadUnimplemented'));
  }

  async listThreads(_params: {
    providerProfile: ProviderProfile;
    limit?: number;
    cursor?: string | null;
    searchTerm?: string | null;
  }): Promise<ProviderThreadListResult> {
    throw new Error(i18n.t('provider.minimax.listThreadsUnimplemented'));
  }

  async startTurn(_params: {
    providerProfile: ProviderProfile;
    bridgeSession: BridgeSession;
    sessionSettings: SessionSettings | null;
    event: InboundTextEvent;
    inputText: string;
    onProgress?: ((progress: ProviderTurnProgress) => Promise<void> | void) | null;
    onTurnStarted?: ((meta: Record<string, unknown>) => Promise<void> | void) | null;
  }): Promise<ProviderTurnResult> {
    throw new Error(i18n.t('provider.minimax.startTurnUnimplemented'));
  }

  async interruptTurn(_params: {
    providerProfile: ProviderProfile;
    threadId: string;
    turnId: string;
  }): Promise<void> {
    throw new Error(i18n.t('provider.minimax.interruptTurnUnimplemented'));
  }
}
