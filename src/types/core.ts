export interface PlatformScopeRef {
  platform: string;
  externalScopeId: string;
}

export interface BridgeSession {
  id: string;
  providerProfileId: string;
  codexThreadId: string;
  cwd: string | null;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface SessionSettings {
  bridgeSessionId: string;
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  accessPreset?: 'read-only' | 'default' | 'full-access' | null;
  approvalPolicy?: string | null;
  sandboxMode?: string | null;
  locale: string | null;
  metadata: Record<string, unknown>;
  updatedAt: number;
}

export interface ThreadMetadata {
  providerProfileId: string;
  threadId: string;
  alias: string | null;
  updatedAt: number;
}

