import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexNativeApiServer } from '../../../src/providers/codex/native_api_server.js';
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

test('CodexNativeApiServer exposes /v1/models with runtime metadata', async () => {
  const runtime = new CodexNativeRuntime({
    now: () => 111,
    readAccountIdentity: () => ({
      email: 'native@example.com',
      name: 'Native Runtime',
      authMode: 'chatgpt',
      accountId: 'acc_native',
      plan: 'plus',
      authPath: '/tmp/auth.json',
    }),
  });
  let modelCalls = 0;
  const providerPlugin = {
    async listModels() {
      modelCalls += 1;
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
  } as any;
  const server = new CodexNativeApiServer({
    runtime,
    resolveRuntimeContext: () => ({
      providerProfile: makeProfile(),
      providerPlugin,
    }),
  });
  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/models`);
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(modelCalls, 1);
    assert.equal(body.object, 'list');
    assert.equal(body.data[0].id, 'gpt-5.4');
    assert.equal(body.data[0].default, true);
    assert.equal(body.meta.native_runtime.ready, true);
    assert.equal(body.meta.native_runtime.account_identity.account_id, 'acc_native');
    assert.equal(body.meta.native_runtime.provider_profile_id, 'openai-default');
    assert.equal(body.meta.continuation_registry.kind, 'in_memory');
    assert.equal(body.meta.continuation_registry.persistence, 'in_process');
    assert.equal(body.meta.continuation_registry.survives_process_restart, false);
    assert.equal(body.meta.continuation_registry.ttl_ms, 30 * 60 * 1000);
  } finally {
    await server.stop();
  }
});

test('CodexNativeApiServer routes /v1/responses through isolated native runtime execution', async () => {
  const calls: Array<{ kind: string; payload: any }> = [];
  const runtime = new CodexNativeRuntime({
    now: () => 222000,
    createSessionId: () => 'session-native-api-1',
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
        id: 'gpt-5.5',
        model: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: 'Newest coding model.',
        isDefault: true,
        supportedReasoningEfforts: ['medium', 'high'],
        defaultReasoningEffort: 'medium',
      }];
    },
    async startThread(params: any) {
      calls.push({ kind: 'startThread', payload: params });
      return {
        threadId: 'thread-native-api-1',
        cwd: params.cwd,
        title: params.title,
      };
    },
    async startTurn(params: any) {
      calls.push({ kind: 'startTurn', payload: params });
      return {
        outputText: 'native answer',
        previewText: '',
        threadId: params.bridgeSession.codexThreadId,
        turnId: 'turn-native-api-1',
      };
    },
  } as any;
  const server = new CodexNativeApiServer({
    runtime,
    resolveRuntimeContext: () => ({
      providerProfile: makeProfile(),
      providerPlugin,
    }),
    defaultCwd: '/workspace/default',
    defaultLocale: 'zh-CN',
    createResponseId: () => 'resp_native_api_1',
  });
  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        instructions: 'Be terse.',
        input: [{
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: 'Explain the test.',
          }],
        }],
        reasoning: {
          effort: 'high',
        },
        service_tier: 'flex',
        metadata: {
          cwd: '/tmp/project',
          locale: 'en-US',
          ticket: 'NATIVE-1',
          codexbridge: {
            taskClass: 'normalization',
            threadMetadata: {
              sourcePlatform: 'weixin',
              source: 'assistant-record-command-skill',
            },
            eventMetadata: {
              developerPromptContext: {
                mode: 'command-skill-parser',
                title: 'Assistant Record Command Skill',
                source: 'assistant-record-command-skill',
                command: 'todo',
                subcommand: 'natural',
                operation: 'classify_new_record',
              },
            },
          },
        },
      }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(body.id, 'resp_native_api_1');
    assert.equal(body.object, 'response');
    assert.equal(body.status, 'completed');
    assert.equal(body.model, 'gpt-5.5');
    assert.equal(body.output[0].content[0].text, 'native answer');
    assert.equal(body.native_runtime.thread_id, 'thread-native-api-1');
    assert.equal(body.native_runtime.turn_id, 'turn-native-api-1');
    assert.equal(body.native_runtime.bridge_session_id, 'session-native-api-1');

    assert.equal(calls[0]?.kind, 'listModels');
    assert.equal(calls[1]?.kind, 'startThread');
    assert.equal(calls[1]?.payload.ephemeral, true);
    assert.equal(calls[1]?.payload.cwd, '/tmp/project');
    assert.equal(calls[1]?.payload.metadata.source, 'codex-native-api');
    assert.equal(calls[1]?.payload.metadata.sourcePlatform, 'weixin');
    assert.equal(calls[1]?.payload.metadata.sideTaskClass, 'normalization');

    assert.equal(calls[2]?.kind, 'startTurn');
    assert.equal(calls[2]?.payload.bridgeSession.id, 'session-native-api-1');
    assert.equal(calls[2]?.payload.sessionSettings.model, 'gpt-5.5');
    assert.equal(calls[2]?.payload.sessionSettings.reasoningEffort, 'high');
    assert.equal(calls[2]?.payload.sessionSettings.serviceTier, 'flex');
    assert.equal(calls[2]?.payload.sessionSettings.locale, 'en-US');
    assert.equal(calls[2]?.payload.sessionSettings.metadata.requestMetadata.ticket, 'NATIVE-1');
    assert.equal(calls[2]?.payload.event.platform, 'codex-native-api');
    assert.equal(calls[2]?.payload.event.cwd, '/tmp/project');
    assert.deepEqual(calls[2]?.payload.event.metadata?.codexbridge?.developerPromptContext, {
      mode: 'command-skill-parser',
      title: 'Assistant Record Command Skill',
      source: 'assistant-record-command-skill',
      command: 'todo',
      subcommand: 'natural',
      operation: 'classify_new_record',
    });
    assert.match(calls[2]?.payload.inputText, /System instructions:\nBe terse\./);
    assert.match(calls[2]?.payload.inputText, /Conversation input:\nUSER:\nExplain the test\./);
  } finally {
    await server.stop();
  }
});

test('CodexNativeApiServer continues the same isolated native thread via previous_response_id', async () => {
  let now = 500_000;
  let nextResponseId = 'resp_native_api_1';
  const calls: Array<{ kind: string; payload: any }> = [];
  const runtime = new CodexNativeRuntime({
    now: () => now,
    createSessionId: () => 'session-native-api-1',
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
        id: 'gpt-5.5',
        model: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: 'Newest coding model.',
        isDefault: true,
        supportedReasoningEfforts: ['medium', 'high'],
        defaultReasoningEffort: 'medium',
      }];
    },
    async startThread(params: any) {
      calls.push({ kind: 'startThread', payload: params });
      return {
        threadId: 'thread-native-api-1',
        cwd: params.cwd,
        title: params.title,
      };
    },
    async startTurn(params: any) {
      calls.push({ kind: 'startTurn', payload: params });
      return {
        outputText: params.event.externalScopeId === 'resp_native_api_1'
          ? 'initial answer'
          : 'follow-up answer',
        previewText: '',
        threadId: params.bridgeSession.codexThreadId,
        turnId: params.event.externalScopeId === 'resp_native_api_1'
          ? 'turn-native-api-1'
          : 'turn-native-api-2',
      };
    },
  } as any;
  const server = new CodexNativeApiServer({
    runtime,
    resolveRuntimeContext: () => ({
      providerProfile: makeProfile(),
      providerPlugin,
    }),
    defaultLocale: 'en-US',
    now: () => now,
    createResponseId: () => nextResponseId,
  });
  await server.start();
  try {
    const initial = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        input: 'First request',
      }),
    });
    const initialBody = await initial.json() as any;
    assert.equal(initial.status, 200);
    assert.equal(initialBody.id, 'resp_native_api_1');
    assert.equal(initialBody.output[0].content[0].text, 'initial answer');

    now = 501_000;
    nextResponseId = 'resp_native_api_2';
    const followup = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previous_response_id: 'resp_native_api_1',
        model: 'gpt-5.5',
        input: 'Second request',
      }),
    });
    const followupBody = await followup.json() as any;
    assert.equal(followup.status, 200);
    assert.equal(followupBody.id, 'resp_native_api_2');
    assert.equal(followupBody.previous_response_id, 'resp_native_api_1');
    assert.equal(followupBody.output[0].content[0].text, 'follow-up answer');
    assert.equal(followupBody.native_runtime.thread_id, 'thread-native-api-1');
    assert.equal(followupBody.native_runtime.bridge_session_id, 'session-native-api-1');

    const startThreadCalls = calls.filter((entry) => entry.kind === 'startThread');
    const startTurnCalls = calls.filter((entry) => entry.kind === 'startTurn');
    assert.equal(startThreadCalls.length, 1);
    assert.equal(startTurnCalls.length, 2);
    assert.equal(startTurnCalls[0]?.payload.bridgeSession.id, 'session-native-api-1');
    assert.equal(startTurnCalls[1]?.payload.bridgeSession.id, 'session-native-api-1');
    assert.equal(startTurnCalls[1]?.payload.bridgeSession.codexThreadId, 'thread-native-api-1');
    assert.equal(startTurnCalls[1]?.payload.sessionSettings.model, 'gpt-5.5');
    assert.equal(startTurnCalls[1]?.payload.event.externalScopeId, 'resp_native_api_2');
  } finally {
    await server.stop();
  }
});

test('CodexNativeApiServer rejects unknown continuation ids and streaming requests before runtime execution', async () => {
  let resolverCalls = 0;
  const server = new CodexNativeApiServer({
    resolveRuntimeContext: () => {
      resolverCalls += 1;
      throw new Error('resolver should not run');
    },
  });
  await server.start();
  try {
    const continuationResponse = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'hello',
        previous_response_id: 'resp_older',
      }),
    });
    const continuationBody = await continuationResponse.json() as any;
    assert.equal(continuationResponse.status, 404);
    assert.equal(continuationBody.error.code, 'continuation_not_found');
    assert.equal(continuationBody.continuation_registry.kind, 'in_memory');
    assert.equal(continuationBody.continuation_registry.persistence, 'in_process');
    assert.equal(continuationBody.continuation_registry.survives_process_restart, false);

    const streamingResponse = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'hello',
        stream: true,
      }),
    });
    const streamingBody = await streamingResponse.json() as any;
    assert.equal(streamingResponse.status, 400);
    assert.match(streamingBody.error.message, /Streaming is not implemented/);
    assert.equal(resolverCalls, 0);
  } finally {
    await server.stop();
  }
});

test('CodexNativeApiServer rejects continuation when the active native account changed', async () => {
  let currentAccountId = 'acc_native_1';
  let nextResponseId = 'resp_native_api_1';
  const calls: Array<{ kind: string; payload: any }> = [];
  const runtime = new CodexNativeRuntime({
    createSessionId: () => 'session-native-api-1',
    readAccountIdentity: () => ({
      email: 'native@example.com',
      name: 'Native Runtime',
      authMode: 'chatgpt',
      accountId: currentAccountId,
      plan: 'plus',
      authPath: '/tmp/auth.json',
    }),
  });
  const providerPlugin = {
    async listModels() {
      return [{
        id: 'gpt-5.5',
        model: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: 'Newest coding model.',
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      }];
    },
    async startThread(params: any) {
      calls.push({ kind: 'startThread', payload: params });
      return {
        threadId: 'thread-native-api-1',
        cwd: params.cwd,
        title: params.title,
      };
    },
    async startTurn(params: any) {
      calls.push({ kind: 'startTurn', payload: params });
      return {
        outputText: 'native answer',
        previewText: '',
        threadId: params.bridgeSession.codexThreadId,
        turnId: 'turn-native-api-1',
      };
    },
  } as any;
  const server = new CodexNativeApiServer({
    runtime,
    resolveRuntimeContext: () => ({
      providerProfile: makeProfile(),
      providerPlugin,
    }),
    createResponseId: () => nextResponseId,
  });
  await server.start();
  try {
    const initial = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'First request',
      }),
    });
    assert.equal(initial.status, 200);

    currentAccountId = 'acc_native_2';
    nextResponseId = 'resp_native_api_2';
    const followup = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        previous_response_id: 'resp_native_api_1',
        input: 'Second request',
      }),
    });
    const followupBody = await followup.json() as any;
    assert.equal(followup.status, 409);
    assert.equal(followupBody.error.code, 'continuation_account_mismatch');
    assert.match(followupBody.error.message, /acc_native_1/);
    assert.equal(calls.filter((entry) => entry.kind === 'startTurn').length, 1);
  } finally {
    await server.stop();
  }
});

test('CodexNativeApiServer enforces optional bearer auth on localhost routes', async () => {
  const runtime = new CodexNativeRuntime({
    now: () => 333,
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
      return [{
        id: 'gpt-5.4-mini',
        model: 'gpt-5.4-mini',
        displayName: 'GPT-5.4 Mini',
        description: '',
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      }];
    },
  } as any;
  const server = new CodexNativeApiServer({
    runtime,
    resolveRuntimeContext: () => ({
      providerProfile: makeProfile(),
      providerPlugin,
    }),
    authToken: 'native-secret',
  });
  await server.start();
  try {
    const unauthorized = await fetch(`${server.baseUrl}/v1/models`);
    const unauthorizedBody = await unauthorized.json() as any;
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorizedBody.error.code, 'invalid_auth_token');

    const authorized = await fetch(`${server.baseUrl}/v1/models`, {
      headers: {
        Authorization: 'Bearer native-secret',
      },
    });
    const authorizedBody = await authorized.json() as any;
    assert.equal(authorized.status, 200);
    assert.equal(authorizedBody.data[0].id, 'gpt-5.4-mini');
  } finally {
    await server.stop();
  }
});
