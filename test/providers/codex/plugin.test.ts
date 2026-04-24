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

function makeBridgeSession(overrides = {}) {
  return {
    id: 'session-1',
    providerProfileId: 'openai-default',
    codexThreadId: 'thread-1',
    cwd: '/tmp/work',
    title: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeSessionSettings(overrides = {}) {
  return {
    bridgeSessionId: 'session-1',
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    personality: null,
    approvalPolicy: null,
    sandboxMode: null,
    locale: null,
    metadata: {},
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makePlugin(clientFactory: any) {
  return new CodexProviderPlugin({ clientFactory: clientFactory as any });
}

function makePluginWithReviewRunner(clientFactory: any, reviewRunner: any) {
  return new CodexProviderPlugin({
    clientFactory: clientFactory as any,
    reviewRunner: reviewRunner as any,
  });
}

test('CodexProviderPlugin uses per-profile clients and forwards default model into startThread/startTurn', async () => {
  const calls = [];
  let seenDeveloperInstructions = null;
  const plugin = makePlugin((profile: any) => ({
      async start() {
        calls.push(['start', profile.id]);
      },
      async startThread(params: any) {
        calls.push(['startThread', profile.id, params.model]);
        return {
          threadId: `${profile.id}-thread-1`,
          cwd: params.cwd ?? null,
          title: params.title ?? null,
        };
      },
      async readThread(threadId: string) {
        calls.push(['readThread', profile.id, threadId]);
        return {
          threadId,
          title: 'Existing thread',
          cwd: '/tmp/work',
        };
      },
      async listThreads() {
        calls.push(['listThreads', profile.id]);
        return { items: [{ threadId: `${profile.id}-thread-1`, cwd: '/tmp/work' }], nextCursor: null };
      },
      async startTurn(params: any) {
        seenDeveloperInstructions = params.developerInstructions;
        calls.push(['startTurn', profile.id, params.model]);
        return {
          outputText: 'done',
          threadId: params.threadId,
          title: 'Existing thread',
        };
      },
      async interruptTurn(params: any) {
        calls.push(['interruptTurn', profile.id, params.turnId]);
      },
      async listModels() {
        calls.push(['listModels', profile.id]);
        return [{
          id: 'gpt-5.4',
          model: 'gpt-5.4',
          displayName: 'GPT-5.4',
          description: '',
          isDefault: true,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
        }];
      },
    }));
  const profile = makeProfile({ defaultModel: 'gpt-5.4' });

  const started = await plugin.startThread({
    providerProfile: profile,
    cwd: '/tmp/work',
  });
  const turn = await plugin.startTurn({
    providerProfile: profile,
    bridgeSession: makeBridgeSession({
      codexThreadId: started.threadId,
      title: 'Existing thread',
    }),
    sessionSettings: makeSessionSettings(),
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

test('CodexProviderPlugin normalizes legacy service tier values before calling the app client', async () => {
  const seenServiceTiers: string[] = [];
  const plugin = makePlugin(() => ({
    async start() {},
    async startThread() {
      return { threadId: 'thread-1', cwd: '/tmp/work', title: null };
    },
    async startTurn(params: any) {
      seenServiceTiers.push(params.serviceTier);
      return {
        outputText: 'done',
        threadId: params.threadId,
        title: null,
      };
    },
    async listModels() {
      return [{
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'GPT-5.4',
        description: '',
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      }];
    },
  }));

  const profile = makeProfile({ defaultModel: 'gpt-5.4' });
  const bridgeSession = makeBridgeSession({ codexThreadId: 'thread-1' });

  await plugin.startTurn({
    providerProfile: profile,
    bridgeSession,
    sessionSettings: makeSessionSettings({ serviceTier: 'priority' }),
    event: { platform: 'weixin', externalScopeId: 'wxid_1', text: 'hello' },
    inputText: 'hello',
  });
  await plugin.startTurn({
    providerProfile: profile,
    bridgeSession,
    sessionSettings: makeSessionSettings({ serviceTier: 'default' }),
    event: { platform: 'weixin', externalScopeId: 'wxid_1', text: 'hello again' },
    inputText: 'hello again',
  });

  assert.deepEqual(seenServiceTiers, ['fast', 'flex']);
});

test('CodexProviderPlugin startReview runs native review through the injected review runner without rebinding a chat thread', async () => {
  const reviewCalls: any[] = [];
  const plugin = makePluginWithReviewRunner(() => ({
    async start() {},
  }), {
    async start(params: any) {
      reviewCalls.push(params);
      await params.onTurnStarted?.({
        threadId: 'codex-review-cli-1',
        turnId: 'codex-review-cli-1-turn-1',
      });
      return {
        outputText: 'review findings',
        outputState: 'complete',
        threadId: 'codex-review-cli-1',
        turnId: 'codex-review-cli-1-turn-1',
        finalSource: 'codex_review_cli',
      };
    },
    readThread() {
      return null;
    },
    async interrupt() {
      return false;
    },
  });

  const result = await plugin.startReview({
    providerProfile: makeProfile({ defaultModel: 'gpt-5.4' }),
    bridgeSession: makeBridgeSession({ codexThreadId: 'thread-1' }),
    sessionSettings: makeSessionSettings({
      model: 'gpt-5.4',
      reasoningEffort: 'xhigh',
      serviceTier: 'priority',
    }),
    cwd: '/tmp/work',
    target: {
      type: 'baseBranch',
      branch: 'main',
    },
    locale: 'zh-CN',
  });

  assert.equal(reviewCalls.length, 1);
  assert.equal(reviewCalls[0]?.cwd, '/tmp/work');
  assert.equal(reviewCalls[0]?.model, 'gpt-5.4');
  assert.equal(reviewCalls[0]?.effort, 'xhigh');
  assert.equal(reviewCalls[0]?.serviceTier, 'fast');
  assert.equal(reviewCalls[0]?.locale, 'zh-CN');
  assert.deepEqual(reviewCalls[0]?.target, {
    type: 'baseBranch',
    branch: 'main',
  });
  assert.equal(result.outputText, 'review findings');
  assert.equal(result.threadId, 'codex-review-cli-1');
});

test('CodexProviderPlugin turns inbound attachments into text prompt plus localImage inputs', async () => {
  let seenInput = null;
  let seenInputText = null;
  const plugin = makePlugin(() => ({
    async start() {},
    async startThread() {
      return { threadId: 'thread-1', cwd: null, title: null };
    },
    async readThread(threadId: string) {
      return { threadId, title: null, cwd: null };
    },
    async listThreads() {
      return { items: [], nextCursor: null };
    },
    async startTurn(params: any) {
      seenInput = params.input;
      seenInputText = params.inputText;
      return {
        outputText: 'done',
        threadId: params.threadId,
        title: null,
      };
    },
    async interruptTurn() {},
    async listModels() {
      return [{
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'GPT-5.4',
        description: '',
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      }];
    },
  }));

  await plugin.startTurn({
    providerProfile: makeProfile(),
    bridgeSession: makeBridgeSession(),
    sessionSettings: makeSessionSettings(),
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: '',
      attachments: [
        {
          kind: 'image',
          localPath: '/tmp/example.png',
          fileName: 'example.png',
          mimeType: 'image/png',
        },
        {
          kind: 'file',
          localPath: '/tmp/report.pdf',
          fileName: 'report.pdf',
          mimeType: 'application/pdf',
        },
      ],
    },
    inputText: '',
  });

  assert.equal(Array.isArray(seenInput), true);
  assert.equal(seenInput?.[0]?.type, 'text');
  assert.match(seenInput?.[0]?.text ?? '', /Weixin attachments:/);
  assert.match(seenInput?.[0]?.text ?? '', /report\.pdf/);
  assert.deepEqual(seenInput?.[1], {
    type: 'localImage',
    path: '/tmp/example.png',
  });
  assert.match(String(seenInputText ?? ''), /Weixin attachments:/);
});

test('CodexProviderPlugin forwards media outputs from the app client', async () => {
  const plugin = makePlugin(() => ({
    async start() {},
    async startThread() {
      return { threadId: 'thread-1', cwd: null, title: null };
    },
    async readThread(threadId: string) {
      return { threadId, title: null, cwd: null };
    },
    async listThreads() {
      return { items: [], nextCursor: null };
    },
    async startTurn(params: any) {
      return {
        outputText: '',
        outputMedia: [{
          kind: 'image',
          path: '/tmp/generated-dog.png',
          caption: null,
        }],
        threadId: params.threadId,
        title: null,
      };
    },
    async interruptTurn() {},
    async listModels() {
      return [{
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'GPT-5.4',
        description: '',
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      }];
    },
  }));

  const result = await plugin.startTurn({
    providerProfile: makeProfile(),
    bridgeSession: makeBridgeSession(),
    sessionSettings: makeSessionSettings(),
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: '画一只小狗',
    },
    inputText: '画一只小狗',
  });

  assert.deepEqual(result.outputMedia, [{
    kind: 'image',
    path: '/tmp/generated-dog.png',
    caption: null,
  }]);
  assert.deepEqual(result.outputArtifacts, [{
    kind: 'image',
    path: '/tmp/generated-dog.png',
    caption: null,
  }]);
});

test('CodexProviderPlugin auto-injects artifact send-back instructions for file delivery turns', async () => {
  let seenDeveloperInstructions = null;
  const plugin = makePlugin(() => ({
    async start() {},
    async startThread() {
      return { threadId: 'thread-1', cwd: null, title: null };
    },
    async readThread(threadId: string) {
      return { threadId, title: null, cwd: null };
    },
    async listThreads() {
      return { items: [], nextCursor: null };
    },
    async startTurn(params: any) {
      seenDeveloperInstructions = params.developerInstructions;
      return {
        outputText: 'done',
        threadId: params.threadId,
        title: null,
      };
    },
    async interruptTurn() {},
    async listModels() {
      return [{
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'GPT-5.4',
        description: '',
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      }];
    },
  }));

  await plugin.startTurn({
    providerProfile: makeProfile(),
    bridgeSession: makeBridgeSession(),
    sessionSettings: makeSessionSettings(),
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: '把这次未提交修改整理成 Word 文档发我',
      metadata: {
        codexbridge: {
          turnArtifactContext: {
            requestId: 'req-1',
            bridgeSessionId: 'session-1',
            artifactDir: '/tmp/project/.codexbridge/turn-artifacts/req-1',
            spoolDir: '/tmp/project/.codexbridge/artifact-spool/req-1',
            turnId: null,
            intent: {
              requested: true,
              preferredKind: 'file',
              requestedFormat: 'docx',
              requestedExtension: '.docx',
              requestedFileName: null,
              userDescription: '把这次未提交修改整理成 Word 文档发我',
              requiresClarification: false,
            },
          },
        },
      },
    },
    inputText: '把这次未提交修改整理成 Word 文档发我',
  });

  assert.match(String(seenDeveloperInstructions ?? ''), /CodexBridge attachment delivery protocol/);
  assert.match(String(seenDeveloperInstructions ?? ''), /\/tmp\/project\/\.codexbridge\/turn-artifacts\/req-1/);
  assert.match(String(seenDeveloperInstructions ?? ''), /codexbridge-artifacts/);
  assert.match(String(seenDeveloperInstructions ?? ''), /Choose a clear, semantic final filename yourself/i);
  assert.match(String(seenDeveloperInstructions ?? ''), /your-chosen-file\.docx/);
});

test('CodexProviderPlugin resolves default model metadata from listModels when profile defaults are empty', async () => {
  const calls = [];
  const plugin = makePlugin(() => ({
      async start() {},
      async startThread(params: any) {
        calls.push(['startThread', params.model]);
        return {
          threadId: 'thread-1',
          cwd: params.cwd ?? null,
          title: params.title ?? null,
        };
      },
      async readThread(threadId: string) {
        return { threadId, title: null, cwd: null };
      },
      async listThreads() {
        return { items: [], nextCursor: null };
      },
      async startTurn(params: any) {
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
          id: 'gpt-5.4',
          model: 'gpt-5.4',
          displayName: 'GPT-5.4',
          description: '',
          isDefault: true,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
        }];
      },
    }));
  const profile = makeProfile({ defaultModel: null });

  const started = await plugin.startThread({
    providerProfile: profile,
    cwd: '/tmp/work',
  });
  await plugin.startTurn({
    providerProfile: profile,
    bridgeSession: makeBridgeSession({
      codexThreadId: started.threadId,
    }),
    sessionSettings: makeSessionSettings(),
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
  const plugin = makePlugin(() => ({
      async start() {},
      async startThread() {
        return { threadId: 'thread-1', cwd: null, title: null };
      },
      async readThread(threadId: string) {
        return { threadId, title: null, cwd: null };
      },
      async listThreads() {
        return { items: [], nextCursor: null };
      },
      async startTurn(params: any) {
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
        return [{
          id: 'gpt-5.4',
          model: 'gpt-5.4',
          displayName: 'GPT-5.4',
          description: '',
          isDefault: true,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
        }];
      },
    }));
  const seen = [];

  const result = await plugin.startTurn({
    providerProfile: makeProfile(),
    bridgeSession: makeBridgeSession(),
    sessionSettings: makeSessionSettings(),
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
  const plugin = makePlugin(() => ({
      async start() {},
      async startThread() {
        return { threadId: 'thread-1', cwd: null, title: null };
      },
      async readThread(threadId: string, includeTurns: boolean) {
        calls.push(['readThread', threadId, includeTurns]);
        return { threadId, title: 'Thread 1', cwd: '/tmp/work', turns: includeTurns ? [] : undefined };
      },
      async listThreads(params: any) {
        calls.push(['listThreads', params]);
        return { items: [{ threadId: 'thread-1', title: 'Thread 1', cwd: '/tmp/work' }], nextCursor: 'cursor-2' };
      },
      async startTurn() {
        return { outputText: 'done', threadId: 'thread-1', title: null };
      },
      async interruptTurn() {},
      async listModels() {
        return [{
          id: 'gpt-5.4',
          model: 'gpt-5.4',
          displayName: 'GPT-5.4',
          description: '',
          isDefault: true,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
        }];
      },
    }));
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
    items: [{ threadId: 'thread-1', title: 'Thread 1', cwd: '/tmp/work' }],
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
  const plugin = makePlugin(() => {
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
      async readThread(threadId: string) {
        return { threadId, cwd: '/tmp/work', title: null };
      },
      async listThreads() {
        return { items: [], nextCursor: null };
      },
      async startTurn(params: any) {
        return {
          outputText: `${name}-done`,
          outputState: 'complete',
          threadId: params.threadId,
          title: null,
        };
      },
      async interruptTurn() {},
      async listModels() {
        return [{
          id: 'gpt-5.4',
          model: 'gpt-5.4',
          displayName: 'GPT-5.4',
          description: '',
          isDefault: true,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
        }];
      },
      async resumeThread() {
        return {};
      },
    };
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
    bridgeSession: makeBridgeSession(),
    sessionSettings: makeSessionSettings(),
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

test('CodexProviderPlugin forwards session personality to the app client', async () => {
  let seenPersonality = null;
  const plugin = makePlugin(() => ({
      async start() {},
      async startThread() {
        return { threadId: 'thread-1', cwd: null, title: null };
      },
      async readThread(threadId: string) {
        return { threadId, title: null, cwd: null };
      },
      async listThreads() {
        return { items: [], nextCursor: null };
      },
      async startTurn(params: any) {
        seenPersonality = params.personality;
        return {
          outputText: 'done',
          outputState: 'complete',
          threadId: params.threadId,
          title: null,
        };
      },
      async interruptTurn() {},
      async listModels() {
        return [{
          id: 'gpt-5.4',
          model: 'gpt-5.4',
          displayName: 'GPT-5.4',
          description: '',
          isDefault: true,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
        }];
      },
      async resumeThread() {
        return {};
      },
    }));

  await plugin.startTurn({
    providerProfile: makeProfile(),
    bridgeSession: makeBridgeSession(),
    sessionSettings: makeSessionSettings({
      personality: 'friendly',
    }),
    event: {
      platform: 'weixin',
      externalScopeId: 'wxid_1',
      text: 'hello',
    },
    inputText: 'hello',
  });

  assert.equal(seenPersonality, 'friendly');
});
