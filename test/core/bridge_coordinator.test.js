import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexBridgeRuntime } from '../../src/runtime/bootstrap.js';

class FakeProviderPlugin {
  constructor(kind, { replyPrefix }) {
    this.kind = kind;
    this.displayName = kind;
    this.replyPrefix = replyPrefix;
    this.startThreadCalls = [];
    this.resumeThreadCalls = [];
    this.startTurnCalls = [];
    this.interruptTurnCalls = [];
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

  async readThread({ threadId, includeTurns = false }) {
    const thread = this.threads.get(threadId) ?? null;
    if (!thread) {
      return null;
    }
    return {
      ...thread,
      turns: includeTurns ? thread.turns : [],
    };
  }

  async listThreads({ limit = 20, cursor = null, searchTerm = null } = {}) {
    const offset = cursor ? Number(cursor) : 0;
    const normalizedSearch = String(searchTerm ?? '').trim().toLowerCase();
    const filtered = [...this.threads.values()]
      .filter((thread) => {
        if (!normalizedSearch) {
          return true;
        }
        const haystack = [thread.threadId, thread.title, thread.preview]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(normalizedSearch);
      })
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    const items = filtered.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    return {
      items,
      nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
    };
  }

  async resumeThread({ threadId }) {
    this.resumeThreadCalls.push({ threadId });
    const existingThread = this.threads.get(threadId);
    if (!existingThread) {
      const restored = {
        threadId,
        cwd: '/tmp/restored',
        title: `restored ${threadId}`,
        updatedAt: this.nextUpdatedAt(),
        preview: '',
        turns: [],
      };
      this.threads.set(threadId, restored);
      return restored;
    }
    return this.threads.get(threadId) ?? null;
  }

  async startTurn({ providerProfile, bridgeSession, sessionSettings, event, inputText, onTurnStarted = null }) {
    this.startTurnCalls.push({ providerProfile, bridgeSession, sessionSettings, event, inputText });
    const existingThread = this.threads.get(bridgeSession.codexThreadId);
    if (!existingThread) {
      throw new Error(`thread not found: ${bridgeSession.codexThreadId}`);
    }
    const turnId = `${bridgeSession.codexThreadId}-turn-${existingThread.turns.length + 1}`;
    if (typeof onTurnStarted === 'function') {
      await onTurnStarted({
        turnId,
        threadId: bridgeSession.codexThreadId,
      });
    }
    const outputText = `${this.replyPrefix}: ${inputText}`;
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

  async interruptTurn({ providerProfile, threadId, turnId }) {
    this.interruptTurnCalls.push({ providerProfile, threadId, turnId });
  }
}

function makeProviderProfile(id, providerKind, displayName) {
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

function makeRuntime({ defaultCwd = null, restartBridge = null } = {}) {
  const openai = new FakeProviderPlugin('openai-native', { replyPrefix: 'openai' });
  const minimax = new FakeProviderPlugin('minimax-via-cliproxy', { replyPrefix: 'minimax' });
  const runtime = createCodexBridgeRuntime({
    providerPlugins: [openai, minimax],
    providerProfiles: [
      makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default'),
      makeProviderProfile('minimax-default', 'minimax-via-cliproxy', 'MiniMax Default'),
    ],
    defaultProviderProfileId: 'openai-default',
    defaultCwd,
    restartBridge,
  });
  return { runtime, openai, minimax };
}

async function waitForCondition(predicate, { timeoutMs = 1000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('Timed out waiting for condition');
}

test('bridge coordinator creates a default-provider session for normal text and starts a turn', async () => {
  const { runtime, openai } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello codexbridge',
  });

  assert.equal(result.type, 'message');
  assert.match(result.messages[0]?.text ?? '', /openai: hello codexbridge/);
  assert.equal(result.session?.providerProfileId, 'openai-default');
  assert.equal(openai.startThreadCalls.length, 1);
  assert.equal(openai.startTurnCalls.length, 1);
});

test('bridge coordinator uses the runtime default cwd for new sessions', async () => {
  const { runtime, openai } = makeRuntime({ defaultCwd: '/tmp/project' });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-cwd-1',
    text: 'hello codexbridge',
  });

  assert.equal(result.session?.providerProfileId, 'openai-default');
  assert.equal(openai.startThreadCalls[0]?.cwd, '/tmp/project');
  assert.equal(openai.startTurnCalls[0]?.bridgeSession.cwd, '/tmp/project');
});

