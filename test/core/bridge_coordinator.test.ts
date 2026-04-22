import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCodexBridgeRuntime } from '../../src/runtime/bootstrap.js';

class FakeProviderPlugin {
  kind: string;
  displayName: string;
  replyPrefix: string;
  models: any[];
  startThreadCalls: any[];
  resumeThreadCalls: any[];
  startTurnCalls: any[];
  interruptTurnCalls: any[];
  respondToApprovalCalls: any[];
  listModelsCalls: any[];
  reconnectProfileCalls: any[];
  usageReport: any;
  threadCounter: number;
  baseTime: number;
  clock: number;
  threads: Map<any, any>;

  constructor(kind: string, options: { replyPrefix?: string; models?: any[] } = {}) {
    const { replyPrefix = '', models = null } = options;
    this.kind = kind;
    this.displayName = kind;
    this.replyPrefix = replyPrefix;
    this.models = models ?? [
      {
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'GPT-5.4',
        description: 'Latest frontier agentic coding model.',
        isDefault: true,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'gpt-5.2-codex',
        model: 'gpt-5.2-codex',
        displayName: 'GPT-5.2-Codex',
        description: 'Frontier codex model.',
        isDefault: false,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'gpt-5.1-codex-max',
        model: 'gpt-5.1-codex-max',
        displayName: 'GPT-5.1-Codex-Max',
        description: 'Codex-optimized flagship for deep and fast reasoning.',
        isDefault: false,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'high',
      },
      {
        id: 'gpt-5.4-mini',
        model: 'gpt-5.4-mini',
        displayName: 'GPT-5.4-Mini',
        description: 'Smaller frontier coding model.',
        isDefault: false,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'gpt-5.3-codex',
        model: 'gpt-5.3-codex',
        displayName: 'GPT-5.3-Codex',
        description: 'Frontier Codex-optimized codex model.',
        isDefault: false,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'gpt-5.3-codex-spark',
        model: 'gpt-5.3-codex-spark',
        displayName: 'GPT-5.3-Codex-Spark',
        description: 'Ultra-fast coding model.',
        isDefault: false,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'gpt-5.2',
        model: 'gpt-5.2',
        displayName: 'GPT-5.2',
        description: 'Optimized for professional work and long-running agents.',
        isDefault: false,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'gpt-5.1-codex-mini',
        model: 'gpt-5.1-codex-mini',
        displayName: 'GPT-5.1-Codex-Mini',
        description: 'Cheaper, faster, but less capable.',
        isDefault: false,
        supportedReasoningEfforts: ['medium', 'high'],
        defaultReasoningEffort: 'medium',
      },
    ];
    this.startThreadCalls = [];
    this.resumeThreadCalls = [];
    this.startTurnCalls = [];
    this.interruptTurnCalls = [];
    this.respondToApprovalCalls = [];
    this.listModelsCalls = [];
    this.reconnectProfileCalls = [];
    this.usageReport = null;
    this.threadCounter = 0;
    this.baseTime = Date.now();
    this.clock = 0;
    this.threads = new Map();
  }

  nextUpdatedAt() {
    this.clock += 1;
    return this.baseTime + this.clock;
  }

  async startThread({ providerProfile, cwd, title, metadata }) {
    this.threadCounter += 1;
    this.startThreadCalls.push({ providerProfile, cwd, title, metadata });
    const thread = {
      threadId: `${providerProfile.id}-thread-${this.threadCounter}`,
      cwd: cwd ?? `/tmp/${providerProfile.id}`,
      title: title ?? `${providerProfile.displayName} thread ${this.threadCounter}`,
      updatedAt: this.nextUpdatedAt(),
      preview: '',
      turns: [],
    };
    this.threads.set(thread.threadId, thread);
    return thread;
  }

  async readThread({ threadId, includeTurns = false }) {
    const thread = this.threads.get(threadId) ?? null;
    if (!thread) {
      return null;
    }
    return {
      ...thread,
      turns: includeTurns ? thread.turns : [],
    };
  }

  async listThreads({ limit = 20, cursor = null, searchTerm = null } = {}) {
    const offset = cursor ? Number(cursor) : 0;
    const normalizedSearch = String(searchTerm ?? '').trim().toLowerCase();
    const filtered = [...this.threads.values()]
      .filter((thread) => {
        if (!normalizedSearch) {
          return true;
        }
        const haystack = [thread.threadId, thread.title, thread.preview]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(normalizedSearch);
      })
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    const items = filtered.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    return {
      items,
      nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
    };
  }

  async resumeThread({ threadId }) {
    this.resumeThreadCalls.push({ threadId });
    const existingThread = this.threads.get(threadId);
    if (!existingThread) {
      const restored = {
        threadId,
        cwd: '/tmp/restored',
        title: `restored ${threadId}`,
        updatedAt: this.nextUpdatedAt(),
        preview: '',
        turns: [],
      };
      this.threads.set(threadId, restored);
      return restored;
    }
    return this.threads.get(threadId) ?? null;
  }

  async startTurn({ providerProfile, bridgeSession, sessionSettings, event, inputText, onTurnStarted = null }) {
    this.startTurnCalls.push({ providerProfile, bridgeSession, sessionSettings, event, inputText });
    const existingThread = this.threads.get(bridgeSession.codexThreadId);
    if (!existingThread) {
      throw new Error(`thread not found: ${bridgeSession.codexThreadId}`);
    }
    const turnId = `${bridgeSession.codexThreadId}-turn-${existingThread.turns.length + 1}`;
    if (typeof onTurnStarted === 'function') {
      await onTurnStarted({
        turnId,
        threadId: bridgeSession.codexThreadId,
      });
    }
    const outputText = `${this.replyPrefix}: ${inputText}`;
    this.threads.set(bridgeSession.codexThreadId, {
      ...existingThread,
      updatedAt: this.nextUpdatedAt(),
      preview: inputText,
      turns: [
        ...existingThread.turns,
        {
          id: turnId,
          status: 'complete',
          error: null,
          items: [
            { role: 'user', text: inputText, type: 'message', phase: 'final' },
            { role: 'assistant', text: outputText, type: 'message', phase: 'final' },
          ],
        },
      ],
    });
    return {
      outputText,
      turnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  }

  async interruptTurn({ providerProfile, threadId, turnId }) {
    this.interruptTurnCalls.push({ providerProfile, threadId, turnId });
  }

  async respondToApproval({ providerProfile, request, option }) {
    this.respondToApprovalCalls.push({ providerProfile, request, option });
  }

  async listModels() {
    this.listModelsCalls.push({});
    return this.models;
  }

  async reconnectProfile() {
    this.reconnectProfileCalls.push({});
    return {
      connected: true,
      accountIdentity: null,
    };
  }

  async getUsage() {
    return this.usageReport ?? null;
  }
}

function makeProviderProfile(id, providerKind, displayName) {
  const now = Date.now();
  return {
    id,
    providerKind,
    displayName,
    config: {},
    createdAt: now,
    updatedAt: now,
  };
}

function makeRuntime({
  defaultCwd = null,
  restartBridge = null,
  locale = null,
  platformPlugins = [],
  codexAuthManager = null,
} = {}) {
  const openai = new FakeProviderPlugin('openai-native', { replyPrefix: 'openai' });
  const minimax = new FakeProviderPlugin('minimax-via-cliproxy', { replyPrefix: 'minimax' });
  const runtime = createCodexBridgeRuntime({
    platformPlugins,
    providerPlugins: [openai, minimax],
    providerProfiles: [
      makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default'),
      makeProviderProfile('minimax-default', 'minimax-via-cliproxy', 'MiniMax Default'),
    ],
    defaultProviderProfileId: 'openai-default',
    defaultCwd,
    locale,
    restartBridge,
    codexAuthManager,
  });
  return { runtime, openai, minimax };
}

function makeUsageReport(overrides = {}) {
  return {
    provider: 'codex',
    accountId: 'acct-usage-1',
    userId: null,
    email: 'ganxing@example.com',
    plan: 'pro',
    buckets: [
      {
        name: 'Codex',
        allowed: true,
        limitReached: false,
        windows: [
          {
            name: 'Primary',
            usedPercent: 23,
            windowSeconds: 18_000,
            resetAfterSeconds: 3_600,
            resetAtUnix: 0,
          },
          {
            name: 'Secondary',
            usedPercent: 42,
            windowSeconds: 604_800,
            resetAfterSeconds: 172_800,
            resetAtUnix: 0,
          },
        ],
      },
    ],
    credits: null,
    ...overrides,
  };
}

function makeFakeCodexAuthManager({
  accounts = [],
  activeAccountId = null,
  pendingLogin = null,
  refreshResults = [],
  startError = null,
} = {}) {
  const state = {
    accounts: accounts.map((account) => ({ ...account })),
    activeAccountId,
    pendingLogin: pendingLogin ? { ...pendingLogin } : null,
    refreshResults: [...refreshResults],
  };
  const startCalls = [];
  const switchCalls = [];
  const cancelCalls = [];

  const decorateAccount = (account) => ({
    ...account,
    isActive: state.activeAccountId === account.id,
  });

  return {
    state,
    startCalls,
    switchCalls,
    cancelCalls,
    async startDeviceLogin(params: { requestedByScope?: string | null } = {}) {
      startCalls.push(params);
      if (startError) {
        throw startError;
      }
      if (!state.pendingLogin) {
        state.pendingLogin = {
          flowId: 'flow-1',
          verificationUriComplete: 'https://auth.openai.com/activate?user_code=ABCD-EFGH',
          verificationUri: 'https://auth.openai.com/activate',
          userCode: 'ABCD-EFGH',
          expiresAt: Date.now() + 15 * 60_000,
          requestedByScope: params.requestedByScope ?? null,
        };
      } else {
        state.pendingLogin = {
          ...state.pendingLogin,
          requestedByScope: params.requestedByScope ?? state.pendingLogin.requestedByScope ?? null,
        };
      }
      return { ...state.pendingLogin };
    },
    async refreshPendingLogin() {
      if (state.refreshResults.length > 0) {
        const next = state.refreshResults.shift();
        if (next?.status === 'completed' && next.account) {
          const existingIndex = state.accounts.findIndex((account) => account.id === next.account.id);
          if (existingIndex >= 0) {
            state.accounts[existingIndex] = { ...next.account };
          } else {
            state.accounts.push({ ...next.account });
          }
          state.pendingLogin = null;
        } else if (next?.status === 'pending' && next.pendingLogin) {
          state.pendingLogin = { ...next.pendingLogin };
        } else if (next?.status === 'expired' || next?.status === 'failed') {
          state.pendingLogin = null;
        }
        return next ?? null;
      }
      if (!state.pendingLogin) {
        return null;
      }
      return {
        status: 'pending',
        pendingLogin: { ...state.pendingLogin },
      };
    },
    async cancelPendingLogin() {
      cancelCalls.push(true);
      const hadPending = Boolean(state.pendingLogin);
      state.pendingLogin = null;
      return hadPending;
    },
    async listAccounts() {
      return {
        accounts: state.accounts.map(decorateAccount),
        activeAccountId: state.activeAccountId,
        pendingLogin: state.pendingLogin ? { ...state.pendingLogin } : null,
      };
    },
    async switchAccountByIndex(index) {
      switchCalls.push(index);
      const account = state.accounts[index - 1];
      if (!account) {
        throw new Error(`Account ${index} not found`);
      }
      state.activeAccountId = account.id;
      return {
        account: decorateAccount(account),
        authPath: '/tmp/.codex/auth.json',
        refreshed: true,
      };
    },
  };
}

function createTempAttachment(fileName: string, content = 'attachment') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-upload-test-'));
  const filePath = path.join(directory, fileName);
  fs.writeFileSync(filePath, content);
  return filePath;
}

async function waitForCondition(predicate, { timeoutMs = 1000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

test('bridge coordinator creates a default-provider session for normal text and starts a turn', async () => {
  const { runtime, openai } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello codexbridge',
  });

  assert.equal(result.type, 'message');
  assert.match(result.messages[0]?.text ?? '', /openai: hello codexbridge/);
  assert.equal(result.session?.providerProfileId, 'openai-default');
  assert.equal(openai.startThreadCalls.length, 1);
  assert.equal(openai.startTurnCalls.length, 1);
});

