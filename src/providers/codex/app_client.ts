import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeSequencedStderrLine } from '../../core/sequenced_stderr.js';
import { readCodexAccountIdentity } from './auth_state.js';
import type {
  ProviderAppInfo,
  ProviderApprovalRequest,
  ProviderMcpServerStatus,
  ProviderMcpOauthLoginResult,
  ProviderPluginDetail,
  ProviderPluginInstallResult,
  ProviderPluginLoadError,
  ProviderPluginMarketplace,
  ProviderPluginsListResult,
  ProviderPluginSummary,
  ProviderSkillError,
  ProviderSkillInfo,
  ProviderPluginAppSummary,
  ProviderPluginSkillSummary,
  ProviderSkillsListResult,
  ProviderSkillToolDependency,
  ProviderUsageReport,
  ProviderThreadListResult,
  ProviderThreadStartResult,
  ProviderThreadSummary,
  ProviderTurnProgress,
  ProviderTurnResult,
} from '../../types/provider.js';

const APP_SERVER_CONNECT_TIMEOUT_MS = 20_000;

interface CodexAppLogger {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

interface CodexClientInfo {
  name: string;
  title: string;
  version: string;
}

interface CodexModelInfo {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string | null;
}

interface CodexAppRateLimitsResponse {
  rateLimits?: CodexAppRateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, CodexAppRateLimitSnapshot> | null;
}

interface CodexAppRateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  planType?: string | null;
  primary?: CodexAppRateLimitWindow | null;
  secondary?: CodexAppRateLimitWindow | null;
  credits?: CodexAppCreditsSnapshot | null;
}

interface CodexAppRateLimitWindow {
  usedPercent?: number | null;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

interface CodexAppCreditsSnapshot {
  balance?: string | null;
  hasCredits?: boolean | null;
  unlimited?: boolean | null;
}

interface CodexAppSkillToolDependency {
  type?: string | null;
  value?: string | null;
  command?: string | null;
  description?: string | null;
  transport?: string | null;
  url?: string | null;
}

interface CodexAppSkillInterface {
  displayName?: string | null;
  defaultPrompt?: string | null;
  shortDescription?: string | null;
  brandColor?: string | null;
}

interface CodexAppSkillMetadata {
  name?: string | null;
  description?: string | null;
  enabled?: boolean | null;
  path?: string | null;
  scope?: string | null;
  shortDescription?: string | null;
  interface?: CodexAppSkillInterface | null;
  dependencies?: {
    tools?: CodexAppSkillToolDependency[] | null;
  } | null;
}

interface CodexAppSkillErrorInfo {
  path?: string | null;
  message?: string | null;
}

interface CodexAppSkillsListEntry {
  cwd?: string | null;
  errors?: CodexAppSkillErrorInfo[] | null;
  skills?: CodexAppSkillMetadata[] | null;
}

interface CodexAppPluginInterface {
  brandColor?: string | null;
  capabilities?: string[] | null;
  category?: string | null;
  defaultPrompt?: string[] | null;
  developerName?: string | null;
  displayName?: string | null;
  longDescription?: string | null;
  shortDescription?: string | null;
  websiteUrl?: string | null;
}

interface CodexAppPluginSourceLocal {
  type?: 'local' | string | null;
  path?: string | null;
}

interface CodexAppPluginSourceMarketplace {
  type?: 'marketplace' | string | null;
  marketplaceName?: string | null;
}

type CodexAppPluginSource = CodexAppPluginSourceLocal | CodexAppPluginSourceMarketplace | null;

interface CodexAppPluginSummary {
  id?: string | null;
  name?: string | null;
  installed?: boolean | null;
  enabled?: boolean | null;
  installPolicy?: string | null;
  authPolicy?: string | null;
  interface?: CodexAppPluginInterface | null;
  source?: CodexAppPluginSource;
}

interface CodexAppPluginMarketplace {
  name?: string | null;
  path?: string | null;
  interface?: {
    displayName?: string | null;
  } | null;
  plugins?: CodexAppPluginSummary[] | null;
}

interface CodexAppMarketplaceLoadError {
  marketplacePath?: string | null;
  message?: string | null;
}

interface CodexAppPluginListResponse {
  featuredPluginIds?: string[] | null;
  marketplaceLoadErrors?: CodexAppMarketplaceLoadError[] | null;
  marketplaces?: CodexAppPluginMarketplace[] | null;
}

interface CodexAppPluginAppSummary {
  id?: string | null;
  name?: string | null;
  needsAuth?: boolean | null;
  description?: string | null;
  installUrl?: string | null;
}

interface CodexAppPluginSkillInterface {
  displayName?: string | null;
}

interface CodexAppPluginSkillSummary {
  name?: string | null;
  path?: string | null;
  description?: string | null;
  enabled?: boolean | null;
  shortDescription?: string | null;
  interface?: CodexAppPluginSkillInterface | null;
}

interface CodexAppPluginDetail {
  summary?: CodexAppPluginSummary | null;
  marketplaceName?: string | null;
  marketplacePath?: string | null;
  description?: string | null;
  apps?: CodexAppPluginAppSummary[] | null;
  mcpServers?: string[] | null;
  skills?: CodexAppPluginSkillSummary[] | null;
}

interface CodexAppPluginInstallResponse {
  authPolicy?: string | null;
  appsNeedingAuth?: CodexAppPluginAppSummary[] | null;
}

interface CodexAppInfo {
  id?: string | null;
  name?: string | null;
  description?: string | null;
  installUrl?: string | null;
  isAccessible?: boolean | null;
  isEnabled?: boolean | null;
  pluginDisplayNames?: string[] | null;
  appMetadata?: {
    categories?: string[] | null;
    developer?: string | null;
  } | null;
  branding?: {
    developer?: string | null;
  } | null;
}

interface CodexAppMcpServerStatus {
  name?: string | null;
  isEnabled?: boolean | null;
  authStatus?: string | null;
  resourceTemplates?: unknown[] | null;
  resources?: unknown[] | null;
  tools?: Record<string, unknown> | null;
}

interface CodexAppMcpOauthLoginResponse {
  authorizationUrl?: string | null;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

interface PendingApproval {
  rpcId: string;
  transportKind: 'v2_command' | 'v2_file_change' | 'v2_permissions' | 'legacy_exec' | 'legacy_apply_patch';
  request: ProviderApprovalRequest;
}

interface ApprovedExecution {
  requestId: string;
  kind: ProviderApprovalRequest['kind'];
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  command: string | null;
  approvedAt: number;
  lastSignalAt: number;
  lastSignalKind: string;
  signalCount: number;
  completedAt: number | null;
  lastObservedTurnSnapshotKey: string | null;
}

interface ProgressState {
  commentaryText: string;
  finalAnswerText: string;
  sawAssistantActivity: boolean;
  lastAssistantActivityAt: number;
}

interface CodexAppClientOptions {
  codexCliBin: string;
  launchCommand?: string | null;
  autolaunch?: boolean;
  modelCatalog?: CodexModelInfo[];
  modelCatalogMode?: 'merge' | 'overlay-only';
  enabledFeatures?: string[];
  clientInfo?: CodexClientInfo;
  spawnImpl?: typeof spawn;
  webSocketFactory?: (url: string) => WebSocket;
  platform?: NodeJS.Platform;
  logger?: CodexAppLogger;
  turnPollSleep?: (ms: number) => Promise<void>;
  turnPollNow?: () => number;
}

export interface CodexTextTurnInput {
  type: 'text';
  text: string;
  text_elements: [];
}

export interface CodexLocalImageTurnInput {
  type: 'localImage';
  path: string;
}

export type CodexTurnInput = CodexTextTurnInput | CodexLocalImageTurnInput;

export class CodexAppClient extends EventEmitter {
  codexCliBin: string;

  launchCommand: string | null;

  autolaunch: boolean;

  modelCatalog: CodexModelInfo[];

  modelCatalogMode: 'merge' | 'overlay-only';

  enabledFeatures: string[];

  clientInfo: CodexClientInfo;

  spawnImpl: typeof spawn;

  webSocketFactory: (url: string) => WebSocket;

  platform: NodeJS.Platform;

  logger: CodexAppLogger;

  turnPollSleep: (ms: number) => Promise<void>;

  turnPollNow: () => number;

  child: ChildProcess | null;

  socket: WebSocket | null;

  pending: Map<string, PendingRequest>;

  pendingApprovals: Map<string, PendingApproval>;

  approvedExecutions: Map<string, ApprovedExecution>;

  requestId: number;

  port: number | null;

  connected: boolean;

  startPromise: Promise<void> | null;

  childStartError: Error | null;

  childStderrTail: string[];

  constructor({
    codexCliBin,
    launchCommand = null,
    autolaunch = false,
    modelCatalog = [],
    modelCatalogMode = 'merge',
    enabledFeatures = ['image_generation'],
    clientInfo = {
      name: 'codexbridge',
      title: 'CodexBridge',
      version: '0.1.0',
    },
    spawnImpl = spawn,
    webSocketFactory = (url) => new WebSocket(url),
    platform = process.platform,
    logger = createNoopLogger(),
    turnPollSleep = sleep,
    turnPollNow = () => Date.now(),
  }: CodexAppClientOptions) {
    super();
    this.codexCliBin = codexCliBin;
    this.launchCommand = launchCommand;
    this.autolaunch = autolaunch;
    this.modelCatalog = modelCatalog;
    this.modelCatalogMode = modelCatalogMode;
    this.enabledFeatures = normalizeFeatureList(enabledFeatures);
    this.clientInfo = clientInfo;
    this.spawnImpl = spawnImpl;
    this.webSocketFactory = webSocketFactory;
    this.platform = platform;
    this.logger = logger;
    this.turnPollSleep = turnPollSleep;
    this.turnPollNow = turnPollNow;

    this.child = null;
    this.socket = null;
    this.pending = new Map();
    this.pendingApprovals = new Map();
    this.approvedExecutions = new Map();
    this.requestId = 0;
    this.port = null;
    this.connected = false;
    this.startPromise = null;
    this.childStartError = null;
    this.childStderrTail = [];
  }

  logDebug(event: string, payload: unknown = null): void {
    try {
      this.logger.debug?.(`[codex-app] ${event} ${JSON.stringify(payload)}`);
    } catch {
      this.logger.debug?.(`[codex-app] ${event}`);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    if (this.connected) {
      return;
    }
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    const task = this.startServer().finally(() => {
      if (this.startPromise === task) {
        this.startPromise = null;
      }
    });
    this.startPromise = task;
    await task;
  }

  async stop(): Promise<void> {
    this.connected = false;
    this.socket?.close();
    this.socket = null;
    this.childStartError = null;
    this.childStderrTail = [];
    const child = this.child;
    if (child && child.exitCode === null) {
      await terminateChildProcess(child, this.platform).catch(() => {});
    }
    this.child = null;
    this.pendingApprovals.clear();
    this.approvedExecutions.clear();
    this.rejectPending(new Error('Codex app client stopped'));
  }

  async listThreads({
    limit = 20,
    cursor = null,
    searchTerm = null,
    archived = false,
  }: {
    limit?: number;
    cursor?: string | null;
    searchTerm?: string | null;
    archived?: boolean;
  } = {}): Promise<ProviderThreadListResult> {
    const result: any = await this.request('thread/list', {
      limit,
      cursor,
      sortKey: 'updated_at',
      searchTerm,
      archived,
    }, { timeoutMs: 30_000 });
    const rows = Array.isArray(result?.data) ? result.data : [];
    return {
      items: rows.map(mapThreadSummary),
      nextCursor: typeof result?.nextCursor === 'string' ? result.nextCursor : null,
    };
  }

  async readThread(threadId: string, includeTurns = false): Promise<ProviderThreadSummary | null> {
    const result: any = await this.request('thread/read', { threadId, includeTurns }, { timeoutMs: 10_000 });
    return result?.thread ? mapThread(result.thread, includeTurns) : null;
  }

  async startThread({
    cwd = null,
    model = null,
    serviceTier = null,
    sandboxMode = 'workspace-write',
    approvalPolicy = 'on-request',
  }: {
    cwd?: string | null;
    model?: string | null;
    serviceTier?: string | null;
    sandboxMode?: string;
    approvalPolicy?: string;
  } = {}): Promise<ProviderThreadStartResult> {
    const result: any = await this.request('thread/start', {
      cwd,
      approvalPolicy,
      model,
      modelProvider: null,
      serviceTier,
      sandbox: sandboxMode,
      config: null,
      serviceName: null,
      baseInstructions: null,
      developerInstructions: null,
      personality: null,
      ephemeral: null,
      experimentalRawEvents: true,
      persistExtendedHistory: false,
    }, { timeoutMs: 30_000 });
    return {
      threadId: String(result.thread.id),
      cwd: result.cwd ? String(result.cwd) : null,
      title: result.thread?.name ? String(result.thread.name) : null,
    };
  }

  async resumeThread({ threadId }: { threadId: string }): Promise<unknown> {
    return this.request('thread/resume', {
      threadId,
      cwd: null,
      approvalPolicy: null,
      baseInstructions: null,
      developerInstructions: null,
      config: null,
      sandbox: null,
      model: null,
      modelProvider: null,
      personality: null,
      experimentalRawEvents: true,
      persistExtendedHistory: false,
    }, { timeoutMs: 30_000 });
  }

  async startTurn({
    threadId,
    inputText,
    input = null,
    cwd = null,
    model = null,
    effort = null,
    serviceTier = null,
    personality = null,
    sandboxMode = 'workspace-write',
    approvalPolicy = 'on-request',
    collaborationMode = 'default',
    developerInstructions = '',
    onProgress = null,
    onTurnStarted = null,
    onApprovalRequest = null,
    timeoutMs = 15 * 60 * 1000,
  }: {
    threadId: string;
    inputText: string;
    input?: CodexTurnInput[] | null;
    cwd?: string | null;
    model?: string | null;
    effort?: string | null;
    serviceTier?: string | null;
    personality?: string | null;
    sandboxMode?: string;
    approvalPolicy?: string;
    collaborationMode?: string;
    developerInstructions?: string;
    onProgress?: ((progress: ProviderTurnProgress) => Promise<void> | void) | null;
    onTurnStarted?: ((meta: Record<string, unknown>) => Promise<void> | void) | null;
    onApprovalRequest?: ((request: ProviderApprovalRequest) => Promise<void> | void) | null;
    timeoutMs?: number;
  }): Promise<ProviderTurnResult> {
    this.logDebug('turn_start_requested', {
      threadId,
      cwd,
      model,
      effort,
      serviceTier,
      personality,
      approvalPolicy,
      sandboxMode,
      collaborationMode,
      timeoutMs,
      inputCount: Array.isArray(input) ? input.length : 1,
      inputSummary: summarizeTurnInput(
        Array.isArray(input) && input.length > 0
          ? input
          : [{
            type: 'text',
            text: inputText,
            text_elements: [],
          }],
      ),
    });
    const result: any = await this.request('turn/start', {
      threadId,
      input: Array.isArray(input) && input.length > 0
        ? input
        : [{
          type: 'text',
          text: inputText,
          text_elements: [],
        }],
      cwd,
      approvalPolicy,
      sandboxPolicy: mapSandboxPolicy(sandboxMode),
      model,
      serviceTier,
      effort,
      summary: null,
      personality,
      outputSchema: null,
      collaborationMode: serializeCollaborationMode({
        collaborationMode,
        model,
        effort,
        developerInstructions,
      }),
    }, { timeoutMs: 30_000 });
    const turn = result?.turn;
    if (!turn?.id) {
      throw new Error('Codex turn/start returned no turn id');
    }
    this.logDebug('turn_start_acknowledged', {
      threadId,
      turnId: String(turn.id),
      status: String(turn.status ?? ''),
    });
    if (typeof onTurnStarted === 'function') {
      await onTurnStarted({
        turnId: String(turn.id),
        threadId,
      });
    }
    return this.waitForTurnResult({
      threadId,
      turnId: String(turn.id),
      onProgress,
      onApprovalRequest,
      timeoutMs,
    });
  }

  async interruptTurn({ threadId, turnId }: { threadId: string; turnId: string }): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 15_000 });
  }