test('bridge coordinator resumes the same scope session when the bound thread is stale', async () => {
  const { runtime, openai } = makeRuntime();
  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello codexbridge',
  });
  openai.threads.delete(original.session.codexThreadId);

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello again',
  });

  assert.match(result.messages[0]?.text ?? '', /openai: hello again/);
  assert.equal(result.session?.codexThreadId, original.session?.codexThreadId);
  assert.equal(result.session?.bridgeSessionId, original.session?.bridgeSessionId);
  assert.equal(openai.startThreadCalls.length, 1);
  assert.equal(openai.resumeThreadCalls.length, 1);
  assert.equal(openai.startTurnCalls.length, 3);
});

test('bridge coordinator keeps the same binding even when stale thread resume fails', async () => {
  const { runtime, openai } = makeRuntime();
  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello codexbridge',
  });
  openai.threads.delete(original.session.codexThreadId);
  openai.resumeThread = async ({ threadId }) => {
    openai.resumeThreadCalls.push({ threadId });
    throw new Error(`thread not found: ${threadId}`);
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello again',
  });

  assert.equal(result.messages[0]?.text ?? '', '');
  assert.equal(result.meta?.codexTurn?.outputState, 'stale_session');

  const rebound = runtime.services.bridgeSessions.resolveScopeSession({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
  });
  assert.equal(rebound?.id, original.session?.bridgeSessionId);
  assert.equal(rebound?.codexThreadId, original.session?.codexThreadId);
});

test('bridge coordinator recreates a scope session when Codex reports a damaged rollout file', async () => {
  const { runtime, openai } = makeRuntime();
  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello codexbridge',
  });

  let injected = false;
  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (args) => {
    if (!injected && args.bridgeSession.codexThreadId === original.session.codexThreadId) {
      injected = true;
      throw new Error(`failed to load rollout '/tmp/${original.session.codexThreadId}.jsonl' for thread ${original.session.codexThreadId}: empty session file`);
    }
    return originalStartTurn(args);
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello after rollout damage',
  });

  assert.match(result.messages[0]?.text ?? '', /openai: hello after rollout damage/);
  assert.equal(result.session?.codexThreadId, original.session?.codexThreadId);
  assert.equal(result.session?.bridgeSessionId, original.session?.bridgeSessionId);
  assert.equal(openai.startThreadCalls.length, 1);
});

test('bridge coordinator keeps the same session bound when rollout loading keeps failing', async () => {
  const { runtime, openai } = makeRuntime();
  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello codexbridge',
  });

  openai.startTurn = async ({ bridgeSession }) => {
    throw new Error(`failed to load rollout '/tmp/${bridgeSession.codexThreadId}.jsonl' for thread ${bridgeSession.codexThreadId}: empty session file`);
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello after persistent rollout damage',
  });

  assert.equal(result.meta?.codexTurn?.outputState, 'provider_error');
  assert.match(result.meta?.codexTurn?.errorMessage ?? '', /failed to load rollout/i);

  const rebound = runtime.services.bridgeSessions.resolveScopeSession({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
  });
  assert.equal(rebound?.id, original.session?.bridgeSessionId);
  assert.equal(rebound?.codexThreadId, original.session?.codexThreadId);
});

test('/status reports when no bridge session is bound yet', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/status',
  });

  assert.match(result.messages[0]?.text ?? '', /No bridge session is bound/);
  assert.match(result.messages[1]?.text ?? '', /Default provider profile: openai-default/);
  assert.match(result.messages[2]?.text ?? '', /Default working directory: \(none\)/);
});

test('/status includes active-turn state when a session is idle', async () => {
  const { runtime } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-1',
    text: 'hello',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-1',
    text: '/status',
  });

  assert.equal(result.messages[12]?.text ?? '', 'Active turn: none');
  assert.equal(result.messages[13]?.text ?? '', 'Turn state: idle');
});

