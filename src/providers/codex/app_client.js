import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export class CodexAppClient extends EventEmitter {
  constructor({
    codexCliBin,
    launchCommand = null,
    autolaunch = false,
    modelCatalog = [],
    modelCatalogMode = 'merge',
    clientInfo = {
      name: 'codexbridge',
      title: 'CodexBridge',
      version: '0.1.0',
    },
    spawnImpl = spawn,
    webSocketFactory = (url) => new WebSocket(url),
    platform = process.platform,
    logger = createNoopLogger(),
  }) {
    super();
    this.codexCliBin = codexCliBin;
    this.launchCommand = launchCommand;
    this.autolaunch = autolaunch;
    this.modelCatalog = modelCatalog;
    this.modelCatalogMode = modelCatalogMode;
    this.clientInfo = clientInfo;
    this.spawnImpl = spawnImpl;
    this.webSocketFactory = webSocketFactory;
    this.platform = platform;
    this.logger = logger;

    this.child = null;
    this.socket = null;
    this.pending = new Map();
    this.requestId = 0;
    this.port = null;
    this.connected = false;
    this.startPromise = null;
  }

  isConnected() {
    return this.connected;
  }

  async start() {
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

  async stop() {
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
    this.rejectPending(new Error('Codex app client stopped'));
  }

  async listThreads({ limit = 20, cursor = null, searchTerm = null, archived = false } = {}) {
    const result = await this.request('thread/list', {
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

  async readThread(threadId, includeTurns = false) {
    const result = await this.request('thread/read', { threadId, includeTurns }, { timeoutMs: 10_000 });
    return result?.thread ? mapThread(result.thread, includeTurns) : null;
  }

  async startThread({
    cwd = null,
    model = null,
    serviceTier = null,
    sandboxMode = 'workspace-write',
    approvalPolicy = 'on-request',
  } = {}) {
    const result = await this.request('thread/start', {
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

  async resumeThread({ threadId }) {
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
    cwd = null,
    model = null,
    effort = null,
    serviceTier = null,
    sandboxMode = 'workspace-write',
    approvalPolicy = 'on-request',
    collaborationMode = 'default',
    onProgress = null,
    timeoutMs = 15 * 60 * 1000,
  }) {
    const result = await this.request('turn/start', {
      threadId,
      input: [{
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
      }),
    }, { timeoutMs: 30_000 });
    const turn = result?.turn;
    if (!turn?.id) {
      throw new Error('Codex turn/start returned no turn id');
    }
    return this.waitForTurnResult({
      threadId,
      turnId: String(turn.id),
      onProgress,
      timeoutMs,
    });
  }

  async interruptTurn({ threadId, turnId }) {
    await this.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 15_000 });
  }

  async listModels() {
    const models = [];
    let cursor = null;
    do {
      const result = await this.request('model/list', {
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

  async startServer() {
    if (this.autolaunch && this.launchCommand?.trim()) {
      const launcher = this.spawnImpl(this.launchCommand, {
        shell: true,
        detached: true,
        stdio: 'ignore',
      });
      launcher.unref?.();
    }
    this.port = await reservePort();
    this.child = this.spawnImpl(this.codexCliBin, ['app-server', '--listen', `ws://127.0.0.1:${this.port}`], {
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

  async connectWebSocket() {
    const url = `ws://127.0.0.1:${this.port}`;
    const started = Date.now();
    while (Date.now() - started < 10_000) {
      try {
        await new Promise((resolve, reject) => {
          const ws = this.webSocketFactory(url);
          const onError = (error) => {
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

  async initialize() {
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

  async request(method, params, { timeoutMs = 30_000 } = {}) {
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

  send(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Codex app-server socket is not open');
    }
    this.socket.send(JSON.stringify(payload));
  }

  handleMessage(raw) {
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
      this.emit('notification', message);
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  async waitForTurnResult({ threadId, turnId, onProgress, timeoutMs }) {
    const deadline = Date.now() + timeoutMs;
    let firstTerminalWithoutOutputAt = null;
    let lastTurnSnapshotKey = null;
    let stableTerminalReadCount = 0;
    const terminalSettleMs = computeTerminalSettleMs(timeoutMs);
    const progressState = {
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
      progressState.lastAssistantActivityAt = Date.now();
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
    this.on('notification', onNotification);
    try {
      while (Date.now() < deadline) {
        let thread = null;
        try {
          thread = await this.readThread(threadId, true);
        } catch (error) {
          if (isThreadMaterializationPendingError(error)) {
            await sleep(1000);
            continue;
          }
          if (isRequestTimeoutError(error)) {
            await sleep(1000);
            continue;
          }
          throw error;
        }
        const turn = thread?.turns?.find((entry) => entry.id === turnId) ?? null;
        if (turn && isTurnTerminal(turn.status)) {
          const outputText = extractTurnOutputText(turn);
          if (outputText) {
            return {
              turnId,
              threadId,
              title: thread?.title ?? null,
              outputText,
              outputState: 'complete',
              previewText: progressState.finalAnswerText,
              finalSource: 'thread_items',
              status: turn.status,
            };
          }
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
          if (shouldWaitForSettledOutputAfterTerminalTurn(turn, progressState)) {
            const snapshotKey = buildTurnSnapshotKey(turn);
            if (snapshotKey === lastTurnSnapshotKey) {
              stableTerminalReadCount += 1;
            } else {
              lastTurnSnapshotKey = snapshotKey;
              stableTerminalReadCount = 1;
            }
            firstTerminalWithoutOutputAt ??= Date.now();
            if (
              Date.now() - firstTerminalWithoutOutputAt < terminalSettleMs
              || stableTerminalReadCount < 3
            ) {
              await sleep(1000);
              continue;
            }
          }
          if (hasUnsettledAssistantActivity(turn, progressState) && Date.now() + 1000 < deadline) {
            await sleep(1000);
            continue;
          }
          return {
            turnId,
            threadId,
            title: thread?.title ?? null,
            outputText: '',
            outputState: progressState.finalAnswerText ? 'partial' : 'missing',
            previewText: progressState.finalAnswerText,
            finalSource: progressState.finalAnswerText ? 'progress_only' : 'none',
            status: turn.status,
          };
        }
        await sleep(1000);
      }
      throw new Error(`Timed out waiting for Codex turn ${turnId}`);
    } finally {
      this.off('notification', onNotification);
    }
  }
}

function serializeCollaborationMode({ collaborationMode, model, effort }) {
  if (!collaborationMode) {
    return null;
  }
  const settings = {
    model,
    developer_instructions: '',
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

function extractAllAssistantVisibleText(turn) {
  return turn.items
    .filter((item) => isAssistantVisibleItem(item))
    .map((item) => item.text)
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function shouldWaitForSettledOutputAfterTerminalTurn(turn, progressState = {}) {
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

function hasUnsettledAssistantActivity(turn, progressState = {}) {
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

async function reservePort() {
  return new Promise((resolve, reject) => {
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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
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