  getPendingApprovals({
    threadId = null,
    turnId = null,
  }: {
    threadId?: string | null;
    turnId?: string | null;
  } = {}): ProviderApprovalRequest[] {
    return [...this.pendingApprovals.values()]
      .map((entry) => entry.request)
      .filter((entry) => {
        if (threadId && entry.threadId !== threadId) {
          return false;
        }
        if (turnId && entry.turnId !== turnId) {
          return false;
        }
        return true;
      });
  }

  async respondToApproval({
    requestId,
    option,
  }: {
    requestId: string;
    option: 1 | 2 | 3;
  }): Promise<void> {
    const pending = this.pendingApprovals.get(String(requestId)) ?? null;
    if (!pending) {
      throw new Error(`Unknown approval request: ${requestId}`);
    }
    const result = buildApprovalResponseResult(pending, option);
    const approvedExecution = createApprovedExecution(pending, option, this.turnPollNow());
    if (approvedExecution) {
      this.approvedExecutions.set(approvedExecution.requestId, approvedExecution);
    }
    try {
      this.send({
        jsonrpc: '2.0',
        id: pending.rpcId,
        result,
      });
    } catch (error) {
      if (approvedExecution) {
        this.approvedExecutions.delete(approvedExecution.requestId);
      }
      throw error;
    }
    this.pendingApprovals.delete(String(requestId));
    if (approvedExecution) {
      this.logDebug('approval_response_sent', summarizeApprovedExecution(approvedExecution));
    }
  }

  async listModels(): Promise<CodexModelInfo[]> {
    const models = [];
    let cursor = null;
    do {
      const result: any = await this.request('model/list', {
        cursor,
        limit: 100,
        includeHidden: false,
      }, { timeoutMs: 30_000 });
      const rows = Array.isArray(result?.data) ? result.data : [];
      models.push(...rows.map(mapModel));
      cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : null;
    } while (cursor);
    if (this.modelCatalogMode === 'overlay-only' && this.modelCatalog.length > 0) {
      return this.modelCatalog;
    }
    return mergeModelCatalog(models, this.modelCatalog);
  }

  async readUsage(): Promise<ProviderUsageReport | null> {
    const result = await this.request('account/rateLimits/read', {}, { timeoutMs: 15_000 });
    return mapAppServerRateLimits(result);
  }

  async listSkills({
    cwd = null,
    forceReload = false,
  }: {
    cwd?: string | null;
    forceReload?: boolean;
  } = {}): Promise<ProviderSkillsListResult> {
    const result: any = await this.request('skills/list', {
      cwds: cwd ? [cwd] : [],
      forceReload,
    }, { timeoutMs: 30_000 });
    const rows = Array.isArray(result?.data) ? result.data : [];
    const entry = rows.find((item: CodexAppSkillsListEntry) => normalizeNullableString(item?.cwd) === cwd)
      ?? rows[0]
      ?? null;
    return {
      cwd: normalizeNullableString(entry?.cwd) ?? cwd ?? null,
      skills: Array.isArray(entry?.skills) ? entry.skills.map(mapSkillMetadata).filter(Boolean) : [],
      errors: Array.isArray(entry?.errors) ? entry.errors.map(mapSkillErrorInfo).filter(Boolean) : [],
    };
  }

  async setSkillEnabled({
    enabled,
    name = null,
    path = null,
  }: {
    enabled: boolean;
    name?: string | null;
    path?: string | null;
  }): Promise<void> {
    await this.request('skills/config/write', {
      enabled,
      name,
      path,
    }, { timeoutMs: 30_000 });
  }

  async listPlugins({
    cwd = null,
  }: {
    cwd?: string | null;
  } = {}): Promise<ProviderPluginsListResult> {
    const result: CodexAppPluginListResponse = await this.request('plugin/list', {
      cwds: cwd ? [cwd] : [],
    }, { timeoutMs: 30_000 });
    return {
      featuredPluginIds: Array.isArray(result?.featuredPluginIds)
        ? result.featuredPluginIds.map((value) => String(value ?? '').trim()).filter(Boolean)
        : [],
      marketplaceLoadErrors: Array.isArray(result?.marketplaceLoadErrors)
        ? result.marketplaceLoadErrors.map(mapPluginLoadError).filter(Boolean) as ProviderPluginLoadError[]
        : [],
      marketplaces: Array.isArray(result?.marketplaces)
        ? result.marketplaces.map(mapPluginMarketplace).filter(Boolean) as ProviderPluginMarketplace[]
        : [],
    };
  }

  async readPlugin({
    pluginName,
    marketplaceName = null,
    marketplacePath = null,
  }: {
    pluginName: string;
    marketplaceName?: string | null;
    marketplacePath?: string | null;
  }): Promise<ProviderPluginDetail | null> {
    const params: Record<string, unknown> = {
      pluginName,
    };
    if (marketplacePath) {
      params.marketplacePath = marketplacePath;
    } else if (marketplaceName) {
      params.remoteMarketplaceName = marketplaceName;
    }
    const result: any = await this.request('plugin/read', params, { timeoutMs: 30_000 });
    return mapPluginDetail(result?.plugin ?? null, {
      marketplaceName,
      marketplacePath,
    });
  }

  async installPlugin({
    pluginName,
    marketplaceName = null,
    marketplacePath = null,
  }: {
    pluginName: string;
    marketplaceName?: string | null;
    marketplacePath?: string | null;
  }): Promise<ProviderPluginInstallResult> {
    const params: Record<string, unknown> = {
      pluginName,
    };
    if (marketplacePath) {
      params.marketplacePath = marketplacePath;
    } else if (marketplaceName) {
      params.remoteMarketplaceName = marketplaceName;
    }
    const result: CodexAppPluginInstallResponse = await this.request('plugin/install', params, { timeoutMs: 30_000 });
    return {
      authPolicy: normalizeNullableString(result?.authPolicy),
      appsNeedingAuth: Array.isArray(result?.appsNeedingAuth)
        ? result.appsNeedingAuth.map(mapPluginAppSummary).filter(Boolean) as ProviderPluginAppSummary[]
        : [],
    };
  }

  async uninstallPlugin({
    pluginId,
  }: {
    pluginId: string;
  }): Promise<void> {
    await this.request('plugin/uninstall', {
      pluginId,
    }, { timeoutMs: 30_000 });
  }

  async listApps(): Promise<ProviderAppInfo[]> {
    const apps = [];
    let cursor = null;
    do {
      const result: any = await this.request('app/list', {
        cursor,
        limit: 100,
      }, { timeoutMs: 30_000 });
      const rows = Array.isArray(result?.data) ? result.data : [];
      apps.push(...rows.map(mapAppInfo).filter(Boolean));
      cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : null;
    } while (cursor);
    return apps;
  }

  async listMcpServerStatuses(): Promise<ProviderMcpServerStatus[]> {
    const servers = [];
    let cursor = null;
    do {
      const result: any = await this.request('mcpServerStatus/list', {
        cursor,
        limit: 100,
      }, { timeoutMs: 30_000 });
      const rows = Array.isArray(result?.data) ? result.data : [];
      servers.push(...rows.map(mapMcpServerStatus).filter(Boolean));
      cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : null;
    } while (cursor);
    return servers;
  }

  async setAppEnabled({
    appId,
    enabled,
  }: {
    appId: string;
    enabled: boolean;
  }): Promise<void> {
    await this.writeConfigValue({
      keyPath: formatConfigKeyPath(['apps', appId, 'enabled']),
      value: enabled,
    });
  }

  async setMcpServerEnabled({
    name,
    enabled,
  }: {
    name: string;
    enabled: boolean;
  }): Promise<void> {
    await this.writeConfigValue({
      keyPath: formatConfigKeyPath(['mcp_servers', name, 'enabled']),
      value: enabled,
    });
  }

  async startMcpServerOauthLogin({
    name,
    scopes = null,
    timeoutSecs = null,
  }: {
    name: string;
    scopes?: string[] | null;
    timeoutSecs?: number | null;
  }): Promise<ProviderMcpOauthLoginResult> {
    const result: CodexAppMcpOauthLoginResponse = await this.request('mcpServer/oauth/login', {
      name,
      scopes,
      timeoutSecs,
    }, { timeoutMs: 30_000 });
    const authorizationUrl = normalizeNullableString(result?.authorizationUrl);
    if (!authorizationUrl) {
      throw new Error(`mcpServer/oauth/login returned no authorization URL for ${name}`);
    }
    return { authorizationUrl };
  }

  async reloadMcpServers(): Promise<void> {
    await this.request('config/mcpServer/reload', {}, { timeoutMs: 30_000 });
  }

  async writeConfigValue({
    keyPath,
    value,
    mergeStrategy = 'upsert',
    filePath = null,
    expectedVersion = null,
  }: {
    keyPath: string;
    value: unknown;
    mergeStrategy?: 'replace' | 'upsert';
    filePath?: string | null;
    expectedVersion?: string | null;
  }): Promise<void> {
    await this.request('config/value/write', {
      keyPath,
      value,
      mergeStrategy,
      filePath,
      expectedVersion,
    }, { timeoutMs: 30_000 });
  }

