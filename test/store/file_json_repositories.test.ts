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
