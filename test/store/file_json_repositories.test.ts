import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCodexBridgeRuntime } from '../../src/runtime/bootstrap.js';
import { createFileJsonRepositories } from '../../src/store/file_json/create_file_json_repositories.js';

class FakeProviderPlugin {
  kind: string;
  displayName: string;
  threadCounter: number;
  baseTime: number;
  clock: number;
  threads: Map<string, any>;

  constructor(kind: string) {
    this.kind = kind;
    this.displayName = kind;
    this.threadCounter = 0;
    this.baseTime = Date.now();
    this.clock = 0;
    this.threads = new Map();
  }

  nextUpdatedAt() {
    this.clock += 1;
    return this.baseTime + this.clock;
  }

  async startThread({ providerProfile, cwd, title }: any) {
    this.threadCounter += 1;
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

  async readThread({ threadId, includeTurns = false }: any) {
    const thread = this.threads.get(threadId) ?? null;
    if (!thread) {
      return null;
    }
    return {
      ...thread,
      turns: includeTurns ? thread.turns : [],
    };
  }

  async listThreads({ limit = 20, cursor = null } = {}) {
    const offset = cursor ? Number(cursor) : 0;
    const threads = [...this.threads.values()];
    const items = threads.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    return {
      items,
      nextCursor: nextOffset < threads.length ? String(nextOffset) : null,
    };
  }

  async startTurn({ bridgeSession, inputText }: any) {
    const existingThread = this.threads.get(bridgeSession.codexThreadId);
    if (existingThread) {
      this.threads.set(bridgeSession.codexThreadId, {
        ...existingThread,
        preview: inputText,
        updatedAt: this.nextUpdatedAt(),
      });
    }
    return {
      outputText: `echo: ${inputText}`,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  }
}

function makeProviderProfile(id: string, providerKind: string, displayName: string) {
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

test('file-backed repositories preserve scope bindings across runtime restarts', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-json-store-'));
  const providerProfile = makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default');
  const providerPlugin = new FakeProviderPlugin('openai-native');

  const runtimeA = createCodexBridgeRuntime({
    providerPlugins: [providerPlugin],
    providerProfiles: [providerProfile],
    defaultProviderProfileId: providerProfile.id,
    repositories: createFileJsonRepositories(stateDir),
  });

  const first = await runtimeA.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello',
  });

  const runtimeB = createCodexBridgeRuntime({
    providerPlugins: [providerPlugin],
    providerProfiles: [providerProfile],
    defaultProviderProfileId: providerProfile.id,
    repositories: createFileJsonRepositories(stateDir),
  });

  const status = await runtimeB.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/status details',
  });

  const lines = status.messages.map((message: any) => message?.text ?? '');
  assert.ok(lines.some((line: string) => /Scope：weixin:wx-user-1/.test(line)));
  assert.ok(lines.some((line: string) => new RegExp(`Codex 线程：${first.session?.codexThreadId}`).test(line)));
  assert.equal(status.session?.bridgeSessionId, first.session?.bridgeSessionId);
});

test('file-backed repositories preserve thread aliases across runtime restarts', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-json-store-'));
  const providerProfile = makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default');
  const providerPlugin = new FakeProviderPlugin('openai-native');

  const runtimeA = createCodexBridgeRuntime({
    providerPlugins: [providerPlugin],
    providerProfiles: [providerProfile],
    defaultProviderProfileId: providerProfile.id,
    repositories: createFileJsonRepositories(stateDir),
  });

  await runtimeA.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'rename me',
  });
  await runtimeA.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/threads',
  });
  await runtimeA.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/rename 1 微信桥接排障',
  });

  const runtimeB = createCodexBridgeRuntime({
    providerPlugins: [providerPlugin],
    providerProfiles: [providerProfile],
    defaultProviderProfileId: providerProfile.id,
    repositories: createFileJsonRepositories(stateDir),
  });

  const result = await runtimeB.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/threads',
  });

  assert.match(result.messages[0]?.text ?? '', /微信桥接排障/);
});

