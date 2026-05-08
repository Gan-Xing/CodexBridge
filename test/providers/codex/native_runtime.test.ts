import assert from 'node:assert/strict';
import test from 'node:test';
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

test('CodexNativeRuntime runIsolatedTurn reuses one ephemeral substrate with read-only defaults', async () => {
  const calls: Array<{ kind: string; payload: any }> = [];
  const runtime = new CodexNativeRuntime({
    now: () => 1234567890,
    createSessionId: () => 'session-native-1',
  });
  const providerPlugin = {
    async startThread(params: any) {
      calls.push({ kind: 'startThread', payload: params });
      return {
        threadId: 'thread-native-1',
        cwd: '/tmp/runtime',
        title: 'Native Runtime Skill',
      };
    },
    async startTurn(params: any) {
      calls.push({ kind: 'startTurn', payload: params });
      return {
        outputText: 'normalized',
        previewText: '',
        threadId: params.bridgeSession.codexThreadId,
      };
    },
  } as any;

  const execution = await runtime.runIsolatedTurn({
    providerProfile: makeProfile(),
    providerPlugin,
    cwd: '/tmp/original',
    title: 'Native Runtime Skill',
    metadata: {
      source: 'unit-test',
    },
    model: 'gpt-5.5',
    reasoningEffort: 'high',
    serviceTier: 'flex',
    prepareTurn: (session) => ({
      inputText: `cwd=${session.cwd}`,
      locale: 'zh-CN',
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      event: {
        platform: 'weixin',
        externalScopeId: 'wx-native-runtime-1',
        text: `cwd=${session.cwd}`,
        cwd: session.cwd,
        locale: 'zh-CN',
        attachments: [],
      },
    }),
  });

  assert.equal(execution.session.id, 'session-native-1');
  assert.equal(execution.session.codexThreadId, 'thread-native-1');
  assert.equal(execution.session.cwd, '/tmp/runtime');
  assert.equal(execution.result.outputText, 'normalized');
  assert.equal(calls[0]?.kind, 'startThread');
  assert.equal(calls[0]?.payload.ephemeral, true);
  assert.equal(calls[0]?.payload.metadata.source, 'unit-test');
  assert.equal(calls[1]?.kind, 'startTurn');
  assert.equal(calls[1]?.payload.bridgeSession.id, 'session-native-1');
  assert.equal(calls[1]?.payload.sessionSettings.model, 'gpt-5.5');
  assert.equal(calls[1]?.payload.sessionSettings.reasoningEffort, 'high');
  assert.equal(calls[1]?.payload.sessionSettings.serviceTier, 'flex');
  assert.equal(calls[1]?.payload.sessionSettings.accessPreset, 'read-only');
  assert.equal(calls[1]?.payload.sessionSettings.approvalPolicy, 'never');
  assert.equal(calls[1]?.payload.sessionSettings.sandboxMode, 'read-only');
  assert.equal(calls[1]?.payload.sessionSettings.locale, 'zh-CN');
  assert.equal(calls[1]?.payload.event.cwd, '/tmp/runtime');
  assert.equal(calls[1]?.payload.inputText, 'cwd=/tmp/runtime');
});

test('CodexNativeRuntime checkReadiness reports account identity and model probe status', async () => {
  const runtime = new CodexNativeRuntime({
    now: () => 222,
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
    async startThread() {
      return null;
    },
    async startTurn() {
      return null;
    },
    async listModels() {
      return [{
        id: 'gpt-5.5',
        model: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: '',
        isDefault: true,
        supportedReasoningEfforts: ['medium'],
        defaultReasoningEffort: 'medium',
      }];
    },
  } as any;

  const readiness = await runtime.checkReadiness({
    providerProfile: makeProfile(),
    providerPlugin,
  });

  assert.equal(readiness.ready, true);
  assert.equal(readiness.runtimeReachable, true);
  assert.equal(readiness.modelCount, 1);
  assert.equal(readiness.accountIdentity?.accountId, 'acc_native');
  assert.equal(readiness.errorMessage, null);
  assert.equal(readiness.checkedAt, 222);
});

test('CodexNativeRuntime checkReadiness surfaces readiness probe failures', async () => {
  const runtime = new CodexNativeRuntime({
    now: () => 333,
    readAccountIdentity: () => null,
  });
  const providerPlugin = {
    async startThread() {
      return null;
    },
    async startTurn() {
      return null;
    },
    async listModels() {
      throw new Error('probe failed');
    },
  } as any;

  const readiness = await runtime.checkReadiness({
    providerProfile: makeProfile(),
    providerPlugin,
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.runtimeReachable, false);
  assert.equal(readiness.modelCount, null);
  assert.equal(readiness.accountIdentity, null);
  assert.equal(readiness.errorMessage, 'probe failed');
});
