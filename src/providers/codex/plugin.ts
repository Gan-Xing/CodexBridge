import { CodexAppClient, createNoopLogger, readCodexAccountIdentity } from './app_client.js';
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

type CodexClientLike = any;
type CodexModelInfo = any;

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
    const result = await client.startTurn({
      threadId: bridgeSession.codexThreadId,
      inputText,
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
  }): Promise<any[]> {
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
  ): Promise<CodexModelInfo | null> {
    if (requestedModel) {
      return { model: requestedModel, defaultReasoningEffort: null };
    }
    const config = providerProfile.config as CodexProviderProfileConfig;
    if (config.defaultModel) {
      return { model: config.defaultModel, defaultReasoningEffort: null };
    }
    const models = await client.listModels();
    return models.find((model) => model.isDefault)
      ?? models[0]
      ?? null;
  }

  resolveReasoningEffort(modelInfo: CodexModelInfo | null, requestedEffort: string | null): string | null {
    if (requestedEffort) {
      return requestedEffort;
    }
    return modelInfo?.defaultReasoningEffort ?? null;
  }
}