test('/helps lists all supported slash commands and help entrypoints', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/helps',
  });

  const text = result.messages[0]?.text ?? '';
  assert.match(text, /Slash 命令/);
  assert.match(text, /\/helps \(\/help, \/h\) 查看所有斜杠命令/);
  assert.match(text, /\/stop \(\/sp\) 请求中断当前正在执行的回复/);
  assert.match(text, /\/threads \(\/th\) 查看当前 provider 的线程列表首页/);
  assert.match(text, /\/rename \(\/rn\) 给线程设置本地显示名/);
  assert.match(text, /帮助：\/helps <命令>/);
  assert.match(text, /示例：\/helps threads  或  \/threads -h/);
});

test('/helps threads renders usage, examples, and notes for a specific command', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/helps threads',
  });

  const text = result.messages[0]?.text ?? '';
  assert.match(text, /命令：\/threads/);
  assert.match(text, /说明：查看当前 provider 的线程列表首页/);
  assert.match(text, /用法：/);
  assert.match(text, /\/threads -h/);
  assert.match(text, /\/open 2/);
  assert.match(text, /微信里推荐先 \/threads，再用序号操作/);
});

test('slash commands support first-argument help flags like -h', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/threads -h',
  });

  const text = result.messages[0]?.text ?? '';
  assert.match(text, /命令：\/threads/);
  assert.match(text, /\/threads -h/);
  assert.match(text, /\/peek 2/);
});

test('slash command short aliases resolve to the same help and action targets', async () => {
  const { runtime } = makeRuntime();

  const helpResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/h th',
  });
  assert.match(helpResult.messages[0]?.text ?? '', /命令：\/threads/);
  assert.match(helpResult.messages[0]?.text ?? '', /别名：\/th/);

  const commandResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/perm',
  });
  assert.match(commandResult.messages[0]?.text ?? '', /当前还没有绑定会话/);
});

test('slash commands support -help, -helps, and --help variants', async () => {
  const { runtime } = makeRuntime();

  for (const text of ['/permissions -help', '/permissions -helps', '/permissions --help']) {
    const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-user-1',
      text,
    });

    const body = result.messages[0]?.text ?? '';
    assert.match(body, /命令：\/permissions/);
    assert.match(body, /\/permissions <read-only\|default\|full-access>/);
  }
});

test('slash commands treat help flags in later argument positions as help requests', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/permissions full-access -h',
  });

  const text = result.messages[0]?.text ?? '';
  assert.match(text, /命令：\/permissions/);
  assert.match(text, /\/permissions -h/);
});

test('/stop reports when there is no active turn to interrupt', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/stop',
  });

  assert.equal(result.messages[0]?.text ?? '', '当前没有进行中的回复。');
});

test('/stop interrupts the active turn once the provider has issued a turn id', async () => {
  const { runtime, openai } = makeRuntime();
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
  };
  let releaseTurn;
  const turnGate = new Promise((resolve) => {
    releaseTurn = resolve;
  });
  let interrupted = false;

  openai.startTurn = async ({ bridgeSession, inputText, onTurnStarted = null }) => {
    const existingThread = openai.threads.get(bridgeSession.codexThreadId);
    const turnId = `${bridgeSession.codexThreadId}-turn-${(existingThread?.turns.length ?? 0) + 1}`;
    await onTurnStarted?.({
      turnId,
      threadId: bridgeSession.codexThreadId,
    });
    await turnGate;
    return {
      outputText: interrupted ? '' : `openai: ${inputText}`,
      outputState: interrupted ? 'interrupted' : 'complete',
      turnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };
  openai.interruptTurn = async (params) => {
    interrupted = true;
    openai.interruptTurnCalls.push(params);
    releaseTurn();
  };

  const firstTurn = runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: 'long running turn',
  });

  await waitForCondition(() => runtime.services.activeTurns.resolveScopeTurn(scopeRef)?.turnId);

  const stopResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: '/stop',
  });

  assert.equal(stopResult.messages[0]?.text ?? '', '已请求中断当前回复。');
  assert.equal(openai.interruptTurnCalls.length, 1);

  const firstResult = await firstTurn;
  assert.equal(firstResult.meta?.codexTurn?.outputState, 'interrupted');
});

