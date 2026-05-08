import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexNativeApiServer } from '../../../src/providers/codex/native_api_server.js';
import { CodexNativeApiSideTaskRouter } from '../../../src/providers/codex/native_api_side_task_router.js';
import { CodexNativeRuntime } from '../../../src/providers/codex/native_runtime.js';

function makeProfile(overrides = {}) {
  return {
    id: 'openai-default',
    providerKind: 'codex',
    displayName: 'Codex OpenAI',
    config: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeEvent(overrides = {}) {
  return {
    platform: 'weixin',
    externalScopeId: 'wx-side-task',
    text: 'side task',
    cwd: '/repo',
    locale: 'zh-CN',
    attachments: [],
    metadata: {
      codexbridge: {
        developerPromptContext: {
          mode: 'command-skill-parser',
          title: 'Thread Command Skill',
          source: 'thread-command-skill',
          command: 'search',
          subcommand: 'search',
          operation: 'search',
        },
      },
    },
    ...overrides,
  };
}

test('CodexNativeApiSideTaskRouter routes eligible tasks through the localhost native API and preserves codexbridge metadata', async () => {
  const calls: Array<{ kind: string; payload: any }> = [];
  const runtime = new CodexNativeRuntime({
    now: () => 111,
    createSessionId: () => 'session-native-api-router-1',
    readAccountIdentity: () => ({
      email: 'native@example.com',
      name: 'Native Runtime',
      authMode: 'chatgpt',
      accountId: 'acc_native',
      plan: 'plus',
      authPath: '/tmp/auth.json',
    }),
  });
  const providerPlugin = {
    async listModels() {
      calls.push({ kind: 'listModels', payload: null });
      return [{
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'GPT-5.4',
        description: 'Frontier coding model.',
        isDefault: true,
        supportedReasoningEfforts: ['medium', 'high'],
        defaultReasoningEffort: 'medium',
      }];
    },
    async startThread(params: any) {
      calls.push({ kind: 'startThread', payload: params });
      return {
        threadId: 'thread-native-api-router-1',
        cwd: params.cwd,
        title: params.title,
      };
    },
    async startTurn(params: any) {
      calls.push({ kind: 'startTurn', payload: params });
      return {
        outputText: 'native api reply',
        previewText: '',
        threadId: params.bridgeSession.codexThreadId,
        turnId: 'turn-native-api-router-1',
      };
    },
  } as any;
  const server = new CodexNativeApiServer({
    runtime,
    resolveRuntimeContext: () => ({
      providerProfile: makeProfile(),
      providerPlugin,
    }),
    createResponseId: () => 'resp_native_api_router_1',
  });
  await server.start();
  try {
    const router = new CodexNativeApiSideTaskRouter({
      runtime,
      baseUrl: server.baseUrl,
    });
    const execution = await router.execute({
      taskClass: 'normalization',
      providerProfile: makeProfile(),
      providerPlugin,
      cwd: '/repo',
      title: 'Thread Command Skill',
      sessionMetadata: {
        sourcePlatform: 'weixin',
        source: 'thread-command-skill',
      },
      model: 'gpt-5.4',
      reasoningEffort: 'high',
      serviceTier: 'flex',
      locale: 'zh-CN',
      inputText: 'Find the invoice thread.',
      event: makeEvent(),
    });

    assert.equal(execution.route, 'native_api');
    assert.equal(execution.responseId, 'resp_native_api_router_1');
    assert.equal(execution.result.outputText, 'native api reply');
    assert.equal(execution.result.threadId, 'thread-native-api-router-1');
    assert.equal(calls[0]?.kind, 'listModels');
    assert.equal(calls[1]?.kind, 'startThread');
    assert.equal(calls[1]?.payload.metadata.sourcePlatform, 'weixin');
    assert.equal(calls[1]?.payload.metadata.sideTaskClass, 'normalization');
    assert.equal(calls[2]?.kind, 'startTurn');
    assert.equal(calls[2]?.payload.event.platform, 'codex-native-api');
    assert.deepEqual(calls[2]?.payload.event.metadata?.codexbridge?.developerPromptContext, {
      mode: 'command-skill-parser',
      title: 'Thread Command Skill',
      source: 'thread-command-skill',
      command: 'search',
      subcommand: 'search',
      operation: 'search',
    });
  } finally {
    await server.stop();
  }
});

test('CodexNativeApiSideTaskRouter falls back to direct native execution when the localhost API is unreachable', async () => {
  const runtime = new CodexNativeRuntime({
    now: () => 222,
    createSessionId: () => 'session-direct-native-1',
  });
  const calls: Array<{ kind: string; payload: any }> = [];
  const providerPlugin = {
    async startThread(params: any) {
      calls.push({ kind: 'startThread', payload: params });
      return {
        threadId: 'thread-direct-native-1',
        cwd: params.cwd,
        title: params.title,
      };
    },
    async startTurn(params: any) {
      calls.push({ kind: 'startTurn', payload: params });
      return {
        outputText: 'direct native reply',
        previewText: '',
        threadId: params.bridgeSession.codexThreadId,
        turnId: 'turn-direct-native-1',
      };
    },
  } as any;
  const router = new CodexNativeApiSideTaskRouter({
    runtime,
    baseUrl: 'http://127.0.0.1:43182',
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });

  const execution = await router.execute({
    taskClass: 'normalization',
    providerProfile: makeProfile(),
    providerPlugin,
    cwd: '/repo',
    title: 'Automation Command Skill',
    sessionMetadata: {
      sourcePlatform: 'weixin',
      source: 'automation-command-skill',
    },
    inputText: 'Normalize this draft.',
    locale: 'zh-CN',
    event: makeEvent({
      metadata: {
        codexbridge: {
          developerPromptContext: {
            mode: 'command-skill-parser',
            title: 'Automation Command Skill',
            source: 'automation-command-skill',
            command: 'auto',
            subcommand: 'add',
            operation: null,
          },
        },
      },
    }),
  });

  assert.equal(execution.route, 'direct_native');
  assert.equal(execution.responseId, null);
  assert.equal(execution.session?.id, 'session-direct-native-1');
  assert.equal(execution.result.outputText, 'direct native reply');
  assert.equal(calls[0]?.kind, 'startThread');
  assert.equal(calls[0]?.payload.metadata.sourcePlatform, 'weixin');
  assert.equal(calls[1]?.kind, 'startTurn');
  assert.equal(calls[1]?.payload.event.platform, 'weixin');
  assert.deepEqual(calls[1]?.payload.event.metadata?.codexbridge?.developerPromptContext, {
    mode: 'command-skill-parser',
    title: 'Automation Command Skill',
    source: 'automation-command-skill',
    command: 'auto',
    subcommand: 'add',
    operation: null,
  });
});

test('CodexNativeApiSideTaskRouter only routes explicitly enabled task classes through the localhost API', async () => {
  const runtime = new CodexNativeRuntime({
    now: () => 333,
    createSessionId: () => 'session-direct-native-2',
  });
  let fetchCalls = 0;
  const providerPlugin = {
    async startThread(params: any) {
      return {
        threadId: 'thread-direct-native-2',
        cwd: params.cwd,
        title: params.title,
      };
    },
    async startTurn(params: any) {
      return {
        outputText: 'direct native reply',
        previewText: '',
        threadId: params.bridgeSession.codexThreadId,
        turnId: 'turn-direct-native-2',
      };
    },
  } as any;
  const router = new CodexNativeApiSideTaskRouter({
    runtime,
    baseUrl: 'http://127.0.0.1:43182',
    enabledTaskClasses: ['small_verification'],
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new TypeError('fetch failed');
    },
  });

  const execution = await router.execute({
    taskClass: 'normalization',
    providerProfile: makeProfile(),
    providerPlugin,
    cwd: '/repo',
    title: 'Thread Command Skill',
    inputText: 'Normalize this request.',
    event: makeEvent(),
  });

  assert.equal(execution.route, 'direct_native');
  assert.equal(fetchCalls, 0);
});
