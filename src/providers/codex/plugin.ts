import { CodexAppClient, createStderrLogger, readCodexAccountIdentity } from './app_client.js';
import type { CodexTurnInput } from './app_client.js';
import { CodexCliReviewRunner } from './review_runner.js';
import { buildTurnArtifactDeveloperInstructions } from '../../core/turn_artifacts.js';
import type { BridgeSession, SessionSettings, TurnArtifactContext } from '../../types/core.js';
import type { InboundAttachment, InboundTextEvent } from '../../types/platform.js';
import type {
  ProviderAppInfo,
  ProviderApprovalRequest,
  ProviderMcpServerStatus,
  ProviderMcpOauthLoginResult,
  ProviderProfile,
  ProviderPluginDetail,
  ProviderPluginInstallResult,
  ProviderPluginsListResult,
  ProviderSkillsListResult,
  ProviderThreadListResult,
  ProviderThreadStartResult,
  ProviderThreadSummary,
  ProviderTurnProgress,
  ProviderTurnResult,
  ProviderModelInfo,
  ProviderReviewTarget,
  ProviderUsageReport,
} from '../../types/provider.js';

type CodexClientLike = any;

interface CodexProviderProfileConfig extends Record<string, unknown> {
  cliBin: string;
  launchCommand?: string | null;
  autolaunch?: boolean;
  modelCatalog?: unknown[];
  modelCatalogMode?: 'merge' | 'overlay-only';
  defaultModel?: string | null;
}

type CodexProviderProfile = ProviderProfile & {
  config: CodexProviderProfileConfig;
};

interface CodexProviderPluginOptions {
  clientFactory?: any;
  reviewRunner?: any;
}

export class CodexProviderPlugin {
  kind: string;

  displayName: string;

  clientFactory: any;

  clients: Map<string, any>;

  reviewRunner: any;

  constructor({
    clientFactory = (profile) => new CodexAppClient({
      codexCliBin: profile.config.cliBin,
      launchCommand: profile.config.launchCommand ?? null,
      autolaunch: profile.config.autolaunch ?? false,
      modelCatalog: profile.config.modelCatalog ?? [],
      modelCatalogMode: profile.config.modelCatalogMode ?? 'merge',
      logger: createStderrLogger(),
    }),
    reviewRunner = new CodexCliReviewRunner(),
  }: CodexProviderPluginOptions = {}) {
    this.kind = 'codex';
    this.displayName = 'Codex Engine';
    this.clientFactory = clientFactory;
    this.clients = new Map();
    this.reviewRunner = reviewRunner;
  }

  async startThread({
    providerProfile,
    cwd = null,
    title = null,
  }: {
    providerProfile: ProviderProfile;
    cwd?: string | null;
    title?: string | null;
  }): Promise<ProviderThreadStartResult> {
    const client = await this.ensureClient(providerProfile);
    const modelInfo = await this.resolveModelInfo(providerProfile, client, null);
    return client.startThread({
      cwd,
      title,
      model: modelInfo?.model ?? null,
    });
  }

  async readThread({
    providerProfile,
    threadId,
    includeTurns = false,
  }: {
    providerProfile: ProviderProfile;
    threadId: string;
    includeTurns?: boolean;
  }): Promise<ProviderThreadSummary | null> {
    const reviewThread = this.reviewRunner?.readThread?.(threadId, includeTurns) ?? null;
    if (reviewThread) {
      return reviewThread;
    }
    const client = await this.ensureClient(providerProfile);
    return client.readThread(threadId, includeTurns);
  }

  async listThreads({
    providerProfile,
    limit = 20,
    cursor = null,
    searchTerm = null,
  }: {
    providerProfile: ProviderProfile;
    limit?: number;
    cursor?: string | null;
    searchTerm?: string | null;
  }): Promise<ProviderThreadListResult> {
    const client = await this.ensureClient(providerProfile);
    return client.listThreads({ limit, cursor, searchTerm });
  }

  async resumeThread({
    providerProfile,
    threadId,
  }: {
    providerProfile: ProviderProfile;
    threadId: string;
  }): Promise<unknown> {
    const client = await this.ensureClient(providerProfile);
    return client.resumeThread({ threadId });
  }

