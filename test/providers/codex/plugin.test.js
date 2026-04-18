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
  let seenDeveloperInstructions = null;
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
        seenDeveloperInstructions = params.developerInstructions;
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
  assert.equal(seenDeveloperInstructions, '');
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

test('CodexProviderPlugin forwards onTurnStarted to the app client and returns the turn id', async () => {
  const plugin = new CodexProviderPlugin({
    clientFactory: () => ({
      async start() {},
      async startThread() {
        return { threadId: 'thread-1', cwd: null, title: null };
      },
      async readThread(threadId) {
        return { threadId, title: null, cwd: null };
      },
      async listThreads() {
        return [];
      },
      async startTurn(params) {
        await params.onTurnStarted?.({
          turnId: 'turn-1',
          threadId: params.threadId,
        });
        return {
          outputText: 'done',
          turnId: 'turn-1',
          threadId: params.threadId,
          title: null,
        };
      },
      async interruptTurn() {},
      async listModels() {
        return [{ model: 'gpt-5.4' }];
      },
    }),
  });
  const seen = [];

  const result = await plugin.startTurn({
    providerProfile: makeProfile(),
    bridgeSession: {
      id: 'session-1',
      codexThreadId: 'thread-1',
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
    onTurnStarted: async (meta) => {
      seen.push(meta);
    },
  });

  assert.equal(result.turnId, 'turn-1');
  assert.deepEqual(seen, [{
    turnId: 'turn-1',
    threadId: 'thread-1',
  }]);
});

test('CodexProviderPlugin forwards thread list paging and includeTurns reads to the app client', async () => {
  const calls = [];
  const plugin = new CodexProviderPlugin({
    clientFactory: () => ({
      async start() {},
      async startThread() {
        return { threadId: 'thread-1', cwd: null, title: null };
      },
      async readThread(threadId, includeTurns) {
        calls.push(['readThread', threadId, includeTurns]);
        return { threadId, title: 'Thread 1', cwd: '/tmp/work', turns: includeTurns ? [] : undefined };
      },
      async listThreads(params) {
        calls.push(['listThreads', params]);
        return { items: [{ threadId: 'thread-1', title: 'Thread 1' }], nextCursor: 'cursor-2' };
      },
      async startTurn() {
        return { outputText: 'done', threadId: 'thread-1', title: null };
      },
      async interruptTurn() {},
      async listModels() {
        return [{ model: 'gpt-5.4' }];
      },
    }),
  });
  const profile = makeProfile();

  const listed = await plugin.listThreads({
    providerProfile: profile,
    limit: 5,
    cursor: 'cursor-1',
    searchTerm: 'bridge',
  });
  const thread = await plugin.readThread({
    providerProfile: profile,
    threadId: 'thread-1',
    includeTurns: true,
  });

  assert.deepEqual(listed, {
    items: [{ threadId: 'thread-1', title: 'Thread 1' }],
    nextCursor: 'cursor-2',
  });
  assert.equal(thread.threadId, 'thread-1');
  assert.deepEqual(calls, [
    ['listThreads', { limit: 5, cursor: 'cursor-1', searchTerm: 'bridge' }],
    ['readThread', 'thread-1', true],
  ]);
});

test('CodexProviderPlugin reconnectProfile replaces the existing client instance', async () => {
  const lifecycle = [];
  let clientIndex = 0;
  const plugin = new CodexProviderPlugin({
    clientFactory: () => {
      clientIndex += 1;
      const name = `client-${clientIndex}`;
      let connected = false;
      return {
        async start() {
          if (connected) {
            return;
          }
          connected = true;
          lifecycle.push([name, 'start']);
        },
        async stop() {
          connected = false;
          lifecycle.push([name, 'stop']);
        },
        isConnected() {
          return connected;
        },
        async startThread() {
          return {
            threadId: `${name}-thread`,
            cwd: '/tmp/work',
            title: null,
          };
        },
        async readThread(threadId) {
          return { threadId, cwd: '/tmp/work', title: null };
        },
        async listThreads() {
          return [];
        },
        async startTurn(params) {
          return {
            outputText: `${name}-done`,
            outputState: 'complete',
            threadId: params.threadId,
            title: null,
          };
        },
        async interruptTurn() {},
        async listModels() {
          return [{ model: 'gpt-5.4' }];
        },
        async resumeThread() {
          return {};
        },
      };
    },
  });
  const profile = makeProfile();

  await plugin.startThread({
    providerProfile: profile,
    cwd: '/tmp/work',
  });
  const reconnect = await plugin.reconnectProfile({
    providerProfile: profile,
  });
  const turn = await plugin.startTurn({
    providerProfile: profile,
    bridgeSession: {
      id: 'session-1',
      codexThreadId: 'thread-1',
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

  assert.equal(reconnect.connected, true);
  assert.deepEqual(lifecycle, [
    ['client-1', 'start'],
    ['client-1', 'stop'],
    ['client-2', 'start'],
  ]);
  assert.equal(turn.outputText, 'client-2-done');
});

test('CodexProviderPlugin forwards developer instructions from environment when configured', async () => {
  const previous = process.env.CODEXBRIDGE_CODEX_DEVELOPER_INSTRUCTIONS;
  process.env.CODEXBRIDGE_CODEX_DEVELOPER_INSTRUCTIONS = 'Always inspect the workspace.';

  try {
    let seenDeveloperInstructions = null;
    const plugin = new CodexProviderPlugin({
      clientFactory: () => ({
        async start() {},
        async startThread() {
          return { threadId: 'thread-1', cwd: null, title: null };
        },
        async readThread(threadId) {
          return { threadId, title: null, cwd: null };
        },
        async listThreads() {
          return [];
        },
        async startTurn(params) {
          seenDeveloperInstructions = params.developerInstructions;
          return {
            outputText: 'done',
            outputState: 'complete',
            threadId: params.threadId,
            title: null,
          };
        },
        async interruptTurn() {},
        async listModels() {
          return [{ model: 'gpt-5.4', isDefault: true }];
        },
        async resumeThread() {
          return {};
        },
      }),
    });

    await plugin.startTurn({
      providerProfile: makeProfile(),
      bridgeSession: {
        id: 'session-1',
        codexThreadId: 'thread-1',
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

    assert.equal(seenDeveloperInstructions, 'Always inspect the workspace.');
  } finally {
    if (previous === undefined) {
      delete process.env.CODEXBRIDGE_CODEX_DEVELOPER_INSTRUCTIONS;
    } else {
      process.env.CODEXBRIDGE_CODEX_DEVELOPER_INSTRUCTIONS = previous;
    }
  }
});
