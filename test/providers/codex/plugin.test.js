import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexProviderPlugin } from '../../../src/providers/codex/plugin.js';

function makeProfile(overrides = {}) {
  return {
    id: 'openai-default',
    providerKind: 'codex',
    displayName: 'Codex OpenAI',
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

test('CodexProviderPlugin uses per-profile clients and forwards default model into startThread/startTurn', async () => {
  const calls = [];
  const plugin = new CodexProviderPlugin({
    clientFactory: (profile) => ({
      async start() {
        calls.push(['start', profile.id]);
      },
      async startThread(params) {
        calls.push(['startThread', profile.id, params.model]);
        return {
          threadId: `${profile.id}-thread-1`,
          cwd: params.cwd ?? null,
          title: params.title ?? null,
        };
      },
      async readThread(threadId) {
        calls.push(['readThread', profile.id, threadId]);
        return {
          threadId,
          title: 'Existing thread',
          cwd: '/tmp/work',
        };
      },
      async listThreads() {
        calls.push(['listThreads', profile.id]);
        return [{ threadId: `${profile.id}-thread-1` }];
      },
      async startTurn(params) {
        calls.push(['startTurn', profile.id, params.model]);
        return {
          outputText: 'done',
          threadId: params.threadId,
          title: 'Existing thread',
        };
      },
      async interruptTurn(params) {
        calls.push(['interruptTurn', profile.id, params.turnId]);
      },
      async listModels() {
        calls.push(['listModels', profile.id]);
        return [{ model: 'gpt-5.4' }];
      },
    }),
  });
  const profile = makeProfile({ defaultModel: 'gpt-5.4' });

  const started = await plugin.startThread({
    providerProfile: profile,
    cwd: '/tmp/work',
  });
  const turn = await plugin.startTurn({
    providerProfile: profile,
    bridgeSession: {
      id: 'session-1',
      codexThreadId: started.threadId,
      cwd: '/tmp/work',
      title: 'Existing thread',
    },
    sessionSettings: {
      model: null,
      reasoningEffort: null,
      serviceTier: null,
    },
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: 'hello',
    },
    inputText: 'hello',
  });

  assert.equal(started.threadId, 'openai-default-thread-1');
  assert.equal(turn.outputText, 'done');
  assert.ok(calls.some((entry) => entry[0] === 'startThread' && entry[2] === 'gpt-5.4'));
  assert.ok(calls.some((entry) => entry[0] === 'startTurn' && entry[2] === 'gpt-5.4'));
});

test('CodexProviderPlugin resolves default model metadata from listModels when profile defaults are empty', async () => {
  const calls = [];
  const plugin = new CodexProviderPlugin({
    clientFactory: () => ({
      async start() {},
      async startThread(params) {
        calls.push(['startThread', params.model]);
        return {
          threadId: 'thread-1',
          cwd: params.cwd ?? null,
          title: params.title ?? null,
        };
      },
      async readThread(threadId) {
        return { threadId, title: null, cwd: null };
      },
      async listThreads() {
        return [];
      },
      async startTurn(params) {
        calls.push(['startTurn', params.model, params.effort]);
        return {
          outputText: 'done',
          threadId: params.threadId,
          title: null,
        };
      },
      async interruptTurn() {},
      async listModels() {
        return [{
          model: 'gpt-5.4',
          isDefault: true,
          defaultReasoningEffort: 'medium',
        }];
      },
    }),
  });
  const profile = makeProfile({ defaultModel: null });

  const started = await plugin.startThread({
    providerProfile: profile,
    cwd: '/tmp/work',
  });
  await plugin.startTurn({
    providerProfile: profile,
    bridgeSession: {
      id: 'session-1',
      codexThreadId: started.threadId,
      cwd: '/tmp/work',
      title: null,
    },
    sessionSettings: {
      model: null,
      reasoningEffort: null,
      serviceTier: null,
    },
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: 'hello',
    },
    inputText: 'hello',
  });

  assert.deepEqual(calls, [
    ['startThread', 'gpt-5.4'],
    ['startTurn', 'gpt-5.4', 'medium'],
  ]);
});