test('bridge coordinator returns generated image outputs as media messages', async () => {
  const { runtime, openai } = makeRuntime();
  const imagePath = createTempAttachment('generated-dog.png', 'png');
  openai.startTurn = async ({ bridgeSession, inputText, onTurnStarted = null }) => {
    const turnId = `${bridgeSession.codexThreadId}-turn-generated-image`;
    if (typeof onTurnStarted === 'function') {
      await onTurnStarted({
        turnId,
        threadId: bridgeSession.codexThreadId,
      });
    }
    return {
      outputText: `openai: ${inputText}`,
      outputMedia: [{
        kind: 'image',
        path: imagePath,
        caption: null,
      }],
      turnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-image-1',
    text: '画一只小狗',
  });

  assert.equal(result.type, 'message');
  assert.equal(result.messages[0]?.text, 'openai: 画一只小狗');
  assert.equal(result.messages[1]?.mediaPath, imagePath);
});

test('bridge coordinator strips hidden artifact manifests and returns declared file attachments as media messages', async () => {
  const { runtime, openai } = makeRuntime({ defaultCwd: '/tmp/codexbridge-artifact-manifest' });
  openai.startTurn = async ({ bridgeSession, inputText, event, onTurnStarted = null }) => {
    const turnId = `${bridgeSession.codexThreadId}-turn-artifact-1`;
    if (typeof onTurnStarted === 'function') {
      await onTurnStarted({
        turnId,
        threadId: bridgeSession.codexThreadId,
      });
    }
    const artifactDir = String(event?.metadata?.codexbridge?.turnArtifactContext?.artifactDir ?? '').trim();
    assert.ok(artifactDir);
    const declaredPath = path.join(artifactDir, 'summary.docx');
    fs.mkdirSync(path.dirname(declaredPath), { recursive: true });
    fs.writeFileSync(declaredPath, 'word-output');
    return {
      outputText: `已整理成 Word 文档。\n\n\`\`\`codexbridge-artifacts\n[{"path":"${declaredPath}","kind":"file","displayName":"summary.docx","caption":"Word 文档"}]\n\`\`\``,
      turnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-file-1',
    text: '把这次未提交修改整理成 Word 文档发我',
  });

  assert.equal(result.type, 'message');
  assert.equal(result.messages[0]?.text, '已整理成 Word 文档。');
  assert.ok(result.messages[0]?.text?.includes('codexbridge-artifacts') === false);
  assert.ok(typeof result.messages[1]?.mediaPath === 'string' && result.messages[1]?.mediaPath.endsWith('summary.docx'));
  assert.match(String(result.messages[1]?.mediaPath ?? ''), /artifact-spool/);
  assert.equal(fs.existsSync(String(result.messages[1]?.mediaPath ?? '')), true);
});

test('bridge coordinator recognizes "md 文件" requests and returns the markdown deliverable as media', async () => {
  const { runtime, openai } = makeRuntime({ defaultCwd: '/tmp/codexbridge-artifact-markdown' });
  openai.startTurn = async ({ bridgeSession, event, onTurnStarted = null }) => {
    const turnId = `${bridgeSession.codexThreadId}-turn-artifact-md-1`;
    if (typeof onTurnStarted === 'function') {
      await onTurnStarted({
        turnId,
        threadId: bridgeSession.codexThreadId,
      });
    }
    const artifactDir = String(event?.metadata?.codexbridge?.turnArtifactContext?.artifactDir ?? '').trim();
    assert.ok(artifactDir);
    const declaredPath = path.join(artifactDir, 'response.md');
    fs.mkdirSync(path.dirname(declaredPath), { recursive: true });
    fs.writeFileSync(declaredPath, '# Markdown Summary');
    return {
      outputText: `Markdown 已整理完成。\n\n\`\`\`codexbridge-artifacts\n[{"path":"${declaredPath}","kind":"file","displayName":"response.md","caption":"Markdown 文件"}]\n\`\`\``,
      turnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-file-md-1',
    text: '帮我整理成一个 md 文件发给我',
  });

  assert.equal(result.type, 'message');
  assert.equal(result.messages[0]?.text, 'Markdown 已整理完成。');
  assert.ok(result.messages[0]?.text?.includes('codexbridge-artifacts') === false);
  assert.ok(typeof result.messages[1]?.mediaPath === 'string' && result.messages[1]?.mediaPath.endsWith('response.md'));
  assert.match(String(result.messages[1]?.mediaPath ?? ''), /artifact-spool/);
  assert.equal(fs.existsSync(String(result.messages[1]?.mediaPath ?? '')), true);
});

test('bridge coordinator clarification flow turns "把文件直接发送给我" + "Markdown" into a markdown attachment response', async () => {
  const { runtime, openai } = makeRuntime({ defaultCwd: '/tmp/codexbridge-artifact-clarify-md' });
  openai.startTurn = async ({ bridgeSession, event, onTurnStarted = null }) => {
    const turnId = `${bridgeSession.codexThreadId}-turn-artifact-clarify-md-1`;
    if (typeof onTurnStarted === 'function') {
      await onTurnStarted({
        turnId,
        threadId: bridgeSession.codexThreadId,
      });
    }
    const artifactDir = String(event?.metadata?.codexbridge?.turnArtifactContext?.artifactDir ?? '').trim();
    assert.ok(artifactDir);
    const declaredPath = path.join(artifactDir, 'deliverable.md');
    fs.mkdirSync(path.dirname(declaredPath), { recursive: true });
    fs.writeFileSync(declaredPath, '# Clarified Markdown');
    return {
      outputText: `已作为 \`.md\` 附件返回。\n\n\`\`\`codexbridge-artifacts\n[{"path":"${declaredPath}","kind":"file","displayName":"deliverable.md","caption":"final deliverable"}]\n\`\`\``,
      turnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const clarification = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-file-clarify-md-1',
    text: '把文件直接发送给我',
  });
  assert.match(clarification.messages[0]?.text ?? '', /要导出成什么格式/);

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-file-clarify-md-1',
    text: 'Markdown',
  });

  assert.equal(result.type, 'message');
  assert.equal(result.messages[0]?.text, '已作为 `.md` 附件返回。');
  assert.ok(result.messages[0]?.text?.includes('codexbridge-artifacts') === false);
  assert.ok(typeof result.messages[1]?.mediaPath === 'string' && result.messages[1]?.mediaPath.endsWith('deliverable.md'));
  assert.match(String(result.messages[1]?.mediaPath ?? ''), /artifact-spool/);
  assert.equal(fs.existsSync(String(result.messages[1]?.mediaPath ?? '')), true);
});

test('bridge coordinator falls back to a single generated file in the turn artifact directory when the manifest is missing', async () => {
  const { runtime, openai } = makeRuntime({ defaultCwd: '/tmp/codexbridge-artifact-fallback' });
  openai.startTurn = async ({ bridgeSession, event, onTurnStarted = null }) => {
    const turnId = `${bridgeSession.codexThreadId}-turn-artifact-2`;
    if (typeof onTurnStarted === 'function') {
      await onTurnStarted({
        turnId,
        threadId: bridgeSession.codexThreadId,
      });
    }
    const artifactDir = String(event?.metadata?.codexbridge?.turnArtifactContext?.artifactDir ?? '').trim();
    assert.ok(artifactDir);
    const generatedPath = path.join(artifactDir, 'summary.pdf');
    fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
    fs.writeFileSync(generatedPath, 'pdf-output');
    return {
      outputText: 'PDF 已生成。',
      turnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-file-2',
    text: '导出成 PDF 发我',
  });

  assert.equal(result.messages[0]?.text, 'PDF 已生成。');
  assert.ok(typeof result.messages[1]?.mediaPath === 'string' && result.messages[1]?.mediaPath.endsWith('summary.pdf'));
  assert.equal(fs.existsSync(String(result.messages[1]?.mediaPath ?? '')), true);
});

test('bridge coordinator asks once for the export format before starting a generic file-delivery turn', async () => {
  const { runtime, openai } = makeRuntime({ defaultCwd: '/tmp/codexbridge-artifact-clarify' });

  const first = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-file-clarify-1',
    text: '把结果导出一下发我',
  });

  assert.match(first.messages[0]?.text ?? '', /什么格式|PDF|Word|Excel/);
  assert.equal(openai.startTurnCalls.length, 0);

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-file-clarify-1',
    text: 'pdf',
  });

  assert.equal(openai.startTurnCalls.length, 1);
  assert.match(String(openai.startTurnCalls[0]?.inputText ?? ''), /Export the final deliverable as PDF/i);
});

test('bridge coordinator warns when multiple fallback candidates remain ambiguous instead of sending arbitrary attachments', async () => {
  const { runtime, openai } = makeRuntime({ defaultCwd: '/tmp/codexbridge-artifact-ambiguous' });
  openai.startTurn = async ({ bridgeSession, event, onTurnStarted = null }) => {
    const turnId = `${bridgeSession.codexThreadId}-turn-artifact-3`;
    if (typeof onTurnStarted === 'function') {
      await onTurnStarted({
        turnId,
        threadId: bridgeSession.codexThreadId,
      });
    }
    const artifactDir = String(event?.metadata?.codexbridge?.turnArtifactContext?.artifactDir ?? '').trim();
    assert.ok(artifactDir);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'summary-a.pdf'), 'a');
    fs.writeFileSync(path.join(artifactDir, 'summary-b.pdf'), 'b');
    return {
      outputText: 'PDF 已生成。',
      turnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-file-3',
    text: '导出成 PDF 发我',
  });

  const lines = result.messages.map((message) => message.text ?? '').filter(Boolean);
  assert.equal(result.messages.some((message) => Boolean(message.mediaPath)), false);
  assert.equal(lines[0], 'PDF 已生成。');
  assert.ok(lines.some((line) => /候选文件/.test(line)));
});

test('bridge coordinator uses the runtime default cwd for new sessions', async () => {
  const { runtime, openai } = makeRuntime({ defaultCwd: '/tmp/project' });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-cwd-1',
    text: 'hello codexbridge',
  });

  assert.equal(result.session?.providerProfileId, 'openai-default');
  assert.equal(openai.startThreadCalls[0]?.cwd, '/tmp/project');
  assert.equal(openai.startTurnCalls[0]?.bridgeSession.cwd, '/tmp/project');
});

test('bridge coordinator resumes the same scope session when the bound thread is stale', async () => {
  const { runtime, openai } = makeRuntime();
  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello codexbridge',
  });
  openai.threads.delete(original.session.codexThreadId);

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello again',
  });

  assert.match(result.messages[0]?.text ?? '', /openai: hello again/);
  assert.equal(result.session?.codexThreadId, original.session?.codexThreadId);
  assert.equal(result.session?.bridgeSessionId, original.session?.bridgeSessionId);
  assert.equal(openai.startThreadCalls.length, 1);
  assert.equal(openai.resumeThreadCalls.length, 1);
  assert.equal(openai.startTurnCalls.length, 3);
});

test('bridge coordinator keeps the same binding even when stale thread resume fails', async () => {
  const { runtime, openai } = makeRuntime();
  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello codexbridge',
  });
  openai.threads.delete(original.session.codexThreadId);
  openai.resumeThread = async ({ threadId }) => {
    openai.resumeThreadCalls.push({ threadId });
    throw new Error(`thread not found: ${threadId}`);
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello again',
  });

  assert.equal(result.messages[0]?.text ?? '', '');
  assert.equal(result.meta?.codexTurn?.outputState, 'stale_session');

  const rebound = runtime.services.bridgeSessions.resolveScopeSession({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
  });
  assert.equal(rebound?.id, original.session?.bridgeSessionId);
  assert.equal(rebound?.codexThreadId, original.session?.codexThreadId);
});

test('bridge coordinator recreates a scope session when Codex reports a damaged rollout file', async () => {
  const { runtime, openai } = makeRuntime();
  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello codexbridge',
  });

  let injected = false;
  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (args) => {
    if (!injected && args.bridgeSession.codexThreadId === original.session.codexThreadId) {
      injected = true;
      throw new Error(`failed to load rollout '/tmp/${original.session.codexThreadId}.jsonl' for thread ${original.session.codexThreadId}: empty session file`);
    }
    return originalStartTurn(args);
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello after rollout damage',
  });

  assert.match(result.messages[0]?.text ?? '', /openai: hello after rollout damage/);
  assert.equal(result.session?.codexThreadId, original.session?.codexThreadId);
  assert.equal(result.session?.bridgeSessionId, original.session?.bridgeSessionId);
  assert.equal(openai.startThreadCalls.length, 1);
});

