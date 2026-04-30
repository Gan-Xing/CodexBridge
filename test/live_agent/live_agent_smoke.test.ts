import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCodexBridgeRuntime } from '../../src/runtime/bootstrap.js';
import { resolveOpenAIAgentRuntimeConfig } from '../../src/core/bridge_coordinator.js';

class FakeProviderPlugin {
  kind: string;
  displayName: string;
  startThreadCalls: any[];
  startTurnCalls: any[];
  threadCounter: number;
  baseTime: number;
  clock: number;
  threads: Map<any, any>;

  constructor(kind: string) {
    this.kind = kind;
    this.displayName = kind;
    this.startThreadCalls = [];
    this.startTurnCalls = [];
    this.threadCounter = 0;
    this.baseTime = Date.now();
    this.clock = 0;
    this.threads = new Map();
  }

  nextUpdatedAt() {
    this.clock += 1;
    return this.baseTime + this.clock;
  }

  async startThread({ providerProfile, cwd, title, metadata }) {
    this.threadCounter += 1;
    this.startThreadCalls.push({ providerProfile, cwd, title, metadata });
    const thread = {
      threadId: `${providerProfile.id}-thread-${this.threadCounter}`,
      cwd: cwd ?? `/tmp/${providerProfile.id}`,
      title: title ?? `${providerProfile.displayName} thread ${this.threadCounter}`,
      updatedAt: this.nextUpdatedAt(),
      preview: '',
      turns: [],
    };
    this.threads.set(thread.threadId, thread);
    return thread;
  }

  async startTurn({ providerProfile, bridgeSession, sessionSettings, event, inputText, onTurnStarted = null }) {
    this.startTurnCalls.push({ providerProfile, bridgeSession, sessionSettings, event, inputText });
    const existingThread = this.threads.get(bridgeSession.codexThreadId);
    if (!existingThread) {
      throw new Error(`thread not found: ${bridgeSession.codexThreadId}`);
    }
    const turnId = `${bridgeSession.codexThreadId}-turn-${existingThread.turns.length + 1}`;
    await onTurnStarted?.({
      turnId,
      threadId: bridgeSession.codexThreadId,
    });
    const outputText = `openai: ${inputText}`;
    this.threads.set(bridgeSession.codexThreadId, {
      ...existingThread,
      updatedAt: this.nextUpdatedAt(),
      preview: inputText,
      turns: [
        ...existingThread.turns,
        {
          id: turnId,
          status: 'complete',
          error: null,
          items: [
            { role: 'user', text: inputText, type: 'message', phase: 'final' },
            { role: 'assistant', text: outputText, type: 'message', phase: 'final' },
          ],
        },
      ],
    });
    return {
      outputText,
      turnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  }

  async listModels() {
    return [];
  }
}

function makeProviderProfile(id: string, providerKind: string, displayName: string) {
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

function makeRuntime(defaultCwd: string) {
  const openai = new FakeProviderPlugin('openai-native');
  const runtime = createCodexBridgeRuntime({
    providerPlugins: [openai as any],
    providerProfiles: [makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default')],
    defaultProviderProfileId: 'openai-default',
    defaultCwd,
  });
  return { runtime, openai };
}

const liveAgentEnabled = process.env.CODEXBRIDGE_TEST_ALLOW_LIVE_AGENT === '1'
  && Boolean(resolveOpenAIAgentRuntimeConfig().apiKey);

test('live-agent assistant record classification stays structured and strips meta instructions', { skip: !liveAgentEnabled }, async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-live-agent-assistant-'));
  const { runtime } = makeRuntime(defaultCwd);

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-live-agent-assistant-1',
    text: [
      '/as 助理贝亚 现在还欠我3张发票。关于要拿回来的发票，情况如下：',
      '1. 之前有一个被退回去的发票',
      '2. 我这个医药的发票（不知道有没有）',
      '3. 修马桶的发票',
      '应该是这三张发票，你帮我整理一下，看看放哪里比较合适，我之后还得记一下',
    ].join('\n'),
  });

  const text = result.messages.map((message) => message.text ?? '').join('\n');
  assert.match(text, /助理记录待确认/);
  assert.match(text, /类型：代办/);
  assert.doesNotMatch(text, /看看放哪里比较合适/);
  assert.doesNotMatch(text, /我之后还得记一下/);

  const record = runtime.repositories.assistantRecords.list()[0];
  assert.ok(record);
  assert.equal(record?.type, 'todo');
  assert.equal(record?.status, 'pending');
  assert.equal(record?.parsedJson?.normalizer, 'agents-sdk');
  assert.doesNotMatch(record?.content ?? '', /看看放哪里比较合适/);
  assert.doesNotMatch(record?.content ?? '', /我之后还得记一下/);
  assert.equal(record?.parsedJson?.strippedAssistantInstruction, true);
});

test('live-agent agent draft edit keeps the draft flow usable', { skip: !liveAgentEnabled }, async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-live-agent-agent-edit-'));
  const { runtime } = makeRuntime(defaultCwd);

  const draft = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-live-agent-agent-edit-1',
    text: '/agent 检查当前项目测试并修复失败项',
  });
  const draftText = draft.messages.map((message) => message.text ?? '').join('\n');
  assert.match(draftText, /Agent 草案/);
  assert.match(draftText, /确认：\/agent confirm/);

  const edited = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-live-agent-agent-edit-1',
    text: '/agent edit 只做方案，不改代码',
  });
  const editedText = edited.messages.map((message) => message.text ?? '').join('\n');
  assert.match(editedText, /Agent 草案/);
  assert.match(editedText, /修改：\/agent edit <修改提示>/);
  assert.doesNotMatch(editedText, /解析失败/);

  const pending = runtime.services.bridgeCoordinator.getPendingAgentDraft({
    platform: 'weixin',
    externalScopeId: 'wx-live-agent-agent-edit-1',
  });
  assert.ok(pending);
  assert.match(pending?.rawInput ?? '', /检查当前项目测试并修复失败项/);
  assert.match(pending?.rawInput ?? '', /Edit: 只做方案，不改代码/);
  assert.ok(['agents-sdk', 'codex'].includes(String(pending?.normalizedBy ?? '')));
});