test('/interrupt remains a hidden compatibility alias and can queue an interrupt before turn startup completes', async () => {
  const { runtime, openai } = makeRuntime();
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-2',
  };
  let releaseStart;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  let releaseFinish;
  const finishGate = new Promise((resolve) => {
    releaseFinish = resolve;
  });

  openai.startTurn = async ({ bridgeSession, onTurnStarted = null }) => {
    await startGate;
    await onTurnStarted?.({
      turnId: `${bridgeSession.codexThreadId}-turn-pending`,
      threadId: bridgeSession.codexThreadId,
    });
    await finishGate;
    return {
      outputText: '',
      outputState: 'interrupted',
      turnId: `${bridgeSession.codexThreadId}-turn-pending`,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };
  openai.interruptTurn = async (params) => {
    openai.interruptTurnCalls.push(params);
    releaseFinish();
  };

  const firstTurn = runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: 'slow startup turn',
  });

  await waitForCondition(() => runtime.services.activeTurns.resolveScopeTurn(scopeRef));

  const stopResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: '/interrupt',
  });

  assert.equal(stopResult.messages[0]?.text ?? '', '已请求中断。当前回复仍在启动，拿到 turn id 后会自动中断。');
  releaseStart();
  await waitForCondition(() => openai.interruptTurnCalls.length === 1);
  await firstTurn;
});

test('/status shows running active-turn details and control hint', async () => {
  const { runtime, openai } = makeRuntime();
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-status-2',
  };
  let releaseTurn;
  const turnGate = new Promise((resolve) => {
    releaseTurn = resolve;
  });

  openai.startTurn = async ({ bridgeSession, inputText, onTurnStarted = null }) => {
    await onTurnStarted?.({
      turnId: `${bridgeSession.codexThreadId}-turn-1`,
      threadId: bridgeSession.codexThreadId,
    });
    await turnGate;
    return {
      outputText: `openai: ${inputText}`,
      turnId: `${bridgeSession.codexThreadId}-turn-1`,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const firstTurn = runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: 'long running turn',
  });

  await waitForCondition(() => runtime.services.activeTurns.resolveScopeTurn(scopeRef)?.turnId);

  const status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: '/status',
  });

  assert.match(status.messages[12]?.text ?? '', /Active turn: .*turn-1/);
  assert.equal(status.messages[13]?.text ?? '', 'Turn state: running');
  assert.equal(status.messages[14]?.text ?? '', 'Turn control: /stop');

  releaseTurn();
  await firstTurn;
});

test('bridge coordinator blocks new conversation turns while another turn is already active', async () => {
  const { runtime, openai } = makeRuntime();
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-3',
  };
  let releaseTurn;
  const turnGate = new Promise((resolve) => {
    releaseTurn = resolve;
  });

  openai.startTurn = async ({ bridgeSession, inputText, onTurnStarted = null }) => {
    await onTurnStarted?.({
      turnId: `${bridgeSession.codexThreadId}-turn-1`,
      threadId: bridgeSession.codexThreadId,
    });
    await turnGate;
    return {
      outputText: `openai: ${inputText}`,
      turnId: `${bridgeSession.codexThreadId}-turn-1`,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const firstTurn = runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: 'first turn',
  });

  await waitForCondition(() => runtime.services.activeTurns.resolveScopeTurn(scopeRef));

  const blocked = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: 'second turn',
  });

  assert.equal(blocked.messages[0]?.text ?? '', '当前已有一轮回复在进行中。');
  assert.equal(blocked.messages[1]?.text ?? '', '请先等待，或使用 /stop 中断。');

  releaseTurn();
  await firstTurn;
});