test('bridge coordinator keeps the same session bound when rollout loading keeps failing', async () => {
  const { runtime, openai } = makeRuntime();
  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello codexbridge',
  });

  openai.startTurn = async ({ bridgeSession }) => {
    throw new Error(`failed to load rollout '/tmp/${bridgeSession.codexThreadId}.jsonl' for thread ${bridgeSession.codexThreadId}: empty session file`);
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello after persistent rollout damage',
  });

  assert.equal(result.meta?.codexTurn?.outputState, 'provider_error');
  assert.match(result.meta?.codexTurn?.errorMessage ?? '', /failed to load rollout/i);

  const rebound = runtime.services.bridgeSessions.resolveScopeSession({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
  });
  assert.equal(rebound?.id, original.session?.bridgeSessionId);
  assert.equal(rebound?.codexThreadId, original.session?.codexThreadId);
});

test('/status reports when no bridge session is bound yet', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/status',
  });

  const lines = result.messages.map((message) => message.text ?? '');
  assert.ok(lines.includes('接口配置：openai-default'));
  assert.ok(lines.includes('默认工作目录：（未设置）'));
  assert.ok(lines.includes('模型：gpt-5.4'));
  assert.ok(lines.includes('推理强度：'));
  assert.ok(lines.includes('权限预设：'));
  assert.ok(lines.includes('完整信息：/status details'));
});

test('/status uses English output when locale is set to en', async () => {
  const { runtime } = makeRuntime({ locale: 'en' });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-en-1',
    text: '/status',
  });

  const lines = result.messages.map((message) => message.text ?? '');
  assert.ok(lines.includes('Interface profile: openai-default'));
  assert.ok(lines.includes('Default working directory: (not set)'));
  assert.ok(lines.includes('Model: gpt-5.4'));
  assert.ok(lines.includes('Reasoning effort: '));
  assert.ok(lines.includes('Access preset: '));
  assert.ok(lines.includes('More details: /status details'));
});

test('/status includes weixin session pause state when the platform exposes it', async () => {
  const weixinPlatform = {
    id: 'weixin',
    getStatus() {
      return {
        data: {
          accountId: 'bot-account',
          sessionPaused: true,
          remainingPauseMinutes: 42,
        },
      };
    },
  };
  const { runtime } = makeRuntime({
    platformPlugins: [weixinPlatform],
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-weixin-1',
    text: '/status',
  });

  const lines = result.messages.map((message) => message.text ?? '');
  assert.ok(lines.some((line) => /微信会话：冷却中/.test(line)));
  assert.ok(lines.every((line) => !/微信账号：/.test(line)));
  assert.ok(lines.every((line) => !/微信上下文 token：/.test(line)));
  assert.ok(lines.every((line) => !/微信冷却剩余：/.test(line)));
});

test('/status includes active-turn state when a session is idle', async () => {
  const { runtime } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-1',
    text: 'hello',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-1',
    text: '/status',
  });

  const lines = result.messages.map((message) => message.text ?? '');
  assert.ok(lines.includes('接口配置：openai-default'));
  assert.ok(lines.includes('会话标题：OpenAI Default thread 1'));
  assert.ok(lines.includes('工作目录：/tmp/openai-default'));
  assert.ok(lines.includes('速度模式：normal'));
  assert.ok(lines.includes('模型：gpt-5.4'));
  assert.ok(lines.includes('推理强度：'));
  assert.ok(lines.includes('权限预设：'));
  assert.ok(lines.includes('完整信息：/status details'));
  assert.ok(lines.every((line) => !/Scope：/.test(line)));
  assert.ok(lines.every((line) => !/当前 Turn：/.test(line)));
  assert.ok(lines.every((line) => !/Turn 状态：/.test(line)));
  assert.ok(lines.every((line) => !/Bridge 会话：/.test(line)));
  assert.ok(lines.every((line) => !/Codex 线程：/.test(line)));
});

test('/status details includes full diagnostics for the current session', async () => {
  const { runtime, openai } = makeRuntime();
  openai.usageReport = makeUsageReport();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-details-1',
    text: 'hello',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-details-1',
    text: '/status details',
  });

  const lines = result.messages.map((message) => message.text ?? '');
  assert.ok(lines.some((line) => /Bridge 会话：/.test(line)));
  assert.ok(lines.some((line) => /会话标题：OpenAI Default thread 1/.test(line)));
  assert.ok(lines.some((line) => /Codex 线程：/.test(line)));
  assert.ok(lines.some((line) => /速度模式：normal/.test(line)));
  assert.ok(lines.some((line) => /审批策略：/.test(line)));
  assert.ok(lines.some((line) => /沙箱模式：/.test(line)));
  assert.ok(lines.every((line) => !/完整信息：\/status details/.test(line)));
});

test('/status details includes the last artifact delivery status for the current session', async () => {
  const { runtime, openai } = makeRuntime({ defaultCwd: '/tmp/codexbridge-status-artifacts' });
  openai.startTurn = async ({ bridgeSession, event, onTurnStarted = null }) => {
    const turnId = `${bridgeSession.codexThreadId}-turn-artifact-status-1`;
    if (typeof onTurnStarted === 'function') {
      await onTurnStarted({
        turnId,
        threadId: bridgeSession.codexThreadId,
      });
    }
    const artifactDir = String(event?.metadata?.codexbridge?.turnArtifactContext?.artifactDir ?? '').trim();
    const declaredPath = path.join(artifactDir, 'summary.docx');
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(declaredPath, 'word-output');
    return {
      outputText: `已整理成 Word 文档。\n\n\`\`\`codexbridge-artifacts\n[{"path":"${declaredPath}","kind":"file","displayName":"summary.docx"}]\n\`\`\``,
      turnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-artifacts-1',
    text: '把摘要整理成 Word 发我',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-artifacts-1',
    text: '/status details',
  });

  const lines = result.messages.map((message) => message.text ?? '');
  assert.ok(lines.some((line) => /附件交付：已选定附件/.test(line)));
  assert.ok(lines.some((line) => /请求格式：docx/.test(line)));
  assert.ok(lines.some((line) => /附件结果：已选 1，拒绝 0/.test(line)));
  assert.ok(lines.some((line) => /产物目录：/.test(line)));
  assert.ok(lines.some((line) => /暂存目录：/.test(line)));
});

test('/status shows the renamed local thread title in simple mode', async () => {
  const { runtime } = makeRuntime();

  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-title-1',
    text: 'hello',
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-title-1',
    text: `/rename ${original.session?.codexThreadId} 微信 Codex`,
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-title-1',
    text: '/status',
  });

  const lines = result.messages.map((message) => message.text ?? '');
  assert.ok(lines.includes('会话标题：微信 Codex'));
});

test('/status details includes weixin diagnostic lines', async () => {
  const weixinPlatform = {
    id: 'weixin',
    getStatus() {
      return {
        data: {
          accountId: 'bot-account',
          sessionPaused: true,
          remainingPauseMinutes: 42,
          hasContextToken: false,
        },
      };
    },
  };
  const { runtime } = makeRuntime({
    platformPlugins: [weixinPlatform],
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-details-weixin-1',
    text: '/status details',
  });

  const lines = result.messages.map((message) => message.text ?? '');
  assert.ok(lines.some((line) => /微信上下文 token：无/.test(line)));
  assert.ok(lines.some((line) => /微信冷却剩余：42 分钟/.test(line)));
});

test('/usage shows account plus 5-hour and weekly remaining quota', async () => {
  const { runtime, openai } = makeRuntime();
  openai.usageReport = makeUsageReport();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-usage-1',
    text: '/usage',
  });

  const lines = result.messages.map((message) => message.text ?? '');
  assert.equal(lines[0], '用量 | openai-default');
  assert.ok(lines.includes('账号：ganxing@example.com (pro)'));
  assert.ok(lines.some((line) => /5 小时剩余：77%（1 小时后重置）/.test(line)));
  assert.ok(lines.some((line) => /本周剩余：58%（2 天后重置）/.test(line)));
});

test('/status includes account and compact usage summary when usage is available', async () => {
  const { runtime, openai } = makeRuntime();
  openai.usageReport = makeUsageReport();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-usage-status-1',
    text: 'hello',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-usage-status-1',
    text: '/status',
  });

  const lines = result.messages.map((message) => message.text ?? '');
  assert.ok(lines.includes('账号：ganxing@example.com (pro)'));
  assert.ok(lines.some((line) => /5 小时剩余：77%（1 小时后重置）/.test(line)));
  assert.ok(lines.some((line) => /本周剩余：58%（2 天后重置）/.test(line)));
});

test('/allow shows pending approval requests for the active turn', async () => {
  const { runtime } = makeRuntime();

  const initial = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-list-1',
    text: 'hello',
  });
  const session = initial.session;
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-list-1',
  };

  runtime.services.activeTurns.beginScopeTurn(scopeRef, {
    bridgeSessionId: session.bridgeSessionId,
    providerProfileId: session.providerProfileId,
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-pending`,
  });
  runtime.services.activeTurns.addPendingApproval(scopeRef, {
    requestId: 'approval-1',
    kind: 'command',
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-pending`,
    itemId: 'item-1',
    reason: 'command failed; retry without sandbox?',
    command: 'npm run build',
    cwd: '/home/ubuntu/dev/CodexBridge',
    availableDecisionKeys: ['accept', 'acceptForSession', 'decline'],
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-list-1',
    text: '/allow',
  });

  const text = result.messages.map((message) => message.text ?? '').join('\n');
  assert.match(text, /审批请求 \| 1 项/);
  assert.match(text, /command failed; retry without sandbox\?/);
  assert.match(text, /\/allow 1：仅批准这一次/);
  assert.match(text, /\/allow 2：在当前会话里记住这次批准/);
  assert.match(text, /\/deny：拒绝这次请求/);
});

test('/allow 2 replies to the provider approval request and clears it from the active turn', async () => {
  const { runtime, openai } = makeRuntime();

  const initial = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-approve-1',
    text: 'hello',
  });
  const session = initial.session;
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-approve-1',
  };

  runtime.services.activeTurns.beginScopeTurn(scopeRef, {
    bridgeSessionId: session.bridgeSessionId,
    providerProfileId: session.providerProfileId,
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-pending`,
  });
  runtime.services.activeTurns.addPendingApproval(scopeRef, {
    requestId: 'approval-2',
    kind: 'command',
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-pending`,
    itemId: 'item-2',
    reason: 'command failed; retry without sandbox?',
    command: 'npm run build',
    cwd: '/home/ubuntu/dev/CodexBridge',
    availableDecisionKeys: ['accept', 'acceptForSession', 'decline'],
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-approve-1',
    text: '/allow 2',
  });

  assert.equal(openai.respondToApprovalCalls.length, 1);
  assert.equal(openai.respondToApprovalCalls[0]?.option, 2);
  assert.equal(openai.respondToApprovalCalls[0]?.request?.requestId, 'approval-2');
  assert.equal(runtime.services.activeTurns.resolveScopeTurn(scopeRef), null);
  assert.match(result.messages[0]?.text ?? '', /已对当前会话记住这次命令执行批准/);
});

test('/allow acknowledges when provider turn has already ended after approval', async () => {
  const { runtime, openai } = makeRuntime();

  const initial = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-ended-1',
    text: 'hello',
  });
  const session = initial.session;
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-ended-1',
  };
  const turnId = `${session.codexThreadId}-turn-pending`;
  runtime.services.activeTurns.beginScopeTurn(scopeRef, {
    bridgeSessionId: session.bridgeSessionId,
    providerProfileId: session.providerProfileId,
    threadId: session.codexThreadId,
    turnId,
  });
  runtime.services.activeTurns.addPendingApproval(scopeRef, {
    requestId: 'approval-ended-1',
    kind: 'command',
    threadId: session.codexThreadId,
    turnId,
    itemId: 'item-ended-1',
    reason: 'command failed; retry without sandbox?',
    command: 'npm run build',
    cwd: '/home/ubuntu/dev/CodexBridge',
    availableDecisionKeys: ['accept', 'acceptForSession', 'decline'],
  });
  const thread = openai.threads.get(session.codexThreadId);
  assert.ok(thread);
  thread.turns = [
    {
      id: turnId,
      status: 'running',
      error: null,
      items: [],
    },
  ];
  openai.respondToApproval = async ({ providerProfile, request, option }) => {
    openai.respondToApprovalCalls.push({ providerProfile, request, option });
    thread.turns = [
      {
        id: turnId,
        status: 'interrupted',
        error: 'Conversation interrupted',
        items: [],
      },
    ];
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-ended-1',
    text: '/allow 2',
  });

  assert.equal(openai.respondToApprovalCalls.length, 1);
  assert.equal(runtime.services.activeTurns.resolveScopeTurn(scopeRef), null);
  assert.match(result.messages[0]?.text ?? '', /已对当前会话记住这次命令执行批准/);
  assert.match(result.messages[1]?.text ?? '', /该回合已经结束/);
});