  async reconnectProfile({
    providerProfile,
  }: {
    providerProfile: ProviderProfile;
  }): Promise<Record<string, unknown>> {
    const previousClient = this.clients.get(providerProfile.id) ?? null;
    if (previousClient) {
      this.clients.delete(providerProfile.id);
      await previousClient.stop();
    }
    const client = this.clientFactory(providerProfile);
    this.clients.set(providerProfile.id, client);
    await client.start();
    return {
      connected: client.isConnected(),
      accountIdentity: readCodexAccountIdentity(),
    };
  }

  async startTurn({
    providerProfile,
    bridgeSession,
    sessionSettings,
    event,
    inputText,
    onProgress = null,
    onTurnStarted = null,
    onApprovalRequest = null,
  }: {
    providerProfile: ProviderProfile;
    bridgeSession: BridgeSession;
    sessionSettings: SessionSettings | null;
    event: InboundTextEvent;
    inputText: string;
    onProgress?: ((progress: ProviderTurnProgress) => Promise<void> | void) | null;
    onTurnStarted?: ((meta: Record<string, unknown>) => Promise<void> | void) | null;
    onApprovalRequest?: ((request: ProviderApprovalRequest) => Promise<void> | void) | null;
  }): Promise<ProviderTurnResult> {
    const client = await this.ensureClient(providerProfile);
    const modelInfo = await this.resolveModelInfo(providerProfile, client, sessionSettings?.model ?? null);
    const effort = this.resolveReasoningEffort(modelInfo, sessionSettings?.reasoningEffort ?? null);
    const turnInput = buildCodexTurnInput(event, inputText);
    const developerInstructions = buildDeveloperInstructions(event);
    const personality = normalizeCodexPersonality(sessionSettings?.personality ?? null);
    const result = await client.startTurn({
      threadId: bridgeSession.codexThreadId,
      inputText: turnInput[0]?.type === 'text' ? turnInput[0].text : inputText,
      input: turnInput,
      cwd: bridgeSession.cwd ?? event.cwd ?? null,
      model: modelInfo?.model ?? null,
      effort,
      serviceTier: normalizeCodexServiceTier(sessionSettings?.serviceTier ?? null),
      personality,
      approvalPolicy: sessionSettings?.approvalPolicy ?? 'on-request',
      sandboxMode: sessionSettings?.sandboxMode ?? 'workspace-write',
      collaborationMode: normalizeCodexCollaborationMode(sessionSettings?.collaborationMode ?? null),
      developerInstructions,
      onProgress,
      onTurnStarted,
      onApprovalRequest,
    });
    return {
      outputText: result.outputText,
      outputArtifacts: normalizeOutputArtifacts(result),
      outputMedia: normalizeOutputMedia(result),
      outputState: result.outputState ?? 'complete',
      errorMessage: result.errorMessage ?? null,
      previewText: result.previewText ?? '',
      finalSource: result.finalSource ?? 'thread_items',
      status: result.status ?? null,
      turnId: result.turnId ?? null,
      threadId: result.threadId,
      title: result.title ?? bridgeSession.title,
    };
  }

  async startReview({
    providerProfile,
    bridgeSession = null,
    sessionSettings,
    cwd,
    target,
    locale = null,
    onTurnStarted = null,
  }: {
    providerProfile: ProviderProfile;
    bridgeSession?: BridgeSession | null;
    sessionSettings: SessionSettings | null;
    cwd: string;
    target: ProviderReviewTarget;
    locale?: string | null;
    onProgress?: ((progress: ProviderTurnProgress) => Promise<void> | void) | null;
    onTurnStarted?: ((meta: Record<string, unknown>) => Promise<void> | void) | null;
    onApprovalRequest?: ((request: ProviderApprovalRequest) => Promise<void> | void) | null;
  }): Promise<ProviderTurnResult> {
    const requestedModel = sessionSettings?.model ?? null;
    const config = providerProfile.config as CodexProviderProfileConfig;
    const effort = sessionSettings?.reasoningEffort ?? null;
    const model = requestedModel || config.defaultModel || null;
    return this.reviewRunner.start({
      codexCliBin: config.cliBin,
      cwd,
      model,
      effort,
      serviceTier: normalizeCodexServiceTier(sessionSettings?.serviceTier ?? null),
      target,
      locale,
      onTurnStarted: async (meta: { threadId: string; turnId: string }) => {
        if (typeof onTurnStarted === 'function') {
          await onTurnStarted({
            ...meta,
            bridgeSessionId: bridgeSession?.id ?? null,
            providerProfileId: providerProfile.id,
          });
        }
      },
    });
  }