test('bridge coordinator shows command-specific blocked messages while a turn is active', async () => {
  const { runtime, openai } = makeRuntime();
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-4',
  };
  let releaseTurn;
  const turnGate = new Promise((resolve) => {
    releaseTurn = resolve;
  });

  openai.startTurn = async ({ bridgeSession, inputText, onTurnStarted = null }) => {
    await onTurnStarted?.({
      turnId: `${bridgeSession.codexThreadId}-turn-1`,
      threadId: bridgeSession.codexThreadId,
    });
    await turnGate;
    return {
      outputText: `openai: ${inputText}`,
      turnId: `${bridgeSession.codexThreadId}-turn-1`,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const firstTurn = runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: 'first turn',
  });

  await waitForCondition(() => runtime.services.activeTurns.resolveScopeTurn(scopeRef));

  const checks = [
    ['/new', '当前有回复在进行中，暂时不能新建会话。请先等待，或使用 /stop 中断。'],
    ['/open thread-1', '当前有回复在进行中，暂时不能切换线程。请先等待，或使用 /stop 中断。'],
    ['/rename thread-1 新名字', '当前有回复在进行中，暂时不能重命名线程。请先等待，或使用 /stop 中断。'],
    ['/provider minimax-default', '当前有回复在进行中，暂时不能切换 provider。请先等待，或使用 /stop 中断。'],
    ['/permissions full-access', '当前有回复在进行中，暂时不能切换权限预设。请先等待，或使用 /stop 中断。'],
    ['/reconnect', '当前有回复在进行中，暂时不能刷新当前 Codex 会话。请先等待，或使用 /stop 中断。'],
    ['/restart', '当前有回复在进行中，暂时不能重启桥接。请先等待，或使用 /stop 中断。'],
  ];

  for (const [text, expected] of checks) {
    const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
      ...scopeRef,
      text,
    });
    assert.equal(result.messages[0]?.text ?? '', expected);
  }

  releaseTurn();
  await firstTurn;
});

test('command-specific blocked messages switch to wait-for-stop wording after interrupt is requested', async () => {
  const { runtime, openai } = makeRuntime();
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-5',
  };
  let releaseTurn;
  const turnGate = new Promise((resolve) => {
    releaseTurn = resolve;
  });
  let interrupted = false;

  openai.startTurn = async ({ bridgeSession, onTurnStarted = null }) => {
    await onTurnStarted?.({
      turnId: `${bridgeSession.codexThreadId}-turn-1`,
      threadId: bridgeSession.codexThreadId,
    });
    await turnGate;
    return {
      outputText: '',
      outputState: interrupted ? 'interrupted' : 'complete',
      turnId: `${bridgeSession.codexThreadId}-turn-1`,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };
  openai.interruptTurn = async (params) => {
    interrupted = true;
    openai.interruptTurnCalls.push(params);
  };

  const firstTurn = runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: 'first turn',
  });

  await waitForCondition(() => runtime.services.activeTurns.resolveScopeTurn(scopeRef)?.turnId);

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: '/stop',
  });

  const blocked = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: '/provider minimax-default',
  });

  assert.equal(blocked.messages[0]?.text ?? '', '已请求中断，请等待当前回复停止后再切换 provider。');

  const status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: '/status',
  });

  assert.match(status.messages[12]?.text ?? '', /Active turn: .*turn-1/);
  assert.equal(status.messages[13]?.text ?? '', 'Turn state: interrupt requested');
  assert.equal(status.messages[14]?.text ?? '', 'Turn control: /stop');

  releaseTurn();
  await firstTurn;
});

test('/new creates a fresh session on the current provider profile', async () => {
  const { runtime, openai } = makeRuntime();
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/new',
  });

  assert.match(result.messages[0]?.text ?? '', /Started a new bridge session/);
  assert.equal(openai.startThreadCalls.length, 2);
});

test('/provider switches the scope to a new provider-backed session', async () => {
  const { runtime, minimax } = makeRuntime();
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/provider minimax-default',
  });

  assert.match(result.messages[0]?.text ?? '', /Switched provider profile to minimax-default/);
  assert.equal(result.session?.providerProfileId, 'minimax-default');
  assert.equal(minimax.startThreadCalls.length, 1);
});

test('/provider without args lists current and available profiles', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/provider',
  });

  assert.match(result.messages[0]?.text ?? '', /Current provider profile: openai-default/);
  assert.match(result.messages[1]?.text ?? '', /Available provider profiles/);
  assert.match(result.messages[2]?.text ?? '', /openai-default/);
  assert.match(result.messages[3]?.text ?? '', /minimax-default/);
});

test('/threads renders a paged thread browser with previews and commands', async () => {
  const { runtime } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello from wx',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'telegram',
    externalScopeId: 'tg-topic-1',
    text: 'hello from tg',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/threads',
  });

  const text = result.messages[0]?.text ?? '';
  assert.match(text, /Threads \| openai-default/);
  assert.match(text, /当前绑定：OpenAI Default thread 1/);
  assert.match(text, /\* \d+\. OpenAI Default thread 1/);
  assert.match(text, /预览：hello from wx/);
  assert.match(text, /操作：\/open \d+  \/peek \d+  \/rename \d+ 新名字  \/search 关键词  \/threads/);
});