test('/deny rejects the provider approval request and clears it from the active turn', async () => {
  const { runtime, openai } = makeRuntime();

  const initial = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-deny-1',
    text: 'hello',
  });
  const session = initial.session;
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-deny-1',
  };

  runtime.services.activeTurns.beginScopeTurn(scopeRef, {
    bridgeSessionId: session.bridgeSessionId,
    providerProfileId: session.providerProfileId,
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-pending`,
  });
  runtime.services.activeTurns.addPendingApproval(scopeRef, {
    requestId: 'approval-deny-1',
    kind: 'file_change',
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-pending`,
    itemId: 'item-deny-1',
    reason: 'apply this patch?',
    fileChanges: ['src/app.ts'],
    availableDecisionKeys: ['accept', 'acceptForSession', 'decline'],
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-deny-1',
    text: '/deny',
  });

  assert.equal(openai.respondToApprovalCalls.length, 1);
  assert.equal(openai.respondToApprovalCalls[0]?.option, 3);
  assert.equal(openai.respondToApprovalCalls[0]?.request?.requestId, 'approval-deny-1');
  assert.equal(runtime.services.activeTurns.resolveScopeTurn(scopeRef), null);
  assert.match(result.messages[0]?.text ?? '', /已拒绝这次文件改动请求/);
});

test('commands are blocked by pending approvals until /allow is handled', async () => {
  const { runtime } = makeRuntime();

  const initial = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-blocked-1',
    text: 'hello',
  });
  const session = initial.session;
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-blocked-1',
  };

  runtime.services.activeTurns.beginScopeTurn(scopeRef, {
    bridgeSessionId: session.bridgeSessionId,
    providerProfileId: session.providerProfileId,
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-pending`,
  });
  runtime.services.activeTurns.addPendingApproval(scopeRef, {
    requestId: 'approval-3',
    kind: 'permissions',
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-pending`,
    itemId: 'item-3',
    reason: 'Would you like to make the following edits?',
    networkPermission: true,
    fileReadPermissions: ['/tmp'],
    fileWritePermissions: ['/tmp'],
    availableDecisionKeys: ['accept', 'acceptForSession', 'decline'],
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-blocked-1',
    text: '/permissions full-access',
  });

  const lines = result.messages.map((message) => message.text ?? '');
  assert.ok(lines.some((line) => /当前有待处理的审批请求/.test(line)));
  assert.ok(lines.some((line) => /先用 \/allow 查看，再用 \/allow 1、\/allow 2 或 \/deny 处理/.test(line)));
});

test('stale active turns are reconciled before starting a new conversation turn', async () => {
  const { runtime, openai } = makeRuntime();

  const initial = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-stale-active-1',
    text: 'hello',
  });
  const session = initial.session;
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-stale-active-1',
  };
  const staleTurnId = `${session.codexThreadId}-turn-stale`;
  runtime.services.activeTurns.beginScopeTurn(scopeRef, {
    bridgeSessionId: session.bridgeSessionId,
    providerProfileId: session.providerProfileId,
    threadId: session.codexThreadId,
    turnId: staleTurnId,
  });
  const thread = openai.threads.get(session.codexThreadId);
  assert.ok(thread);
  thread.turns = [
    {
      id: staleTurnId,
      status: 'interrupted',
      error: 'Conversation interrupted',
      items: [],
    },
  ];

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-stale-active-1',
    text: 'hello again',
  });

  assert.match(result.messages[0]?.text ?? '', /openai: hello again/);
  assert.equal(runtime.services.activeTurns.resolveScopeTurn(scopeRef), null);
});

test('conversation turns remain blocked when the previous provider turn is still running', async () => {
  const { runtime, openai } = makeRuntime();
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-running-turn-1',
  };
  let runningTurnId = '';

  openai.startTurn = async ({ bridgeSession, onTurnStarted = null }) => {
    openai.startTurnCalls.push({ bridgeSession });
    const thread = openai.threads.get(bridgeSession.codexThreadId);
    assert.ok(thread);
    runningTurnId = `${bridgeSession.codexThreadId}-turn-${thread.turns.length + 1}`;
    await onTurnStarted?.({
      turnId: runningTurnId,
      threadId: bridgeSession.codexThreadId,
    });
    thread.turns = [{
      id: runningTurnId,
      status: 'running',
      error: null,
      items: [],
    }];
    return {
      outputText: '',
      outputState: 'partial',
      previewText: 'still waiting',
      turnId: runningTurnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const firstResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: 'first request',
  });

  assert.equal(firstResult.meta?.codexTurn?.outputState, 'partial');
  assert.equal(runtime.services.activeTurns.resolveScopeTurn(scopeRef)?.turnId, runningTurnId);

  const secondResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: 'second request',
  });

  const combined = secondResult.messages.map((message) => message.text ?? '').join('\n');
  assert.match(combined, /当前已有一轮回复在进行中/);
  assert.equal(openai.startTurnCalls.length, 1);
});

