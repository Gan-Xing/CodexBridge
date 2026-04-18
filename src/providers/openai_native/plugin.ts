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

export class OpenAINativeProviderPlugin {
  kind: string;

  displayName: string;

  constructor() {
    this.kind = 'openai-native';
    this.displayName = 'OpenAI Native';
  }

  async startThread(_params: {
    providerProfile: ProviderProfile;
    cwd?: string | null;
    title?: string | null;
  }): Promise<ProviderThreadStartResult> {
    throw new Error('OpenAINativeProviderPlugin.startThread is not implemented yet');
  }

  async readThread(_params: {
    providerProfile: ProviderProfile;
    threadId: string;
    includeTurns?: boolean;
  }): Promise<ProviderThreadSummary | null> {
    throw new Error('OpenAINativeProviderPlugin.readThread is not implemented yet');
  }

  async listThreads(_params: {
    providerProfile: ProviderProfile;
    limit?: number;
    cursor?: string | null;
    searchTerm?: string | null;
  }): Promise<ProviderThreadListResult> {
    throw new Error('OpenAINativeProviderPlugin.listThreads is not implemented yet');
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
    throw new Error('OpenAINativeProviderPlugin.startTurn is not implemented yet');
  }

  async interruptTurn(_params: {
    providerProfile: ProviderProfile;
    threadId: string;
    turnId: string;
  }): Promise<void> {
    throw new Error('OpenAINativeProviderPlugin.interruptTurn is not implemented yet');
  }
}