test('/next and /prev paginate the current thread browser page', async () => {
  const { runtime } = makeRuntime();

  for (let index = 1; index <= 6; index += 1) {
    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: `wx-thread-${index}`,
      text: `hello ${index}`,
    });
  }

  const firstPage = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/threads',
  });
  const nextPage = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/next',
  });
  const previousPage = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/prev',
  });

  assert.match(firstPage.messages[0]?.text ?? '', /OpenAI Default thread 6/);
  assert.doesNotMatch(firstPage.messages[0]?.text ?? '', /OpenAI Default thread 1/);
  assert.match(nextPage.messages[0]?.text ?? '', /第 2 页/);
  assert.match(nextPage.messages[0]?.text ?? '', /OpenAI Default thread 1/);
  assert.match(previousPage.messages[0]?.text ?? '', /第 1 页/);
  assert.match(previousPage.messages[0]?.text ?? '', /OpenAI Default thread 6/);
});

test('/search filters the thread browser by preview or title', async () => {
  const { runtime } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-search-1',
    text: 'alpha deployment issue',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-search-2',
    text: 'beta followup',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/search alpha',
  });

  assert.match(result.messages[0]?.text ?? '', /搜索：alpha/);
  assert.match(result.messages[0]?.text ?? '', /alpha deployment issue/);
  assert.doesNotMatch(result.messages[0]?.text ?? '', /beta followup/);
});

test('/open binds the scope to an existing provider thread', async () => {
  const { runtime } = makeRuntime();

  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'telegram',
    externalScopeId: 'tg-topic-1',
    text: 'hello from telegram',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-2',
    text: `/open ${original.session?.codexThreadId}`,
  });

  assert.match(result.messages[0]?.text ?? '', new RegExp(`Opened Codex thread ${original.session?.codexThreadId}`));
  assert.equal(result.session?.codexThreadId, original.session?.codexThreadId);
  assert.equal(result.session?.bridgeSessionId, original.session?.bridgeSessionId);

  const status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-2',
    text: '/status',
  });

  assert.match(status.messages[4]?.text ?? '', new RegExp(`Codex thread: ${original.session?.codexThreadId}`));
  assert.match(status.messages[5]?.text ?? '', /Working directory:/);
});

test('/open accepts the current-page index in addition to raw thread ids', async () => {
  const { runtime } = makeRuntime();

  const first = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'telegram',
    externalScopeId: 'tg-topic-1',
    text: 'first thread',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'telegram',
    externalScopeId: 'tg-topic-2',
    text: 'second thread',
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/threads',
  });
  const opened = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/open 2',
  });

  assert.equal(opened.session?.codexThreadId, first.session?.codexThreadId);
});

test('/rename updates the local thread alias used by /threads', async () => {
  const { runtime } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-rename-1',
    text: 'rename candidate',
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/threads',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/rename 1 微信桥接排障',
  });
  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/threads',
  });

  assert.match(result.messages[0]?.text ?? '', /微信桥接排障/);
});

test('/peek shows recent conversation turns for the selected thread', async () => {
  const { runtime } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-peek-1',
    text: 'hello bridge',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-peek-1',
    text: 'show me logs',
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/threads',
  });
  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser',
    text: '/peek 1',
  });

  assert.match(result.messages[0]?.text ?? '', /线程预览：/);
  assert.match(result.messages[0]?.text ?? '', /最近 2 轮：/);
  assert.match(result.messages[0]?.text ?? '', /你：hello bridge/);
  assert.match(result.messages[0]?.text ?? '', /你：show me logs/);
});


test('/restart returns a queued reply and defers the actual restart action to runtime delivery', async () => {
  let restartCalls = 0;
  const { runtime } = makeRuntime({
    restartBridge: async () => {
      restartCalls += 1;
    },
  });

  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/restart',
  });

  assert.equal(restartCalls, 0);
  assert.equal(result.messages[0]?.text ?? '', '桥接重启已排队。');
  assert.equal(result.meta?.systemAction?.kind, 'restart_bridge');
  assert.equal(result.session?.bridgeSessionId, original.session?.bridgeSessionId);
  assert.equal(result.session?.codexThreadId, original.session?.codexThreadId);
});