test('/stop rebinds a phantom active turn id to the live in-progress provider turn', async () => {
  const { runtime, openai } = makeRuntime();

  const initial = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-phantom-stop-1',
    text: 'hello',
  });
  const session = initial.session;
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-phantom-stop-1',
  };
  const liveTurnId = `${session.codexThreadId}-turn-live`;

  runtime.services.activeTurns.beginScopeTurn(scopeRef, {
    bridgeSessionId: session.bridgeSessionId,
    providerProfileId: session.providerProfileId,
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-phantom`,
  });
  const thread = openai.threads.get(session.codexThreadId);
  assert.ok(thread);
  thread.turns = [{
    id: liveTurnId,
    status: 'running',
    error: null,
    items: [],
  }];

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: '/stop',
  });

  assert.equal(result.messages[0]?.text ?? '', '已请求中断当前回复。');
  assert.equal(openai.interruptTurnCalls.length, 1);
  assert.equal(openai.interruptTurnCalls[0]?.turnId, liveTurnId);
  assert.equal(runtime.services.activeTurns.resolveScopeTurn(scopeRef)?.turnId, liveTurnId);
});

test('/stop interrupts every non-terminal turn on the bound thread', async () => {
  const { runtime, openai } = makeRuntime();

  const initial = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-stop-thread-1',
    text: 'hello',
  });
  const session = initial.session;
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-stop-thread-1',
  };
  runtime.services.activeTurns.beginScopeTurn(scopeRef, {
    bridgeSessionId: session.bridgeSessionId,
    providerProfileId: session.providerProfileId,
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-2`,
  });
  runtime.services.activeTurns.addPendingApproval(scopeRef, {
    requestId: 'approval-stop-thread-1',
    kind: 'command',
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-2`,
    itemId: 'item-stop-thread-1',
    reason: 'command failed; retry without sandbox?',
    command: 'npm run build',
    cwd: '/home/ubuntu/dev/CodexBridge',
    availableDecisionKeys: ['accept', 'acceptForSession', 'decline'],
  });
  const thread = openai.threads.get(session.codexThreadId);
  assert.ok(thread);
  thread.turns = [
    {
      id: `${session.codexThreadId}-turn-1`,
      status: 'running',
      error: null,
      items: [],
    },
    {
      id: `${session.codexThreadId}-turn-2`,
      status: 'running',
      error: null,
      items: [],
    },
  ];
  openai.interruptTurn = async (params) => {
    openai.interruptTurnCalls.push(params);
    const currentThread = openai.threads.get(params.threadId);
    assert.ok(currentThread);
    currentThread.turns = currentThread.turns.map((turn) => (
      turn.id === params.turnId
        ? {
          ...turn,
          status: 'interrupted',
          error: 'Conversation interrupted',
          items: [],
        }
        : turn
    ));
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: '/stop',
  });

  assert.equal(openai.interruptTurnCalls.length, 2);
  assert.deepEqual(
    openai.interruptTurnCalls.map((entry) => entry.turnId).sort(),
    [`${session.codexThreadId}-turn-1`, `${session.codexThreadId}-turn-2`].sort(),
  );
  assert.equal(result.messages[0]?.text ?? '', '已请求停止当前线程上的 2 个进行中回合。');
  assert.equal(result.messages[1]?.text ?? '', '已同时清空 1 项待处理审批。');
});

test('/helps lists all supported slash commands and help entrypoints', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/helps',
  });

  const text = result.messages[0]?.text ?? '';
  assert.match(text, /斜杠命令/);
  assert.match(text, /\/helps \(\/help, \/h\) 查看所有斜杠命令/);
  assert.match(text, /\/usage \(\/us\) 查看当前 Codex 账号，以及 5 小时 \/ 本周剩余用量/);
  assert.match(text, /\/login \(\/lg\) 管理本机 Codex 登录账号/);
  assert.match(text, /\/stop \(\/sp\) 请求中断当前正在执行的回复/);
  assert.match(text, /\/uploads \(\/up, \/ul\) 开启上传暂存模式/);
  assert.match(text, /\/provider \(\/pd\) 查看可用 provider/);
  assert.match(text, /\/models \(\/ms\) 列出当前 provider 的可用模型/);
  assert.match(text, /\/model \(\/m\) 查看或切换当前 scope 的模型设置/);
  assert.match(text, /\/fast 开启或关闭 Fast 模式/);
  assert.match(text, /\/threads \(\/th\) 查看当前 provider 的线程列表首页/);
  assert.match(text, /\/search \(\/se\) 按关键词搜索线程标题或 preview/);
  assert.match(text, /\/next \(\/nx\) 翻到当前线程列表的下一页/);
  assert.match(text, /\/prev \(\/pv\) 翻到当前线程列表的上一页/);
  assert.match(text, /\/rename \(\/rn\) 给线程设置本地显示名/);
  assert.match(text, /\/allow \(\/al\) 查看并批准当前回合中的审批请求/);
  assert.match(text, /\/deny \(\/dn\) 拒绝当前回合中的审批请求/);
  assert.match(text, /\/retry \(\/rt\) 在同一线程里重试上一条请求/);
  assert.match(text, /\/lang 查看\/切换当前会话的语言/);
  assert.match(text, /帮助：\/helps <命令>/);
  assert.match(text, /示例：\/helps threads  或  \/threads -h/);
});

test('/helps renders English help text when locale is set to en', async () => {
  const { runtime } = makeRuntime({ locale: 'en' });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-help-en-1',
    text: '/helps',
  });

  const text = result.messages[0]?.text ?? '';
  assert.match(text, /Slash Commands/);
  assert.match(text, /\/helps \(\/help, \/h\) Show all slash commands/);
  assert.match(text, /\/usage \(\/us\) Show the current Codex account plus 5-hour and weekly remaining usage/);
  assert.match(text, /\/login \(\/lg\) Manage the host Codex login account/);
  assert.match(text, /\/uploads \(\/up, \/ul\) Enter upload staging mode/);
  assert.match(text, /\/allow \(\/al\) Inspect and approve in-turn approval requests/);
  assert.match(text, /\/deny \(\/dn\) Deny the current in-turn approval request/);
  assert.match(text, /\/retry \(\/rt\) Retry the previous request in the same thread/);
  assert.match(text, /Help: \/helps <command>/);
  assert.match(text, /\/models \(\/ms\) List available models for the current provider/);
  assert.match(text, /\/model \(\/m\) View or switch model settings for the current scope/);
  assert.match(text, /\/fast Enable or disable Fast mode/);
  assert.match(text, /\/lang Show or switch the current language used for text replies/);
});

test('/login starts a pending Codex device login flow', async () => {
  const codexAuthManager = makeFakeCodexAuthManager();
  const { runtime } = makeRuntime({ codexAuthManager });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-login-start-1',
    text: '/login',
  });

  const text = result.messages.map((message) => message.text ?? '').join('\n');
  assert.match(text, /Codex 登录 \| 等待授权/);
  assert.match(text, /链接：https:\/\/auth\.openai\.com\/activate\?user_code=ABCD-EFGH/);
  assert.match(text, /验证码：ABCD-EFGH/);
  assert.match(text, /这是全局 Codex 登录/);
  assert.equal(codexAuthManager.startCalls.length, 1);
});

test('/login returns a friendly message when the OpenAI device endpoint is blocked', async () => {
  const codexAuthManager = makeFakeCodexAuthManager({
    startError: new Error('Device login request failed: <!DOCTYPE html><title>Just a moment...</title>'),
  });
  const { runtime } = makeRuntime({ codexAuthManager });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-login-start-blocked',
    text: '/login',
  });

  const text = result.messages.map((message) => message.text ?? '').join('\n');
  assert.match(text, /无法开始 Codex 登录/);
  assert.match(text, /被 Cloudflare 拦截/);
});

test('/login list shows saved Codex accounts and marks the active one', async () => {
  const codexAuthManager = makeFakeCodexAuthManager({
    accounts: [
      { id: 'acct-1', email: 'a@example.com', planType: 'pro' },
      { id: 'acct-2', email: 'b@example.com', planType: 'plus' },
    ],
    activeAccountId: 'acct-2',
  });
  const { runtime } = makeRuntime({ codexAuthManager });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-login-list-1',
    text: '/login list',
  });

  const text = result.messages.map((message) => message.text ?? '').join('\n');
  assert.match(text, /Codex 账号池 \| 2 个账号/);
  assert.match(text, /1\. a@example\.com \| pro/);
  assert.match(text, /2\. b@example\.com \| 当前 \| plus/);
  assert.match(text, /切换：\/login <序号>/);
});

test('/login reports completion when a pending authorization has just finished', async () => {
  const codexAuthManager = makeFakeCodexAuthManager({
    pendingLogin: {
      flowId: 'flow-1',
      verificationUriComplete: 'https://auth.openai.com/activate?user_code=ABCD-EFGH',
      userCode: 'ABCD-EFGH',
      expiresAt: Date.now() + 10_000,
    },
    refreshResults: [
      {
        status: 'completed',
        account: {
          id: 'acct-1',
          email: 'done@example.com',
          planType: 'pro',
        },
      },
    ],
  });
  const { runtime } = makeRuntime({ codexAuthManager });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-login-done-1',
    text: '/login',
  });

  const text = result.messages.map((message) => message.text ?? '').join('\n');
  assert.match(text, /Codex 登录已完成，并已保存到本机/);
  assert.match(text, /账号：done@example\.com/);
  assert.match(text, /套餐：pro/);
});

test('/login 1 switches the active Codex account and reconnects native providers', async () => {
  const codexAuthManager = makeFakeCodexAuthManager({
    accounts: [
      { id: 'acct-1', email: 'a@example.com', planType: 'pro' },
      { id: 'acct-2', email: 'b@example.com', planType: 'plus' },
    ],
    activeAccountId: 'acct-2',
  });
  const { runtime, openai } = makeRuntime({ codexAuthManager });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-login-switch-1',
    text: '/login 1',
  });

  const text = result.messages.map((message) => message.text ?? '').join('\n');
  assert.match(text, /Codex 登录账号已切换/);
  assert.match(text, /账号：a@example\.com/);
  assert.match(text, /已写入：\/tmp\/\.codex\/auth\.json/);
  assert.match(text, /已自动刷新 access token/);
  assert.match(text, /已刷新 1 个 OpenAI Native Codex 会话/);
  assert.equal(codexAuthManager.state.activeAccountId, 'acct-1');
  assert.equal(openai.reconnectProfileCalls.length, 1);
});

test('/login 1 is blocked when any active turn is still running', async () => {
  const codexAuthManager = makeFakeCodexAuthManager({
    accounts: [
      { id: 'acct-1', email: 'a@example.com', planType: 'pro' },
    ],
    activeAccountId: 'acct-1',
  });
  const { runtime } = makeRuntime({ codexAuthManager });
  runtime.services.activeTurns.beginScopeTurn({
    platform: 'weixin',
    externalScopeId: 'wx-user-login-busy-other',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-login-busy-current',
    text: '/login 1',
  });

  const text = result.messages.map((message) => message.text ?? '').join('\n');
  assert.match(text, /暂时不能切换全局登录账号/);
  assert.equal(codexAuthManager.switchCalls.length, 0);
});

test('/uploads starts upload mode and persists batch state without starting a turn', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-uploads-cwd-'));
  const { runtime, openai } = makeRuntime({ defaultCwd });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-1',
    text: '/uploads',
  });

  const joined = result.messages.map((message) => message.text ?? '').join('\n');
  assert.match(joined, /已进入上传模式/);
  assert.match(joined, /查看：\/up status/);
  assert.equal(openai.startTurnCalls.length, 0);

  const session = runtime.services.bridgeSessions.resolveScopeSession({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-1',
  });
  const settings = runtime.services.bridgeSessions.getSessionSettings(session.id);
  const uploadsState = settings?.metadata?.uploads as any;
  assert.equal(uploadsState?.active, true);
});

test('/uploads stages files, exposes status, and waits for text before starting a turn', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-uploads-stage-'));
  const sourceFile = createTempAttachment('diagram.png', 'png-data');
  const { runtime, openai } = makeRuntime({ defaultCwd });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-2',
    text: '/up',
  });

  const staged = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-2',
    text: '',
    attachments: [
      {
        kind: 'image',
        localPath: sourceFile,
        fileName: 'diagram.png',
        mimeType: 'image/png',
      },
    ],
  });

  const stagedText = staged.messages.map((message) => message.text ?? '').join('\n');
  assert.match(stagedText, /已暂存 1 个文件/);
  assert.equal(openai.startTurnCalls.length, 0);

  const status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-2',
    text: '/up status',
  });
  const statusText = status.messages.map((message) => message.text ?? '').join('\n');
  assert.match(statusText, /上传暂存 \| 1 个文件/);
  assert.match(statusText, /diagram\.png/);
  assert.match(statusText, /\.codexbridge\/uploads\//);
});

test('/uploads submits staged files together with the next text prompt and clears staged state', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-uploads-submit-'));
  const sourceFile = createTempAttachment('report.pdf', 'pdf-data');
  const { runtime, openai } = makeRuntime({ defaultCwd });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-3',
    text: '/uploads',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-3',
    text: '',
    attachments: [
      {
        kind: 'file',
        localPath: sourceFile,
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
      },
    ],
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-3',
    text: '请根据资料总结重点',
  });

  assert.match(result.messages[0]?.text ?? '', /openai: 请根据资料总结重点/);
  assert.equal(openai.startTurnCalls.length, 1);
  assert.equal(openai.startTurnCalls[0]?.inputText, '请根据资料总结重点');
  assert.equal(openai.startTurnCalls[0]?.event?.attachments?.length, 1);
  assert.match(openai.startTurnCalls[0]?.event?.attachments?.[0]?.localPath ?? '', /\.codexbridge\/uploads\//);

  const session = runtime.services.bridgeSessions.resolveScopeSession({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-3',
  });
  const settings = runtime.services.bridgeSessions.getSessionSettings(session.id);
  assert.equal((settings?.metadata?.uploads as any) ?? null, null);
});

test('/uploads can be finalized by a voice attachment transcript when no text is present', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-uploads-voice-'));
  const sourceFile = createTempAttachment('sheet.xlsx', 'xlsx-data');
  const voiceFile = createTempAttachment('note.m4a', 'voice-data');
  const { runtime, openai } = makeRuntime({ defaultCwd });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-4',
    text: '/ul',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-4',
    text: '',
    attachments: [
      {
        kind: 'file',
        localPath: sourceFile,
        fileName: 'sheet.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    ],
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-4',
    text: '',
    attachments: [
      {
        kind: 'voice',
        localPath: voiceFile,
        fileName: 'note.m4a',
        mimeType: 'audio/mp4',
        transcriptText: '请结合这些文件说明差异',
        durationSeconds: 8,
      },
    ],
  });

  assert.equal(openai.startTurnCalls.length, 1);
  assert.equal(openai.startTurnCalls[0]?.inputText, '请结合这些文件说明差异');
  assert.equal(openai.startTurnCalls[0]?.event?.attachments?.length, 2);
});

test('/uploads cancel clears the staged batch', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-uploads-cancel-'));
  const sourceFile = createTempAttachment('clip.mp4', 'video-data');
  const { runtime } = makeRuntime({ defaultCwd });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-5',
    text: '/uploads',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-5',
    text: '',
    attachments: [
      {
        kind: 'video',
        localPath: sourceFile,
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
      },
    ],
  });

  const cancelled = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-5',
    text: '/up cancel',
  });
  const cancelText = cancelled.messages.map((message) => message.text ?? '').join('\n');
  assert.match(cancelText, /已取消上传模式/);
  assert.match(cancelText, /已清空 1 个暂存文件/);

  const status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-5',
    text: '/up status',
  });
  assert.equal(status.messages[0]?.text ?? '', '当前没有进行中的上传暂存。先发送 /uploads。');
});

test('/models lists available models for the current provider', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-models-1',
    text: '/models',
  });

  assert.match(result.messages[0]?.text ?? '', /可用模型：openai-default/);
  assert.match(result.messages[1]?.text ?? '', /当前模型：默认/);
  assert.match(result.messages[2]?.text ?? '', /模型列表：/);
  assert.match(result.messages[3]?.text ?? '', /- gpt-5.4/);
  assert.match(result.messages[4]?.text ?? '', /- gpt-5.2-codex/);
  assert.match(result.messages[3]?.text ?? '', /最新 frontier/);
});

test('/model shows current model and updates model setting for the next turn', async () => {
  const { runtime, openai } = makeRuntime();

  const empty = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-1',
    text: '/model',
  });
  assert.match(empty.messages[0]?.text ?? '', /当前模型：默认/);

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-1',
    text: 'start conversation',
  });

  const updated = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-1',
    text: '/model gpt-5.2-codex',
  });
  assert.equal(updated.messages[0]?.text ?? '', '模型已更新为：gpt-5.2-codex');
  assert.equal(updated.messages[1]?.text ?? '', '下一轮生效。');

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-1',
    text: 'next turn',
  });
  assert.equal(openai.startTurnCalls.at(-1)?.sessionSettings?.model, 'gpt-5.2-codex');
});

test('/model sets reasoning effort for the current/default model', async () => {
  const { runtime, openai } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-effort-1',
    text: 'start conversation',
  });

  const effortOnly = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-effort-1',
    text: '/model high',
  });
  assert.equal(effortOnly.messages[0]?.text ?? '', '思考深度已更新为：high');

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-effort-1',
    text: 'next turn',
  });
  assert.equal(openai.startTurnCalls.at(-1)?.sessionSettings?.reasoningEffort, 'high');
});

test('/model supports model and reasoning effort together, with validation', async () => {
  const { runtime, openai } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-effort-1',
    text: 'hello first',
  });

  const updated = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-effort-1',
    text: '/model gpt-5.4 xhigh',
  });
  assert.equal(updated.messages[0]?.text ?? '', '模型已更新为：gpt-5.4');
  assert.equal(updated.messages[1]?.text ?? '', '思考深度已更新为：xhigh');

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-effort-1',
    text: 'next turn',
  });
  const latestSessionSettings = openai.startTurnCalls.at(-1)?.sessionSettings ?? null;
  assert.equal(latestSessionSettings?.model, 'gpt-5.4');
  assert.equal(latestSessionSettings?.reasoningEffort, 'xhigh');

  const invalid = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-effort-1',
    text: '/model gpt-5.1-codex-mini xhigh',
  });
  assert.match(invalid.messages[0]?.text ?? '', /不支持该模型|不支持|不支持的思考深度/);
});

test('/model requires a space between model and reasoning effort', async () => {
  const { runtime } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-separator-1',
    text: 'seed conversation',
  });

  const merged = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-separator-1',
    text: '/model gpt-5.4xhigh',
  });
  assert.match(merged.messages[0]?.text ?? '', /模型和思考深度需要用空格分隔/);
});

test('/model supports reset and unknown-model handling', async () => {
  const { runtime, openai } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-2',
    text: 'hello first',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-2',
    text: '/model gpt-5.2-codex',
  });

  const reset = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-2',
    text: '/model default',
  });
  assert.equal(reset.messages[0]?.text ?? '', '模型已重置为默认');

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-2',
    text: 'after reset',
  });
  assert.equal(openai.startTurnCalls.at(-1)?.sessionSettings?.model ?? null, null);

  const unknown = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-2',
    text: '/model unknown-model',
  });
  assert.match(unknown.messages[0]?.text ?? '', /未知模型：unknown-model/);
});

test('/fast enables fast service tier and creates a session when needed', async () => {
  const { runtime, openai } = makeRuntime();

  const enabled = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-fast-1',
    text: '/fast',
  });

  assert.equal(enabled.messages[0]?.text ?? '', 'Fast 模式已开启。');
  assert.equal(enabled.messages[1]?.text ?? '', '当前速度模式：fast');
  assert.equal(enabled.messages[2]?.text ?? '', '服务层级：fast');
  assert.equal(enabled.messages[3]?.text ?? '', '下一轮生效。');

  const session = runtime.services.bridgeSessions.resolveScopeSession({
    platform: 'weixin',
    externalScopeId: 'wx-user-fast-1',
  });
  assert.ok(session);

  const status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-fast-1',
    text: '/status details',
  });
  const statusLines = status.messages.map((message) => message.text ?? '');
  assert.ok(statusLines.includes('速度模式：fast'));
  assert.ok(statusLines.includes('服务层级：fast'));

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-fast-1',
    text: 'hello with fast mode',
  });

  assert.equal(openai.startTurnCalls.at(-1)?.sessionSettings?.serviceTier, 'fast');
});

test('/fast off forces flex service tier for the next turn', async () => {
  const { runtime, openai } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-fast-2',
    text: '/fast',
  });

  const disabled = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-fast-2',
    text: '/fast off',
  });

  assert.equal(disabled.messages[0]?.text ?? '', 'Fast 模式已关闭，已恢复普通模式。');
  assert.equal(disabled.messages[1]?.text ?? '', '当前速度模式：normal');
  assert.equal(disabled.messages[2]?.text ?? '', '服务层级：flex');
  assert.equal(disabled.messages[3]?.text ?? '', '下一轮生效。');

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-fast-2',
    text: 'hello with normal mode',
  });

  assert.equal(openai.startTurnCalls.at(-1)?.sessionSettings?.serviceTier, 'flex');
});

test('legacy service tier values are normalized to fast/flex in status output', async () => {
  const { runtime, openai } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-fast-legacy-1',
    text: 'hello legacy tier',
  });

  const session = runtime.services.bridgeSessions.resolveScopeSession({
    platform: 'weixin',
    externalScopeId: 'wx-user-fast-legacy-1',
  });
  assert.ok(session);

  runtime.services.bridgeSessions.upsertSessionSettings(session.id, {
    serviceTier: 'priority',
  });
  let status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-fast-legacy-1',
    text: '/status details',
  });
  let statusLines = status.messages.map((message) => message.text ?? '');
  assert.ok(statusLines.includes('服务层级：fast'));

  runtime.services.bridgeSessions.upsertSessionSettings(session.id, {
    serviceTier: 'default',
  });

  status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-fast-legacy-1',
    text: '/status details',
  });
  statusLines = status.messages.map((message) => message.text ?? '');
  assert.ok(statusLines.includes('服务层级：flex'));
});

test('/lang displays current language when no locale argument is provided', async () => {
  const { runtime } = makeRuntime({ locale: 'en' });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-lang-1',
    text: '/lang',
  });

  assert.equal(result.messages[0]?.text ?? '', 'Current language: English');
});

test('/lang persists command locale for scope and overrides env', async () => {
  const { runtime } = makeRuntime({ locale: 'en' });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-lang-2',
    text: '/lang zh',
  });

  const status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-lang-2',
    text: '/status',
  });

  const lines = status.messages.map((message) => message.text ?? '');
  assert.ok(lines.includes('接口配置：openai-default'));
  assert.ok(lines.includes('默认工作目录：（未设置）'));
  assert.ok(lines.includes('模型：gpt-5.4'));
  assert.ok(lines.includes('完整信息：/status details'));
});

test('/lang rejects invalid language values', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-lang-3',
    text: '/lang jp',
  });

  assert.equal(result.messages[0]?.text ?? '', '不支持的语言：jp');
  assert.equal(result.messages[1]?.text ?? '', '用法：/lang <zh-CN|en>');
});

test('/helps threads renders usage, examples, and notes for a specific command', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/helps threads',
  });

  const text = result.messages[0]?.text ?? '';
  assert.match(text, /命令：\/threads/);
  assert.match(text, /说明：查看当前 provider 的线程列表首页/);
  assert.match(text, /用法：/);
  assert.match(text, /\/threads -h/);
  assert.match(text, /\/open 2/);
  assert.match(text, /微信里推荐先 \/threads，再用序号操作/);
});

test('slash commands support first-argument help flags like -h', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/threads -h',
  });

  const text = result.messages[0]?.text ?? '';
  assert.match(text, /命令：\/threads/);
  assert.match(text, /\/threads -h/);
  assert.match(text, /\/peek 2/);
});

test('slash command short aliases resolve to the same help and action targets', async () => {
  const { runtime } = makeRuntime();

  const helpResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/h th',
  });
  assert.match(helpResult.messages[0]?.text ?? '', /命令：\/threads/);
  assert.match(helpResult.messages[0]?.text ?? '', /别名：\/th/);

  const commandResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/perm',
  });
  assert.match(commandResult.messages[0]?.text ?? '', /当前还没有绑定会话/);

  const uploadsHelpResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/h up',
  });
  assert.match(uploadsHelpResult.messages[0]?.text ?? '', /命令：\/uploads/);
  assert.match(uploadsHelpResult.messages[0]?.text ?? '', /别名：\/up \/ul/);

  const providerResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/pd',
  });
  assert.match(providerResult.messages[0]?.text ?? '', /当前 Provider 配置：openai-default/);

  const searchResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/se bridge',
  });
  assert.match(searchResult.messages[0]?.text ?? '', /没有找到匹配的线程|线程列表 \|/);
});

test('slash commands support -help, -helps, and --help variants', async () => {
  const { runtime } = makeRuntime();

  for (const text of ['/permissions -help', '/permissions -helps', '/permissions --help']) {
    const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-user-1',
      text,
    });

    const body = result.messages[0]?.text ?? '';
    assert.match(body, /命令：\/permissions/);
    assert.match(body, /\/permissions <read-only\|default\|full-access>/);
  }
});

test('slash commands treat help flags in later argument positions as help requests', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/permissions full-access -h',
  });

  const text = result.messages[0]?.text ?? '';
  assert.match(text, /命令：\/permissions/);
  assert.match(text, /\/permissions -h/);
});

test('/allow -h and /deny -h mention the full-access workaround for approval issues', async () => {
  const { runtime } = makeRuntime();

  const allowResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-help-1',
    text: '/allow -h',
  });
  const denyResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-deny-help-1',
    text: '/deny -h',
  });

  const allowText = allowResult.messages[0]?.text ?? '';
  const denyText = denyResult.messages[0]?.text ?? '';
  assert.match(allowText, /\/perm full-access/);
  assert.match(allowText, /只对下一轮生效/);
  assert.match(denyText, /\/perm full-access/);
  assert.match(denyText, /只对下一轮生效/);
});

test('/stop reports when there is no active turn to interrupt', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/stop',
  });

  assert.equal(result.messages[0]?.text ?? '', '当前没有进行中的回复。');
});

test('/stop interrupts the active turn once the provider has issued a turn id', async () => {
  const { runtime, openai } = makeRuntime();
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
  };
  /** @type {(value?: unknown) => void} */
  let releaseTurn: (value?: unknown) => void = () => {};
  const turnGate = new Promise((resolve) => {
    releaseTurn = resolve;
  });
  let interrupted = false;

  openai.startTurn = async ({ bridgeSession, inputText, onTurnStarted = null }) => {
    const existingThread = openai.threads.get(bridgeSession.codexThreadId);
    assert.ok(existingThread);
    const turnId = `${bridgeSession.codexThreadId}-turn-${(existingThread?.turns.length ?? 0) + 1}`;
    await onTurnStarted?.({
      turnId,
      threadId: bridgeSession.codexThreadId,
    });
    existingThread.turns = [
      {
        id: turnId,
        status: 'running',
        error: null,
        items: [],
      },
    ];
    await turnGate;
    existingThread.turns = [
      {
        id: turnId,
        status: interrupted ? 'interrupted' : 'complete',
        error: interrupted ? 'Conversation interrupted' : null,
        items: interrupted
          ? []
          : [
            { role: 'user', text: inputText, type: 'message', phase: 'final' },
            { role: 'assistant', text: `openai: ${inputText}`, type: 'message', phase: 'final' },
          ],
      },
    ];
    return {
      outputText: interrupted ? '' : `openai: ${inputText}`,
      outputState: interrupted ? 'interrupted' : 'complete',
      turnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };
  openai.interruptTurn = async (params) => {
    interrupted = true;
    openai.interruptTurnCalls.push(params);
    const thread = openai.threads.get(params.threadId);
    if (thread) {
      thread.turns = [
        {
          id: params.turnId,
          status: 'interrupted',
          error: 'Conversation interrupted',
          items: [],
        },
      ];
    }
    releaseTurn();
  };

  const firstTurn = runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: 'long running turn',
  });

  await waitForCondition(() => runtime.services.activeTurns.resolveScopeTurn(scopeRef)?.turnId);

  const stopResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: '/stop',
  });

  assert.equal(stopResult.messages[0]?.text ?? '', '已请求中断当前回复。');
  assert.equal(openai.interruptTurnCalls.length, 1);

  const firstResult = await firstTurn;
  assert.equal(firstResult.meta?.codexTurn?.outputState, 'interrupted');
});

test('/interrupt remains a hidden compatibility alias and can queue an interrupt before turn startup completes', async () => {
  const { runtime, openai } = makeRuntime();
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-2',
  };
  /** @type {(value?: unknown) => void} */
  let releaseStart: (value?: unknown) => void = () => {};
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  /** @type {(value?: unknown) => void} */
  let releaseFinish: (value?: unknown) => void = () => {};
  const finishGate = new Promise((resolve) => {
    releaseFinish = resolve;
  });

  openai.startTurn = async ({ bridgeSession, onTurnStarted = null }) => {
    await startGate;
    await onTurnStarted?.({
      turnId: `${bridgeSession.codexThreadId}-turn-pending`,
      threadId: bridgeSession.codexThreadId,
    });
    await finishGate;
    return {
      outputText: '',
      outputState: 'interrupted',
      turnId: `${bridgeSession.codexThreadId}-turn-pending`,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };
  openai.interruptTurn = async (params) => {
    openai.interruptTurnCalls.push(params);
    releaseFinish();
  };

  const firstTurn = runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: 'slow startup turn',
  });

  await waitForCondition(() => runtime.services.activeTurns.resolveScopeTurn(scopeRef));

  const stopResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: '/interrupt',
  });

  assert.equal(stopResult.messages[0]?.text ?? '', '已请求中断。当前回复仍在启动，拿到 turn id 后会自动中断。');
  releaseStart();
  await waitForCondition(() => openai.interruptTurnCalls.length === 1);
  await firstTurn;
});

test('/status shows running active-turn details and control hint', async () => {
  const { runtime, openai } = makeRuntime();
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-status-2',
  };
  /** @type {(value?: unknown) => void} */
  let releaseTurn: (value?: unknown) => void = () => {};
  const turnGate = new Promise((resolve) => {
    releaseTurn = resolve;
  });

  openai.startTurn = async ({ bridgeSession, inputText, onTurnStarted = null }) => {
    const thread = openai.threads.get(bridgeSession.codexThreadId);
    assert.ok(thread);
    await onTurnStarted?.({
      turnId: `${bridgeSession.codexThreadId}-turn-1`,
      threadId: bridgeSession.codexThreadId,
    });
    thread.turns = [
      {
        id: `${bridgeSession.codexThreadId}-turn-1`,
        status: 'running',
        error: null,
        items: [],
      },
    ];
    await turnGate;
    thread.turns = [
      {
        id: `${bridgeSession.codexThreadId}-turn-1`,
        status: 'complete',
        error: null,
        items: [
          { role: 'user', text: inputText, type: 'message', phase: 'final' },
          { role: 'assistant', text: `openai: ${inputText}`, type: 'message', phase: 'final' },
        ],
      },
    ];
    return {
      outputText: `openai: ${inputText}`,
      turnId: `${bridgeSession.codexThreadId}-turn-1`,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const firstTurn = runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: 'long running turn',
  });

  await waitForCondition(() => runtime.services.activeTurns.resolveScopeTurn(scopeRef)?.turnId);

  const status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: '/status details',
  });

  const lines = status.messages.map((message) => message.text ?? '');
  assert.ok(lines.some((line) => /当前 Turn：.*turn-1/.test(line)));
  assert.ok(lines.includes('Turn 状态：运行中'));
  assert.ok(lines.includes('Turn 控制：/stop'));

  releaseTurn();
  await firstTurn;
});

test('bridge coordinator blocks new conversation turns while another turn is already active', async () => {
  const { runtime, openai } = makeRuntime();
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-3',
  };
  /** @type {(value?: unknown) => void} */
  let releaseTurn: (value?: unknown) => void = () => {};
  const turnGate = new Promise((resolve) => {
    releaseTurn = resolve;
  });

  openai.startTurn = async ({ bridgeSession, inputText, onTurnStarted = null }) => {
    const thread = openai.threads.get(bridgeSession.codexThreadId);
    assert.ok(thread);
    await onTurnStarted?.({
      turnId: `${bridgeSession.codexThreadId}-turn-1`,
      threadId: bridgeSession.codexThreadId,
    });
    thread.turns = [
      {
        id: `${bridgeSession.codexThreadId}-turn-1`,
        status: 'running',
        error: null,
        items: [],
      },
    ];
    await turnGate;
    thread.turns = [
      {
        id: `${bridgeSession.codexThreadId}-turn-1`,
        status: 'complete',
        error: null,
        items: [
          { role: 'user', text: inputText, type: 'message', phase: 'final' },
          { role: 'assistant', text: `openai: ${inputText}`, type: 'message', phase: 'final' },
        ],
      },
    ];
    return {
      outputText: `openai: ${inputText}`,
      turnId: `${bridgeSession.codexThreadId}-turn-1`,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const firstTurn = runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: 'first turn',
  });

  await waitForCondition(() => runtime.services.activeTurns.resolveScopeTurn(scopeRef));

  const blocked = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: 'second turn',
  });

  assert.equal(blocked.messages[0]?.text ?? '', '当前已有一轮回复在进行中。');
  assert.equal(blocked.messages[1]?.text ?? '', '请先等待，或使用 /stop 中断。');

  releaseTurn();
  await firstTurn;
});

test('bridge coordinator shows command-specific blocked messages while a turn is active', async () => {
  const { runtime, openai } = makeRuntime();
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-4',
  };
  /** @type {(value?: unknown) => void} */
  let releaseTurn: (value?: unknown) => void = () => {};
  const turnGate = new Promise((resolve) => {
    releaseTurn = resolve;
  });

  openai.startTurn = async ({ bridgeSession, inputText, onTurnStarted = null }) => {
    const thread = openai.threads.get(bridgeSession.codexThreadId);
    assert.ok(thread);
    await onTurnStarted?.({
      turnId: `${bridgeSession.codexThreadId}-turn-1`,
      threadId: bridgeSession.codexThreadId,
    });
    thread.turns = [
      {
        id: `${bridgeSession.codexThreadId}-turn-1`,
        status: 'running',
        error: null,
        items: [],
      },
    ];
    await turnGate;
    thread.turns = [
      {
        id: `${bridgeSession.codexThreadId}-turn-1`,
        status: 'complete',
        error: null,
        items: [
          { role: 'user', text: inputText, type: 'message', phase: 'final' },
          { role: 'assistant', text: `openai: ${inputText}`, type: 'message', phase: 'final' },
        ],
      },
    ];
    return {
      outputText: `openai: ${inputText}`,
      turnId: `${bridgeSession.codexThreadId}-turn-1`,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const firstTurn = runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: 'first turn',
  });

  await waitForCondition(() => runtime.services.activeTurns.resolveScopeTurn(scopeRef));

  const checks = [
    ['/new', '当前有回复在进行中，暂时不能新建会话。请先等待，或使用 /stop 中断。'],
    ['/open thread-1', '当前有回复在进行中，暂时不能切换线程。请先等待，或使用 /stop 中断。'],
    ['/rename thread-1 新名字', '当前有回复在进行中，暂时不能重命名线程。请先等待，或使用 /stop 中断。'],
    ['/provider minimax-default', '当前有回复在进行中，暂时不能切换 provider。请先等待，或使用 /stop 中断。'],
    ['/model gpt-5.4', '当前有回复在进行中，暂时不能切换模型。请先等待，或使用 /stop 中断。'],
    ['/permissions full-access', '当前有回复在进行中，暂时不能切换权限预设。请先等待，或使用 /stop 中断。'],
    ['/reconnect', '当前有回复在进行中，暂时不能刷新当前 Codex 会话。请先等待，或使用 /stop 中断。'],
    ['/restart', '当前有回复在进行中，暂时不能重启桥接。请先等待，或使用 /stop 中断。'],
  ];

  for (const [text, expected] of checks) {
    const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
      ...scopeRef,
      text,
    });
    assert.equal(result.messages[0]?.text ?? '', expected);
  }

  releaseTurn();
  await firstTurn;
});

test('command-specific blocked messages switch to wait-for-stop wording after interrupt is requested', async () => {
  const { runtime, openai } = makeRuntime();
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-5',
  };
  /** @type {(value?: unknown) => void} */
  let releaseTurn: (value?: unknown) => void = () => {};
  const turnGate = new Promise((resolve) => {
    releaseTurn = resolve;
  });
  let interrupted = false;

  openai.startTurn = async ({ bridgeSession, onTurnStarted = null }) => {
    const thread = openai.threads.get(bridgeSession.codexThreadId);
    assert.ok(thread);
    await onTurnStarted?.({
      turnId: `${bridgeSession.codexThreadId}-turn-1`,
      threadId: bridgeSession.codexThreadId,
    });
    thread.turns = [
      {
        id: `${bridgeSession.codexThreadId}-turn-1`,
        status: 'running',
        error: null,
        items: [],
      },
    ];
    await turnGate;
    thread.turns = [
      {
        id: `${bridgeSession.codexThreadId}-turn-1`,
        status: interrupted ? 'interrupted' : 'complete',
        error: interrupted ? 'Conversation interrupted' : null,
        items: [],
      },
    ];
    return {
      outputText: '',
      outputState: interrupted ? 'interrupted' : 'complete',
      turnId: `${bridgeSession.codexThreadId}-turn-1`,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };
  openai.interruptTurn = async (params) => {
    interrupted = true;
    openai.interruptTurnCalls.push(params);
  };

  const firstTurn = runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: 'first turn',
  });

  await waitForCondition(() => runtime.services.activeTurns.resolveScopeTurn(scopeRef)?.turnId);

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: '/stop',
  });

  const blocked = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: '/provider minimax-default',
  });

  assert.equal(blocked.messages[0]?.text ?? '', '已请求中断，请等待当前回复停止后再切换 provider。');

  const status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: '/status details',
  });

  const lines = status.messages.map((message) => message.text ?? '');
  assert.ok(lines.some((line) => /当前 Turn：.*turn-1/.test(line)));
  assert.ok(lines.includes('Turn 状态：已请求中断'));
  assert.ok(lines.includes('Turn 控制：/stop'));

  releaseTurn();
  await firstTurn;
});

test('/new creates a fresh session on the current provider profile', async () => {
  const { runtime, openai } = makeRuntime();
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/new',
  });

  assert.match(result.messages[0]?.text ?? '', /已创建新的 Bridge 会话/);
  assert.equal(openai.startThreadCalls.length, 2);
});

test('/provider switches the scope to a new provider-backed session', async () => {
  const { runtime, minimax } = makeRuntime();
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/provider minimax-default',
  });

  assert.match(result.messages[0]?.text ?? '', /已切换到 Provider 配置：minimax-default/);
  assert.equal(result.session?.providerProfileId, 'minimax-default');
  assert.equal(minimax.startThreadCalls.length, 1);
});

test('/provider without args lists current and available profiles', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/provider',
  });

  assert.match(result.messages[0]?.text ?? '', /当前 Provider 配置：openai-default/);
  assert.match(result.messages[1]?.text ?? '', /可用的 Provider 配置/);
  assert.match(result.messages[2]?.text ?? '', /openai-default/);
  assert.match(result.messages[3]?.text ?? '', /minimax-default/);
});

test('/threads renders a paged thread browser with previews and commands', async () => {
  const { runtime } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello from wx',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'telegram',
    externalScopeId: 'tg-topic-1',
    text: 'hello from tg',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/threads',
  });

  const text = result.messages[0]?.text ?? '';
  assert.match(text, /线程列表 \| openai-default/);
  assert.match(text, /当前绑定：OpenAI Default thread 1/);
  assert.match(text, /\* \d+\. OpenAI Default thread 1/);
  assert.match(text, /预览：hello from wx/);
  assert.match(text, /操作：\/open \d+  \/peek \d+  \/rename \d+ 新名字  \/search 关键词  \/threads/);
});

test('/threads shows thread id in current binding when the current thread has no title', async () => {
  const { runtime, openai } = makeRuntime();

  const first = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-threads-untitled-1',
    text: 'first thread',
  });

  const currentSession = runtime.services.bridgeSessions.resolveScopeSession({
    platform: 'weixin',
    externalScopeId: 'wx-user-threads-untitled-1',
  });
  runtime.services.bridgeSessions.updateSession(currentSession.id, {
    title: null,
  });
  const currentThread = openai.threads.get(first.session?.codexThreadId);
  openai.threads.set(first.session?.codexThreadId, {
    ...currentThread,
    title: null,
  });

  for (let index = 0; index < 5; index += 1) {
    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'telegram',
      externalScopeId: `tg-topic-untitled-${index}`,
      text: `newer thread ${index}`,
    });
  }

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-threads-untitled-1',
    text: '/threads',
  });

  const text = result.messages[0]?.text ?? '';
  assert.match(text, new RegExp(`当前绑定：未命名线程 \\(${first.session?.codexThreadId}\\)`));
});

test('/next and /prev paginate the current thread browser page', async () => {
  const { runtime } = makeRuntime();

  for (let index = 1; index <= 6; index += 1) {
    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: `wx-thread-${index}`,
      text: `hello ${index}`,
    });
  }

  const firstPage = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/threads',
  });
  const nextPage = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/next',
  });
  const previousPage = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/prev',
  });

  assert.match(firstPage.messages[0]?.text ?? '', /OpenAI Default thread 6/);
  assert.doesNotMatch(firstPage.messages[0]?.text ?? '', /OpenAI Default thread 1/);
  assert.match(nextPage.messages[0]?.text ?? '', /第 2 页/);
  assert.match(nextPage.messages[0]?.text ?? '', /OpenAI Default thread 1/);
  assert.match(previousPage.messages[0]?.text ?? '', /第 1 页/);
  assert.match(previousPage.messages[0]?.text ?? '', /OpenAI Default thread 6/);
});

test('/search filters the thread browser by preview or title', async () => {
  const { runtime } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-search-1',
    text: 'alpha deployment issue',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-search-2',
    text: 'beta followup',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/search alpha',
  });

  assert.match(result.messages[0]?.text ?? '', /搜索：alpha/);
  assert.match(result.messages[0]?.text ?? '', /alpha deployment issue/);
  assert.doesNotMatch(result.messages[0]?.text ?? '', /beta followup/);
});

test('/open binds the scope to an existing provider thread', async () => {
  const { runtime } = makeRuntime();

  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'telegram',
    externalScopeId: 'tg-topic-1',
    text: 'hello from telegram',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-2',
    text: `/open ${original.session?.codexThreadId}`,
  });

  assert.match(result.messages[0]?.text ?? '', new RegExp(`已打开 Codex 线程 ${original.session?.codexThreadId}`));
  assert.equal(result.session?.codexThreadId, original.session?.codexThreadId);
  assert.equal(result.session?.bridgeSessionId, original.session?.bridgeSessionId);

  const status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-2',
    text: '/status details',
  });

  const lines = status.messages.map((message) => message.text ?? '');
  assert.ok(lines.some((line) => new RegExp(`Codex 线程：${original.session?.codexThreadId}`).test(line)));
  assert.ok(lines.some((line) => /工作目录：/.test(line)));
});

test('/open accepts the current-page index in addition to raw thread ids', async () => {
  const { runtime } = makeRuntime();

  const first = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'telegram',
    externalScopeId: 'tg-topic-1',
    text: 'first thread',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'telegram',
    externalScopeId: 'tg-topic-2',
    text: 'second thread',
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/threads',
  });
  const opened = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/open 2',
  });

  assert.equal(opened.session?.codexThreadId, first.session?.codexThreadId);
});

test('/rename updates the local thread alias used by /threads', async () => {
  const { runtime } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-rename-1',
    text: 'rename candidate',
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/threads',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/rename 1 微信桥接排障',
  });
  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/threads',
  });

  assert.match(result.messages[0]?.text ?? '', /微信桥接排障/);
});

test('/peek shows recent conversation turns for the selected thread', async () => {
  const { runtime } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-peek-1',
    text: 'hello bridge',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-peek-1',
    text: 'show me logs',
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/threads',
  });
  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/peek 1',
  });

  assert.match(result.messages[0]?.text ?? '', /线程预览：/);
  assert.match(result.messages[0]?.text ?? '', /最近 2 轮：/);
  assert.match(result.messages[0]?.text ?? '', /你：hello bridge/);
  assert.match(result.messages[0]?.text ?? '', /你：show me logs/);
});


test('/restart returns a queued reply and defers the actual restart action to runtime delivery', async () => {
  let restartCalls = 0;
  const { runtime } = makeRuntime({
    restartBridge: async () => {
      restartCalls += 1;
    },
  });

  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/restart',
  });

  assert.equal(restartCalls, 0);
  assert.equal(result.messages[0]?.text ?? '', '桥接重启已排队。');
  assert.equal(result.meta?.systemAction?.kind, 'restart_bridge');
  assert.equal(result.session?.bridgeSessionId, original.session?.bridgeSessionId);
  assert.equal(result.session?.codexThreadId, original.session?.codexThreadId);
});

test('/reconnect refreshes the current Codex session and keeps the same binding', async () => {
  const { runtime, openai } = makeRuntime();

  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello',
  });

  let reconnectCalls = 0;
  openai.reconnectProfile = async () => {
    reconnectCalls += 1;
    return {
      connected: true,
      accountIdentity: {
        email: 'ganxing@example.com',
        name: null,
        authMode: 'chatgpt',
        accountId: null,
      },
    };
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/reconnect',
  });

  assert.equal(reconnectCalls, 1);
  assert.equal(result.messages[0]?.text ?? '', '当前 Codex 会话已刷新。');
  assert.equal(result.messages[1]?.text ?? '', '账号：ganxing@example.com');
  assert.equal(result.messages[2]?.text ?? '', '直接继续发消息即可。');
  assert.equal(result.session?.bridgeSessionId, original.session?.bridgeSessionId);
  assert.equal(result.session?.codexThreadId, original.session?.codexThreadId);
});

test('/retry resumes the same thread and reruns the previous request on the same binding', async () => {
  const { runtime, openai } = makeRuntime();

  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-retry-1',
    text: 'hello retry',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-retry-1',
    text: '/retry',
  });

  assert.equal(openai.resumeThreadCalls.length, 1);
  assert.equal(openai.startTurnCalls.length, 2);
  assert.equal(openai.startTurnCalls[1]?.inputText, 'hello retry');
  assert.equal(openai.startTurnCalls[1]?.event?.metadata?.codexbridge?.retryContext?.threadId, original.session?.codexThreadId);
  assert.equal(result.messages[0]?.text ?? '', 'openai: hello retry');
  assert.equal(result.session?.bridgeSessionId, original.session?.bridgeSessionId);
  assert.equal(result.session?.codexThreadId, original.session?.codexThreadId);
});

test('/retry stops live turns before rerunning the previous request', async () => {
  const { runtime, openai } = makeRuntime();

  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-retry-stop-1',
    text: 'hello retry stop',
  });
  const session = original.session;
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-retry-stop-1',
  };
  runtime.services.activeTurns.beginScopeTurn(scopeRef, {
    bridgeSessionId: session.bridgeSessionId,
    providerProfileId: session.providerProfileId,
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-live`,
  });
  const thread = openai.threads.get(session.codexThreadId);
  assert.ok(thread);
  thread.turns = [{
    id: `${session.codexThreadId}-turn-live`,
    status: 'running',
    error: null,
    items: [],
  }];
  openai.interruptTurn = async (params) => {
    openai.interruptTurnCalls.push(params);
    const currentThread = openai.threads.get(params.threadId);
    assert.ok(currentThread);
    currentThread.turns = [{
      id: params.turnId,
      status: 'interrupted',
      error: 'Conversation interrupted',
      items: [],
    }];
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: '/retry',
  });

  assert.equal(openai.interruptTurnCalls.length, 1);
  assert.equal(openai.resumeThreadCalls.length, 1);
  assert.equal(openai.startTurnCalls.at(-1)?.inputText, 'hello retry stop');
  assert.deepEqual(
    openai.startTurnCalls.at(-1)?.event?.metadata?.codexbridge?.retryContext?.interruptedTurnIds,
    [`${session.codexThreadId}-turn-live`],
  );
  assert.equal(result.messages[0]?.text ?? '', 'openai: hello retry stop');
});

