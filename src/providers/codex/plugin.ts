import { CodexAppClient, createNoopLogger, readCodexAccountIdentity } from './app_client.js';
import type { CodexTurnInput } from './app_client.js';
import type { BridgeSession, SessionSettings } from '../../types/core.js';
import type { InboundAttachment, InboundTextEvent } from '../../types/platform.js';
import type {
  ProviderProfile,
  ProviderThreadListResult,
  ProviderThreadStartResult,
  ProviderThreadSummary,
  ProviderTurnProgress,
  ProviderTurnResult,
  ProviderModelInfo,
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
}

export class CodexProviderPlugin {
  kind: string;

  displayName: string;

  clientFactory: any;

  clients: Map<string, any>;

  constructor({
    clientFactory = (profile) => new CodexAppClient({
      codexCliBin: profile.config.cliBin,
      launchCommand: profile.config.launchCommand ?? null,
      autolaunch: profile.config.autolaunch ?? false,
      modelCatalog: profile.config.modelCatalog ?? [],
      modelCatalogMode: profile.config.modelCatalogMode ?? 'merge',
      logger: createNoopLogger(),
    }),
  }: CodexProviderPluginOptions = {}) {
    this.kind = 'codex';
    this.displayName = 'Codex Engine';
    this.clientFactory = clientFactory;
    this.clients = new Map();
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
  }: {
    providerProfile: ProviderProfile;
    bridgeSession: BridgeSession;
    sessionSettings: SessionSettings | null;
    event: InboundTextEvent;
    inputText: string;
    onProgress?: ((progress: ProviderTurnProgress) => Promise<void> | void) | null;
    onTurnStarted?: ((meta: Record<string, unknown>) => Promise<void> | void) | null;
  }): Promise<ProviderTurnResult> {
    const client = await this.ensureClient(providerProfile);
    const modelInfo = await this.resolveModelInfo(providerProfile, client, sessionSettings?.model ?? null);
    const effort = this.resolveReasoningEffort(modelInfo, sessionSettings?.reasoningEffort ?? null);
    const turnInput = buildCodexTurnInput(event, inputText);
    const result = await client.startTurn({
      threadId: bridgeSession.codexThreadId,
      inputText: turnInput[0]?.type === 'text' ? turnInput[0].text : inputText,
      input: turnInput,
      cwd: bridgeSession.cwd ?? event.cwd ?? null,
      model: modelInfo?.model ?? null,
      effort,
      serviceTier: sessionSettings?.serviceTier ?? null,
      approvalPolicy: sessionSettings?.approvalPolicy ?? 'on-request',
      sandboxMode: sessionSettings?.sandboxMode ?? 'workspace-write',
      collaborationMode: 'default',
      developerInstructions: process.env.CODEXBRIDGE_CODEX_DEVELOPER_INSTRUCTIONS ?? '',
      onProgress,
      onTurnStarted,
    });
    return {
      outputText: result.outputText,
      outputState: result.outputState ?? 'complete',
      previewText: result.previewText ?? '',
      finalSource: result.finalSource ?? 'thread_items',
      turnId: result.turnId ?? null,
      threadId: result.threadId,
      title: result.title ?? bridgeSession.title,
    };
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
    const client = await this.ensureClient(providerProfile);
    return client.interruptTurn({ threadId, turnId });
  }

  async listModels({
    providerProfile,
  }: {
    providerProfile: ProviderProfile;
  }): Promise<ProviderModelInfo[]> {
    const client = await this.ensureClient(providerProfile);
    return client.listModels();
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