test('file-backed repositories preserve archived thread metadata across runtime restarts', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-json-store-'));
  const providerProfile = makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default');
  const providerPlugin = new FakeProviderPlugin('openai-native');

  const runtimeA = createCodexBridgeRuntime({
    providerPlugins: [providerPlugin],
    providerProfiles: [providerProfile],
    defaultProviderProfileId: providerProfile.id,
    repositories: createFileJsonRepositories(stateDir),
  });

  await runtimeA.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-archive-store-1',
    text: 'archive me',
  });
  await runtimeA.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/threads',
  });
  await runtimeA.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/threads del 1',
  });

  const runtimeB = createCodexBridgeRuntime({
    providerPlugins: [providerPlugin],
    providerProfiles: [providerProfile],
    defaultProviderProfileId: providerProfile.id,
    repositories: createFileJsonRepositories(stateDir),
  });

  const defaultView = await runtimeB.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/threads',
  });
  assert.doesNotMatch(defaultView.messages[0]?.text ?? '', /archive me/);

  const allView = await runtimeB.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/threads all',
  });
  assert.match(allView.messages[0]?.text ?? '', /OpenAI Default thread 1 \[已归档\]/);
  assert.match(allView.messages[0]?.text ?? '', /预览：archive me/);
});

test('file-backed repositories preserve pinned thread metadata across runtime restarts', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-json-store-'));
  const providerProfile = makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default');
  const providerPlugin = new FakeProviderPlugin('openai-native');

  const runtimeA = createCodexBridgeRuntime({
    providerPlugins: [providerPlugin],
    providerProfiles: [providerProfile],
    defaultProviderProfileId: providerProfile.id,
    repositories: createFileJsonRepositories(stateDir),
  });

  await runtimeA.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-pin-store-1',
    text: 'pin me',
  });
  await runtimeA.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/threads',
  });
  await runtimeA.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/threads pin 1',
  });

  const runtimeB = createCodexBridgeRuntime({
    providerPlugins: [providerPlugin],
    providerProfiles: [providerProfile],
    defaultProviderProfileId: providerProfile.id,
    repositories: createFileJsonRepositories(stateDir),
  });

  const defaultView = await runtimeB.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/threads',
  });
  assert.match(defaultView.messages[0]?.text ?? '', /OpenAI Default thread 1 \[置顶\]/);

  const pinnedView = await runtimeB.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/threads pin',
  });
  assert.match(pinnedView.messages[0]?.text ?? '', /OpenAI Default thread 1 \[置顶\]/);
  assert.match(pinnedView.messages[0]?.text ?? '', /预览：pin me/);
});

test('file-backed repositories preserve plugin aliases across repository reloads', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-json-store-'));
  const repositoriesA = createFileJsonRepositories(stateDir);
  repositoriesA.pluginAliases.save({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugins',
    providerProfileId: 'openai-default',
    alias: 'gd',
    pluginId: 'google-drive@openai-curated',
    pluginName: 'google-drive',
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    displayName: 'Google Drive',
    updatedAt: Date.now(),
  });

  const repositoriesB = createFileJsonRepositories(stateDir);
  const aliases = repositoriesB.pluginAliases.listByScope('weixin', 'wx-user-plugins', 'openai-default');
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0]?.alias, 'gd');
  assert.equal(aliases[0]?.pluginId, 'google-drive@openai-curated');
});

test('file-backed repositories preserve agent jobs across repository reloads', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-json-store-'));
  const providerProfile = makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default');
  const providerPlugin = new FakeProviderPlugin('openai-native');
  const repositoriesA = createFileJsonRepositories(stateDir);
  const runtimeA = createCodexBridgeRuntime({
    providerPlugins: [providerPlugin],
    providerProfiles: [providerProfile],
    defaultProviderProfileId: providerProfile.id,
    repositories: repositoriesA,
  });
  const session = await runtimeA.services.bridgeSessions.createDetachedSession({
    providerProfileId: providerProfile.id,
    cwd: '/repo',
    title: 'Agent | Test',
    initialSettings: {
      locale: 'zh-CN',
    },
  });
  const job = runtimeA.services.agentJobs.createJob({
    scopeRef: {
      platform: 'weixin',
      externalScopeId: 'wx-agent-store',
    },
    title: '测试 Agent',
    originalInput: '测试',
    goal: '测试持久化',
    expectedOutput: '保存后可恢复',
    plan: ['创建任务', '重载仓库'],
    category: 'code',
    riskLevel: 'low',
    mode: 'hybrid',
    providerProfileId: providerProfile.id,
    bridgeSessionId: session.id,
    cwd: '/repo',
    locale: 'zh-CN',
  });

  const repositoriesB = createFileJsonRepositories(stateDir);
  const restored = repositoriesB.agentJobs.getById(job.id);
  assert.equal(restored?.title, '测试 Agent');
  assert.equal(restored?.goal, '测试持久化');
  assert.equal(restored?.bridgeSessionId, session.id);
});