  async interruptTurn({
    providerProfile,
    threadId,
    turnId,
  }: {
    providerProfile: ProviderProfile;
    threadId: string;
    turnId: string;
  }): Promise<void> {
    if (await this.reviewRunner?.interrupt?.(turnId)) {
      return;
    }
    const client = await this.ensureClient(providerProfile);
    return client.interruptTurn({ threadId, turnId });
  }

  async respondToApproval({
    providerProfile,
    request,
    option,
  }: {
    providerProfile: ProviderProfile;
    request: ProviderApprovalRequest;
    option: 1 | 2 | 3;
  }): Promise<void> {
    const client = await this.ensureClient(providerProfile);
    await client.respondToApproval({
      requestId: request.requestId,
      option,
    });
  }

  async listModels({
    providerProfile,
  }: {
    providerProfile: ProviderProfile;
  }): Promise<ProviderModelInfo[]> {
    const client = await this.ensureClient(providerProfile);
    return client.listModels();
  }

  async getUsage({
    providerProfile,
  }: {
    providerProfile: ProviderProfile;
  }): Promise<ProviderUsageReport | null> {
    const client = await this.ensureClient(providerProfile);
    let report = null;
    if (typeof client.readUsage === 'function') {
      try {
        report = await client.readUsage();
      } catch {
        report = null;
      }
    }
    const identity = readCodexAccountIdentity();
    if (!report && !identity) {
      return null;
    }
    return {
      provider: report?.provider ?? 'codex',
      accountId: report?.accountId ?? identity?.accountId ?? null,
      userId: report?.userId ?? null,
      email: report?.email ?? identity?.email ?? null,
      plan: report?.plan ?? null,
      buckets: Array.isArray(report?.buckets) ? report.buckets : [],
      credits: report?.credits ?? null,
    };
  }

  async listSkills({
    providerProfile,
    cwd = null,
    forceReload = false,
  }: {
    providerProfile: ProviderProfile;
    cwd?: string | null;
    forceReload?: boolean;
  }): Promise<ProviderSkillsListResult> {
    const client = await this.ensureClient(providerProfile);
    return client.listSkills({
      cwd,
      forceReload,
    });
  }

  async listPlugins({
    providerProfile,
    cwd = null,
  }: {
    providerProfile: ProviderProfile;
    cwd?: string | null;
  }): Promise<ProviderPluginsListResult> {
    const client = await this.ensureClient(providerProfile);
    return client.listPlugins({ cwd });
  }

  async readPlugin({
    providerProfile,
    pluginName,
    marketplaceName = null,
    marketplacePath = null,
  }: {
    providerProfile: ProviderProfile;
    pluginName: string;
    marketplaceName?: string | null;
    marketplacePath?: string | null;
  }): Promise<ProviderPluginDetail | null> {
    const client = await this.ensureClient(providerProfile);
    return client.readPlugin({
      pluginName,
      marketplaceName,
      marketplacePath,
    });
  }

  async installPlugin({
    providerProfile,
    pluginName,
    marketplaceName = null,
    marketplacePath = null,
  }: {
    providerProfile: ProviderProfile;
    pluginName: string;
    marketplaceName?: string | null;
    marketplacePath?: string | null;
  }): Promise<ProviderPluginInstallResult> {
    const client = await this.ensureClient(providerProfile);
    return client.installPlugin({
      pluginName,
      marketplaceName,
      marketplacePath,
    });
  }

  async uninstallPlugin({
    providerProfile,
    pluginId,
  }: {
    providerProfile: ProviderProfile;
    pluginId: string;
  }): Promise<void> {
    const client = await this.ensureClient(providerProfile);
    await client.uninstallPlugin({ pluginId });
  }

  async listApps({
    providerProfile,
  }: {
    providerProfile: ProviderProfile;
  }): Promise<ProviderAppInfo[]> {
    const client = await this.ensureClient(providerProfile);
    return client.listApps();
  }

  async listMcpServerStatuses({
    providerProfile,
  }: {
    providerProfile: ProviderProfile;
  }): Promise<ProviderMcpServerStatus[]> {
    const client = await this.ensureClient(providerProfile);
    return client.listMcpServerStatuses();
  }

  async setAppEnabled({
    providerProfile,
    appId,
    enabled,
  }: {
    providerProfile: ProviderProfile;
    appId: string;
    enabled: boolean;
  }): Promise<void> {
    const client = await this.ensureClient(providerProfile);
    await client.setAppEnabled({
      appId,
      enabled,
    });
  }

