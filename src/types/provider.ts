import type { BridgeSession, SessionSettings, TurnArtifactDeliveryState } from './core.js';
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
  savedPath?: string | null;
  result?: string | null;
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

export interface ProviderUsageWindow {
  name: string;
  usedPercent: number;
  windowSeconds: number;
  resetAfterSeconds: number;
  resetAtUnix: number;
}

export interface ProviderUsageBucket {
  name: string;
  allowed: boolean;
  limitReached: boolean;
  windows: ProviderUsageWindow[];
}

export interface ProviderUsageCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface ProviderUsageReport {
  provider: string;
  accountId: string | null;
  userId: string | null;
  email: string | null;
  plan: string | null;
  buckets: ProviderUsageBucket[];
  credits?: ProviderUsageCredits | null;
}

export interface ProviderSkillToolDependency {
  type: string;
  value: string;
  command?: string | null;
  description?: string | null;
  transport?: string | null;
  url?: string | null;
}

export interface ProviderSkillInfo {
  name: string;
  description: string;
  enabled: boolean;
  path: string;
  scope: 'user' | 'repo' | 'system' | 'admin' | string;
  shortDescription?: string | null;
  displayName?: string | null;
  defaultPrompt?: string | null;
  brandColor?: string | null;
  dependencies?: ProviderSkillToolDependency[];
}

export interface ProviderSkillError {
  path: string;
  message: string;
}

export interface ProviderSkillsListResult {
  cwd: string | null;
  skills: ProviderSkillInfo[];
  errors: ProviderSkillError[];
}

export interface ProviderTurnProgress {
  text: string;
  delta: string;
  outputKind: string;
}

export type OutputArtifactKind = 'image' | 'file' | 'video' | 'audio';

export interface OutputArtifact {
  kind: OutputArtifactKind;
  path: string;
  displayName?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  caption?: string | null;
  source?: 'provider_native' | 'bridge_declared' | 'bridge_fallback';
  turnId?: string | null;
}

export interface ProviderApprovalRequest {
  requestId: string;
  kind: 'command' | 'file_change' | 'permissions';
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  reason: string | null;
  command?: string | null;
  cwd?: string | null;
  fileChanges?: string[];
  grantRoot?: string | null;
  networkPermission?: boolean | null;
  fileReadPermissions?: string[];
  fileWritePermissions?: string[];
  availableDecisionKeys?: string[];
  execPolicyAmendment?: string[] | null;
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
  outputArtifacts?: OutputArtifact[];
  outputMedia?: Array<{
    kind: 'image';
    path: string;
    caption?: string | null;
  }>;
  artifactDelivery?: TurnArtifactDeliveryState | null;
}

export type ProviderReviewTarget =
  | {
    type: 'uncommittedChanges';
  }
  | {
    type: 'baseBranch';
    branch: string;
  }
  | {
    type: 'commit';
    sha: string;
    title?: string | null;
  }
  | {
    type: 'custom';
    instructions: string;
  };

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
    onApprovalRequest?: ((request: ProviderApprovalRequest) => Promise<void> | void) | null;
  }): Promise<ProviderTurnResult>;
  startReview?(params: {
    providerProfile: ProviderProfile;
    bridgeSession?: BridgeSession | null;
    sessionSettings: SessionSettings | null;
    cwd: string;
    target: ProviderReviewTarget;
    locale?: string | null;
    onProgress?: ((progress: ProviderTurnProgress) => Promise<void> | void) | null;
    onTurnStarted?: ((meta: Record<string, unknown>) => Promise<void> | void) | null;
    onApprovalRequest?: ((request: ProviderApprovalRequest) => Promise<void> | void) | null;
  }): Promise<ProviderTurnResult>;
  interruptTurn?(params: {
    providerProfile: ProviderProfile;
    threadId: string;
    turnId: string;
  }): Promise<void>;
  respondToApproval?(params: {
    providerProfile: ProviderProfile;
    request: ProviderApprovalRequest;
    option: 1 | 2 | 3;
  }): Promise<void>;
  reconnectProfile?(params: {
    providerProfile: ProviderProfile;
  }): Promise<Record<string, unknown>>;
  listModels?(params: {
    providerProfile: ProviderProfile;
  }): Promise<ProviderModelInfo[]>;
  getUsage?(params: {
    providerProfile: ProviderProfile;
  }): Promise<ProviderUsageReport | null>;
  listSkills?(params: {
    providerProfile: ProviderProfile;
    cwd?: string | null;
    forceReload?: boolean;
  }): Promise<ProviderSkillsListResult>;
  setSkillEnabled?(params: {
    providerProfile: ProviderProfile;
    enabled: boolean;
    name?: string | null;
    path?: string | null;
  }): Promise<void>;
}
