import { CodexAppClient, createNoopLogger, readCodexAccountIdentity } from './app_client.js';

export class CodexProviderPlugin {
  constructor({
    clientFactory = (profile) => new CodexAppClient({
      codexCliBin: profile.config.cliBin,
      launchCommand: profile.config.launchCommand ?? null,
      autolaunch: profile.config.autolaunch ?? false,
      modelCatalog: profile.config.modelCatalog ?? [],
      modelCatalogMode: profile.config.modelCatalogMode ?? 'merge',
      logger: createNoopLogger(),
    }),
  } = {}) {
    this.kind = 'codex';
    this.displayName = 'Codex Engine';
    this.clientFactory = clientFactory;
    this.clients = new Map();
  }

  async startThread({ providerProfile, cwd, title }) {
    const client = await this.ensureClient(providerProfile);
    const modelInfo = await this.resolveModelInfo(providerProfile, client, null);
    return client.startThread({
      cwd,
      title,
      model: modelInfo?.model ?? null,
    });
  }

  async readThread({ providerProfile, threadId, includeTurns = false }) {
    const client = await this.ensureClient(providerProfile);
    return client.readThread(threadId, includeTurns);
  }

  async listThreads({ providerProfile, limit = 20, cursor = null, searchTerm = null }) {
    const client = await this.ensureClient(providerProfile);
    return client.listThreads({ limit, cursor, searchTerm });
  }

  async resumeThread({ providerProfile, threadId }) {
    const client = await this.ensureClient(providerProfile);
    return client.resumeThread({ threadId });
  }

  async reconnectProfile({ providerProfile }) {
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
  }) {
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

  async interruptTurn({ providerProfile, threadId, turnId }) {
    const client = await this.ensureClient(providerProfile);
    return client.interruptTurn({ threadId, turnId });
  }

  async listModels({ providerProfile }) {
    const client = await this.ensureClient(providerProfile);
    return client.listModels();
  }

  getClient(profileId) {
    return this.clients.get(profileId) ?? null;
  }

  async ensureClient(providerProfile) {
    let client = this.clients.get(providerProfile.id) ?? null;
    if (!client) {
      client = this.clientFactory(providerProfile);
      this.clients.set(providerProfile.id, client);
    }
    await client.start();
    return client;
  }

  async resolveModelInfo(providerProfile, client, requestedModel) {
    if (requestedModel) {
      return { model: requestedModel, defaultReasoningEffort: null };
    }
    if (providerProfile.config.defaultModel) {
      return { model: providerProfile.config.defaultModel, defaultReasoningEffort: null };
    }
    const models = await client.listModels();
    return models.find((model) => model.isDefault)
      ?? models[0]
      ?? null;
  }

  resolveReasoningEffort(modelInfo, requestedEffort) {
    if (requestedEffort) {
      return requestedEffort;
    }
    return modelInfo?.defaultReasoningEffort ?? null;
  }
}