  async setMcpServerEnabled({
    providerProfile,
    name,
    enabled,
  }: {
    providerProfile: ProviderProfile;
    name: string;
    enabled: boolean;
  }): Promise<void> {
    const client = await this.ensureClient(providerProfile);
    await client.setMcpServerEnabled({
      name,
      enabled,
    });
  }

  async startMcpServerOauthLogin({
    providerProfile,
    name,
    scopes = null,
    timeoutSecs = null,
  }: {
    providerProfile: ProviderProfile;
    name: string;
    scopes?: string[] | null;
    timeoutSecs?: number | null;
  }): Promise<ProviderMcpOauthLoginResult> {
    const client = await this.ensureClient(providerProfile);
    return client.startMcpServerOauthLogin({
      name,
      scopes,
      timeoutSecs,
    });
  }

  async reloadMcpServers({
    providerProfile,
  }: {
    providerProfile: ProviderProfile;
  }): Promise<void> {
    const client = await this.ensureClient(providerProfile);
    await client.reloadMcpServers();
  }

  async setSkillEnabled({
    providerProfile,
    enabled,
    name = null,
    path = null,
  }: {
    providerProfile: ProviderProfile;
    enabled: boolean;
    name?: string | null;
    path?: string | null;
  }): Promise<void> {
    const client = await this.ensureClient(providerProfile);
    await client.setSkillEnabled({
      enabled,
      name,
      path,
    });
  }

  getClient(profileId: string): any {
    return this.clients.get(profileId) ?? null;
  }

  async ensureClient(providerProfile: ProviderProfile): Promise<any> {
    let client = this.clients.get(providerProfile.id) ?? null;
    if (!client) {
      client = this.clientFactory(providerProfile as CodexProviderProfile);
      this.clients.set(providerProfile.id, client);
    }
    await client.start();
    return client;
  }

  async resolveModelInfo(
    providerProfile: ProviderProfile,
    client: any,
    requestedModel: string | null,
  ): Promise<ProviderModelInfo | null> {
    if (requestedModel) {
      return {
        id: requestedModel,
        model: requestedModel,
        displayName: requestedModel,
        description: '',
        isDefault: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
      };
    }
    const config = providerProfile.config as CodexProviderProfileConfig;
    if (config.defaultModel) {
      return {
        id: config.defaultModel,
        model: config.defaultModel,
        displayName: config.defaultModel,
        description: '',
        isDefault: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
      };
    }
    const models = await client.listModels();
    return models.find((model) => model.isDefault)
      ?? models[0]
      ?? null;
  }

  resolveReasoningEffort(modelInfo: ProviderModelInfo | null, requestedEffort: string | null): string | null {
    if (requestedEffort) {
      return requestedEffort;
    }
    return modelInfo?.defaultReasoningEffort ?? null;
  }
}

function buildCodexTurnInput(event: InboundTextEvent, inputText: string): CodexTurnInput[] {
  const attachments = Array.isArray(event.attachments) ? event.attachments : [];
  const normalizedInputText = String(inputText ?? '').trim();
  if (attachments.length === 0) {
    return [{
      type: 'text',
      text: normalizedInputText,
      text_elements: [],
    }];
  }

  const textPrompt = shouldReuseAttachmentPrompt(normalizedInputText)
    ? normalizedInputText
    : buildAttachmentPrompt(normalizedInputText, attachments);
  const input: CodexTurnInput[] = [{
    type: 'text',
    text: textPrompt,
    text_elements: [],
  }];
  for (const attachment of attachments) {
    if (attachment.kind !== 'image') {
      continue;
    }
    input.push({
      type: 'localImage',
      path: attachment.localPath,
    });
  }
  return input;
}

function shouldReuseAttachmentPrompt(inputText: string): boolean {
  return /we(chat|ixin) attachments:/iu.test(inputText);
}

