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