test('ordinary messages after /stop do not eagerly resume the thread when startTurn succeeds', async () => {
  const { runtime, openai } = makeRuntime();

  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-stop-resume-1',
    text: 'hello stop',
  });
  runtime.services.bridgeCoordinator.storeStopCheckpoint(original.session.bridgeSessionId, {
    threadId: original.session.codexThreadId,
    stoppedAt: Date.now(),
    interruptedTurnIds: [`${original.session.codexThreadId}-turn-paused`],
    pendingApprovalCount: 0,
    interruptErrors: [],
    requestedWhileStarting: false,
    settled: true,
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-stop-resume-1',
    text: 'hello after stop',
  });

  assert.equal(openai.resumeThreadCalls.length, 0);
  assert.equal(openai.startTurnCalls.length, 2);
  assert.equal(result.messages[0]?.text ?? '', 'openai: hello after stop');

  const settings = runtime.services.bridgeSessions.getSessionSettings(original.session.bridgeSessionId);
  assert.equal((settings?.metadata?.lastStopCheckpoint as any) ?? null, null);
});

test('ordinary messages after /stop lazily resume the same thread when Codex asks for recovery', async () => {
  const { runtime, openai } = makeRuntime();

  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-stop-resume-2',
    text: 'hello stop resume',
  });
  runtime.services.bridgeCoordinator.storeStopCheckpoint(original.session.bridgeSessionId, {
    threadId: original.session.codexThreadId,
    stoppedAt: Date.now(),
    interruptedTurnIds: [`${original.session.codexThreadId}-turn-paused`],
    pendingApprovalCount: 0,
    interruptErrors: [],
    requestedWhileStarting: false,
    settled: true,
  });

  let injected = false;
  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (args) => {
    if (!injected && args.bridgeSession.codexThreadId === original.session.codexThreadId && args.inputText === 'hello after lazy resume') {
      injected = true;
      throw new Error(`failed to load rollout '/tmp/${original.session.codexThreadId}.jsonl' for thread ${original.session.codexThreadId}: empty session file`);
    }
    return originalStartTurn(args);
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-stop-resume-2',
    text: 'hello after lazy resume',
  });

  assert.equal(openai.resumeThreadCalls.length, 1);
  assert.equal(openai.startTurnCalls.length, 2);
  assert.equal(result.messages[0]?.text ?? '', 'openai: hello after lazy resume');
  assert.equal(result.session?.bridgeSessionId, original.session?.bridgeSessionId);
  assert.equal(result.session?.codexThreadId, original.session?.codexThreadId);

  const settings = runtime.services.bridgeSessions.getSessionSettings(original.session.bridgeSessionId);
  assert.equal((settings?.metadata?.lastStopCheckpoint as any) ?? null, null);
});