  async startServer(): Promise<void> {
    if (this.autolaunch && this.launchCommand?.trim()) {
      const launcher = this.spawnImpl(this.launchCommand, {
        shell: true,
        detached: true,
        stdio: 'ignore',
      });
      launcher.unref?.();
    }
    this.childStartError = null;
    this.childStderrTail = [];
    this.port = await reservePort();
    const featureArgs = this.enabledFeatures.flatMap((feature) => ['--enable', feature]);
    const launchSpec = createCodexAppServerLaunchSpec({
      command: this.codexCliBin,
      args: ['app-server', ...featureArgs, '--listen', `ws://127.0.0.1:${this.port}`],
      platform: this.platform,
    });
    try {
      this.child = launchSpec.args
        ? this.spawnImpl(launchSpec.command, launchSpec.args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          ...launchSpec.options,
        })
        : this.spawnImpl(launchSpec.command, {
          stdio: ['ignore', 'pipe', 'pipe'],
          ...launchSpec.options,
        });
    } catch (error) {
      throw createCodexLaunchError({
        command: launchSpec.displayCommand,
        error,
        platform: this.platform,
      });
    }
    this.logDebug('app_server_spawned', {
      command: launchSpec.displayCommand,
      spawnCommand: launchSpec.command,
      spawnArgs: launchSpec.args,
      port: this.port,
      enabledFeatures: this.enabledFeatures,
      autolaunch: this.autolaunch,
      launchCommand: this.launchCommand,
    });
    this.child.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        rememberCodexStderrLine(this.childStderrTail, text);
        this.logger.debug?.(`[codex-app] codex.stderr ${text}`);
      }
    });
    this.child.on('error', (error) => {
      this.childStartError = createCodexLaunchError({
        command: launchSpec.displayCommand,
        error,
        platform: this.platform,
      });
    });
    this.child.on('exit', () => {
      this.connected = false;
      this.socket = null;
    });
    await this.connectWebSocket();
    await this.initialize();
  }

  async connectWebSocket(): Promise<void> {
    const url = `ws://127.0.0.1:${this.port}`;
    const started = Date.now();
    while (Date.now() - started < APP_SERVER_CONNECT_TIMEOUT_MS) {
      if (this.childStartError) {
        throw this.childStartError;
      }
      if (this.child && this.child.exitCode !== null && !this.connected) {
        throw createCodexAppServerExitedError({
          command: this.codexCliBin,
          exitCode: this.child.exitCode,
          stderrTail: this.childStderrTail,
        });
      }
      try {
        await new Promise<void>((resolve, reject) => {
          const ws = this.webSocketFactory(url);
          const onError = (error: any) => {
            ws.close();
            reject(error instanceof Error ? error : new Error(String(error?.message ?? 'WebSocket connect failed')));
          };
          ws.addEventListener('open', () => {
            this.socket = ws;
            this.connected = true;
            ws.addEventListener('message', (message) => this.handleMessage(String(message.data)));
            ws.addEventListener('close', () => {
              this.connected = false;
              this.socket = null;
            });
            resolve();
          }, { once: true });
          ws.addEventListener('error', onError, { once: true });
        });
        return;
      } catch {
        await sleep(250);
      }
    }
    if (this.childStartError) {
      throw this.childStartError;
    }
    throw createCodexConnectTimeoutError({
      command: this.codexCliBin,
      url,
      stderrTail: this.childStderrTail,
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: this.clientInfo,
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          'codex/event/agent_reasoning_delta',
          'codex/event/reasoning_content_delta',
          'codex/event/reasoning_raw_content_delta',
          'codex/event/exec_command_output_delta',
        ],
      },
    }, { timeoutMs: 30_000 });
    this.send({ jsonrpc: '2.0', method: 'initialized' });
  }

  async request(method: string, params: any, { timeoutMs = 30_000 }: { timeoutMs?: number } = {}): Promise<any> {
    if (!this.socket || !this.connected) {
      await this.start();
    }
    const id = String(++this.requestId);
    const startedAt = this.turnPollNow();
    this.logDebug('rpc_request_start', {
      id,
      method,
      timeoutMs,
      params: summarizeRpcParams(method, params),
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) {
          return;
        }
        this.pending.delete(id);
        this.logDebug('rpc_request_timeout', {
          id,
          method,
          elapsedMs: this.turnPollNow() - startedAt,
        });
        reject(new Error(`Timed out waiting for Codex JSON-RPC response to ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          this.logDebug('rpc_request_result', {
            id,
            method,
            elapsedMs: this.turnPollNow() - startedAt,
            result: summarizeRpcResult(method, result),
          });
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.logDebug('rpc_request_error', {
            id,
            method,
            elapsedMs: this.turnPollNow() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          });
          reject(error);
        },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  send(payload: any): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Codex app-server socket is not open');
    }
    this.socket.send(JSON.stringify(payload));
  }

  handleMessage(raw: string): void {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if ('id' in message && !('method' in message)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) {
        return;
      }
      this.pending.delete(String(message.id));
      if (message.error) {
        pending.reject(new Error(message.error.message || 'JSON-RPC error'));
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if ('method' in message) {
      this.noteApprovedExecutionSignalFromNotification(message);
      this.logDebug('rpc_notification', summarizeNotificationMessage(message));
      if ('id' in message && this.handleServerRequest(message)) {
        return;
      }
      this.emit('notification', message);
    }
  }

  handleServerRequest(message: any): boolean {
    const pendingApproval = mapPendingApproval(message);
    if (!pendingApproval) {
      this.emit('server_request', message);
      return false;
    }
    this.pendingApprovals.set(pendingApproval.rpcId, pendingApproval);
    this.emit('approval_request', pendingApproval.request);
    return true;
  }

  rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  getApprovedExecutions({
    threadId = null,
    turnId = null,
    activeOnly = false,
  }: {
    threadId?: string | null;
    turnId?: string | null;
    activeOnly?: boolean;
  } = {}): ApprovedExecution[] {
    return [...this.approvedExecutions.values()].filter((entry) => {
      if (threadId && entry.threadId !== threadId) {
        return false;
      }
      if (turnId && entry.turnId && entry.turnId !== turnId) {
        return false;
      }
      if (activeOnly && entry.completedAt) {
        return false;
      }
      return true;
    });
  }

  noteApprovedExecutionSignalFromNotification(message: any): void {
    const signalKind = classifyApprovedExecutionSignal(message?.method);
    if (!signalKind) {
      return;
    }
    const threadId = extractThreadIdFromNotification(message);
    if (!threadId) {
      return;
    }
    this.noteApprovedExecutionSignal({
      threadId,
      turnId: extractNotificationTurnId(message?.params ?? null),
      itemId: extractItemId(message?.params ?? null),
      signalKind,
      markCompleted: signalKind === 'item_completed' || signalKind === 'turn_completed',
    });
  }

  noteApprovedExecutionSignal({
    threadId,
    turnId = null,
    itemId = null,
    signalKind,
    markCompleted = false,
  }: {
    threadId: string;
    turnId?: string | null;
    itemId?: string | null;
    signalKind: string;
    markCompleted?: boolean;
  }): void {
    const now = this.turnPollNow();
    for (const entry of this.approvedExecutions.values()) {
      if (entry.completedAt) {
        continue;
      }
      if (entry.threadId !== threadId) {
        continue;
      }
      if (turnId && entry.turnId && entry.turnId !== turnId) {
        continue;
      }
      if (!turnId && entry.turnId && !isThreadLevelApprovedExecutionSignal(signalKind)) {
        continue;
      }
      const firstSignal = entry.signalCount === 0;
      entry.lastSignalAt = now;
      entry.lastSignalKind = signalKind;
      entry.signalCount += 1;
      if (
        markCompleted
        && (
          !itemId
          || !entry.itemId
          || entry.itemId === itemId
        )
      ) {
        entry.completedAt = now;
      }
      if (firstSignal || entry.completedAt) {
        this.logDebug('approval_signal', summarizeApprovedExecutionSignal(entry, signalKind));
      }
    }
  }

  observeApprovedExecutionTurnSnapshot({
    threadId,
    turnId,
    turn,
  }: {
    threadId: string;
    turnId: string;
    turn: any;
  }): void {
    const activeEntries = this.getApprovedExecutions({ threadId, turnId, activeOnly: true });
    if (activeEntries.length === 0 || !turn) {
      return;
    }
    const snapshotKey = buildTurnSnapshotKey(turn);
    let changed = false;
    for (const entry of activeEntries) {
      if (!entry.lastObservedTurnSnapshotKey) {
        entry.lastObservedTurnSnapshotKey = snapshotKey;
        continue;
      }
      if (entry.lastObservedTurnSnapshotKey !== snapshotKey) {
        entry.lastObservedTurnSnapshotKey = snapshotKey;
        changed = true;
      }
    }
    if (changed) {
      this.noteApprovedExecutionSignal({
        threadId,
        turnId,
        signalKind: 'turn_snapshot_changed',
      });
    }
  }

  inspectApprovedExecutionStall({
    threadId,
    turnId,
    timeoutMs,
  }: {
    threadId: string;
    turnId: string;
    timeoutMs: number;
  }): null | {
    entry: ApprovedExecution;
    idleMs: number;
    idleLimitMs: number;
  } {
    const activeEntries = this.getApprovedExecutions({ threadId, turnId, activeOnly: true });
    if (activeEntries.length === 0) {
      return null;
    }
    const now = this.turnPollNow();
    const idleLimitMs = computeApprovedExecutionIdleLimitMs(timeoutMs);
    let stalledEntry: ApprovedExecution | null = null;
    let stalledIdleMs = 0;
    for (const entry of activeEntries) {
      const idleMs = Math.max(0, now - Math.max(entry.lastSignalAt, entry.approvedAt));
      if (idleMs < idleLimitMs) {
        continue;
      }
      if (!stalledEntry || idleMs > stalledIdleMs) {
        stalledEntry = entry;
        stalledIdleMs = idleMs;
      }
    }
    if (!stalledEntry) {
      return null;
    }
    return {
      entry: stalledEntry,
      idleMs: stalledIdleMs,
      idleLimitMs,
    };
  }

  clearApprovedExecutionsForTurn({
    threadId,
    turnId,
  }: {
    threadId: string;
    turnId: string;
  }): void {
    for (const [requestId, entry] of this.approvedExecutions.entries()) {
      if (entry.threadId !== threadId) {
        continue;
      }
      if (entry.turnId && entry.turnId !== turnId) {
        continue;
      }
      this.approvedExecutions.delete(requestId);
    }
  }

  async waitForTurnResult({
    threadId,
    turnId,
    onProgress,
    onApprovalRequest,
    timeoutMs,
  }: {
    threadId: string;
    turnId: string;
    onProgress?: ((progress: ProviderTurnProgress) => Promise<void> | void) | null;
    onApprovalRequest?: ((request: ProviderApprovalRequest) => Promise<void> | void) | null;
    timeoutMs: number;
  }): Promise<ProviderTurnResult> {
    const deadline = this.turnPollNow() + timeoutMs;
    let firstTerminalWithoutOutputAt = null;
    let lastTurnSnapshotKey = null;
    let stableTerminalReadCount = 0;
    let pollCount = 0;
    let pendingApprovalWaitLogged = false;
    let lastPendingApprovalCount = 0;
    const terminalSettleMs = computeTerminalSettleMs(timeoutMs);
    const progressState: ProgressState = {
      commentaryText: '',
      finalAnswerText: '',
      sawAssistantActivity: false,
      lastAssistantActivityAt: 0,
    };
    const itemOutputKinds = new Map();
    const onNotification = (notification) => {
      const progress = extractProgressUpdate(notification, turnId, itemOutputKinds, progressState);
      if (!progress) {
        return;
      }
      if (progress.outputKind === 'final_answer') {
        progressState.finalAnswerText += progress.delta;
      } else {
        progressState.commentaryText += progress.delta;
      }
      progressState.sawAssistantActivity = true;
      progressState.lastAssistantActivityAt = this.turnPollNow();
      if (typeof onProgress === 'function') {
        void onProgress({
          text: progress.outputKind === 'final_answer'
            ? progressState.finalAnswerText
            : progressState.commentaryText,
          delta: progress.delta,
          outputKind: progress.outputKind,
        });
      }
    };
    const onApprovalEvent = (request: ProviderApprovalRequest) => {
      if (request.threadId !== threadId) {
        return;
      }
      if (request.turnId && request.turnId !== turnId) {
        return;
      }
      if (typeof onApprovalRequest === 'function') {
        void onApprovalRequest(request);
      }
    };
    this.on('notification', onNotification);
    this.on('approval_request', onApprovalEvent);
    this.logDebug('turn_wait_start', {
      threadId,
      turnId,
      timeoutMs,
      deadline,
      terminalSettleMs,
    });
    try {
      while (true) {
        const pendingApprovalCount = this.getPendingApprovals({ threadId, turnId }).length;
        const pastDeadline = this.turnPollNow() >= deadline;
        if (pastDeadline && pendingApprovalCount === 0) {
          break;
        }
        if (pastDeadline && pendingApprovalCount > 0) {
          if (!pendingApprovalWaitLogged || pendingApprovalCount !== lastPendingApprovalCount) {
            this.logDebug('turn_wait_continue', {
              threadId,
              turnId,
              pollCount,
              reason: 'pending_approval_wait',
              pendingApprovalCount,
            });
          }
          pendingApprovalWaitLogged = true;
          lastPendingApprovalCount = pendingApprovalCount;
        } else {
          pendingApprovalWaitLogged = false;
          lastPendingApprovalCount = pendingApprovalCount;
        }
        pollCount += 1;
        let thread = null;
        try {
          thread = await this.readThread(threadId, true);
        } catch (error) {
          if (isThreadMaterializationPendingError(error)) {
            this.logDebug('turn_poll_retry', {
              threadId,
              turnId,
              pollCount,
              reason: 'thread_materialization_pending',
            });
            await this.turnPollSleep(1000);
            continue;
          }
          if (isRequestTimeoutError(error)) {
            this.logDebug('turn_poll_retry', {
              threadId,
              turnId,
              pollCount,
              reason: 'thread_read_timeout',
            });
            await this.turnPollSleep(1000);
            continue;
          }
          throw error;
        }
        const turn = thread?.turns?.find((entry) => entry.id === turnId) ?? null;
        this.logDebug('turn_poll_snapshot', {
          threadId,
          turnId,
          pollCount,
          elapsedMs: timeoutMs - Math.max(0, deadline - this.turnPollNow()),
          threadFound: Boolean(thread),
          threadPath: thread?.path ?? null,
          turn: summarizeTurnSnapshot(turn),
          progress: summarizeProgressState(progressState),
        });
        if (turn) {
          this.observeApprovedExecutionTurnSnapshot({
            threadId,
            turnId,
            turn,
          });
        }
        const approvedExecutionStall = this.inspectApprovedExecutionStall({
          threadId,
          turnId,
          timeoutMs,
        });
        if (approvedExecutionStall) {
          this.logDebug('turn_wait_error', {
            threadId,
            turnId,
            pollCount,
            reason: 'approved_execution_stalled',
            idleMs: approvedExecutionStall.idleMs,
            idleLimitMs: approvedExecutionStall.idleLimitMs,
            approval: summarizeApprovedExecution(approvedExecutionStall.entry),
          });
          throw new Error(buildApprovedExecutionStallError(approvedExecutionStall));
        }
        if (turn && isTurnTerminal(turn.status)) {
          const outputText = extractTurnOutputText(turn);
          if (outputText) {
            this.noteApprovedExecutionSignal({
              threadId,
              turnId,
              signalKind: 'turn_terminal',
              markCompleted: true,
            });
            const outputArtifacts = extractTurnOutputArtifacts(turn);
            const result = {
              turnId,
              threadId,
              title: thread?.title ?? null,
              outputText,
              outputArtifacts,
              outputMedia: normalizeLegacyImageMedia(outputArtifacts),
              outputState: 'complete',
              previewText: progressState.finalAnswerText,
              finalSource: 'thread_items',
              status: turn.status,
            };
            this.logDebug('turn_wait_return', summarizeTurnResultForDebug(result));
            return result;
          }
          const outputArtifacts = extractTurnOutputArtifacts(turn);
          if (outputArtifacts.length > 0) {
            this.noteApprovedExecutionSignal({
              threadId,
              turnId,
              signalKind: 'turn_terminal',
              markCompleted: true,
            });
            const result = {
              turnId,
              threadId,
              title: thread?.title ?? null,
              outputText: '',
              outputArtifacts,
              outputMedia: normalizeLegacyImageMedia(outputArtifacts),
              outputState: 'complete',
              previewText: progressState.finalAnswerText,
              finalSource: 'thread_items_media',
              status: turn.status,
            };
            this.logDebug('turn_wait_return', summarizeTurnResultForDebug(result));
            return result;
          }
          const sessionState = inspectTurnCompletionFromSessionPath(thread?.path ?? null, turnId);
          const hasAssistantVisibleItems = turn.items.some((item) => isAssistantVisibleItem(item));
          const completionState = classifyTurnCompletionState(turn);
          this.logDebug('turn_terminal_state', {
            threadId,
            turnId,
            pollCount,
            turn: summarizeTurnSnapshot(turn),
            hasAssistantVisibleItems,
            completionState,
            sessionState: summarizeSessionState(thread?.path ?? null, sessionState),
            progress: summarizeProgressState(progressState),
          });
          if (completionState === 'interrupted') {
            this.noteApprovedExecutionSignal({
              threadId,
              turnId,
              signalKind: 'turn_terminal',
              markCompleted: true,
            });
            const result = {
              turnId,
              threadId,
              title: thread?.title ?? null,
              outputText: '',
              outputState: 'interrupted',
              previewText: progressState.finalAnswerText,
              finalSource: progressState.finalAnswerText ? 'progress_only' : 'none',
              status: turn.status,
            };
            this.logDebug('turn_wait_return', summarizeTurnResultForDebug(result));
            return result;
          }
          if (turn.error) {
            this.logDebug('turn_wait_error', {
              threadId,
              turnId,
              pollCount,
              error: turn.error,
            });
            throw new Error(turn.error);
          }
          if (sessionState.lastAgentMessage && hasAssistantVisibleItems) {
            this.noteApprovedExecutionSignal({
              threadId,
              turnId,
              signalKind: 'session_task_complete',
              markCompleted: true,
            });
            const result = buildSessionTaskCompleteResult({
              turnId,
              threadId,
              title: thread?.title ?? null,
              status: turn.status,
              previewText: progressState.finalAnswerText,
              sessionState,
            });
            this.logDebug('turn_wait_return', summarizeTurnResultForDebug(result));
            return result;
          }
          const sessionTaskCompleteNeedsMaterializationWait = shouldWaitForSessionTaskMaterialization(
            sessionState,
            hasAssistantVisibleItems,
          );
          if (shouldWaitForSettledOutputAfterTerminalTurn(turn, progressState) || sessionTaskCompleteNeedsMaterializationWait) {
            const snapshotKey = buildTurnSnapshotKey(turn);
            if (snapshotKey === lastTurnSnapshotKey) {
              stableTerminalReadCount += 1;
            } else {
              lastTurnSnapshotKey = snapshotKey;
              stableTerminalReadCount = 1;
            }
            firstTerminalWithoutOutputAt ??= this.turnPollNow();
            if (
              (
                this.turnPollNow() - firstTerminalWithoutOutputAt < terminalSettleMs
                || stableTerminalReadCount < 3
              )
              && this.turnPollNow() + 1000 < deadline
            ) {
              this.logDebug('turn_wait_continue', {
                threadId,
                turnId,
                pollCount,
                reason: sessionTaskCompleteNeedsMaterializationWait
                  ? 'session_task_materialization_wait'
                  : 'terminal_settle_wait',
                stableTerminalReadCount,
                terminalElapsedMs: this.turnPollNow() - firstTerminalWithoutOutputAt,
                terminalSettleMs,
              });
              await this.turnPollSleep(1000);
              continue;
            }
          }
          if (sessionState.lastAgentMessage || sessionState.outputArtifacts.length > 0) {
            this.noteApprovedExecutionSignal({
              threadId,
              turnId,
              signalKind: 'session_task_complete',
              markCompleted: true,
            });
            const result = buildSessionTaskCompleteResult({
              turnId,
              threadId,
              title: thread?.title ?? null,
              status: turn.status,
              previewText: progressState.finalAnswerText,
              sessionState,
            });
            this.logDebug('turn_wait_return', summarizeTurnResultForDebug(result));
            return result;
          }
          if (sessionState.hasTaskComplete) {
            this.noteApprovedExecutionSignal({
              threadId,
              turnId,
              signalKind: 'session_task_complete',
              markCompleted: true,
            });
            const previewText = resolveTurnPreviewText(turn, progressState);
            if (!previewText && sessionState.runtimeError) {
              const result = {
                turnId,
                threadId,
                title: thread?.title ?? null,
                outputText: '',
                outputState: 'provider_error',
                previewText: '',
                finalSource: 'session_runtime_error',
                status: turn.status,
                errorMessage: sessionState.runtimeError,
              };
              this.logDebug('turn_wait_return', summarizeTurnResultForDebug(result));
              return result;
            }
            const result = {
              turnId,
              threadId,
              title: thread?.title ?? null,
              outputText: '',
              outputState: previewText ? 'partial' : 'missing',
              previewText,
              finalSource: progressState.finalAnswerText
                ? 'progress_only'
                : progressState.commentaryText
                  ? 'commentary_only'
                  : 'session_task_complete_empty',
              status: turn.status,
            };
            this.logDebug('turn_wait_return', summarizeTurnResultForDebug(result));
            return result;
          }
          if (shouldWaitForTaskCompleteBeforeMissing(thread?.path ?? null, sessionState)) {
            if (this.turnPollNow() + 1000 < deadline) {
              this.logDebug('turn_wait_continue', {
                threadId,
                turnId,
                pollCount,
                reason: 'waiting_for_session_task_complete',
                sessionPath: thread?.path ?? null,
              });
              await this.turnPollSleep(1000);
              continue;
            }
            const previewText = resolveTurnPreviewText(turn, progressState);
            if (previewText) {
              const result = {
                turnId,
                threadId,
                title: thread?.title ?? null,
                outputText: '',
                outputState: 'partial',
                previewText,
                finalSource: progressState.finalAnswerText ? 'progress_only' : 'commentary_only',
                status: turn.status,
              };
              this.logDebug('turn_wait_return', summarizeTurnResultForDebug(result));
              return result;
            }
            this.logDebug('turn_wait_error', {
              threadId,
              turnId,
              pollCount,
              reason: 'task_complete_timeout_without_preview',
            });
            throw new Error(`Timed out waiting for Codex turn ${turnId}`);
          }
          if (hasUnsettledAssistantActivity(turn, progressState)) {
            if (this.turnPollNow() + 1000 < deadline) {
              this.logDebug('turn_wait_continue', {
                threadId,
                turnId,
                pollCount,
                reason: 'unsettled_assistant_activity',
                progress: summarizeProgressState(progressState),
              });
              await this.turnPollSleep(1000);
              continue;
            }
            const previewText = resolveTurnPreviewText(turn, progressState);
            if (previewText) {
              const result = {
                turnId,
                threadId,
                title: thread?.title ?? null,
                outputText: '',
                outputState: 'partial',
                previewText,
                finalSource: progressState.finalAnswerText ? 'progress_only' : 'commentary_only',
                status: turn.status,
              };
              this.logDebug('turn_wait_return', summarizeTurnResultForDebug(result));
              return result;
            }
            this.logDebug('turn_wait_error', {
              threadId,
              turnId,
              pollCount,
              reason: 'assistant_activity_timeout_without_preview',
            });
            throw new Error(`Timed out waiting for Codex turn ${turnId}`);
          }
          const previewText = resolveTurnPreviewText(turn, progressState);
          const result = {
            turnId,
            threadId,
            title: thread?.title ?? null,
            outputText: '',
            outputState: previewText ? 'partial' : 'missing',
            previewText,
            finalSource: progressState.finalAnswerText
              ? 'progress_only'
              : progressState.commentaryText
                ? 'commentary_only'
                : 'none',
            status: turn.status,
          };
          this.logDebug('turn_wait_return', summarizeTurnResultForDebug(result));
          return result;
        }
        await this.turnPollSleep(1000);
      }
      const previewText = progressState.finalAnswerText || progressState.commentaryText;
      if (previewText) {
        const result = {
          turnId,
          threadId,
          title: null,
          outputText: '',
          outputState: 'partial',
          previewText,
          finalSource: progressState.finalAnswerText ? 'progress_only' : 'commentary_only',
          status: null,
        };
        this.logDebug('turn_wait_return', summarizeTurnResultForDebug(result));
        return result;
      }
      this.logDebug('turn_wait_error', {
        threadId,
        turnId,
        pollCount,
        reason: 'overall_timeout_without_preview',
      });
      throw new Error(`Timed out waiting for Codex turn ${turnId}`);
    } finally {
      this.clearApprovedExecutionsForTurn({ threadId, turnId });
      this.off('notification', onNotification);
      this.off('approval_request', onApprovalEvent);
    }
  }
}

function mapPendingApproval(message: any): PendingApproval | null {
  const rpcId = String(message?.id ?? '').trim();
  const method = String(message?.method ?? '').trim();
  if (!rpcId || !method) {
    return null;
  }
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return {
        rpcId,
        transportKind: 'v2_command',
        request: mapCommandExecutionApprovalRequest(rpcId, message.params),
      };
    case 'item/fileChange/requestApproval':
      return {
        rpcId,
        transportKind: 'v2_file_change',
        request: mapFileChangeApprovalRequest(rpcId, message.params),
      };
    case 'item/permissions/requestApproval':
      return {
        rpcId,
        transportKind: 'v2_permissions',
        request: mapPermissionsApprovalRequest(rpcId, message.params),
      };
    case 'execCommandApproval':
      return {
        rpcId,
        transportKind: 'legacy_exec',
        request: mapLegacyExecApprovalRequest(rpcId, message.params),
      };
    case 'applyPatchApproval':
      return {
        rpcId,
        transportKind: 'legacy_apply_patch',
        request: mapLegacyApplyPatchApprovalRequest(rpcId, message.params),
      };
    default:
      return null;
  }
}

function mapCommandExecutionApprovalRequest(requestId: string, params: any): ProviderApprovalRequest {
  return {
    requestId,
    kind: 'command',
    threadId: String(params?.threadId ?? ''),
    turnId: normalizeNullableString(params?.turnId),
    itemId: normalizeNullableString(params?.itemId),
    reason: normalizeNullableString(params?.reason),
    command: normalizeNullableString(params?.command),
    cwd: normalizeNullableString(params?.cwd),
    availableDecisionKeys: Array.isArray(params?.availableDecisions)
      ? params.availableDecisions.map(normalizeApprovalDecisionKey).filter(Boolean)
      : [],
    execPolicyAmendment: Array.isArray(params?.proposedExecpolicyAmendment)
      ? params.proposedExecpolicyAmendment
        .map((entry: unknown) => String(entry ?? '').trim())
        .filter(Boolean)
      : null,
    networkPermission: normalizeBoolean(params?.additionalPermissions?.network?.enabled),
    fileReadPermissions: normalizeStringList(params?.additionalPermissions?.fileSystem?.read),
    fileWritePermissions: normalizeStringList(params?.additionalPermissions?.fileSystem?.write),
  };
}

function mapFileChangeApprovalRequest(requestId: string, params: any): ProviderApprovalRequest {
  return {
    requestId,
    kind: 'file_change',
    threadId: String(params?.threadId ?? ''),
    turnId: normalizeNullableString(params?.turnId),
    itemId: normalizeNullableString(params?.itemId),
    reason: normalizeNullableString(params?.reason),
    grantRoot: normalizeNullableString(params?.grantRoot),
    availableDecisionKeys: ['accept', 'acceptForSession', 'decline'],
  };
}

function mapPermissionsApprovalRequest(requestId: string, params: any): ProviderApprovalRequest {
  return {
    requestId,
    kind: 'permissions',
    threadId: String(params?.threadId ?? ''),
    turnId: normalizeNullableString(params?.turnId),
    itemId: normalizeNullableString(params?.itemId),
    reason: normalizeNullableString(params?.reason),
    networkPermission: normalizeBoolean(params?.permissions?.network?.enabled),
    fileReadPermissions: normalizeStringList(params?.permissions?.fileSystem?.read),
    fileWritePermissions: normalizeStringList(params?.permissions?.fileSystem?.write),
    availableDecisionKeys: ['accept', 'acceptForSession', 'decline'],
  };
}

function mapLegacyExecApprovalRequest(requestId: string, params: any): ProviderApprovalRequest {
  return {
    requestId,
    kind: 'command',
    threadId: String(params?.conversationId ?? ''),
    turnId: null,
    itemId: normalizeNullableString(params?.approvalId) ?? normalizeNullableString(params?.callId),
    reason: normalizeNullableString(params?.reason),
    command: Array.isArray(params?.command)
      ? params.command.map((entry: unknown) => String(entry ?? '').trim()).filter(Boolean).join(' ')
      : null,
    cwd: normalizeNullableString(params?.cwd),
    availableDecisionKeys: ['accept', 'acceptForSession', 'decline'],
  };
}

function mapLegacyApplyPatchApprovalRequest(requestId: string, params: any): ProviderApprovalRequest {
  return {
    requestId,
    kind: 'file_change',
    threadId: String(params?.conversationId ?? ''),
    turnId: null,
    itemId: normalizeNullableString(params?.callId),
    reason: normalizeNullableString(params?.reason),
    fileChanges: params?.fileChanges && typeof params.fileChanges === 'object'
      ? Object.keys(params.fileChanges).filter(Boolean)
      : [],
    grantRoot: normalizeNullableString(params?.grantRoot),
    availableDecisionKeys: ['accept', 'acceptForSession', 'decline'],
  };
}

function buildApprovalResponseResult(pending: PendingApproval, option: 1 | 2 | 3): any {
  switch (pending.transportKind) {
    case 'v2_command':
      return {
        decision: buildV2CommandApprovalDecision(pending.request, option),
      };
    case 'v2_file_change':
      return {
        decision: buildV2FileChangeApprovalDecision(option),
      };
    case 'v2_permissions':
      return buildV2PermissionsApprovalDecision(pending.request, option);
    case 'legacy_exec':
    case 'legacy_apply_patch':
      return {
        decision: buildLegacyReviewDecision(option),
      };
    default:
      throw new Error(`Unsupported approval transport: ${pending.transportKind}`);
  }
}

function createApprovedExecution(
  pending: PendingApproval,
  option: 1 | 2 | 3,
  now: number,
): ApprovedExecution | null {
  if (option === 3) {
    return null;
  }
  return {
    requestId: pending.rpcId,
    kind: pending.request.kind,
    threadId: pending.request.threadId,
    turnId: pending.request.turnId,
    itemId: pending.request.itemId,
    command: pending.request.command ?? null,
    approvedAt: now,
    lastSignalAt: now,
    lastSignalKind: 'approval_response_sent',
    signalCount: 0,
    completedAt: null,
    lastObservedTurnSnapshotKey: null,
  };
}

function buildV2CommandApprovalDecision(request: ProviderApprovalRequest, option: 1 | 2 | 3): any {
  if (option === 1) {
    return 'accept';
  }
  if (option === 2) {
    if (
      request.execPolicyAmendment
      && request.execPolicyAmendment.length > 0
      && request.availableDecisionKeys?.includes('acceptWithExecpolicyAmendment')
    ) {
      return {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: request.execPolicyAmendment,
        },
      };
    }
    if (request.availableDecisionKeys?.includes('acceptForSession')) {
      return 'acceptForSession';
    }
    throw new Error('Current approval request does not support session-wide approval');
  }
  if (request.availableDecisionKeys?.includes('decline')) {
    return 'decline';
  }
  if (request.availableDecisionKeys?.includes('cancel')) {
    return 'cancel';
  }
  throw new Error('Current approval request does not support denial');
}

function buildV2FileChangeApprovalDecision(option: 1 | 2 | 3): string {
  if (option === 1) {
    return 'accept';
  }
  if (option === 2) {
    return 'acceptForSession';
  }
  return 'decline';
}

function buildV2PermissionsApprovalDecision(request: ProviderApprovalRequest, option: 1 | 2 | 3) {
  return {
    permissions: option === 3
      ? {}
      : {
        ...(request.networkPermission != null ? {
          network: {
            enabled: request.networkPermission,
          },
        } : {}),
        ...(request.fileReadPermissions?.length || request.fileWritePermissions?.length ? {
          fileSystem: {
            read: request.fileReadPermissions ?? [],
            write: request.fileWritePermissions ?? [],
          },
        } : {}),
      },
    scope: option === 2 ? 'session' : 'turn',
  };
}

function buildLegacyReviewDecision(option: 1 | 2 | 3): any {
  if (option === 1) {
    return 'approved';
  }
  if (option === 2) {
    return 'approved_for_session';
  }
  return 'denied';
}

function normalizeApprovalDecisionKey(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (!value || typeof value !== 'object') {
    return '';
  }
  const entries = Object.entries(value);
  if (entries.length !== 1) {
    return '';
  }
  return String(entries[0]?.[0] ?? '').trim();
}

function classifyApprovedExecutionSignal(method: unknown): string | null {
  const normalized = String(method ?? '').replace(/[^a-z]/gi, '').toLowerCase();
  switch (normalized) {
    case 'itemstarted':
      return 'item_started';
    case 'itemcompleted':
      return 'item_completed';
    case 'threadstatuschanged':
      return 'thread_status_changed';
    case 'turnstarted':
      return 'turn_started';
    case 'turncompleted':
      return 'turn_completed';
    default:
      return isAgentDeltaNotificationMethod(normalized) ? 'assistant_delta' : null;
  }
}

function isThreadLevelApprovedExecutionSignal(signalKind: string): boolean {
  return signalKind === 'thread_status_changed' || signalKind === 'turn_completed';
}

function summarizeApprovedExecution(entry: ApprovedExecution) {
  return {
    requestId: entry.requestId,
    kind: entry.kind,
    threadId: entry.threadId,
    turnId: entry.turnId,
    itemId: entry.itemId,
    commandPreview: truncateDebugText(entry.command, 120),
    approvedAt: entry.approvedAt,
    lastSignalAt: entry.lastSignalAt,
    lastSignalKind: entry.lastSignalKind,
    signalCount: entry.signalCount,
    completedAt: entry.completedAt,
  };
}

function summarizeApprovedExecutionSignal(entry: ApprovedExecution, signalKind: string) {
  return {
    requestId: entry.requestId,
    threadId: entry.threadId,
    turnId: entry.turnId,
    itemId: entry.itemId,
    signalKind,
    signalCount: entry.signalCount,
    commandPreview: truncateDebugText(entry.command, 120),
    completedAt: entry.completedAt,
  };
}

function normalizeNullableString(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry ?? '').trim()).filter(Boolean)
    : [];
}

function normalizeBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function formatConfigKeyPath(segments: string[]): string {
  return segments
    .map((segment) => {
      const value = String(segment ?? '').trim();
      if (/^[A-Za-z0-9_]+$/u.test(value)) {
        return value;
      }
      return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
    })
    .join('.');
}

function serializeCollaborationMode({ collaborationMode, model, effort, developerInstructions = '' }: any) {
  if (!collaborationMode) {
    return null;
  }
  const settings: any = {
    model,
    developer_instructions: developerInstructions,
  };
  if (effort) {
    settings.reasoning_effort = effort;
  }
  if (collaborationMode === 'default') {
    return {
      mode: 'default',
      settings,
    };
  }
  return {
    mode: collaborationMode,
    settings,
  };
}

export function createNoopLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

export function createStderrLogger({
  envVar = 'CODEXBRIDGE_DEBUG_WEIXIN',
}: {
  envVar?: string;
} = {}) {
  if (process.env[envVar] !== '1') {
    return createNoopLogger();
  }
  return {
    debug(message: string) {
      writeSequencedStderrLine(message);
    },
    info(message: string) {
      writeSequencedStderrLine(message);
    },
    warn(message: string) {
      writeSequencedStderrLine(message);
    },
    error(message: string) {
      writeSequencedStderrLine(message);
    },
  };
}

function normalizeFeatureList(features: string[]): string[] {
  const normalized = [];
  const seen = new Set<string>();
  for (const feature of features) {
    if (typeof feature !== 'string') {
      continue;
    }
    const value = feature.trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

function summarizeTurnInput(input: CodexTurnInput[]) {
  return input.map((item) => {
    if (item.type === 'text') {
      return {
        type: item.type,
        textPreview: truncateDebugText(item.text, 160),
      };
    }
    return {
      type: item.type,
      path: item.path,
    };
  });
}

function summarizeRpcParams(method: string, params: any) {
  switch (method) {
    case 'thread/read':
      return {
        threadId: String(params?.threadId ?? ''),
        includeTurns: Boolean(params?.includeTurns),
      };
    case 'thread/start':
      return {
        cwd: params?.cwd ?? null,
        model: params?.model ?? null,
        serviceTier: params?.serviceTier ?? null,
        sandbox: params?.sandbox ?? null,
        approvalPolicy: params?.approvalPolicy ?? null,
      };
    case 'turn/start':
      return {
        threadId: String(params?.threadId ?? ''),
        cwd: params?.cwd ?? null,
        model: params?.model ?? null,
        serviceTier: params?.serviceTier ?? null,
        effort: params?.effort ?? null,
        approvalPolicy: params?.approvalPolicy ?? null,
        sandboxPolicy: params?.sandboxPolicy ?? null,
        collaborationMode: params?.collaborationMode?.mode ?? null,
        inputSummary: summarizeTurnInput(Array.isArray(params?.input) ? params.input : []),
      };
    case 'turn/interrupt':
      return {
        threadId: String(params?.threadId ?? ''),
        turnId: String(params?.turnId ?? ''),
      };
    default:
      return summarizePlainObject(params);
  }
}

function summarizeRpcResult(method: string, result: any) {
  switch (method) {
    case 'thread/read':
      return summarizeThreadReadResult(result?.thread ?? null);
    case 'thread/start':
      return {
        threadId: String(result?.thread?.id ?? ''),
        cwd: result?.cwd ?? null,
      };
    case 'turn/start':
      return {
        turnId: String(result?.turn?.id ?? ''),
        status: String(result?.turn?.status ?? ''),
      };
    default:
      return summarizePlainObject(result);
  }
}

function summarizeNotificationMessage(message: any) {
  return {
    method: String(message?.method ?? ''),
    id: 'id' in (message ?? {}) ? String(message.id ?? '') : null,
    threadId: extractThreadIdFromNotification(message),
    turnId: extractNotificationTurnId(message?.params ?? null),
    itemId: typeof message?.params?.item?.id === 'string' ? message.params.item.id : null,
    outputKind: typeof message?.params?.item?.output_kind === 'string'
      ? message.params.item.output_kind
      : null,
  };
}

function summarizeThreadReadResult(thread: any) {
  if (!thread) {
    return null;
  }
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  return {
    threadId: String(thread?.id ?? ''),
    title: typeof thread?.name === 'string' ? thread.name : null,
    path: typeof thread?.path === 'string' ? thread.path : null,
    turnCount: turns.length,
    turns: turns.slice(-3).map((turn) => summarizeTurnSnapshot(turn)),
  };
}

function summarizeTurnSnapshot(turn: any) {
  if (!turn) {
    return null;
  }
  const items = Array.isArray(turn?.items) ? turn.items : [];
  return {
    id: String(turn?.id ?? ''),
    status: String(turn?.status ?? ''),
    itemCount: items.length,
    visibleItemCount: items.filter((item) => isAssistantVisibleItem(item) || isUserVisibleItem(item)).length,
    outputTextPresent: Boolean(extractTurnOutputText(turn)),
    outputArtifactCount: extractTurnOutputArtifacts(turn).length,
    error: typeof turn?.error === 'string' ? turn.error : null,
  };
}

function summarizeProgressState(progressState: Partial<ProgressState>) {
  return {
    commentaryLength: String(progressState?.commentaryText ?? '').length,
    finalAnswerLength: String(progressState?.finalAnswerText ?? '').length,
    sawAssistantActivity: Boolean(progressState?.sawAssistantActivity),
    lastAssistantActivityAt: progressState?.lastAssistantActivityAt ?? 0,
  };
}

function summarizeSessionState(sessionPath: string | null | undefined, sessionState: {
  hasTaskComplete: boolean;
  lastAgentMessage: string | null;
  outputArtifacts: Array<{ kind?: string | null; path?: string | null }>;
  runtimeError?: string | null;
}) {
  return {
    sessionPath: sessionPath ?? null,
    hasTaskComplete: sessionState.hasTaskComplete,
    lastAgentMessagePreview: truncateDebugText(sessionState.lastAgentMessage, 160),
    runtimeError: truncateDebugText(sessionState.runtimeError, 160),
    outputArtifactCount: sessionState.outputArtifacts.length,
    outputArtifacts: sessionState.outputArtifacts.map((artifact) => ({
      kind: artifact.kind ?? null,
      path: artifact.path ?? null,
    })),
  };
}

function summarizeTurnResultForDebug(result: ProviderTurnResult) {
  return {
    threadId: result.threadId ?? null,
    turnId: result.turnId ?? null,
    status: result.status ?? null,
    outputState: result.outputState ?? null,
    finalSource: result.finalSource ?? null,
    errorMessage: truncateDebugText(result.errorMessage, 160),
    outputTextPreview: truncateDebugText(result.outputText, 160),
    previewTextPreview: truncateDebugText(result.previewText, 160),
    outputArtifactCount: Array.isArray(result.outputArtifacts) ? result.outputArtifacts.length : 0,
    outputArtifacts: Array.isArray(result.outputArtifacts)
      ? result.outputArtifacts.map((artifact) => ({
        kind: artifact.kind ?? null,
        path: artifact.path ?? null,
        caption: truncateDebugText(artifact.caption, 120),
      }))
      : [],
  };
}

function summarizePlainObject(value: any) {
  if (!value || typeof value !== 'object') {
    return value ?? null;
  }
  const summary: Record<string, unknown> = {};
  Object.keys(value).slice(0, 12).forEach((key) => {
    const raw = value[key];
    if (raw == null || typeof raw === 'number' || typeof raw === 'boolean') {
      summary[key] = raw;
      return;
    }
    if (typeof raw === 'string') {
      summary[key] = truncateDebugText(raw, 120);
      return;
    }
    if (Array.isArray(raw)) {
      summary[key] = { length: raw.length };
      return;
    }
    summary[key] = { keys: Object.keys(raw).slice(0, 8) };
  });
  return summary;
}

function extractThreadIdFromNotification(message: any): string | null {
  const params = message?.params ?? null;
  if (typeof params?.threadId === 'string') {
    return params.threadId;
  }
  if (typeof params?.conversationId === 'string') {
    return params.conversationId;
  }
  if (typeof params?.item?.threadId === 'string') {
    return params.item.threadId;
  }
  if (typeof params?.event?.threadId === 'string') {
    return params.event.threadId;
  }
  return null;
}

function truncateDebugText(value: unknown, limit = 240): string {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (!text) {
    return '';
  }
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

function mapThreadSummary(raw) {
  return {
    threadId: String(raw.id),
    title: raw.name ? String(raw.name) : null,
    cwd: raw.cwd ? String(raw.cwd) : null,
    updatedAt: normalizeTimestamp(raw.updatedAt),
    preview: typeof raw.preview === 'string' ? raw.preview : '',
  };
}

function mapThread(raw, includeTurns) {
  return {
    threadId: String(raw.id),
    title: raw.name ? String(raw.name) : null,
    cwd: raw.cwd ? String(raw.cwd) : null,
    path: raw.path ? String(raw.path) : null,
    updatedAt: normalizeTimestamp(raw.updatedAt),
    preview: typeof raw.preview === 'string' ? raw.preview : '',
    turns: includeTurns && Array.isArray(raw.turns) ? raw.turns.map(mapTurn) : [],
  };
}

function normalizeTimestamp(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function mapTurn(raw) {
  return {
    id: String(raw?.id ?? ''),
    status: extractStructuredString(raw?.status),
    error: extractStructuredString(raw?.error),
    items: Array.isArray(raw?.items) ? raw.items.map(mapTurnItem) : [],
  };
}

function mapTurnItem(raw) {
  return {
    type: typeof raw?.type === 'string' ? raw.type : 'unknown',
    role: typeof raw?.role === 'string' ? raw.role : null,
    phase: typeof raw?.phase === 'string' ? raw.phase : null,
    text: extractStructuredText(raw),
    savedPath: extractStructuredString(raw?.savedPath),
    result: extractStructuredString(raw?.result),
  };
}

function mapModel(raw) {
  return {
    id: String(raw.id),
    model: String(raw.model),
    displayName: String(raw.displayName || raw.model),
    description: String(raw.description || ''),
    isDefault: Boolean(raw.isDefault),
    supportedReasoningEfforts: Array.isArray(raw.supportedReasoningEfforts)
      ? raw.supportedReasoningEfforts
        .map((entry) => entry?.reasoningEffort)
        .filter((value) => typeof value === 'string')
      : [],
    defaultReasoningEffort: typeof raw.defaultReasoningEffort === 'string' ? raw.defaultReasoningEffort : null,
  };
}

function mapAppServerRateLimits(payload: CodexAppRateLimitsResponse | null | undefined): ProviderUsageReport | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const report: ProviderUsageReport = {
    provider: 'codex',
    accountId: null,
    userId: null,
    email: null,
    plan: null,
    buckets: [],
    credits: null,
  };
  const snapshots: CodexAppRateLimitSnapshot[] = [];
  if (payload.rateLimitsByLimitId && typeof payload.rateLimitsByLimitId === 'object') {
    const keys = Object.keys(payload.rateLimitsByLimitId).sort();
    for (const key of keys) {
      const snapshot = payload.rateLimitsByLimitId[key];
      if (snapshot && typeof snapshot === 'object') {
        snapshots.push(snapshot);
      }
    }
  } else if (payload.rateLimits && typeof payload.rateLimits === 'object') {
    if (payload.rateLimits.limitId || payload.rateLimits.primary || payload.rateLimits.secondary || payload.rateLimits.credits) {
      snapshots.push(payload.rateLimits);
    }
  }

  for (const snapshot of snapshots) {
    if (!report.plan && typeof snapshot.planType === 'string' && snapshot.planType.trim()) {
      report.plan = snapshot.planType.trim();
    }
    if (!report.credits && snapshot.credits && typeof snapshot.credits === 'object') {
      report.credits = {
        hasCredits: Boolean(snapshot.credits.hasCredits),
        unlimited: Boolean(snapshot.credits.unlimited),
        balance: typeof snapshot.credits.balance === 'string' && snapshot.credits.balance.trim()
          ? snapshot.credits.balance.trim()
          : null,
      };
    }
    const windows = appServerUsageWindows(snapshot);
    if (!windows.length) {
      continue;
    }
    const limitReached = windows.some((window) => window.usedPercent >= 100);
    report.buckets.push({
      name: appServerBucketName(snapshot),
      allowed: !limitReached,
      limitReached,
      windows,
    });
  }

  return report;
}

function mapSkillToolDependency(raw: CodexAppSkillToolDependency): ProviderSkillToolDependency | null {
  const type = normalizeNullableString(raw?.type);
  const value = normalizeNullableString(raw?.value);
  if (!type || !value) {
    return null;
  }
  return {
    type,
    value,
    command: normalizeNullableString(raw?.command),
    description: normalizeNullableString(raw?.description),
    transport: normalizeNullableString(raw?.transport),
    url: normalizeNullableString(raw?.url),
  };
}

function mapSkillMetadata(raw: CodexAppSkillMetadata): ProviderSkillInfo | null {
  const name = normalizeNullableString(raw?.name);
  const description = normalizeNullableString(raw?.description);
  const skillPath = normalizeNullableString(raw?.path);
  const scope = normalizeNullableString(raw?.scope);
  if (!name || !description || !skillPath || !scope) {
    return null;
  }
  const dependencies = Array.isArray(raw?.dependencies?.tools)
    ? raw.dependencies.tools.map(mapSkillToolDependency).filter(Boolean)
    : [];
  return {
    name,
    description,
    enabled: raw?.enabled !== false,
    path: skillPath,
    scope,
    shortDescription: normalizeNullableString(raw?.interface?.shortDescription)
      ?? normalizeNullableString(raw?.shortDescription),
    displayName: normalizeNullableString(raw?.interface?.displayName),
    defaultPrompt: normalizeNullableString(raw?.interface?.defaultPrompt),
    brandColor: normalizeNullableString(raw?.interface?.brandColor),
    dependencies,
  };
}

function mapSkillErrorInfo(raw: CodexAppSkillErrorInfo): ProviderSkillError | null {
  const skillPath = normalizeNullableString(raw?.path);
  const message = normalizeNullableString(raw?.message);
  if (!skillPath || !message) {
    return null;
  }
  return {
    path: skillPath,
    message,
  };
}

function mapPluginLoadError(raw: CodexAppMarketplaceLoadError): ProviderPluginLoadError | null {
  const marketplacePath = normalizeNullableString(raw?.marketplacePath);
  const message = normalizeNullableString(raw?.message);
  if (!marketplacePath || !message) {
    return null;
  }
  return {
    marketplacePath,
    message,
  };
}

function mapPluginMarketplace(raw: CodexAppPluginMarketplace): ProviderPluginMarketplace | null {
  const name = normalizeNullableString(raw?.name);
  if (!name) {
    return null;
  }
  return {
    name,
    path: normalizeNullableString(raw?.path),
    displayName: normalizeNullableString(raw?.interface?.displayName),
    plugins: Array.isArray(raw?.plugins)
      ? raw.plugins.map((plugin) => mapPluginSummary(plugin, {
        marketplaceName: name,
        marketplacePath: normalizeNullableString(raw?.path),
        marketplaceDisplayName: normalizeNullableString(raw?.interface?.displayName),
      })).filter(Boolean) as ProviderPluginSummary[]
      : [],
  };
}

function mapPluginSummary(
  raw: CodexAppPluginSummary | null | undefined,
  context: {
    marketplaceName?: string | null;
    marketplacePath?: string | null;
    marketplaceDisplayName?: string | null;
  } = {},
): ProviderPluginSummary | null {
  const id = normalizeNullableString(raw?.id);
  const name = normalizeNullableString(raw?.name);
  if (!id || !name) {
    return null;
  }
  const sourceType = normalizeNullableString((raw?.source as any)?.type);
  const defaultPrompts = Array.isArray(raw?.interface?.defaultPrompt)
    ? raw.interface.defaultPrompt.map((entry) => normalizeNullableString(entry)).filter(Boolean) as string[]
    : [];
  return {
    id,
    name,
    installed: raw?.installed !== false,
    enabled: raw?.enabled !== false,
    installPolicy: normalizeNullableString(raw?.installPolicy) ?? 'AVAILABLE',
    authPolicy: normalizeNullableString(raw?.authPolicy) ?? 'ON_USE',
    marketplaceName: normalizeNullableString(context.marketplaceName) ?? 'unknown',
    marketplacePath: normalizeNullableString(context.marketplacePath),
    marketplaceDisplayName: normalizeNullableString(context.marketplaceDisplayName),
    displayName: normalizeNullableString(raw?.interface?.displayName),
    shortDescription: normalizeNullableString(raw?.interface?.shortDescription),
    longDescription: normalizeNullableString(raw?.interface?.longDescription),
    category: normalizeNullableString(raw?.interface?.category),
    capabilities: Array.isArray(raw?.interface?.capabilities)
      ? raw.interface.capabilities.map((entry) => String(entry ?? '').trim()).filter(Boolean)
      : [],
    developerName: normalizeNullableString(raw?.interface?.developerName),
    brandColor: normalizeNullableString(raw?.interface?.brandColor),
    defaultPrompts,
    websiteUrl: normalizeNullableString(raw?.interface?.websiteUrl),
    sourceType,
    sourcePath: normalizeNullableString((raw?.source as any)?.path),
    sourceRemoteMarketplaceName: normalizeNullableString((raw?.source as any)?.marketplaceName),
  };
}

function mapPluginSkillSummary(raw: CodexAppPluginSkillSummary): ProviderPluginSkillSummary | null {
  const name = normalizeNullableString(raw?.name);
  const skillPath = normalizeNullableString(raw?.path);
  const description = normalizeNullableString(raw?.description);
  if (!name || !skillPath || !description) {
    return null;
  }
  return {
    name,
    path: skillPath,
    description,
    enabled: raw?.enabled !== false,
    shortDescription: normalizeNullableString(raw?.shortDescription),
    displayName: normalizeNullableString(raw?.interface?.displayName),
  };
}

function mapPluginAppSummary(raw: CodexAppPluginAppSummary): ProviderPluginAppSummary | null {
  const id = normalizeNullableString(raw?.id);
  const name = normalizeNullableString(raw?.name);
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name,
    needsAuth: Boolean(raw?.needsAuth),
    description: normalizeNullableString(raw?.description),
    installUrl: normalizeNullableString(raw?.installUrl),
  };
}

function mapPluginDetail(
  raw: CodexAppPluginDetail | null | undefined,
  fallback: {
    marketplaceName?: string | null;
    marketplacePath?: string | null;
  } = {},
): ProviderPluginDetail | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const summary = mapPluginSummary(raw.summary ?? null, {
    marketplaceName: normalizeNullableString(raw?.marketplaceName) ?? normalizeNullableString(fallback.marketplaceName),
    marketplacePath: normalizeNullableString(raw?.marketplacePath) ?? normalizeNullableString(fallback.marketplacePath),
  });
  if (!summary) {
    return null;
  }
  return {
    summary,
    marketplaceName: normalizeNullableString(raw?.marketplaceName) ?? summary.marketplaceName,
    marketplacePath: normalizeNullableString(raw?.marketplacePath) ?? summary.marketplacePath,
    description: normalizeNullableString(raw?.description),
    apps: Array.isArray(raw?.apps) ? raw.apps.map(mapPluginAppSummary).filter(Boolean) as ProviderPluginAppSummary[] : [],
    mcpServers: Array.isArray(raw?.mcpServers) ? raw.mcpServers.map((entry) => String(entry ?? '').trim()).filter(Boolean) : [],
    skills: Array.isArray(raw?.skills) ? raw.skills.map(mapPluginSkillSummary).filter(Boolean) as ProviderPluginSkillSummary[] : [],
  };
}

function mapAppInfo(raw: CodexAppInfo): ProviderAppInfo | null {
  const id = normalizeNullableString(raw?.id);
  const name = normalizeNullableString(raw?.name);
  if (!id || !name) {
    return null;
  }
  const categories = Array.isArray(raw?.appMetadata?.categories)
    ? raw.appMetadata.categories.map((entry) => normalizeNullableString(entry)).filter(Boolean) as string[]
    : [];
  return {
    id,
    name,
    description: normalizeNullableString(raw?.description),
    installUrl: normalizeNullableString(raw?.installUrl),
    isAccessible: Boolean(raw?.isAccessible),
    isEnabled: raw?.isEnabled !== false,
    pluginDisplayNames: Array.isArray(raw?.pluginDisplayNames)
      ? raw.pluginDisplayNames.map((entry) => String(entry ?? '').trim()).filter(Boolean)
      : [],
    categories,
    developer: normalizeNullableString(raw?.appMetadata?.developer)
      ?? normalizeNullableString(raw?.branding?.developer),
  };
}

function mapMcpServerStatus(raw: CodexAppMcpServerStatus): ProviderMcpServerStatus | null {
  const name = normalizeNullableString(raw?.name);
  if (!name) {
    return null;
  }
  return {
    name,
    isEnabled: raw?.isEnabled !== false,
    authStatus: normalizeNullableString(raw?.authStatus) ?? 'unsupported',
    toolCount: raw?.tools && typeof raw.tools === 'object' ? Object.keys(raw.tools).length : 0,
    resourceCount: Array.isArray(raw?.resources) ? raw.resources.length : 0,
    resourceTemplateCount: Array.isArray(raw?.resourceTemplates) ? raw.resourceTemplates.length : 0,
  };
}

function appServerBucketName(snapshot: CodexAppRateLimitSnapshot): string {
  if (typeof snapshot.limitName === 'string' && snapshot.limitName.trim()) {
    return snapshot.limitName.trim();
  }
  if (typeof snapshot.limitId === 'string' && snapshot.limitId.trim()) {
    return snapshot.limitId.trim();
  }
  return 'Rate limit';
}

function appServerUsageWindows(snapshot: CodexAppRateLimitSnapshot) {
  const windows = [] as Array<{
    name: string;
    usedPercent: number;
    windowSeconds: number;
    resetAfterSeconds: number;
    resetAtUnix: number;
  }>;
  if (snapshot.primary) {
    windows.push(appServerUsageWindow('Primary', snapshot.primary));
  }
  if (snapshot.secondary) {
    windows.push(appServerUsageWindow('Secondary', snapshot.secondary));
  }
  return windows;
}

function appServerUsageWindow(name: string, window: CodexAppRateLimitWindow) {
  const rawUsedPercent = Number(window?.usedPercent ?? 0);
  const usedPercent = Number.isFinite(rawUsedPercent)
    ? Math.max(0, Math.min(100, Math.round(rawUsedPercent)))
    : 0;
  const rawWindowMinutes = Number(window?.windowDurationMins ?? 0);
  const windowSeconds = Number.isFinite(rawWindowMinutes)
    ? Math.max(0, Math.round(rawWindowMinutes * 60))
    : 0;
  const resetAtUnix = Math.max(0, Math.floor(Number(window?.resetsAt ?? 0)));
  const nowSeconds = Math.floor(Date.now() / 1000);
  const resetAfterSeconds = resetAtUnix > 0 ? Math.max(0, resetAtUnix - nowSeconds) : 0;
  return {
    name,
    usedPercent,
    windowSeconds,
    resetAfterSeconds,
    resetAtUnix,
  };
}

function mergeModelCatalog(baseModels, overlayModels) {
  if (overlayModels.length === 0) {
    return baseModels;
  }
  const overlayKeys = new Set(overlayModels.map((model) => model.model));
  const hasOverlayDefault = overlayModels.some((model) => model.isDefault);
  const merged = overlayModels.map((overlay) => {
    const base = baseModels.find((model) => model.model === overlay.model) ?? null;
    return {
      ...(base ?? {}),
      ...overlay,
      isDefault: overlay.isDefault || (!hasOverlayDefault && Boolean(base?.isDefault)),
    };
  });
  for (const base of baseModels) {
    if (!overlayKeys.has(base.model)) {
      merged.push({
        ...base,
        isDefault: hasOverlayDefault ? false : base.isDefault,
      });
    }
  }
  return merged;
}

function mapSandboxPolicy(mode) {
  if (mode === 'read-only') {
    return { type: 'readOnly' };
  }
  if (mode === 'danger-full-access') {
    return { type: 'dangerFullAccess' };
  }
  return { type: 'workspaceWrite' };
}

const TERMINAL_TURN_STATUS_KEYS = new Set([
  'completed',
  'complete',
  'succeeded',
  'success',
  'finished',
  'failed',
  'error',
  'timedout',
  'timeout',
  'interrupted',
  'cancelled',
  'canceled',
  'aborted',
]);

function normalizeTurnStatusKey(status) {
  return String(status ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function isTurnTerminal(status) {
  const normalized = normalizeTurnStatusKey(status);
  return Boolean(normalized) && TERMINAL_TURN_STATUS_KEYS.has(normalized);
}

function isThreadMaterializationPendingError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /not materialized yet/i.test(message)
    || /includeTurns is unavailable before first user message/i.test(message)
    || /empty session file/i.test(message);
}

function isRequestTimeoutError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /Timed out waiting for Codex JSON-RPC response to /i.test(message);
}

function computeTerminalSettleMs(timeoutMs) {
  const numericTimeout = Number(timeoutMs || 0);
  if (!Number.isFinite(numericTimeout) || numericTimeout <= 0) {
    return 60_000;
  }
  return Math.min(60_000, Math.max(10_000, Math.floor(numericTimeout / 2)));
}

function computeApprovedExecutionIdleLimitMs(timeoutMs) {
  const numericTimeout = Number(timeoutMs || 0);
  if (!Number.isFinite(numericTimeout) || numericTimeout <= 0) {
    return 300_000;
  }
  return Math.min(Math.max(180_000, Math.floor(numericTimeout / 3)), 300_000);
}

function buildApprovedExecutionStallError({
  entry,
  idleMs,
}: {
  entry: ApprovedExecution;
  idleMs: number;
}) {
  const idleSeconds = Math.max(1, Math.round(idleMs / 1000));
  const kindLabel = entry.kind === 'command'
    ? 'command'
    : entry.kind === 'file_change'
      ? 'file change'
      : 'permission grant';
  const commandSuffix = entry.command
    ? ` (${truncateDebugText(entry.command, 120)})`
    : '';
  if (entry.signalCount === 0) {
    return `Approval was accepted, but the approved ${kindLabel}${commandSuffix} produced no follow-up signal for ${idleSeconds} seconds. The provider may be stuck; use /retry to try again.`;
  }
  return `Approval was accepted, but the approved ${kindLabel}${commandSuffix} stopped making progress after ${entry.lastSignalKind} and stayed idle for ${idleSeconds} seconds. The provider may be stuck; use /retry to try again.`;
}

const INTERRUPTED_PATTERN = /interrupt|interrupted|cancel(?:led)?|aborted?|stopped by user|用户中断|已中断/i;

function classifyTurnCompletionState(turn) {
  const haystack = `${String(turn?.status ?? '')}\n${String(turn?.error ?? '')}`.trim();
  if (!haystack) {
    return 'unknown';
  }
  if (INTERRUPTED_PATTERN.test(haystack)) {
    return 'interrupted';
  }
  return 'other';
}

function extractTurnOutputText(turn) {
  return turn.items
    .filter((item) =>
      isAssistantVisibleItem(item)
      && classifyAgentOutput(extractAgentPhase(item), true) === 'final_answer')
    .map((item) => item.text)
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function extractTurnCommentaryText(turn) {
  return turn.items
    .filter((item) =>
      isAssistantVisibleItem(item)
      && classifyAgentOutput(extractAgentPhase(item), true) !== 'final_answer')
    .map((item) => item.text)
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function resolveTurnPreviewText(turn, progressState: Partial<ProgressState> = {}) {
  return progressState.finalAnswerText
    || progressState.commentaryText
    || extractTurnCommentaryText(turn);
}

function extractTurnOutputArtifacts(turn) {
  const seen = new Set<string>();
  return turn.items
    .flatMap((item) => extractOutputArtifactFromItem(item))
    .filter((item) => {
      const key = `${item.kind}:${item.path}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function normalizeLegacyImageMedia(artifacts) {
  return artifacts.filter((artifact) => artifact?.kind === 'image');
}

function extractOutputArtifactFromItem(item) {
  const savedPath = typeof item?.savedPath === 'string' ? item.savedPath.trim() : '';
  if (savedPath && fs.existsSync(savedPath)) {
    return [buildArtifactFromFilePath(savedPath)];
  }
  const result = typeof item?.result === 'string' ? item.result.trim() : '';
  if (result && isLocalFilePath(result) && fs.existsSync(result)) {
    return [buildArtifactFromFilePath(result)];
  }
  if (isRemoteImageUrl(result)) {
    return [{
      kind: 'image' as const,
      path: result,
      displayName: path.basename(new URL(result).pathname) || null,
      mimeType: inferMimeTypeFromPath(result),
      sizeBytes: null,
      caption: null,
      source: 'provider_native' as const,
      turnId: null,
    }];
  }
  if (String(item?.type ?? '') === 'imageGeneration') {
    const inlineImage = decodeInlineImagePayload(result);
    if (inlineImage) {
      const outputPath = materializeInlineImage(savedPath, inlineImage);
      if (outputPath) {
        return [buildArtifactFromFilePath(outputPath)];
      }
    }
  }
  return [];
}

function buildArtifactFromFilePath(filePath) {
  const normalizedPath = String(filePath ?? '').trim();
  const kind = inferArtifactKindFromPath(normalizedPath);
  let sizeBytes = null;
  try {
    sizeBytes = fs.statSync(normalizedPath).size;
  } catch {
    sizeBytes = null;
  }
  return {
    kind,
    path: normalizedPath,
    displayName: path.basename(normalizedPath) || null,
    mimeType: inferMimeTypeFromPath(normalizedPath),
    sizeBytes,
    caption: null,
    source: 'provider_native' as const,
    turnId: null,
  };
}

function inferArtifactKindFromPath(filePath) {
  const extension = path.extname(String(filePath ?? '')).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(extension)) {
    return 'image';
  }
  if (['.mp4', '.mov', '.mkv', '.webm'].includes(extension)) {
    return 'video';
  }
  if (['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.amr'].includes(extension)) {
    return 'audio';
  }
  return 'file';
}

function inferMimeTypeFromPath(filePath) {
  const extension = path.extname(String(filePath ?? '')).toLowerCase();
  return ({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.csv': 'text/csv',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.html': 'text/html',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
    '.tgz': 'application/gzip',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
  })[extension] ?? null;
}

function isLocalFilePath(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return false;
  }
  if (/^(?:https?:)?\/\//iu.test(normalized)) {
    return false;
  }
  if (/^data:/iu.test(normalized)) {
    return false;
  }
  return path.isAbsolute(normalized);
}

function extractAllAssistantVisibleText(turn) {
  return turn.items
    .filter((item) => isAssistantVisibleItem(item))
    .map((item) => item.text)
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function isRemoteImageUrl(value) {
  return /^https?:\/\/\S+/iu.test(String(value ?? ''));
}

function decodeInlineImagePayload(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return null;
  }
  const dataUrlMatch = raw.match(/^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\r\n]+)$/iu);
  const base64 = dataUrlMatch?.[2] ?? (looksLikeBase64Image(raw) ? raw : '');
  if (!base64) {
    return null;
  }
  try {
    const buffer = Buffer.from(base64.replace(/\s+/g, ''), 'base64');
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

function looksLikeBase64Image(value) {
  const normalized = String(value ?? '').replace(/\s+/g, '');
  if (!normalized || normalized.length < 64 || normalized.length % 4 !== 0) {
    return false;
  }
  return /^[A-Za-z0-9+/=]+$/u.test(normalized);
}

function materializeInlineImage(savedPath, buffer) {
  if (savedPath) {
    try {
      fs.mkdirSync(path.dirname(savedPath), { recursive: true });
      fs.writeFileSync(savedPath, buffer);
      return savedPath;
    } catch {
      return null;
    }
  }
  try {
    const fallbackPath = path.join(os.tmpdir(), `codexbridge-inline-image-${Date.now()}.png`);
    fs.writeFileSync(fallbackPath, buffer);
    return fallbackPath;
  } catch {
    return null;
  }
}

function inspectTurnCompletionFromSessionPath(sessionPath, turnId) {
  if (!sessionPath || !turnId || !fs.existsSync(sessionPath)) {
    return {
      hasTaskComplete: false,
      lastAgentMessage: null,
      outputArtifacts: [],
      runtimeError: null,
    };
  }
  try {
    const lines = fs.readFileSync(sessionPath, 'utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) {
        continue;
      }
      let entry = null;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = entry?.payload ?? null;
      if (entry?.type !== 'event_msg' || payload?.type !== 'task_complete') {
        continue;
      }
      if (String(payload.turn_id ?? '') !== turnId) {
        continue;
      }
      const lastAgentMessage = extractTextCandidate(payload.last_agent_message)?.trim() || null;
      const runtimeError = findSessionRuntimeErrorForTurn(lines, index, turnId);
      return inspectSessionTurnArtifacts(lines, index, {
        hasTaskComplete: true,
        lastAgentMessage,
        runtimeError,
      });
    }
  } catch {
    return {
      hasTaskComplete: false,
      lastAgentMessage: null,
      outputArtifacts: [],
      runtimeError: null,
    };
  }
  return {
    hasTaskComplete: false,
    lastAgentMessage: null,
    outputArtifacts: [],
    runtimeError: null,
  };
}

function findSessionRuntimeErrorForTurn(lines: string[], taskCompleteIndex: number, turnId: string): string | null {
  for (let index = taskCompleteIndex - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }
    let entry: any = null;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry?.payload ?? null;
    if (entry?.type === 'turn_context') {
      if (String(payload?.turn_id ?? '') === turnId) {
        break;
      }
      continue;
    }
    if (entry?.type !== 'event_msg') {
      continue;
    }
    const eventType = String(payload?.type ?? '');
    if (eventType === 'task_started' && String(payload?.turn_id ?? '') === turnId) {
      break;
    }
    if (eventType === 'token_count') {
      const rateLimitError = describeSessionRateLimitError(payload?.rate_limits ?? payload?.rateLimits ?? null);
      if (rateLimitError) {
        return rateLimitError;
      }
    }
    const message = extractSessionErrorMessage(payload);
    if (message) {
      return message;
    }
  }
  return null;
}