function buildAttachmentPrompt(userText: string, attachments: readonly InboundAttachment[]): string {
  const normalizedText = String(userText ?? '').trim();
  const lines: string[] = [];
  if (normalizedText) {
    lines.push(normalizedText, '');
  } else {
    lines.push('User sent Weixin attachments without additional text.', '');
  }
  lines.push('Weixin attachments:');
  attachments.forEach((attachment, index) => {
    lines.push(`${index + 1}. ${describeAttachment(attachment)}`);
    lines.push(`   path: ${attachment.localPath}`);
    if (attachment.fileName) {
      lines.push(`   filename: ${attachment.fileName}`);
    }
    if (attachment.mimeType) {
      lines.push(`   mime: ${attachment.mimeType}`);
    }
    if (typeof attachment.durationSeconds === 'number' && Number.isFinite(attachment.durationSeconds)) {
      lines.push(`   duration_seconds: ${attachment.durationSeconds}`);
    }
    if (attachment.transcriptText) {
      lines.push(`   transcript_hint: ${attachment.transcriptText}`);
    }
    if (attachment.kind === 'image') {
      lines.push('   attached_as: localImage');
    }
  });
  lines.push('', 'Use the local file paths above when you inspect these attachments.');
  return lines.join('\n');
}

function describeAttachment(attachment: InboundAttachment): string {
  switch (attachment.kind) {
    case 'image':
      return 'image';
    case 'voice':
      return 'voice message';
    case 'file':
      return 'file';
    case 'video':
      return 'video';
    default:
      return 'attachment';
  }
}

function buildDeveloperInstructions(event: InboundTextEvent): string {
  const parts: string[] = [];
  const artifactContext = resolveTurnArtifactContext(event);
  const artifactInstructions = buildTurnArtifactDeveloperInstructions(artifactContext);
  if (artifactInstructions) {
    parts.push(artifactInstructions);
  }
  const retryInstructions = buildRetryDeveloperInstructions(resolveRetryContext(event));
  if (retryInstructions) {
    parts.push(retryInstructions);
  }
  const explicitPluginInstructions = buildExplicitPluginDeveloperInstructions(resolveExplicitPluginTargets(event));
  if (explicitPluginInstructions) {
    parts.push(explicitPluginInstructions);
  }
  return parts.filter(Boolean).join('\n\n');
}

function normalizeCodexPersonality(value: unknown): 'friendly' | 'pragmatic' | 'none' | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'friendly' || normalized === 'pragmatic' || normalized === 'none') {
    return normalized;
  }
  return null;
}

function resolveTurnArtifactContext(event: InboundTextEvent): TurnArtifactContext | null {
  const metadata = event?.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }
  const codexbridge = (metadata as Record<string, unknown>).codexbridge;
  if (!codexbridge || typeof codexbridge !== 'object') {
    return null;
  }
  const context = (codexbridge as Record<string, unknown>).turnArtifactContext;
  if (!context || typeof context !== 'object') {
    return null;
  }
  return context as TurnArtifactContext;
}

function resolveRetryContext(event: InboundTextEvent): Record<string, unknown> | null {
  const metadata = event?.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }
  const codexbridge = (metadata as Record<string, unknown>).codexbridge;
  if (!codexbridge || typeof codexbridge !== 'object') {
    return null;
  }
  const context = (codexbridge as Record<string, unknown>).retryContext;
  if (!context || typeof context !== 'object') {
    return null;
  }
  return context as Record<string, unknown>;
}

function resolveExplicitPluginTargets(event: InboundTextEvent): Record<string, unknown>[] {
  const metadata = event?.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return [];
  }
  const codexbridge = (metadata as Record<string, unknown>).codexbridge;
  if (!codexbridge || typeof codexbridge !== 'object') {
    return [];
  }
  const targets = (codexbridge as Record<string, unknown>).explicitPluginTargets;
  if (Array.isArray(targets)) {
    return targets.filter((entry) => entry && typeof entry === 'object') as Record<string, unknown>[];
  }
  const target = (codexbridge as Record<string, unknown>).explicitPluginTarget;
  if (!target || typeof target !== 'object') {
    return [];
  }
  return [target as Record<string, unknown>];
}

