import type { BridgeSession, SessionSettings } from './core.js';
import type { InboundTextEvent } from './platform.js';

export interface ProviderProfile {
  id: string;
  providerKind: string;
  displayName: string;
  config: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderThreadTurnItem {
  type: string;
  role: string | null;
  phase: string | null;
  text: string;
}

export interface ProviderThreadTurn {
  id: string;
  status: string | null;
  error: string | null;
  items: ProviderThreadTurnItem[];
}

export interface ProviderThreadSummary {
  threadId: string;
  cwd: string | null;
  title: string | null;
  updatedAt?: number | null;
  preview?: string | null;
  turns?: ProviderThreadTurn[] | null;
  bridgeSessionId?: string | null;
  path?: string | null;
}

export interface ProviderThreadStartResult {
  threadId: string;
  cwd: string | null;
  title: string | null;
}

export interface ProviderThreadListResult {
  items: ProviderThreadSummary[];
  nextCursor: string | null;
}

export interface ProviderModelInfo {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
}

export interface ProviderTurnProgress {
  text: string;
  delta: string;
  outputKind: string;
}

export interface ProviderTurnResult {
  outputText: string;
  outputState?: string;
  previewText?: string;
  finalSource?: string;
  turnId?: string | null;
  threadId?: string | null;
  title?: string | null;
  status?: string | null;
}

export interface ProviderPluginContract {
  kind: string;
  displayName: string;
  startThread(params: {
    providerProfile: ProviderProfile;
    cwd?: string | null;
    title?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<ProviderThreadStartResult>;
  readThread(params: {
    providerProfile: ProviderProfile;
    threadId: string;
    includeTurns?: boolean;
  }): Promise<ProviderThreadSummary | null>;
  listThreads(params: {
    providerProfile: ProviderProfile;
    limit?: number;
    cursor?: string | null;
    searchTerm?: string | null;
  }): Promise<ProviderThreadListResult>;
  startTurn(params: {
    providerProfile: ProviderProfile;
    bridgeSession: BridgeSession;
    sessionSettings: SessionSettings | null;
    event: InboundTextEvent;
    inputText: string;
    onProgress?: ((progress: ProviderTurnProgress) => Promise<void> | void) | null;
    onTurnStarted?: ((meta: Record<string, unknown>) => Promise<void> | void) | null;
  }): Promise<ProviderTurnResult>;
  interruptTurn?(params: {
    providerProfile: ProviderProfile;
    threadId: string;
    turnId: string;
  }): Promise<void>;
  reconnectProfile?(params: {
    providerProfile: ProviderProfile;
  }): Promise<Record<string, unknown>>;
  listModels?(params: {
    providerProfile: ProviderProfile;
  }): Promise<ProviderModelInfo[]>;
}
