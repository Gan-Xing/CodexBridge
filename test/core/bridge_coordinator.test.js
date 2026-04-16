import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexBridgeRuntime } from '../../src/runtime/bootstrap.js';

class FakeProviderPlugin {
  constructor(kind, { replyPrefix }) {
    this.kind = kind;
    this.displayName = kind;
    this.replyPrefix = replyPrefix;
    this.startThreadCalls = [];
    this.resumeThreadCalls = [];
    this.startTurnCalls = [];
    this.threadCounter = 0;
    this.threads = new Map();
  }

  async startThread({ providerProfile, cwd, title, metadata }) {
    this.threadCounter += 1;
    this.startThreadCalls.push({ providerProfile, cwd, title, metadata });
    const thread = {
      threadId: `${providerProfile.id}-thread-${this.threadCounter}`,
      cwd: cwd ?? `/tmp/${providerProfile.id}`,
      title: title ?? `${providerProfile.displayName} thread ${this.threadCounter}`,
      updatedAt: Date.now(),
    };
    this.threads.set(thread.threadId, thread);
    return thread;
  }

  async readThread({ threadId }) {
    return this.threads.get(threadId) ?? null;
  }

  async listThreads() {
    return [...this.threads.values()].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  }

  async resumeThread({ threadId }) {
    this.resumeThreadCalls.push({ threadId });
    const existingThread = this.threads.get(threadId);
    if (!existingThread) {
      const restored = {
        threadId,
        cwd: '/tmp/restored',
        title: `restored ${threadId}`,
        updatedAt: Date.now(),
      };
      this.threads.set(threadId, restored);
      return restored;
    }
    return existingThread;
  }

  async startTurn({ providerProfile, bridgeSession, sessionSettings, event, inputText }) {
    this.startTurnCalls.push({ providerProfile, bridgeSession, sessionSettings, event, inputText });
    const existingThread = this.threads.get(bridgeSession.codexThreadId);
    if (!existingThread) {
      throw new Error(`thread not found: ${bridgeSession.codexThreadId}`);
    }
    this.threads.set(bridgeSession.codexThreadId, {
      ...existingThread,
      updatedAt: Date.now(),
    });
    return {
      outputText: `${this.replyPrefix}: ${inputText}`,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
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

function makeRuntime({ restartBridge = null } = {}) {
  const openai = new FakeProviderPlugin('openai-native', { replyPrefix: 'openai' });
  const minimax = new FakeProviderPlugin('minimax-via-cliproxy', { replyPrefix: 'minimax' });
  const runtime = createCodexBridgeRuntime({
    providerPlugins: [openai, minimax],
    providerProfiles: [
      makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default'),
      makeProviderProfile('minimax-default', 'minimax-via-cliproxy', 'MiniMax Default'),
    ],
    defaultProviderProfileId: 'openai-default',
    restartBridge,
  });
  return { runtime, openai, minimax };
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

  assert.match(result.messages[0]?.text ?? '', /No bridge session is bound/);
  assert.match(result.messages[1]?.text ?? '', /Default provider profile: openai-default/);
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

  assert.match(result.messages[0]?.text ?? '', /Started a new bridge session/);
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

  assert.match(result.messages[0]?.text ?? '', /Switched provider profile to minimax-default/);
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

  assert.match(result.messages[0]?.text ?? '', /Current provider profile: openai-default/);
  assert.match(result.messages[1]?.text ?? '', /Available provider profiles/);
  assert.match(result.messages[2]?.text ?? '', /openai-default/);
  assert.match(result.messages[3]?.text ?? '', /minimax-default/);
});

test('/threads lists provider-scoped threads and marks the current thread', async () => {
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

  assert.match(result.messages[0]?.text ?? '', /Provider profile: openai-default/);
  assert.match(result.messages[1]?.text ?? '', /Available threads/);
  const threadLines = result.messages.slice(2).map((message) => message.text);
  assert.ok(threadLines.some((line) => /^\* openai-default-thread-1 \| /.test(line)));
  assert.ok(threadLines.some((line) => /^- openai-default-thread-2 \| /.test(line)));
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

  assert.match(result.messages[0]?.text ?? '', new RegExp(`Opened Codex thread ${original.session?.codexThreadId}`));
  assert.equal(result.session?.codexThreadId, original.session?.codexThreadId);
  assert.equal(result.session?.bridgeSessionId, original.session?.bridgeSessionId);

  const status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-2',
    text: '/status',
  });

  assert.match(status.messages[4]?.text ?? '', new RegExp(`Codex thread: ${original.session?.codexThreadId}`));
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