test('/permissions shows current access settings and updates the preset for the next turn', async () => {
  const { runtime, openai } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello',
  });

  const statusBefore = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/permissions',
  });

  assert.equal(statusBefore.messages[0]?.text ?? '', '当前权限预设：default');
  assert.equal(statusBefore.messages[1]?.text ?? '', '审批策略：on-request');
  assert.equal(statusBefore.messages[2]?.text ?? '', '沙箱模式：workspace-write');
  assert.equal(statusBefore.messages[4]?.text ?? '', '可选命令：');
  assert.equal(statusBefore.messages[5]?.text ?? '', '- /permissions read-only');
  assert.equal(statusBefore.messages[6]?.text ?? '', '- /permissions default');
  assert.equal(statusBefore.messages[7]?.text ?? '', '- /permissions full-access');
  assert.equal(statusBefore.messages[9]?.text ?? '', '说明：');
  assert.equal(statusBefore.messages[10]?.text ?? '', '- read-only：按需审批 + 只读');
  assert.equal(statusBefore.messages[11]?.text ?? '', '- default：按需审批 + 工作区可写');
  assert.equal(statusBefore.messages[12]?.text ?? '', '- full-access：不审批 + 完全访问');

  const updated = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/permissions full-access',
  });

  assert.equal(updated.messages[0]?.text ?? '', '已切换权限预设：full-access');
  assert.equal(updated.messages[1]?.text ?? '', '审批策略：never');
  assert.equal(updated.messages[2]?.text ?? '', '沙箱模式：danger-full-access');
  assert.equal(updated.messages[3]?.text ?? '', '下一轮生效。');

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello again',
  });

  const lastTurn = openai.startTurnCalls.at(-1);
  assert.equal(lastTurn?.sessionSettings?.accessPreset, 'full-access');
  assert.equal(lastTurn?.sessionSettings?.approvalPolicy, 'never');
  assert.equal(lastTurn?.sessionSettings?.sandboxMode, 'danger-full-access');
});

