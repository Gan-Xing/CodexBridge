import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export class CodexAppClient {
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
    if (this.child && this.child.exitCode === null) {
      this.child.kill('SIGTERM');
    }
    this.child = null;
    this.rejectPending(new Error('Codex app client stopped'));
  }

  async listThreads({ limit = 20, searchTerm = null } = {}) {
    const result = await this.request('thread/list', {
      limit,
      sortKey: 'updated_at',
      searchTerm,
      archived: false,
    });
    const rows = Array.isArray(result?.data) ? result.data : [];
    return rows.map(mapThreadSummary);
  }

  async readThread(threadId, includeTurns = false) {
    const result = await this.request('thread/read', { threadId, includeTurns });
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
    });
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
    });
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
    });
    const turn = result?.turn;
    if (!turn?.id) {
      throw new Error('Codex turn/start returned no turn id');
    }
    return this.waitForTurnResult({
      threadId,
      turnId: String(turn.id),
      timeoutMs,
    });
  }

  async interruptTurn({ threadId, turnId }) {
    await this.request('turn/interrupt', { threadId, turnId });
  }

  async listModels() {
    const models = [];
    let cursor = null;
    do {
      const result = await this.request('model/list', {
        cursor,
        limit: 100,
        includeHidden: false,
      });
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
    });
    this.send({ jsonrpc: '2.0', method: 'initialized' });
  }

  async request(method, params) {
    if (!this.socket || !this.connected) {
      await this.start();
    }
    const id = String(++this.requestId);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  async waitForTurnResult({ threadId, turnId, timeoutMs }) {
    const deadline = Date.now() + timeoutMs;
    let firstTerminalWithoutOutputAt = null;
    while (Date.now() < deadline) {
      let thread = null;
      try {
        thread = await this.readThread(threadId, true);
      } catch (error) {
        if (isThreadMaterializationPendingError(error)) {
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
            status: turn.status,
          };
        }
        if (turn.error) {
          throw new Error(turn.error);
        }
        if (turnContainsOnlyUserVisibleItems(turn)) {
          firstTerminalWithoutOutputAt ??= Date.now();
          if (Date.now() - firstTerminalWithoutOutputAt < 10_000) {
            await sleep(1000);
            continue;
          }
        }
        return {
          turnId,
          threadId,
          title: thread?.title ?? null,
          outputText: '',
          status: turn.status,
        };
      }
      await sleep(1000);
    }
    throw new Error(`Timed out waiting for Codex turn ${turnId}`);
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
    updatedAt: Number(raw.updatedAt || 0),
    preview: typeof raw.preview === 'string' ? raw.preview : '',
  };
}

function mapThread(raw, includeTurns) {
  return {
    threadId: String(raw.id),
    title: raw.name ? String(raw.name) : null,
    cwd: raw.cwd ? String(raw.cwd) : null,
    updatedAt: Number(raw.updatedAt || 0),
    turns: includeTurns && Array.isArray(raw.turns) ? raw.turns.map(mapTurn) : [],
  };
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

function extractTurnOutputText(turn) {
  return turn.items
    .filter((item) => {
      const type = String(item.type ?? '').toLowerCase();
      const phase = String(item.phase ?? '').toLowerCase();
      return type.includes('assistant') || phase.startsWith('final');
    })
    .map((item) => item.text)
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function turnContainsOnlyUserVisibleItems(turn) {
  const visibleItems = turn.items.filter((item) => item.text);
  return visibleItems.length > 0 && visibleItems.every((item) => {
    const type = String(item.type ?? '').toLowerCase();
    const phase = String(item.phase ?? '').toLowerCase();
    return type.includes('user') && !phase.startsWith('final');
  });
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
