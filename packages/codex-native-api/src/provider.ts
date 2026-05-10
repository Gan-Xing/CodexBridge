export type ProviderInboundAttachmentKind = 'image' | 'voice' | 'file' | 'video';

export interface ProviderTurnAttachment {
  kind: ProviderInboundAttachmentKind;
  localPath: string;
  fileName?: string | null;
  mimeType?: string | null;
  transcriptText?: string | null;
  durationSeconds?: number | null;
}

export interface ProviderTurnEvent {
  platform: string;
  externalScopeId: string;
  text: string;
  attachments?: ProviderTurnAttachment[];
  cwd?: string | null;
  locale?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ProviderTurnSession {
  id: string;
  providerProfileId: string;
  codexThreadId: string;
  cwd: string | null;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderTurnSessionSettings {
  bridgeSessionId: string;
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  collaborationMode?: 'plan' | 'default' | null;
  personality?: 'friendly' | 'pragmatic' | 'none' | null;
  accessPreset?: 'read-only' | 'default' | 'full-access' | null;
  approvalPolicy?: string | null;
  sandboxMode?: string | null;
  locale: string | null;
  metadata: Record<string, unknown>;
  updatedAt: number;
}

export type ProviderTurnArtifactKind = 'image' | 'file' | 'video' | 'audio';

export interface ProviderTurnArtifactDeliveredItem {
  path: string;
  kind: ProviderTurnArtifactKind;
  displayName: string | null;
  mimeType?: string | null;
  sizeBytes: number | null;
  caption: string | null;
  source: 'provider_native' | 'bridge_declared' | 'bridge_fallback';
  turnId: string | null;
}

export type ProviderTurnArtifactRejectionReason =
  | 'path_outside_artifact_dir'
  | 'missing_file'
  | 'not_file'
  | 'symlink'
  | 'invalid_manifest'
  | 'size_limit'
  | 'count_limit'
  | 'ambiguous_candidates';

export interface ProviderTurnArtifactRejectedItem {
  path: string | null;
  displayName: string | null;
  sizeBytes: number | null;
  reason: ProviderTurnArtifactRejectionReason;
}

export type ProviderTurnArtifactDeliveryStage =
  | 'pending'
  | 'ready'
  | 'fallback_ready'
  | 'limited'
  | 'ambiguous'
  | 'missing';

export type ProviderTurnArtifactNoticeCode =
  | 'count_limited'
  | 'size_limited'
  | 'count_and_size_limited'
  | 'ambiguous_candidates'
  | 'missing_deliverable';

export interface ProviderTurnArtifactDeliveryState {
  requestId: string;
  bridgeSessionId: string;
  turnId: string | null;
  requestedByUser: boolean;
  requestedFormat: string | null;
  preferredKind: ProviderTurnArtifactKind | null;
  requestedByText: string | null;
  artifactDir: string;
  spoolDir: string;
  stage: ProviderTurnArtifactDeliveryStage;
  fallbackUsed: boolean;
  manifestDeclaredCount: number;
  scannedCandidateCount: number;
  maxArtifactCount: number;
  maxArtifactSizeBytes: number;
  noticeCode: ProviderTurnArtifactNoticeCode | null;
  deliveredArtifacts: ProviderTurnArtifactDeliveredItem[];
  rejectedArtifacts: ProviderTurnArtifactRejectedItem[];
}

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

export interface ProviderThreadGoal {
  threadId: string;
  objective: string;
  status: string;
  tokenBudget?: number | null;
  tokensUsed?: number | null;
  timeUsedSeconds?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
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

export interface ProviderPluginLoadError {
  marketplacePath: string;
  message: string;
}

export interface ProviderPluginSummary {
  id: string;
  name: string;
  installed: boolean;
  enabled: boolean;
  installPolicy: 'NOT_AVAILABLE' | 'AVAILABLE' | 'INSTALLED_BY_DEFAULT' | string;
  authPolicy: 'ON_INSTALL' | 'ON_USE' | string;
  marketplaceName: string;
  marketplacePath: string | null;
  marketplaceDisplayName?: string | null;
  displayName?: string | null;
  shortDescription?: string | null;
  longDescription?: string | null;
  category?: string | null;
  capabilities?: string[];
  developerName?: string | null;
  brandColor?: string | null;
  defaultPrompts?: string[] | null;
  websiteUrl?: string | null;
  sourceType?: string | null;
  sourcePath?: string | null;
  sourceRemoteMarketplaceName?: string | null;
}

export interface ProviderPluginMarketplace {
  name: string;
  path: string | null;
  displayName?: string | null;
  plugins: ProviderPluginSummary[];
}

export interface ProviderPluginsListResult {
  featuredPluginIds: string[];
  marketplaceLoadErrors: ProviderPluginLoadError[];
  marketplaces: ProviderPluginMarketplace[];
}

export interface ProviderPluginAppSummary {
  id: string;
  name: string;
  needsAuth: boolean;
  description?: string | null;
  installUrl?: string | null;
}

export interface ProviderPluginSkillSummary {
  name: string;
  path: string;
  description: string;
  enabled: boolean;
  shortDescription?: string | null;
  displayName?: string | null;
}

export interface ProviderPluginDetail {
  summary: ProviderPluginSummary;
  marketplaceName: string;
  marketplacePath: string | null;
  description?: string | null;
  apps: ProviderPluginAppSummary[];
  mcpServers: string[];
  skills: ProviderPluginSkillSummary[];
}

export interface ProviderPluginInstallResult {
  authPolicy: 'ON_INSTALL' | 'ON_USE' | string | null;
  appsNeedingAuth: ProviderPluginAppSummary[];
}

export interface ProviderMcpOauthLoginResult {
  authorizationUrl: string;
}

export interface ProviderAppInfo {
  id: string;
  name: string;
  description?: string | null;
  installUrl?: string | null;
  isAccessible: boolean;
  isEnabled: boolean;
  pluginDisplayNames: string[];
  categories?: string[] | null;
  developer?: string | null;
}

export interface ProviderMcpServerStatus {
  name: string;
  isEnabled: boolean;
  authStatus: 'unsupported' | 'notLoggedIn' | 'bearerToken' | 'oAuth' | string;
  toolCount: number;
  resourceCount: number;
  resourceTemplateCount: number;
}

export interface ProviderTurnProgress {
  text: string;
  delta: string;
  outputKind: string;
}

export interface ProviderResponseItem {
  [key: string]: unknown;
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
  errorMessage?: string | null;
  turnId?: string | null;
  threadId?: string | null;
  title?: string | null;
  status?: string | null;
  responseItems?: ProviderResponseItem[];
  outputArtifacts?: OutputArtifact[];
  outputMedia?: Array<{
    kind: 'image';
    path: string;
    caption?: string | null;
  }>;
  artifactDelivery?: ProviderTurnArtifactDeliveryState | null;
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
    focus?: string[];
    includePaths?: string[];
    excludePaths?: string[];
  };

export interface ProviderPluginContract {
  kind: string;
  displayName: string;
  startThread(params: {
    providerProfile: ProviderProfile;
    cwd?: string | null;
    title?: string | null;
    ephemeral?: boolean | null;
    metadata?: Record<string, unknown>;
  }): Promise<ProviderThreadStartResult>;
  readThread(params: {
    providerProfile: ProviderProfile;
    threadId: string;
    includeTurns?: boolean;
  }): Promise<ProviderThreadSummary | null>;
  getThreadGoal?(params: {
    providerProfile: ProviderProfile;
    threadId: string;
  }): Promise<ProviderThreadGoal | null>;
  setThreadGoal?(params: {
    providerProfile: ProviderProfile;
    threadId: string;
    objective?: string | null;
    status?: string | null;
    suppressAutoTurn?: boolean;
  }): Promise<ProviderThreadGoal | null>;
  clearThreadGoal?(params: {
    providerProfile: ProviderProfile;
    threadId: string;
  }): Promise<boolean>;
  listThreads(params: {
    providerProfile: ProviderProfile;
    limit?: number;
    cursor?: string | null;
    searchTerm?: string | null;
    archived?: boolean | null;
  }): Promise<ProviderThreadListResult>;
  archiveThread?(params: {
    providerProfile: ProviderProfile;
    threadId: string;
  }): Promise<void>;
  unarchiveThread?(params: {
    providerProfile: ProviderProfile;
    threadId: string;
  }): Promise<void>;
  startTurn(params: {
    providerProfile: ProviderProfile;
    bridgeSession: ProviderTurnSession;
    sessionSettings: ProviderTurnSessionSettings | null;
    event: ProviderTurnEvent;
    inputText: string;
    developerInstructions?: string | null;
    onProgress?: ((progress: ProviderTurnProgress) => Promise<void> | void) | null;
    onTurnStarted?: ((meta: Record<string, unknown>) => Promise<void> | void) | null;
    onApprovalRequest?: ((request: ProviderApprovalRequest) => Promise<void> | void) | null;
  }): Promise<ProviderTurnResult>;
  startReview?(params: {
    providerProfile: ProviderProfile;
    bridgeSession?: ProviderTurnSession | null;
    sessionSettings: ProviderTurnSessionSettings | null;
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
  listPlugins?(params: {
    providerProfile: ProviderProfile;
    cwd?: string | null;
  }): Promise<ProviderPluginsListResult>;
  readPlugin?(params: {
    providerProfile: ProviderProfile;
    pluginName: string;
    marketplaceName?: string | null;
    marketplacePath?: string | null;
  }): Promise<ProviderPluginDetail | null>;
  installPlugin?(params: {
    providerProfile: ProviderProfile;
    pluginName: string;
    marketplaceName?: string | null;
    marketplacePath?: string | null;
  }): Promise<ProviderPluginInstallResult>;
  uninstallPlugin?(params: {
    providerProfile: ProviderProfile;
    pluginId: string;
  }): Promise<void>;
  listApps?(params: {
    providerProfile: ProviderProfile;
  }): Promise<ProviderAppInfo[]>;
  listMcpServerStatuses?(params: {
    providerProfile: ProviderProfile;
  }): Promise<ProviderMcpServerStatus[]>;
  setAppEnabled?(params: {
    providerProfile: ProviderProfile;
    appId: string;
    enabled: boolean;
  }): Promise<void>;
  setMcpServerEnabled?(params: {
    providerProfile: ProviderProfile;
    name: string;
    enabled: boolean;
  }): Promise<void>;
  startMcpServerOauthLogin?(params: {
    providerProfile: ProviderProfile;
    name: string;
    scopes?: string[] | null;
    timeoutSecs?: number | null;
  }): Promise<ProviderMcpOauthLoginResult>;
  reloadMcpServers?(params: {
    providerProfile: ProviderProfile;
  }): Promise<void>;
  setSkillEnabled?(params: {
    providerProfile: ProviderProfile;
    enabled: boolean;
    name?: string | null;
    path?: string | null;
  }): Promise<void>;
}