test('/permissions rejects unknown presets', async () => {
  const { runtime } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/permissions yolo',
  });

  assert.equal(result.messages[0]?.text ?? '', '用法：/permissions [read-only|default|full-access]');
});

test('bridge coordinator converts Codex turn timeout into a user-visible timeout state', async () => {
  const { runtime, openai } = makeRuntime();
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello',
  });

  openai.startTurn = async () => {
    throw new Error('Timed out waiting for Codex turn turn-1');
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello again',
  });

  assert.equal(result.messages[0]?.text ?? '', '');
  assert.equal(result.meta?.codexTurn?.outputState, 'timeout');
});

test('bridge coordinator forwards unexpected provider errors as user-visible provider_error state', async () => {
  const { runtime, openai } = makeRuntime();
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello',
  });

  openai.startTurn = async () => {
    throw new Error('401 Unauthorized: refresh_token_reused');
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello again',
  });

  assert.equal(result.meta?.codexTurn?.outputState, 'provider_error');
  assert.equal(result.meta?.codexTurn?.errorMessage, '401 Unauthorized: refresh_token_reused');
});

test('bridge coordinator rewrites approved execution stalls into a workaround hint', async () => {
  const { runtime, openai } = makeRuntime();
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-approval-stall-1',
    text: 'hello',
  });

  openai.startTurn = async () => {
    throw new Error('Approval was accepted, but the approved command (node resend-file.js) produced no follow-up signal for 300 seconds. The provider may be stuck; use /retry to try again.');
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-approval-stall-1',
    text: 'hello again',
  });

  assert.equal(result.meta?.codexTurn?.outputState, 'provider_error');
  assert.equal(
    result.meta?.codexTurn?.errorMessage,
    '审批已通过，但 Codex 未继续执行。可先 /stop，再发送 /perm full-access，然后 /retry 重新执行；该设置仅对下一轮生效。',
  );
});