function extractSessionErrorMessage(payload: any): string | null {
  const eventType = String(payload?.type ?? '').toLowerCase();
  if (!/error|failed|failure/.test(eventType)) {
    return null;
  }
  return extractTextCandidate(payload?.message)
    ?? extractTextCandidate(payload?.error)
    ?? extractTextCandidate(payload);
}

function describeSessionRateLimitError(rateLimits: any): string | null {
  if (!rateLimits || typeof rateLimits !== 'object') {
    return null;
  }
  const limitId = normalizeRateLimitString(rateLimits.limit_id ?? rateLimits.limitId) ?? 'codex';
  const credits = rateLimits.credits && typeof rateLimits.credits === 'object'
    ? rateLimits.credits
    : null;
  if (credits) {
    const hasCredits = normalizeRateLimitBoolean(credits.has_credits ?? credits.hasCredits);
    const unlimited = normalizeRateLimitBoolean(credits.unlimited) === true;
    const balance = normalizeRateLimitString(credits.balance);
    if (hasCredits === false && !unlimited) {
      return `Codex subscription credits are exhausted (${limitId} balance ${balance ?? '0'}).`;
    }
  }
  const reachedType = normalizeRateLimitString(rateLimits.rate_limit_reached_type ?? rateLimits.rateLimitReachedType);
  if (reachedType) {
    return `Codex usage limit reached (${limitId}: ${reachedType}).`;
  }
  const primaryUsed = normalizeRateLimitNumber(rateLimits.primary?.used_percent ?? rateLimits.primary?.usedPercent);
  if (primaryUsed !== null && primaryUsed >= 100) {
    return `Codex usage limit reached (${limitId} primary ${Math.round(primaryUsed)}%).`;
  }
  const secondaryUsed = normalizeRateLimitNumber(rateLimits.secondary?.used_percent ?? rateLimits.secondary?.usedPercent);
  if (secondaryUsed !== null && secondaryUsed >= 100) {
    return `Codex usage limit reached (${limitId} weekly ${Math.round(secondaryUsed)}%).`;
  }
  return null;
}

