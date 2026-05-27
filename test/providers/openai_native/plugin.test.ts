import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAINativeProviderPlugin } from '../../../src/providers/openai_native/plugin.js';

function makeProfile(overrides = {}) {
  return {
    id: 'openai-default',
    providerKind: 'openai-native',
    displayName: 'OpenAI Default',
    config: {
      cliBin: 'codex',
      defaultModel: null,
      modelCatalog: [],
      modelCatalogMode: 'merge',
      ...overrides,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

test('OpenAINativeProviderPlugin delegates thread creation through CodexProviderPlugin', async () => {
  const calls: any[] = [];
  const plugin = new OpenAINativeProviderPlugin({
    clientFactory: (profile: any) => ({
      async start() {
        calls.push(['start', profile.id]);
      },
      async startThread(params: any) {
        calls.push(['startThread', profile.id, params.cwd]);
        return {
          threadId: 'thread-openai-1',
          cwd: params.cwd ?? null,
          title: params.title ?? null,
        };
      },
      async readThread() {
        return null;
      },
      async listThreads() {
        return { items: [], nextCursor: null };
      },
      async startTurn() {
        return { outputText: 'done', threadId: 'thread-openai-1', title: null };
      },
      async interruptTurn() {},
      async listModels() {
        return [];
      },
    }),
  });

  const result = await plugin.startThread({
    providerProfile: makeProfile(),
    cwd: '/tmp/openai',
  });

  assert.equal(plugin.kind, 'openai-native');
  assert.equal(plugin.displayName, 'OpenAI Native');
  assert.equal(result.threadId, 'thread-openai-1');
  assert.deepEqual(calls, [
    ['start', 'openai-default'],
    ['startThread', 'openai-default', '/tmp/openai'],
  ]);
});

test('OpenAINativeProviderPlugin uses the Codex default model when the bridge session does not explicitly select one', async () => {
  const calls: any[] = [];
  const plugin = new OpenAINativeProviderPlugin({
    clientFactory: () => ({
      async start() {
        calls.push(['start']);
      },
      async startThread(params: any) {
        calls.push(['startThread', params.model ?? null]);
        return {
          threadId: 'thread-openai-2',
          cwd: params.cwd ?? null,
          title: params.title ?? null,
        };
      },
      async startTurn(params: any) {
        calls.push(['startTurn', params.model ?? null]);
        return {
          outputText: 'done',
          threadId: params.threadId,
          title: null,
        };
      },
      async listModels() {
        calls.push(['listModels']);
        return [{
          id: 'gpt-5.1-codex-max',
          model: 'gpt-5.1-codex-max',
          displayName: 'GPT-5.1 Codex Max',
          description: '',
          isDefault: true,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
        }];
      },
    }),
  });

  const providerProfile = makeProfile();
  const session = {
    id: 'bridge-session-1',
    providerProfileId: providerProfile.id,
    codexThreadId: 'thread-openai-2',
    cwd: '/tmp/openai',
    title: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await plugin.startThread({
    providerProfile,
    cwd: '/tmp/openai',
  });
  await plugin.startTurn({
    providerProfile,
    bridgeSession: session,
    sessionSettings: null,
    event: {
      platform: 'weixin',
      externalScopeId: 'wx-user-1',
      text: 'hello',
    },
    inputText: 'hello',
  });

  assert.deepEqual(calls, [
    ['start'],
    ['listModels'],
    ['startThread', 'gpt-5.1-codex-max'],
    ['start'],
    ['listModels'],
    ['startTurn', 'gpt-5.1-codex-max'],
  ]);
});

test('OpenAINativeProviderPlugin delegates native thread compaction through CodexProviderPlugin', async () => {
  const calls: any[] = [];
  const plugin = new OpenAINativeProviderPlugin({
    clientFactory: () => ({
      async start() {
        calls.push(['start']);
      },
      async compactThread(params: any) {
        calls.push(['compactThread', params.threadId]);
        return {
          requestedThreadId: params.threadId,
          threadId: params.threadId,
          cwd: '/tmp/openai',
          title: 'Compacted thread',
          turnId: 'turn-compact-1',
          status: 'completed',
        };
      },
    }),
  });

  const result = await plugin.compactThread({
    providerProfile: makeProfile(),
    threadId: 'thread-openai-3',
  });

  assert.deepEqual(calls, [
    ['start'],
    ['compactThread', 'thread-openai-3'],
  ]);
  assert.equal(result.threadId, 'thread-openai-3');
  assert.equal(result.turnId, 'turn-compact-1');
});
