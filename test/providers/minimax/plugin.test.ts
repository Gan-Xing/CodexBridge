import assert from 'node:assert/strict';
import test from 'node:test';
import { MiniMaxViaCLIProxyProviderPlugin } from '../../../src/providers/minimax/plugin.js';

function makeProfile(overrides = {}) {
  return {
    id: 'minimax-default',
    providerKind: 'minimax-via-cliproxy',
    displayName: 'MiniMax Default',
    config: {
      cliBin: 'codex-via-proxy',
      defaultModel: 'MiniMax-M2.7',
      modelCatalog: [],
      modelCatalogMode: 'overlay-only',
      ...overrides,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

test('MiniMaxViaCLIProxyProviderPlugin delegates thread listing through CodexProviderPlugin', async () => {
  const calls: any[] = [];
  const plugin = new MiniMaxViaCLIProxyProviderPlugin({
    clientFactory: (profile: any) => ({
      async start() {
        calls.push(['start', profile.id]);
      },
      async startThread() {
        return { threadId: 'thread-1', cwd: null, title: null };
      },
      async readThread() {
        return null;
      },
      async listThreads(params: any) {
        calls.push(['listThreads', profile.id, params.searchTerm]);
        return {
          items: [{
            threadId: 'thread-minimax-1',
            cwd: '/tmp/minimax',
            title: 'MiniMax thread',
            preview: 'hello',
          }],
          nextCursor: null,
        };
      },
      async startTurn() {
        return { outputText: 'done', threadId: 'thread-minimax-1', title: null };
      },
      async interruptTurn() {},
      async listModels() {
        return [];
      },
    }),
  });

  const result = await plugin.listThreads({
    providerProfile: makeProfile(),
    searchTerm: 'bridge',
  });

  assert.equal(plugin.kind, 'minimax-via-cliproxy');
  assert.equal(plugin.displayName, 'MiniMax via CLIProxyAPI');
  assert.equal(result.items[0]?.threadId, 'thread-minimax-1');
  assert.deepEqual(calls, [
    ['start', 'minimax-default'],
    ['listThreads', 'minimax-default', 'bridge'],
  ]);
});
