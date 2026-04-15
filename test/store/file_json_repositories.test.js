import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCodexBridgeRuntime } from '../../src/runtime/bootstrap.js';
import { createFileJsonRepositories } from '../../src/store/file_json/create_file_json_repositories.js';

class FakeProviderPlugin {
  constructor(kind) {
    this.kind = kind;
    this.displayName = kind;
    this.threadCounter = 0;
    this.threads = new Map();
  }

  async startThread({ providerProfile, cwd, title }) {
    this.threadCounter += 1;
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
    return [...this.threads.values()];
  }

  async startTurn({ bridgeSession, inputText }) {
    return {
      outputText: `echo: ${inputText}`,
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
    text: '/status',
  });

  assert.match(status.messages[0]?.text ?? '', /Scope: weixin:wx-user-1/);
  assert.match(status.messages[4]?.text ?? '', new RegExp(`Codex thread: ${first.session?.codexThreadId}`));
  assert.equal(status.session?.bridgeSessionId, first.session?.bridgeSessionId);
});