function normalizeRateLimitString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizeRateLimitBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }
  return null;
}

function normalizeRateLimitNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function inspectSessionTurnArtifacts(lines, taskCompleteIndex, state) {
  const outputArtifacts = [];
  const seenArtifacts = new Set<string>();
  for (let index = taskCompleteIndex - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }
    let entry = null;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry?.payload ?? null;
    if (entry?.type === 'event_msg' && payload?.type === 'task_started') {
      break;
    }
    if (entry?.type !== 'event_msg' || payload?.type !== 'image_generation_end') {
      continue;
    }
    const savedPath = typeof payload?.saved_path === 'string' ? payload.saved_path.trim() : '';
    if (!savedPath || !fs.existsSync(savedPath)) {
      continue;
    }
    const artifact = buildArtifactFromFilePath(savedPath);
    const key = `${artifact.kind}:${artifact.path}`;
    if (seenArtifacts.has(key)) {
      continue;
    }
    seenArtifacts.add(key);
    outputArtifacts.unshift(artifact);
  }
  return {
    hasTaskComplete: state.hasTaskComplete,
    lastAgentMessage: state.lastAgentMessage,
    runtimeError: state.runtimeError ?? null,
    outputArtifacts,
  };
}

function buildSessionTaskCompleteResult({
  turnId,
  threadId,
  title,
  status,
  previewText,
  sessionState,
}) {
  return {
    turnId,
    threadId,
    title,
    outputText: sessionState.lastAgentMessage ?? '',
    outputArtifacts: sessionState.outputArtifacts,
    outputMedia: normalizeLegacyImageMedia(sessionState.outputArtifacts),
    outputState: 'complete',
    previewText,
    finalSource: sessionState.outputArtifacts.length > 0
      ? 'session_task_complete_media'
      : 'session_task_complete',
    status,
  };
}

