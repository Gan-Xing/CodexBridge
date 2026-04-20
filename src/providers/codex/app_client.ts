import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type {
  ProviderApprovalRequest,
  ProviderUsageReport,
  ProviderThreadListResult,
  ProviderThreadStartResult,
  ProviderThreadSummary,
  ProviderTurnProgress,
  ProviderTurnResult,
} from '../../types/provider.js';

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

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

interface PendingApproval {
  rpcId: string;
  transportKind: 'v2_command' | 'v2_file_change' | 'v2_permissions' | 'legacy_exec' | 'legacy_apply_patch';
  request: ProviderApprovalRequest;
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

  requestId: number;

  port: number | null;

  connected: boolean;

  startPromise: Promise<void> | null;

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
    this.requestId = 0;
    this.port = null;
    this.connected = false;
    this.startPromise = null;
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
    const child = this.child;
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await waitForChildExit(child, 5000).catch(() => {
        if (child.exitCode === null) {
          child.kill('SIGKILL');
        }
        return waitForChildExit(child, 2000).catch(() => {});
      });
    }
    this.child = null;
    this.pendingApprovals.clear();
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
    sandboxMode?: string;
    approvalPolicy?: string;
    collaborationMode?: string;
    developerInstructions?: string;
    onProgress?: ((progress: ProviderTurnProgress) => Promise<void> | void) | null;
    onTurnStarted?: ((meta: Record<string, unknown>) => Promise<void> | void) | null;
    onApprovalRequest?: ((request: ProviderApprovalRequest) => Promise<void> | void) | null;
    timeoutMs?: number;
  }): Promise<ProviderTurnResult> {
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
      personality: null,
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
    this.pendingApprovals.delete(String(requestId));
    this.send({
      jsonrpc: '2.0',
      id: pending.rpcId,
      result,
    });
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

  async startServer(): Promise<void> {
    if (this.autolaunch && this.launchCommand?.trim()) {
      const launcher = this.spawnImpl(this.launchCommand, {
        shell: true,
        detached: true,
        stdio: 'ignore',
      });
      launcher.unref?.();
    }
    this.port = await reservePort();
    const featureArgs = this.enabledFeatures.flatMap((feature) => ['--enable', feature]);
    this.child = this.spawnImpl(this.codexCliBin, ['app-server', ...featureArgs, '--listen', `ws://127.0.0.1:${this.port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stderr?.on('data', (chunk) => {
      this.logger.debug?.(`codex.stderr ${String(chunk).trim()}`);
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
    while (Date.now() - started < 10_000) {
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
    throw new Error(`Timed out connecting to ${url}`);
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) {
          return;
        }
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Codex JSON-RPC response to ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
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
    try {
      while (this.turnPollNow() < deadline) {
        let thread = null;
        try {
          thread = await this.readThread(threadId, true);
        } catch (error) {
          if (isThreadMaterializationPendingError(error)) {
            await this.turnPollSleep(1000);
            continue;
          }
          if (isRequestTimeoutError(error)) {
            await this.turnPollSleep(1000);
            continue;
          }
          throw error;
        }
        const turn = thread?.turns?.find((entry) => entry.id === turnId) ?? null;
        if (turn && isTurnTerminal(turn.status)) {
          const outputText = extractTurnOutputText(turn);
          if (outputText) {
            const outputArtifacts = extractTurnOutputArtifacts(turn);
            return {
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
          }
          const outputArtifacts = extractTurnOutputArtifacts(turn);
          if (outputArtifacts.length > 0) {
            return {
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
          }
          const sessionState = inspectTurnCompletionFromSessionPath(thread?.path ?? null, turnId);
          const hasAssistantVisibleItems = turn.items.some((item) => isAssistantVisibleItem(item));
          const completionState = classifyTurnCompletionState(turn);
          if (completionState === 'interrupted') {
            return {
              turnId,
              threadId,
              title: thread?.title ?? null,
              outputText: '',
              outputState: 'interrupted',
              previewText: progressState.finalAnswerText,
              finalSource: progressState.finalAnswerText ? 'progress_only' : 'none',
              status: turn.status,
            };
          }
          if (turn.error) {
            throw new Error(turn.error);
          }
          if (sessionState.lastAgentMessage && hasAssistantVisibleItems) {
            return {
              turnId,
              threadId,
              title: thread?.title ?? null,
              outputText: sessionState.lastAgentMessage,
              outputState: 'complete',
              previewText: progressState.finalAnswerText,
              finalSource: 'session_task_complete',
              status: turn.status,
            };
          }
          const sessionTaskCompleteNeedsMaterializationWait = sessionState.hasTaskComplete && !hasAssistantVisibleItems;
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
              await this.turnPollSleep(1000);
              continue;
            }
          }
          if (sessionState.lastAgentMessage) {
            return {
              turnId,
              threadId,
              title: thread?.title ?? null,
              outputText: sessionState.lastAgentMessage,
              outputState: 'complete',
              previewText: progressState.finalAnswerText,
              finalSource: 'session_task_complete',
              status: turn.status,
            };
          }
          if (sessionState.hasTaskComplete) {
            const previewText = resolveTurnPreviewText(turn, progressState);
            return {
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
          }
          if (hasUnsettledAssistantActivity(turn, progressState)) {
            if (this.turnPollNow() + 1000 < deadline) {
              await this.turnPollSleep(1000);
              continue;
            }
            const previewText = resolveTurnPreviewText(turn, progressState);
            if (previewText) {
              return {
                turnId,
                threadId,
                title: thread?.title ?? null,
                outputText: '',
                outputState: 'partial',
                previewText,
                finalSource: progressState.finalAnswerText ? 'progress_only' : 'commentary_only',
                status: turn.status,
              };
            }
            throw new Error(`Timed out waiting for Codex turn ${turnId}`);
          }
          const previewText = resolveTurnPreviewText(turn, progressState);
          return {
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
        }
        await this.turnPollSleep(1000);
      }
      const previewText = progressState.finalAnswerText || progressState.commentaryText;
      if (previewText) {
        return {
          turnId,
          threadId,
          title: null,
          outputText: '',
          outputState: 'partial',
          previewText,
          finalSource: progressState.finalAnswerText ? 'progress_only' : 'commentary_only',
          status: null,
        };
      }
      throw new Error(`Timed out waiting for Codex turn ${turnId}`);
    } finally {
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

function isTurnTerminal(status) {
  const normalized = String(status ?? '').toLowerCase();
  return Boolean(normalized) && !['pending', 'running', 'in_progress', 'active'].includes(normalized);
}

function isThreadMaterializationPendingError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /not materialized yet/i.test(message)
    || /includeTurns is unavailable before first user message/i.test(message);
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
      return {
        hasTaskComplete: true,
        lastAgentMessage,
      };
    }
  } catch {
    return {
      hasTaskComplete: false,
      lastAgentMessage: null,
    };
  }
  return {
    hasTaskComplete: false,
    lastAgentMessage: null,
  };
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

export function readCodexAccountIdentity(authPath = path.join(os.homedir(), '.codex', 'auth.json')) {
  try {
    const raw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    const idPayload = decodeJwtPayload(typeof raw.tokens?.id_token === 'string' ? raw.tokens.id_token : null);
    return {
      email: firstString(idPayload?.email),
      name: firstString(idPayload?.name),
      authMode: firstString(raw.auth_mode, idPayload?.auth_provider),
      accountId: firstString(raw.account_id),
    };
  } catch {
    return null;
  }
}

function decodeJwtPayload(token) {
  if (!token) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) {
    return null;
  }
  try {
    const normalized = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(parts[1].length / 4) * 4, '=');
    return JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