function buildRetryDeveloperInstructions(retryContext: Record<string, unknown> | null): string {
  if (!retryContext) {
    return '';
  }
  const stoppedAt = typeof retryContext.stoppedAt === 'number'
    ? new Date(retryContext.stoppedAt).toISOString()
    : null;
  const threadId = typeof retryContext.threadId === 'string' && retryContext.threadId.trim()
    ? retryContext.threadId.trim()
    : null;
  const interruptedTurnIds = Array.isArray(retryContext.interruptedTurnIds)
    ? retryContext.interruptedTurnIds
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter(Boolean)
    : [];
  const pendingApprovalCount = typeof retryContext.pendingApprovalCount === 'number'
    ? retryContext.pendingApprovalCount
    : 0;
  const interruptErrors = Array.isArray(retryContext.interruptErrors)
    ? retryContext.interruptErrors
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter(Boolean)
    : [];
  const lines = [
    'Retry context from CodexBridge:',
    '- This request is being retried on the same Codex thread after the previous attempt was manually stopped.',
  ];
  if (threadId) {
    lines.push(`- Thread id: ${threadId}`);
  }
  if (stoppedAt) {
    lines.push(`- Stop requested at: ${stoppedAt}`);
  }
  if (interruptedTurnIds.length > 0) {
    lines.push(`- Interrupted turn ids: ${interruptedTurnIds.join(', ')}`);
  }
  if (pendingApprovalCount > 0) {
    lines.push(`- Pending approval requests discarded during stop: ${pendingApprovalCount}`);
  }
  if (interruptErrors.length > 0) {
    lines.push(`- Interrupt errors observed: ${interruptErrors.join(' | ')}`);
  }
  lines.push('- Continue from the existing thread context when it helps, but answer the user request fully from scratch if needed.');
  return lines.join('\n');
}

function buildExplicitPluginDeveloperInstructions(targets: Record<string, unknown>[]): string {
  if (!Array.isArray(targets) || targets.length === 0) {
    return '';
  }
  const normalizedTargets = targets
    .map((target) => {
      const pluginId = typeof target.pluginId === 'string' ? target.pluginId.trim() : '';
      const pluginName = typeof target.pluginName === 'string' ? target.pluginName.trim() : '';
      const pluginDisplayName = typeof target.pluginDisplayName === 'string' ? target.pluginDisplayName.trim() : '';
      const alias = typeof target.alias === 'string' ? target.alias.trim() : '';
      const syntax = typeof target.syntax === 'string' ? target.syntax.trim() : '';
      const pluginLabel = pluginDisplayName || pluginName || pluginId;
      if (!pluginLabel) {
        return null;
      }
      return {
        pluginId,
        pluginLabel,
        alias,
        syntax,
      };
    })
    .filter(Boolean) as Array<{
      pluginId: string;
      pluginLabel: string;
      alias: string;
      syntax: string;
    }>;
  if (normalizedTargets.length === 0) {
    return '';
  }
  const lines = [
    'CodexBridge plugin targeting hints:',
    '- The user explicitly requested this turn to prefer the following plugins, in this order:',
  ];
  normalizedTargets.forEach((target, index) => {
    const details = [
      target.pluginId ? `id=${target.pluginId}` : '',
      target.alias ? `alias=${target.alias}` : '',
      target.syntax ? `syntax=${target.syntax}` : '',
    ].filter(Boolean).join(', ');
    lines.push(`${index + 1}. ${target.pluginLabel}${details ? ` (${details})` : ''}`);
  });
  lines.push('- Use one or more of these plugins when they are relevant to the requested workflow.');
  lines.push('- If the request describes multiple steps, map each step to the most relevant plugin instead of forcing everything through one plugin.');
  lines.push('- If auth, installation, or access is missing, explain that constraint briefly and continue with the best fallback only if appropriate.');
  return lines.join('\n');
}

function normalizeOutputArtifacts(result: ProviderTurnResult) {
  const direct = Array.isArray(result?.outputArtifacts) ? result.outputArtifacts : [];
  if (direct.length > 0) {
    return direct.map((artifact) => ({
      ...artifact,
      source: artifact.source ?? 'provider_native',
      turnId: artifact.turnId ?? result?.turnId ?? null,
    }));
  }
  return normalizeOutputMedia(result);
}

function normalizeOutputMedia(result: ProviderTurnResult) {
  const direct = Array.isArray(result?.outputArtifacts) ? result.outputArtifacts : [];
  if (direct.length > 0) {
    return direct
      .filter((artifact) => artifact?.kind === 'image')
      .map((artifact) => ({
        kind: 'image' as const,
        path: artifact.path,
        caption: artifact.caption ?? null,
      }));
  }
  return Array.isArray(result?.outputMedia) ? result.outputMedia : [];
}

function normalizeCodexServiceTier(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) {
    return null;
  }
  if (normalized === 'priority') {
    return 'fast';
  }
  if (normalized === 'default') {
    return 'flex';
  }
  return normalized;
}

function normalizeCodexCollaborationMode(value: string | null | undefined): 'default' | 'plan' {
  return String(value ?? '').trim().toLowerCase() === 'plan' ? 'plan' : 'default';
}