function shouldWaitForSessionTaskMaterialization(sessionState, hasAssistantVisibleItems) {
  return sessionState.hasTaskComplete
    && !hasAssistantVisibleItems
    && !sessionState.lastAgentMessage
    && sessionState.outputArtifacts.length === 0;
}

function shouldWaitForTaskCompleteBeforeMissing(sessionPath, sessionState) {
  return Boolean(String(sessionPath ?? '').trim()) && !sessionState.hasTaskComplete;
}

function shouldWaitForSettledOutputAfterTerminalTurn(turn: any, progressState: Partial<ProgressState> = {}) {
  const visibleItems = turn.items.filter((item) => item.text);
  if (visibleItems.length === 0) {
    return true;
  }
  if (progressState.finalAnswerText) {
    return true;
  }
  return visibleItems.every((item) => {
    if (isUserVisibleItem(item)) {
      return true;
    }
    if (!isAssistantVisibleItem(item)) {
      return false;
    }
    return classifyAgentOutput(extractAgentPhase(item), true) !== 'final_answer';
  });
}

function hasUnsettledAssistantActivity(turn: any, progressState: Partial<ProgressState> = {}) {
  if (progressState.finalAnswerText) {
    return true;
  }
  if (progressState.commentaryText || progressState.sawAssistantActivity) {
    return true;
  }
  return turn.items.some((item) => {
    if (!isAssistantVisibleItem(item)) {
      return false;
    }
    return classifyAgentOutput(extractAgentPhase(item), true) !== 'final_answer' && Boolean(item.text);
  });
}