test('/reconnect refreshes the current Codex session and keeps the same binding', async () => {
  const { runtime, openai } = makeRuntime();

  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello',
  });

  let reconnectCalls = 0;
  openai.reconnectProfile = async () => {
    reconnectCalls += 1;
    return {
      connected: true,
      accountIdentity: {
        email: 'ganxing@example.com',
        name: null,
        authMode: 'chatgpt',
        accountId: null,
      },
    };
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/reconnect',
  });

  assert.equal(reconnectCalls, 1);
  assert.equal(result.messages[0]?.text ?? '', '当前 Codex 会话已刷新。');
  assert.equal(result.messages[1]?.text ?? '', '账号：ganxing@example.com');
  assert.equal(result.messages[2]?.text ?? '', '直接继续发消息即可。');
  assert.equal(result.session?.bridgeSessionId, original.session?.bridgeSessionId);
  assert.equal(result.session?.codexThreadId, original.session?.codexThreadId);
});

test('/permissions shows current access settings and updates the preset for the next turn', async () => {
  const { runtime, openai } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello',
  });

  const statusBefore = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/permissions',
  });

  assert.equal(statusBefore.messages[0]?.text ?? '', '当前权限预设：default');
  assert.equal(statusBefore.messages[1]?.text ?? '', '审批策略：on-request');
  assert.equal(statusBefore.messages[2]?.text ?? '', '沙箱模式：workspace-write');
  assert.equal(statusBefore.messages[4]?.text ?? '', '可选命令：');
  assert.equal(statusBefore.messages[5]?.text ?? '', '- /permissions read-only');
  assert.equal(statusBefore.messages[6]?.text ?? '', '- /permissions default');
  assert.equal(statusBefore.messages[7]?.text ?? '', '- /permissions full-access');
  assert.equal(statusBefore.messages[9]?.text ?? '', '说明：');
  assert.equal(statusBefore.messages[10]?.text ?? '', '- read-only：按需审批 + 只读');
  assert.equal(statusBefore.messages[11]?.text ?? '', '- default：按需审批 + 工作区可写');
  assert.equal(statusBefore.messages[12]?.text ?? '', '- full-access：不审批 + 完全访问');

  const updated = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/permissions full-access',
  });

  assert.equal(updated.messages[0]?.text ?? '', '已切换权限预设：full-access');
  assert.equal(updated.messages[1]?.text ?? '', '审批策略：never');
  assert.equal(updated.messages[2]?.text ?? '', '沙箱模式：danger-full-access');
  assert.equal(updated.messages[3]?.text ?? '', '下一轮生效。');

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello again',
  });

  const lastTurn = openai.startTurnCalls.at(-1);
  assert.equal(lastTurn?.sessionSettings?.accessPreset, 'full-access');
  assert.equal(lastTurn?.sessionSettings?.approvalPolicy, 'never');
  assert.equal(lastTurn?.sessionSettings?.sandboxMode, 'danger-full-access');
});

test('/permissions rejects unknown presets', async () => {
  const { runtime } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/permissions yolo',
  });

  assert.equal(result.messages[0]?.text ?? '', '用法：/permissions [read-only|default|full-access]');
});

test('bridge coordinator converts Codex turn timeout into a user-visible timeout state', async () => {
  const { runtime, openai } = makeRuntime();
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello',
  });

  openai.startTurn = async () => {
    throw new Error('Timed out waiting for Codex turn turn-1');
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello again',
  });

  assert.equal(result.messages[0]?.text ?? '', '');
  assert.equal(result.meta?.codexTurn?.outputState, 'timeout');
});

test('bridge coordinator forwards unexpected provider errors as user-visible provider_error state', async () => {
  const { runtime, openai } = makeRuntime();
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello',
  });

  openai.startTurn = async () => {
    throw new Error('401 Unauthorized: refresh_token_reused');
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello again',
  });

  assert.equal(result.meta?.codexTurn?.outputState, 'provider_error');
  assert.equal(result.meta?.codexTurn?.errorMessage, '401 Unauthorized: refresh_token_reused');
});
