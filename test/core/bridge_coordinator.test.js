import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexBridgeRuntime } from '../../src/runtime/bootstrap.js';

class FakeProviderPlugin {
  constructor(kind, { replyPrefix }) {
    this.kind = kind;
    this.displayName = kind;
    this.replyPrefix = replyPrefix;
    this.startThreadCalls = [];
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

function makeRuntime({ defaultCwd = null } = {}) {
  const openai = new FakeProviderPlugin('openai-native', { replyPrefix: 'openai' });
  const minimax = new FakeProviderPlugin('minimax-via-cliproxy', { replyPrefix: 'minimax' });
  const runtime = createCodexBridgeRuntime({
    providerPlugins: [openai, minimax],
    providerProfiles: [
      makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default'),
      makeProviderProfile('minimax-default', 'minimax-via-cliproxy', 'MiniMax Default'),
    ],
    defaultProviderProfileId: 'openai-default',
    defaultCwd,
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

test('bridge coordinator uses the runtime default cwd for new sessions', async () => {
  const { runtime, openai } = makeRuntime({ defaultCwd: '/tmp/project' });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello codexbridge',
  });

  assert.equal(result.session?.providerProfileId, 'openai-default');
  assert.equal(openai.startThreadCalls[0]?.cwd, '/tmp/project');
  assert.equal(openai.startTurnCalls[0]?.bridgeSession.cwd, '/tmp/project');
});

test('bridge coordinator recreates a scope session when the bound thread is stale', async () => {
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
  assert.notEqual(result.session?.codexThreadId, original.session?.codexThreadId);
  assert.equal(openai.startThreadCalls.length, 2);
  assert.equal(openai.startTurnCalls.length, 3);
});

test('/status reports when no bridge session is bound yet', async () => {
  const { runtime } = makeRuntime({ defaultCwd: '/tmp/project' });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/status',
  });

  assert.match(result.messages[0]?.text ?? '', /No bridge session is bound/);
  assert.match(result.messages[1]?.text ?? '', /Default provider profile: openai-default/);
  assert.match(result.messages[2]?.text ?? '', /Default working directory: \/tmp\/project/);
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
  assert.match(status.messages[5]?.text ?? '', /Working directory:/);
});