function buildTurnSnapshotKey(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  return JSON.stringify({
    status: turn?.status ?? '',
    error: turn?.error ?? '',
    items: items.map((item) => ({
      type: item?.type ?? '',
      role: item?.role ?? '',
      phase: item?.phase ?? '',
      text: item?.text ?? '',
    })),
  });
}

function extractProgressUpdate(notification, turnId, itemOutputKinds, progressState) {
  if (!notification || typeof notification.method !== 'string') {
    return null;
  }
  const params = notification.params ?? {};
  const notificationTurnId = extractNotificationTurnId(params);
  if (!notificationTurnId || notificationTurnId !== turnId) {
    return null;
  }
  const method = notification.method;
  if (method === 'item/started' || method === 'item/completed') {
    const item = params?.item ?? params;
    if (!isAssistantVisibleItem(item)) {
      return null;
    }
    const itemId = extractItemId(item);
    const outputKind = classifyAgentOutput(extractAgentPhase(item), method === 'item/completed');
    if (itemId) {
      itemOutputKinds.set(itemId, outputKind);
    }
    if (method === 'item/completed' && outputKind === 'final_answer') {
      const nextText = extractCompletedAgentText(params) ?? item?.text ?? null;
      return buildProgressUpdate(progressState.finalAnswerText, nextText, outputKind);
    }
    return null;
  }
  if (method !== 'item/agentMessage/delta') {
    if (!isAgentDeltaNotificationMethod(method)) {
      return null;
    }
  }
  const delta = extractNotificationDelta(params);
  if (!delta) {
    return null;
  }
  const itemId = extractItemId(params);
  const outputKind = resolveNotificationOutputKind(params, itemId, itemOutputKinds);
  const currentText = outputKind === 'final_answer'
    ? progressState.finalAnswerText
    : progressState.commentaryText;
  return buildProgressUpdate(currentText, `${currentText}${delta}`, outputKind);
}

function extractNotificationTurnId(params) {
  const direct = typeof params?.turnId === 'string' ? params.turnId : null;
  if (direct) {
    return direct;
  }
  const nested = typeof params?.item?.turnId === 'string' ? params.item.turnId : null;
  if (nested) {
    return nested;
  }
  return typeof params?.event?.turnId === 'string' ? params.event.turnId : null;
}

function extractNotificationDelta(params) {
  if (typeof params?.delta === 'string' && params.delta) {
    return params.delta;
  }
  if (typeof params?.text === 'string' && params.text) {
    return params.text;
  }
  if (typeof params?.item?.delta === 'string' && params.item.delta) {
    return params.item.delta;
  }
  return null;
}

function extractNotificationPhase(params) {
  if (typeof params?.phase === 'string') {
    return params.phase;
  }
  if (typeof params?.item?.phase === 'string') {
    return params.item.phase;
  }
  return null;
}

function resolveNotificationOutputKind(params, itemId, itemOutputKinds) {
  const explicit = classifyAgentOutput(extractNotificationPhase(params), false);
  if (explicit === 'final_answer') {
    return explicit;
  }
  if (itemId && itemOutputKinds.has(itemId)) {
    return itemOutputKinds.get(itemId);
  }
  return explicit;
}

function buildProgressUpdate(currentText, nextText, outputKind) {
  const normalizedNextText = String(nextText ?? '');
  if (!normalizedNextText) {
    return null;
  }
  const previous = String(currentText ?? '');
  const delta = normalizedNextText.startsWith(previous)
    ? normalizedNextText.slice(previous.length)
    : normalizedNextText;
  if (!delta) {
    return null;
  }
  return {
    text: normalizedNextText,
    delta,
    outputKind,
  };
}

function classifyAgentOutput(phase, completed) {
  if (!phase) {
    return completed ? 'final_answer' : 'commentary';
  }
  const normalized = phase.replace(/[^a-z]/gi, '').toLowerCase();
  if (
    normalized === 'final'
    || normalized === 'answer'
    || normalized === 'response'
    || normalized === 'finalanswer'
    || normalized === 'finalresponse'
  ) {
    return 'final_answer';
  }
  return 'commentary';
}

function normalizeEventItemType(item) {
  return String(item?.type ?? '').replace(/[^a-z]/gi, '').toLowerCase();
}

function normalizeEventItemRole(item) {
  return String(item?.role ?? '').replace(/[^a-z]/gi, '').toLowerCase();
}

function isAssistantVisibleItem(item) {
  const itemType = normalizeEventItemType(item);
  if (itemType === 'agentmessage' || itemType === 'assistantmessage') {
    return true;
  }
  return itemType === 'message' && normalizeEventItemRole(item) === 'assistant';
}

function isUserVisibleItem(item) {
  const itemType = normalizeEventItemType(item);
  if (itemType.includes('user')) {
    return true;
  }
  return itemType === 'message' && normalizeEventItemRole(item) === 'user';
}

function isAgentDeltaNotificationMethod(method) {
  const normalized = String(method ?? '').replace(/[^a-z]/gi, '').toLowerCase();
  return normalized === 'itemagentmessagedelta'
    || normalized === 'itemassistantmessagedelta'
    || normalized === 'itemmessagedelta';
}

function extractItemId(value) {
  const candidates = [value?.itemId, value?.item_id, value?.id, value?.item?.id];
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined && String(candidate).trim()) {
      return String(candidate);
    }
  }
  return null;
}

function extractAgentPhase(value) {
  const candidates = [value?.phase, value?.item?.phase];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }
  return null;
}

function extractCompletedAgentText(params) {
  if (typeof params?.text === 'string' && params.text) {
    return params.text;
  }
  if (typeof params?.item?.text === 'string' && params.item.text) {
    return params.item.text;
  }
  return null;
}

function extractStructuredText(value) {
  const directText = extractTextCandidate(value?.text)
    ?? extractTextCandidate(value?.content)
    ?? extractTextCandidate(value?.message)
    ?? extractTextCandidate(value?.value);
  return directText ?? extractTextCandidate(value);
}

function extractStructuredString(value) {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  return extractTextCandidate(value) ?? extractTextCandidate(value?.message) ?? extractTextCandidate(value?.error);
}

function extractTextCandidate(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  for (const key of ['text', 'delta', 'content', 'value', 'message']) {
    if (typeof value[key] === 'string') {
      return value[key];
    }
  }
  for (const key of ['parts', 'segments', 'content']) {
    const candidate = value[key];
    if (!Array.isArray(candidate)) {
      continue;
    }
    const text = candidate
      .map((entry) => extractTextCandidate(entry))
      .filter((entry) => typeof entry === 'string')
      .join('');
    if (text) {
      return text;
    }
  }
  return null;
}

function rememberCodexStderrLine(stderrTail: string[], text: string): void {
  stderrTail.push(text);
  while (stderrTail.length > 10) {
    stderrTail.shift();
  }
}

function createCodexAppServerLaunchSpec({
  command,
  args,
  platform,
}: {
  command: string;
  args: string[];
  platform: NodeJS.Platform;
}): {
  command: string;
  args?: string[] | null;
  options?: Record<string, unknown>;
  displayCommand: string;
} {
  if (platform === 'win32' && /\.(cmd|bat)$/iu.test(command)) {
    return {
      command: buildWindowsShellCommandLine([command, ...args]),
      args: null,
      options: {
        shell: true,
        windowsHide: true,
      },
      displayCommand: command,
    };
  }
  return {
    command,
    args,
    displayCommand: command,
  };
}

function createCodexLaunchError({
  command,
  error,
  platform,
}: {
  command: string;
  error: unknown;
  platform: NodeJS.Platform;
}): Error {
  const code = typeof error === 'object' && error && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  if (code === 'ENOENT' || /spawn .* ENOENT/i.test(message)) {
    const windowsHint = platform === 'win32'
      ? ' Ensure the Codex CLI is installed and reachable on PATH, or set CODEX_REAL_BIN to the full path of codex.exe or codex.cmd.'
      : ' Ensure the Codex CLI is installed and reachable on PATH.';
    return new Error(`Failed to launch Codex app-server with "${command}": command not found.${windowsHint}`);
  }
  return new Error(`Failed to launch Codex app-server with "${command}": ${message}`);
}

function createCodexAppServerExitedError({
  command,
  exitCode,
  stderrTail,
}: {
  command: string;
  exitCode: number;
  stderrTail: string[];
}): Error {
  const detail = stderrTail.length > 0
    ? ` Last stderr: ${stderrTail.join(' | ')}`
    : '';
  return new Error(`Codex app-server exited before opening its WebSocket (command: "${command}", exit code: ${exitCode}).${detail}`);
}

function createCodexConnectTimeoutError({
  command,
  url,
  stderrTail,
}: {
  command: string;
  url: string;
  stderrTail: string[];
}): Error {
  const detail = stderrTail.length > 0
    ? ` Last stderr: ${stderrTail.join(' | ')}`
    : '';
  return new Error(`Timed out connecting to ${url} after launching "${command}".${detail}`);
}

function buildWindowsShellCommandLine(parts: string[]): string {
  return parts.map(quoteWindowsShellArgument).join(' ');
}

function quoteWindowsShellArgument(value: string): string {
  const normalized = String(value ?? '');
  if (!normalized) {
    return '""';
  }
  if (!/[\s"]/u.test(normalized)) {
    return normalized;
  }
  return `"${normalized.replace(/"/g, '""')}"`;
}

async function reservePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to reserve TCP port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function waitForChildExit(child: ChildProcess | null, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!child || child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for Codex child process to exit'));
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
    };
    child.on('exit', onExit);
  });
}

async function terminateChildProcess(child: ChildProcess, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32' && typeof child.pid === 'number') {
    await terminateWindowsProcessTree(child.pid);
    return;
  }
  child.kill('SIGTERM');
  await waitForChildExit(child, 5000).catch(() => {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
    return waitForChildExit(child, 2000).catch(() => {});
  });
}

function terminateWindowsProcessTree(pid: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => {
      resolve();
    });
    killer.on('exit', () => {
      resolve();
    });
  });
}

export { readCodexAccountIdentity };
