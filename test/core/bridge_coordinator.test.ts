import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AUTO_COMMAND_SKILL_ACTIONS,
  resolveOpenAIAgentRuntimeConfig,
  AGENT_COMMAND_SKILL_ACTIONS,
  INSTRUCTIONS_COMMAND_SKILL_ACTIONS,
  REVIEW_COMMAND_SKILL_ACTIONS,
  THREAD_COMMAND_SKILL_ACTIONS,
} from '../../src/core/bridge_coordinator.js';
import {
  createMissionChecklistSnapshot,
  createMissionCycleResult,
  transitionMission,
} from '../../packages/mission-control/src/index.js';
import { createCodexBridgeRuntime } from '../../src/runtime/bootstrap.js';

function normalizeCommandSkillInput(value: unknown) {
  return String(value ?? '').replace(/\\/g, '/');
}

class FakeProviderPlugin {
  kind: string;
  displayName: string;
  replyPrefix: string;
  models: any[];
  startThreadCalls: any[];
  resumeThreadCalls: any[];
  startTurnCalls: any[];
  startReviewCalls: any[];
  interruptTurnCalls: any[];
  respondToApprovalCalls: any[];
  listModelsCalls: any[];
  reconnectProfileCalls: any[];
  listSkillsCalls: any[];
  listPluginsCalls: any[];
  readPluginCalls: any[];
  installPluginCalls: any[];
  uninstallPluginCalls: any[];
  setAppEnabledCalls: any[];
  setMcpServerEnabledCalls: any[];
  startMcpServerOauthLoginCalls: any[];
  reloadMcpServersCalls: any[];
  setSkillEnabledCalls: any[];
  archiveThreadCalls: any[];
  unarchiveThreadCalls: any[];
  usageReport: any;
  skillEntries: any[];
  skillErrors: any[];
  listSkillsError: any;
  pluginCatalog: any;
  pluginDetails: Map<any, any>;
  appEntries: any[];
  mcpServerStatuses: any[];
  mcpEnabledByName: Map<any, any>;
  threadCounter: number;
  baseTime: number;
  clock: number;
  threads: Map<any, any>;
  archivedThreadIds: Set<any>;

  constructor(kind: string, options: { replyPrefix?: string; models?: any[] } = {}) {
    const { replyPrefix = '', models = null } = options;
    this.kind = kind;
    this.displayName = kind;
    this.replyPrefix = replyPrefix;
    this.models = models ?? [
      {
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'GPT-5.4',
        description: 'Latest frontier agentic coding model.',
        isDefault: true,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'gpt-5.2-codex',
        model: 'gpt-5.2-codex',
        displayName: 'GPT-5.2-Codex',
        description: 'Frontier codex model.',
        isDefault: false,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'gpt-5.1-codex-max',
        model: 'gpt-5.1-codex-max',
        displayName: 'GPT-5.1-Codex-Max',
        description: 'Codex-optimized flagship for deep and fast reasoning.',
        isDefault: false,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'high',
      },
      {
        id: 'gpt-5.4-mini',
        model: 'gpt-5.4-mini',
        displayName: 'GPT-5.4-Mini',
        description: 'Smaller frontier coding model.',
        isDefault: false,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'gpt-5.3-codex',
        model: 'gpt-5.3-codex',
        displayName: 'GPT-5.3-Codex',
        description: 'Frontier Codex-optimized codex model.',
        isDefault: false,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'gpt-5.3-codex-spark',
        model: 'gpt-5.3-codex-spark',
        displayName: 'GPT-5.3-Codex-Spark',
        description: 'Ultra-fast coding model.',
        isDefault: false,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'gpt-5.2',
        model: 'gpt-5.2',
        displayName: 'GPT-5.2',
        description: 'Optimized for professional work and long-running agents.',
        isDefault: false,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'gpt-5.1-codex-mini',
        model: 'gpt-5.1-codex-mini',
        displayName: 'GPT-5.1-Codex-Mini',
        description: 'Cheaper, faster, but less capable.',
        isDefault: false,
        supportedReasoningEfforts: ['medium', 'high'],
        defaultReasoningEffort: 'medium',
      },
    ];
    this.startThreadCalls = [];
    this.resumeThreadCalls = [];
    this.startTurnCalls = [];
    this.startReviewCalls = [];
    this.interruptTurnCalls = [];
    this.respondToApprovalCalls = [];
    this.listModelsCalls = [];
    this.reconnectProfileCalls = [];
    this.listSkillsCalls = [];
    this.listPluginsCalls = [];
    this.readPluginCalls = [];
    this.installPluginCalls = [];
    this.uninstallPluginCalls = [];
    this.setAppEnabledCalls = [];
    this.setMcpServerEnabledCalls = [];
    this.startMcpServerOauthLoginCalls = [];
    this.reloadMcpServersCalls = [];
    this.setSkillEnabledCalls = [];
    this.archiveThreadCalls = [];
    this.unarchiveThreadCalls = [];
    this.usageReport = null;
    this.skillEntries = [];
    this.skillErrors = [];
    this.listSkillsError = null;
    this.pluginCatalog = {
      featuredPluginIds: [],
      marketplaceLoadErrors: [],
      marketplaces: [],
    };
    this.pluginDetails = new Map();
    this.appEntries = [];
    this.mcpServerStatuses = [];
    this.mcpEnabledByName = new Map();
    this.threadCounter = 0;
    this.baseTime = Date.now();
    this.clock = 0;
    this.threads = new Map();
    this.archivedThreadIds = new Set();
  }

  nextUpdatedAt() {
    this.clock += 1;
    return this.baseTime + this.clock;
  }

  async startThread({ providerProfile, cwd, title, metadata, ephemeral = null }) {
    this.threadCounter += 1;
    this.startThreadCalls.push({ providerProfile, cwd, title, metadata, ephemeral });
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

  async listThreads({ limit = 20, cursor = null, searchTerm = null, archived = false } = {}) {
    const offset = cursor ? Number(cursor) : 0;
    const normalizedSearch = String(searchTerm ?? '').trim().toLowerCase();
    const filtered = [...this.threads.values()]
      .filter((thread) => archived
        ? this.archivedThreadIds.has(thread.threadId)
        : !this.archivedThreadIds.has(thread.threadId))
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

  async archiveThread({ threadId }) {
    this.archiveThreadCalls.push({ threadId });
    if (!this.threads.has(threadId)) {
      throw new Error(`thread not found: ${threadId}`);
    }
    this.archivedThreadIds.add(threadId);
  }

  async unarchiveThread({ threadId }) {
    this.unarchiveThreadCalls.push({ threadId });
    if (!this.threads.has(threadId)) {
      throw new Error(`thread not found: ${threadId}`);
    }
    this.archivedThreadIds.delete(threadId);
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
    const outputText = String(inputText ?? '').includes('CodexBridge review result localizer.')
      ? '已按当前语言输出代码审查结果。'
      : `${this.replyPrefix}: ${inputText}`;
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

  async startReview({ providerProfile, bridgeSession = null, sessionSettings, cwd, target, locale = null, onTurnStarted = null }) {
    this.startReviewCalls.push({ providerProfile, bridgeSession, sessionSettings, cwd, target, locale });
    const threadId = `review-${this.kind}-${this.startReviewCalls.length}`;
    const turnId = `${threadId}-turn-1`;
    if (typeof onTurnStarted === 'function') {
      await onTurnStarted({ threadId, turnId });
    }
    const targetLabel = target?.type === 'baseBranch'
      ? `base ${target.branch}`
      : target?.type === 'commit'
        ? `commit ${target.sha}`
        : target?.type === 'custom'
          ? 'custom'
          : 'uncommitted';
    return {
      outputText: `${this.replyPrefix} review: ${targetLabel}`,
      outputState: 'complete',
      turnId,
      threadId,
      title: `review ${targetLabel}`,
      finalSource: 'fake_review',
    };
  }

  async interruptTurn({ providerProfile, threadId, turnId }) {
    this.interruptTurnCalls.push({ providerProfile, threadId, turnId });
  }

  async respondToApproval({ providerProfile, request, option }) {
    this.respondToApprovalCalls.push({ providerProfile, request, option });
  }

  async listSkills({ providerProfile, cwd = null, forceReload = false }: any = {}) {
    this.listSkillsCalls.push({ providerProfile, cwd, forceReload });
    if (this.listSkillsError) {
      throw this.listSkillsError;
    }
    return {
      cwd: cwd ?? '/tmp/work',
      skills: this.skillEntries,
      errors: this.skillErrors,
    };
  }

  async setSkillEnabled({ providerProfile, enabled, name = null, path = null }) {
    this.setSkillEnabledCalls.push({ providerProfile, enabled, name, path });
    this.skillEntries = this.skillEntries.map((entry) => {
      if ((path && entry.path === path) || (name && entry.name === name)) {
        return {
          ...entry,
          enabled,
        };
      }
      return entry;
    });
    for (const detail of this.pluginDetails.values()) {
      detail.skills = detail.skills.map((entry) => {
        if ((path && entry.path === path) || (name && entry.name === name)) {
          return {
            ...entry,
            enabled,
          };
        }
        return entry;
      });
    }
    this.recomputePluginEnabledStates();
  }

  async listPlugins({ providerProfile, cwd = null }: any = {}) {
    this.listPluginsCalls.push({ providerProfile, cwd });
    return this.pluginCatalog;
  }

  async readPlugin({ providerProfile, pluginName, marketplaceName = null, marketplacePath = null }: any = {}) {
    this.readPluginCalls.push({ providerProfile, pluginName, marketplaceName, marketplacePath });
    return this.pluginDetails.get(pluginName) ?? null;
  }

  async listApps() {
    return this.appEntries;
  }

  async listMcpServerStatuses() {
    return this.mcpServerStatuses;
  }

  async installPlugin({ providerProfile, pluginName, marketplaceName = null, marketplacePath = null }: any = {}) {
    this.installPluginCalls.push({ providerProfile, pluginName, marketplaceName, marketplacePath });
    const plugin = this.findPluginSummaryByName(pluginName, marketplaceName, marketplacePath);
    if (plugin) {
      plugin.installed = true;
    }
    this.recomputePluginEnabledStates();
    const detail = this.pluginDetails.get(pluginName) ?? null;
    return {
      authPolicy: plugin?.authPolicy ?? 'ON_USE',
      appsNeedingAuth: detail?.apps?.filter((entry: any) => entry?.needsAuth) ?? [],
    };
  }

  async uninstallPlugin({ providerProfile, pluginId }: any = {}) {
    this.uninstallPluginCalls.push({ providerProfile, pluginId });
    const plugin = this.findPluginSummaryById(pluginId);
    if (plugin) {
      plugin.installed = false;
      plugin.enabled = false;
    }
    this.recomputePluginEnabledStates();
  }

  async setAppEnabled({ providerProfile, appId, enabled }: any = {}) {
    this.setAppEnabledCalls.push({ providerProfile, appId, enabled });
    this.appEntries = this.appEntries.map((entry) => entry.id === appId ? { ...entry, isEnabled: enabled } : entry);
    this.recomputePluginEnabledStates();
  }

  async setMcpServerEnabled({ providerProfile, name, enabled }: any = {}) {
    this.setMcpServerEnabledCalls.push({ providerProfile, name, enabled });
    this.mcpEnabledByName.set(name, enabled);
    this.mcpServerStatuses = this.mcpServerStatuses.map((entry) => entry.name === name ? { ...entry, isEnabled: enabled } : entry);
    this.recomputePluginEnabledStates();
  }

  async startMcpServerOauthLogin({ providerProfile, name, scopes = null, timeoutSecs = null }: any = {}) {
    this.startMcpServerOauthLoginCalls.push({ providerProfile, name, scopes, timeoutSecs });
    return {
      authorizationUrl: `https://example.com/oauth/${name}`,
    };
  }

  async reloadMcpServers({ providerProfile }: any = {}) {
    this.reloadMcpServersCalls.push({ providerProfile });
  }

  async listModels() {
    this.listModelsCalls.push({});
    return this.models;
  }

  async reconnectProfile() {
    this.reconnectProfileCalls.push({});
    return {
      connected: true,
      accountIdentity: null,
    };
  }

  findPluginSummaryById(pluginId: string) {
    for (const marketplace of this.pluginCatalog.marketplaces ?? []) {
      const found = (marketplace.plugins ?? []).find((entry: any) => entry.id === pluginId);
      if (found) {
        return found;
      }
    }
    return null;
  }

  findPluginSummaryByName(pluginName: string, marketplaceName: string | null, marketplacePath: string | null) {
    for (const marketplace of this.pluginCatalog.marketplaces ?? []) {
      const found = (marketplace.plugins ?? []).find((entry: any) => (
        entry.name === pluginName
        && (marketplaceName ? entry.marketplaceName === marketplaceName : true)
        && (marketplacePath ? entry.marketplacePath === marketplacePath : true)
      ));
      if (found) {
        return found;
      }
    }
    return null;
  }

  recomputePluginEnabledStates() {
    for (const detail of this.pluginDetails.values()) {
      const summary = detail?.summary;
      if (!summary) {
        continue;
      }
      const appsEnabled = (detail.apps ?? []).every((app: any) => {
        const match = this.appEntries.find((entry) => entry.id === app.id);
        return match ? match.isEnabled !== false : true;
      });
      const skillsEnabled = (detail.skills ?? []).every((skill: any) => skill.enabled !== false);
      const mcpEnabled = (detail.mcpServers ?? []).every((name: any) => this.mcpEnabledByName.get(name) !== false);
      summary.enabled = Boolean(summary.installed) && appsEnabled && skillsEnabled && mcpEnabled;
    }
  }

  async getUsage() {
    return this.usageReport ?? null;
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

function makeRuntime({
  defaultCwd = null,
  providerProfiles = null,
  defaultProviderProfileId = 'openai-default',
  restartBridge = null,
  locale = null,
  platformPlugins = [],
  codexAuthManager = null,
  codexInstructionsManager = null,
  weiboHotSearch = null,
} = {}) {
  const openai = new FakeProviderPlugin('openai-native', { replyPrefix: 'openai' });
  const compatible = new FakeProviderPlugin('openai-compatible', { replyPrefix: 'compatible' });
  const runtime = createCodexBridgeRuntime({
    platformPlugins,
    providerPlugins: [openai, compatible],
    providerProfiles: providerProfiles ?? [
      makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default'),
      makeProviderProfile('compat-default', 'openai-compatible', 'Compatible Default'),
    ],
    defaultProviderProfileId,
    defaultCwd,
    locale,
    restartBridge,
    codexAuthManager,
    codexInstructionsManager,
    weiboHotSearch,
  });
  return { runtime, openai, compatible, minimax: compatible };
}

async function maybeReturnArtifactIntentParserResult({
  bridgeSession: _bridgeSession,
  onTurnStarted: _onTurnStarted,
  decision: _decision,
}: {
  bridgeSession: any;
  onTurnStarted?: ((meta: { turnId?: string | null; threadId?: string | null }) => Promise<void>) | null;
  decision: Record<string, unknown>;
}) {
  return null;
}

function makeFakeCodexInstructionsManager({
  path: filePath = '/tmp/.codex/AGENTS.md',
  content = '',
  exists = false,
} = {}) {
  const state = {
    path: filePath,
    content,
    exists,
  };
  const writes: string[] = [];
  let clears = 0;
  return {
    state,
    writes,
    get clears() {
      return clears;
    },
    async readInstructions() {
      return { ...state };
    },
    async writeInstructions(nextContent: string) {
      const normalized = String(nextContent ?? '').trim();
      writes.push(nextContent);
      state.content = normalized ? `${normalized}\n` : '';
      state.exists = Boolean(normalized);
      return { ...state };
    },
    async clearInstructions() {
      clears += 1;
      state.content = '';
      state.exists = false;
      return { ...state };
    },
  };
}

function makeUsageReport(overrides = {}) {
  return {
    provider: 'codex',
    accountId: 'acct-usage-1',
    userId: null,
    email: 'ganxing@example.com',
    plan: 'pro',
    buckets: [
      {
        name: 'Codex',
        allowed: true,
        limitReached: false,
        windows: [
          {
            name: 'Primary',
            usedPercent: 23,
            windowSeconds: 18_000,
            resetAfterSeconds: 3_600,
            resetAtUnix: 0,
          },
          {
            name: 'Secondary',
            usedPercent: 42,
            windowSeconds: 604_800,
            resetAfterSeconds: 172_800,
            resetAtUnix: 0,
          },
        ],
      },
    ],
    credits: null,
    ...overrides,
  };
}

function makeFakeCodexAuthManager({
  accounts = [],
  activeAccountId = null,
  pendingLogin = null,
  refreshResults = [],
  startError = null,
} = {}) {
  const state = {
    accounts: accounts.map((account) => ({ ...account })),
    activeAccountId,
    pendingLogin: pendingLogin ? { ...pendingLogin } : null,
    refreshResults: [...refreshResults],
  };
  const startCalls = [];
  const switchCalls = [];
  const cancelCalls = [];

  const decorateAccount = (account) => ({
    ...account,
    isActive: state.activeAccountId === account.id,
  });

  return {
    state,
    startCalls,
    switchCalls,
    cancelCalls,
    async startDeviceLogin(params: { requestedByScope?: string | null } = {}) {
      startCalls.push(params);
      if (startError) {
        throw startError;
      }
      if (!state.pendingLogin) {
        state.pendingLogin = {
          flowId: 'flow-1',
          verificationUriComplete: 'https://auth.openai.com/activate?user_code=ABCD-EFGH',
          verificationUri: 'https://auth.openai.com/activate',
          userCode: 'ABCD-EFGH',
          expiresAt: Date.now() + 15 * 60_000,
          requestedByScope: params.requestedByScope ?? null,
        };
      } else {
        state.pendingLogin = {
          ...state.pendingLogin,
          requestedByScope: params.requestedByScope ?? state.pendingLogin.requestedByScope ?? null,
        };
      }
      return { ...state.pendingLogin };
    },
    async refreshPendingLogin() {
      if (state.refreshResults.length > 0) {
        const next = state.refreshResults.shift();
        if (next?.status === 'completed' && next.account) {
          const existingIndex = state.accounts.findIndex((account) => account.id === next.account.id);
          if (existingIndex >= 0) {
            state.accounts[existingIndex] = { ...next.account };
          } else {
            state.accounts.push({ ...next.account });
          }
          state.pendingLogin = null;
        } else if (next?.status === 'pending' && next.pendingLogin) {
          state.pendingLogin = { ...next.pendingLogin };
        } else if (next?.status === 'expired' || next?.status === 'failed') {
          state.pendingLogin = null;
        }
        return next ?? null;
      }
      if (!state.pendingLogin) {
        return null;
      }
      return {
        status: 'pending',
        pendingLogin: { ...state.pendingLogin },
      };
    },
    async cancelPendingLogin() {
      cancelCalls.push(true);
      const hadPending = Boolean(state.pendingLogin);
      state.pendingLogin = null;
      return hadPending;
    },
    async listAccounts() {
      return {
        accounts: state.accounts.map(decorateAccount),
        activeAccountId: state.activeAccountId,
        pendingLogin: state.pendingLogin ? { ...state.pendingLogin } : null,
      };
    },
    async switchAccountByIndex(index) {
      switchCalls.push(index);
      const account = state.accounts[index - 1];
      if (!account) {
        throw new Error(`Account ${index} not found`);
      }
      state.activeAccountId = account.id;
      return {
        account: decorateAccount(account),
        authPath: '/tmp/.codex/auth.json',
        refreshed: true,
      };
    },
  };
}

function createTempAttachment(fileName: string, content = 'attachment') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-upload-test-'));
  const filePath = path.join(directory, fileName);
  fs.writeFileSync(filePath, content);
  return filePath;
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

async function fullyConfirmLatestAgentJob(runtime, externalScopeId: string) {
  const created = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId,
    text: '/agent confirm',
  });
  const index = runtime.services.agentJobs.listForScope({
    platform: 'weixin',
    externalScopeId,
  }).length;
  const checklist = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId,
    text: `/agent confirm ${index}`,
  });
  const queued = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId,
    text: `/agent confirm ${index}`,
  });
  return {
    created,
    checklist,
    queued,
    index,
  };
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

test('bridge coordinator returns generated image outputs as media messages', async () => {
  const { runtime, openai } = makeRuntime();
  const imagePath = createTempAttachment('generated-dog.png', 'png');
  openai.startTurn = async ({ bridgeSession, inputText, onTurnStarted = null }) => {
    const turnId = `${bridgeSession.codexThreadId}-turn-generated-image`;
    if (typeof onTurnStarted === 'function') {
      await onTurnStarted({
        turnId,
        threadId: bridgeSession.codexThreadId,
      });
    }
    return {
      outputText: `openai: ${inputText}`,
      outputMedia: [{
        kind: 'image',
        path: imagePath,
        caption: null,
      }],
      turnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-image-1',
    text: '画一只小狗',
  });

  assert.equal(result.type, 'message');
  assert.equal(result.messages[0]?.text, 'openai: 画一只小狗');
  assert.equal(result.messages[1]?.mediaPath, imagePath);
});

test('bridge coordinator strips hidden artifact manifests and returns declared file attachments as media messages', async () => {
  const { runtime, openai } = makeRuntime({ defaultCwd: '/tmp/codexbridge-artifact-manifest' });
  openai.startTurn = async ({ bridgeSession, inputText, event, onTurnStarted = null }) => {
    const parserResult = await maybeReturnArtifactIntentParserResult({
      bridgeSession,
      onTurnStarted,
      decision: {
        action: 'deliver_file',
        preferredKind: 'file',
        requestedFormat: 'docx',
        explicit: true,
        confidence: 0.99,
        reason: '用户明确要求整理成 Word 文档并发送。',
      },
    });
    if (parserResult) {
      return parserResult;
    }
    const turnId = `${bridgeSession.codexThreadId}-turn-artifact-1`;
    if (typeof onTurnStarted === 'function') {
      await onTurnStarted({
        turnId,
        threadId: bridgeSession.codexThreadId,
      });
    }
    const artifactDir = String(event?.metadata?.codexbridge?.turnArtifactContext?.artifactDir ?? '').trim();
    assert.ok(artifactDir);
    const declaredPath = path.join(artifactDir, 'summary.docx');
    fs.mkdirSync(path.dirname(declaredPath), { recursive: true });
    fs.writeFileSync(declaredPath, 'word-output');
    return {
      outputText: `已整理成 Word 文档。\n\n\`\`\`codexbridge-artifacts\n[{"path":${JSON.stringify(declaredPath)},"kind":"file","displayName":"summary.docx","caption":"Word 文档"}]\n\`\`\``,
      turnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-file-1',
    text: '把这次未提交修改整理成 Word 文档发我',
  });

  assert.equal(result.type, 'message');
  assert.equal(result.messages[0]?.text, '已整理成 Word 文档。');
  assert.ok(result.messages[0]?.text?.includes('codexbridge-artifacts') === false);
  assert.ok(typeof result.messages[1]?.mediaPath === 'string' && result.messages[1]?.mediaPath.endsWith('summary.docx'));
  assert.match(String(result.messages[1]?.mediaPath ?? ''), /artifact-spool/);
  assert.equal(fs.existsSync(String(result.messages[1]?.mediaPath ?? '')), true);
});

test('bridge coordinator recognizes "md 文件" requests and returns the markdown deliverable as media', async () => {
  const { runtime, openai } = makeRuntime({ defaultCwd: '/tmp/codexbridge-artifact-markdown' });
  openai.startTurn = async ({ bridgeSession, event, onTurnStarted = null }) => {
    const parserResult = await maybeReturnArtifactIntentParserResult({
      bridgeSession,
      onTurnStarted,
      decision: {
        action: 'deliver_file',
        preferredKind: 'file',
        requestedFormat: 'md',
        explicit: true,
        confidence: 0.99,
        reason: '用户明确要求 md 文件交付。',
      },
    });
    if (parserResult) {
      return parserResult;
    }
    const turnId = `${bridgeSession.codexThreadId}-turn-artifact-md-1`;
    if (typeof onTurnStarted === 'function') {
      await onTurnStarted({
        turnId,
        threadId: bridgeSession.codexThreadId,
      });
    }
    const artifactDir = String(event?.metadata?.codexbridge?.turnArtifactContext?.artifactDir ?? '').trim();
    assert.ok(artifactDir);
    const declaredPath = path.join(artifactDir, 'response.md');
    fs.mkdirSync(path.dirname(declaredPath), { recursive: true });
    fs.writeFileSync(declaredPath, '# Markdown Summary');
    return {
      outputText: `Markdown 已整理完成。\n\n\`\`\`codexbridge-artifacts\n[{"path":${JSON.stringify(declaredPath)},"kind":"file","displayName":"response.md","caption":"Markdown 文件"}]\n\`\`\``,
      turnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-file-md-1',
    text: '帮我整理成一个 md 文件发给我',
  });

  assert.equal(result.type, 'message');
  assert.equal(result.messages[0]?.text, 'Markdown 已整理完成。');
  assert.ok(result.messages[0]?.text?.includes('codexbridge-artifacts') === false);
  assert.ok(typeof result.messages[1]?.mediaPath === 'string' && result.messages[1]?.mediaPath.endsWith('response.md'));
  assert.match(String(result.messages[1]?.mediaPath ?? ''), /artifact-spool/);
  assert.equal(fs.existsSync(String(result.messages[1]?.mediaPath ?? '')), true);
});

test('bridge coordinator starts a generic file-delivery turn without asking for format first', async () => {
  const { runtime, openai } = makeRuntime({ defaultCwd: '/tmp/codexbridge-artifact-clarify-md' });
  openai.startTurn = async ({ bridgeSession, event, onTurnStarted = null }) => {
    const parserResult = await maybeReturnArtifactIntentParserResult({
      bridgeSession,
      onTurnStarted,
      decision: {
        action: 'deliver_file',
        preferredKind: 'file',
        requestedFormat: null,
        explicit: true,
        confidence: 0.97,
        reason: '用户明确要求把文件直接发送回去，格式未指定。',
      },
    });
    if (parserResult) {
      return parserResult;
    }
    const turnId = `${bridgeSession.codexThreadId}-turn-artifact-clarify-md-1`;
    if (typeof onTurnStarted === 'function') {
      await onTurnStarted({
        turnId,
        threadId: bridgeSession.codexThreadId,
      });
    }
    const artifactDir = String(event?.metadata?.codexbridge?.turnArtifactContext?.artifactDir ?? '').trim();
    assert.ok(artifactDir);
    const declaredPath = path.join(artifactDir, 'deliverable.md');
    fs.mkdirSync(path.dirname(declaredPath), { recursive: true });
    fs.writeFileSync(declaredPath, '# Clarified Markdown');
    return {
      outputText: `已作为 \`.md\` 附件返回。\n\n\`\`\`codexbridge-artifacts\n[{"path":${JSON.stringify(declaredPath)},"kind":"file","displayName":"deliverable.md","caption":"final deliverable"}]\n\`\`\``,
      turnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-file-clarify-md-1',
    text: '把文件直接发送给我',
  });

  assert.equal(result.type, 'message');
  assert.equal(result.messages[0]?.text, '已作为 `.md` 附件返回。');
  assert.ok(result.messages[0]?.text?.includes('codexbridge-artifacts') === false);
  assert.ok(typeof result.messages[1]?.mediaPath === 'string' && result.messages[1]?.mediaPath.endsWith('deliverable.md'));
  assert.match(String(result.messages[1]?.mediaPath ?? ''), /artifact-spool/);
  assert.equal(fs.existsSync(String(result.messages[1]?.mediaPath ?? '')), true);
});

test('bridge coordinator does not send undeclared files when the model omits the manifest', async () => {
  const { runtime, openai } = makeRuntime({ defaultCwd: '/tmp/codexbridge-artifact-fallback' });
  openai.startTurn = async ({ bridgeSession, event, onTurnStarted = null }) => {
    const parserResult = await maybeReturnArtifactIntentParserResult({
      bridgeSession,
      onTurnStarted,
      decision: {
        action: 'deliver_file',
        preferredKind: 'file',
        requestedFormat: 'pdf',
        explicit: true,
        confidence: 0.99,
        reason: '用户明确要求导出 PDF 并发送。',
      },
    });
    if (parserResult) {
      return parserResult;
    }
    const turnId = `${bridgeSession.codexThreadId}-turn-artifact-2`;
    if (typeof onTurnStarted === 'function') {
      await onTurnStarted({
        turnId,
        threadId: bridgeSession.codexThreadId,
      });
    }
    const artifactDir = String(event?.metadata?.codexbridge?.turnArtifactContext?.artifactDir ?? '').trim();
    assert.ok(artifactDir);
    const generatedPath = path.join(artifactDir, 'summary.pdf');
    fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
    fs.writeFileSync(generatedPath, 'pdf-output');
    return {
      outputText: 'PDF 已生成。',
      turnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-file-2',
    text: '导出成 PDF 发我',
  });

  assert.equal(result.messages[0]?.text, 'PDF 已生成。');
  assert.equal(result.messages.some((message) => Boolean(message.mediaPath)), false);
});

test('bridge coordinator starts a generic export turn immediately without asking for the export format', async () => {
  const { runtime, openai } = makeRuntime({ defaultCwd: '/tmp/codexbridge-artifact-clarify' });
  openai.startTurn = async ({ bridgeSession, event, onTurnStarted = null }) => {
    const parserResult = await maybeReturnArtifactIntentParserResult({
      bridgeSession,
      onTurnStarted,
      decision: {
        action: 'deliver_file',
        preferredKind: 'file',
        requestedFormat: null,
        explicit: true,
        confidence: 0.95,
        reason: '用户明确要求导出并发送结果，但没有指定格式。',
      },
    });
    if (parserResult) {
      return parserResult;
    }
    const turnId = `${bridgeSession.codexThreadId}-turn-artifact-generic-1`;
    if (typeof onTurnStarted === 'function') {
      await onTurnStarted({
        turnId,
        threadId: bridgeSession.codexThreadId,
      });
    }
    const artifactDir = String(event?.metadata?.codexbridge?.turnArtifactContext?.artifactDir ?? '').trim();
    assert.ok(artifactDir);
    const declaredPath = path.join(artifactDir, 'deliverable.txt');
    fs.mkdirSync(path.dirname(declaredPath), { recursive: true });
    fs.writeFileSync(declaredPath, 'generic-file-output');
    return {
      outputText: `文件已附上。\n\n\`\`\`codexbridge-artifacts\n[{"path":${JSON.stringify(declaredPath)},"kind":"file","displayName":"deliverable.txt","caption":"final deliverable"}]\n\`\`\``,
      turnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const first = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-file-clarify-1',
    text: '把结果导出一下发我',
  });

  assert.equal(first.messages[0]?.text, '文件已附上。');
  assert.ok(typeof first.messages[1]?.mediaPath === 'string' && first.messages[1]?.mediaPath.endsWith('deliverable.txt'));
});

test('bridge coordinator does not send arbitrary undeclared attachments when multiple files exist', async () => {
  const { runtime, openai } = makeRuntime({ defaultCwd: '/tmp/codexbridge-artifact-ambiguous' });
  openai.startTurn = async ({ bridgeSession, event, onTurnStarted = null }) => {
    const parserResult = await maybeReturnArtifactIntentParserResult({
      bridgeSession,
      onTurnStarted,
      decision: {
        action: 'deliver_file',
        preferredKind: 'file',
        requestedFormat: 'pdf',
        explicit: true,
        confidence: 0.99,
        reason: '用户明确要求导出 PDF 并发送。',
      },
    });
    if (parserResult) {
      return parserResult;
    }
    const turnId = `${bridgeSession.codexThreadId}-turn-artifact-3`;
    if (typeof onTurnStarted === 'function') {
      await onTurnStarted({
        turnId,
        threadId: bridgeSession.codexThreadId,
      });
    }
    const artifactDir = String(event?.metadata?.codexbridge?.turnArtifactContext?.artifactDir ?? '').trim();
    assert.ok(artifactDir);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'summary-a.pdf'), 'a');
    fs.writeFileSync(path.join(artifactDir, 'summary-b.pdf'), 'b');
    return {
      outputText: 'PDF 已生成。',
      turnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-file-3',
    text: '导出成 PDF 发我',
  });

  assert.equal(result.messages.some((message) => Boolean(message.mediaPath)), false);
  assert.equal(result.messages[0]?.text, 'PDF 已生成。');
});

test('bridge coordinator does not force artifact delivery when the user complains about unexpected files', async () => {
  const { runtime, openai } = makeRuntime({ defaultCwd: '/tmp/codexbridge-artifact-complaint' });
  openai.startTurn = async ({ bridgeSession, event, inputText, onTurnStarted = null }) => {
    const parserResult = await maybeReturnArtifactIntentParserResult({
      bridgeSession,
      onTurnStarted,
      decision: {
        action: 'none',
        preferredKind: null,
        requestedFormat: null,
        textOnly: true,
        explicit: false,
        confidence: 0.98,
        reason: '用户是在抱怨附件，不是在要求新的文件交付。',
      },
    });
    if (parserResult) {
      return parserResult;
    }
    const turnId = `${bridgeSession.codexThreadId}-turn-artifact-complaint-1`;
    if (typeof onTurnStarted === 'function') {
      await onTurnStarted({
        turnId,
        threadId: bridgeSession.codexThreadId,
      });
    }
    assert.ok(event?.metadata?.codexbridge?.turnArtifactContext?.artifactDir);
    return {
      outputText: `openai: ${inputText}`,
      turnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-file-complaint-1',
    text: '怎么回事？怎么又多了一个文件？又多了一个文件，你这每回都会给我发文件，这可不太好吧',
  });

  assert.equal(result.type, 'message');
  assert.equal(result.messages.length, 1);
  assert.match(result.messages[0]?.text ?? '', /openai:/);
  assert.equal(result.messages[0]?.mediaPath ?? null, null);
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

test('bridge coordinator auto-rebinds to a new session when stale thread resume fails', async () => {
  const { runtime, openai } = makeRuntime();
  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello codexbridge',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/plan on',
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

  assert.match(result.messages[0]?.text ?? '', /openai: hello again/);
  assert.equal(openai.startThreadCalls.length, 2);

  const rebound = runtime.services.bridgeSessions.resolveScopeSession({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
  });
  assert.notEqual(rebound?.id, original.session?.bridgeSessionId);
  assert.notEqual(rebound?.codexThreadId, original.session?.codexThreadId);
  assert.equal(
    rebound ? runtime.services.bridgeSessions.getSessionSettings(rebound.id)?.collaborationMode : null,
    'plan',
  );
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

test('bridge coordinator auto-rebinds to a new session when rollout loading keeps failing', async () => {
  const { runtime, openai } = makeRuntime();
  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello codexbridge',
  });

  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (args) => {
    if (args.bridgeSession.codexThreadId === original.session.codexThreadId) {
      throw new Error(`failed to load rollout '/tmp/${args.bridgeSession.codexThreadId}.jsonl' for thread ${args.bridgeSession.codexThreadId}: empty session file`);
    }
    return originalStartTurn(args);
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello after persistent rollout damage',
  });

  assert.match(result.messages[0]?.text ?? '', /openai: hello after persistent rollout damage/);
  assert.equal(openai.startThreadCalls.length, 2);

  const rebound = runtime.services.bridgeSessions.resolveScopeSession({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
  });
  assert.notEqual(rebound?.id, original.session?.bridgeSessionId);
  assert.notEqual(rebound?.codexThreadId, original.session?.codexThreadId);
});

test('/status reports when no bridge session is bound yet', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/status',
  });

  const lines = result.messages.map((message) => message.text ?? '');
  assert.ok(lines.includes('接口配置：openai-default'));
  assert.ok(lines.includes('默认工作目录：（未设置）'));
  assert.ok(lines.includes('模型：gpt-5.4'));
  assert.ok(lines.includes('推理强度：'));
  assert.ok(lines.includes('权限预设：'));
  assert.ok(lines.includes('完整信息：/status details'));
});

test('/status uses English output when locale is set to en', async () => {
  const { runtime } = makeRuntime({ locale: 'en' });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-en-1',
    text: '/status',
  });

  const lines = result.messages.map((message) => message.text ?? '');
  assert.ok(lines.includes('Interface profile: openai-default'));
  assert.ok(lines.includes('Default working directory: (not set)'));
  assert.ok(lines.includes('Model: gpt-5.4'));
  assert.ok(lines.includes('Reasoning effort: '));
  assert.ok(lines.includes('Access preset: '));
  assert.ok(lines.includes('More details: /status details'));
});

test('/status includes weixin session pause state when the platform exposes it', async () => {
  const weixinPlatform = {
    id: 'weixin',
    getStatus() {
      return {
        data: {
          accountId: 'bot-account',
          sessionPaused: true,
          remainingPauseMinutes: 42,
        },
      };
    },
  };
  const { runtime } = makeRuntime({
    platformPlugins: [weixinPlatform],
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-weixin-1',
    text: '/status',
  });

  const lines = result.messages.map((message) => message.text ?? '');
  assert.ok(lines.some((line) => /微信会话：冷却中/.test(line)));
  assert.ok(lines.every((line) => !/微信账号：/.test(line)));
  assert.ok(lines.every((line) => !/微信上下文 token：/.test(line)));
  assert.ok(lines.every((line) => !/微信冷却剩余：/.test(line)));
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

  const lines = result.messages.map((message) => message.text ?? '');
  assert.ok(lines.includes('接口配置：openai-default'));
  assert.ok(lines.includes('会话标题：OpenAI Default thread 1'));
  assert.ok(lines.includes('工作目录：/tmp/openai-default'));
  assert.ok(lines.includes('速度模式：normal'));
  assert.ok(lines.includes('模型：gpt-5.4'));
  assert.ok(lines.includes('推理强度：'));
  assert.ok(lines.includes('权限预设：'));
  assert.ok(lines.includes('完整信息：/status details'));
  assert.ok(lines.every((line) => !/Scope：/.test(line)));
  assert.ok(lines.every((line) => !/当前 Turn：/.test(line)));
  assert.ok(lines.every((line) => !/Turn 状态：/.test(line)));
  assert.ok(lines.every((line) => !/Bridge 会话：/.test(line)));
  assert.ok(lines.every((line) => !/Codex 线程：/.test(line)));
});

test('/status details includes full diagnostics for the current session', async () => {
  const { runtime, openai } = makeRuntime();
  openai.usageReport = makeUsageReport();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-details-1',
    text: 'hello',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-details-1',
    text: '/status details',
  });

  const lines = result.messages.map((message) => message.text ?? '');
  assert.ok(lines.some((line) => /Bridge 会话：/.test(line)));
  assert.ok(lines.some((line) => /会话标题：OpenAI Default thread 1/.test(line)));
  assert.ok(lines.some((line) => /Codex 线程：/.test(line)));
  assert.ok(lines.some((line) => /速度模式：normal/.test(line)));
  assert.ok(lines.some((line) => /审批策略：/.test(line)));
  assert.ok(lines.some((line) => /沙箱模式：/.test(line)));
  assert.ok(lines.every((line) => !/完整信息：\/status details/.test(line)));
});

test('/status details includes the last artifact delivery status for the current session', async () => {
  const { runtime, openai } = makeRuntime({ defaultCwd: '/tmp/codexbridge-status-artifacts' });
  openai.startTurn = async ({ bridgeSession, event, onTurnStarted = null }) => {
    const parserResult = await maybeReturnArtifactIntentParserResult({
      bridgeSession,
      onTurnStarted,
      decision: {
        action: 'deliver_file',
        preferredKind: 'file',
        requestedFormat: 'docx',
        explicit: true,
        confidence: 0.99,
        reason: '用户明确要求整理成 Word 发回。',
      },
    });
    if (parserResult) {
      return parserResult;
    }
    const turnId = `${bridgeSession.codexThreadId}-turn-artifact-status-1`;
    if (typeof onTurnStarted === 'function') {
      await onTurnStarted({
        turnId,
        threadId: bridgeSession.codexThreadId,
      });
    }
    const artifactDir = String(event?.metadata?.codexbridge?.turnArtifactContext?.artifactDir ?? '').trim();
    const declaredPath = path.join(artifactDir, 'summary.docx');
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(declaredPath, 'word-output');
    return {
      outputText: `已整理成 Word 文档。\n\n\`\`\`codexbridge-artifacts\n[{"path":${JSON.stringify(declaredPath)},"kind":"file","displayName":"summary.docx"}]\n\`\`\``,
      turnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-artifacts-1',
    text: '把摘要整理成 Word 发我',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-artifacts-1',
    text: '/status details',
  });

  const lines = result.messages.map((message) => message.text ?? '');
  assert.ok(lines.some((line) => /附件交付：已选定附件/.test(line)));
  assert.ok(lines.some((line) => /请求格式：docx/.test(line)));
  assert.ok(lines.some((line) => /附件结果：已选 1，拒绝 0(?:，候选 \d+)?/.test(line)));
  assert.ok(lines.some((line) => /产物目录：/.test(line)));
  assert.ok(lines.some((line) => /暂存目录：/.test(line)));
});

test('/status shows the renamed local thread title in simple mode', async () => {
  const { runtime } = makeRuntime();

  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-title-1',
    text: 'hello',
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-title-1',
    text: `/rename ${original.session?.codexThreadId} 微信 Codex`,
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-title-1',
    text: '/status',
  });

  const lines = result.messages.map((message) => message.text ?? '');
  assert.ok(lines.includes('会话标题：微信 Codex'));
});

test('/status details includes weixin diagnostic lines', async () => {
  const weixinPlatform = {
    id: 'weixin',
    getStatus() {
      return {
        data: {
          accountId: 'bot-account',
          sessionPaused: true,
          remainingPauseMinutes: 42,
          hasContextToken: false,
        },
      };
    },
  };
  const { runtime } = makeRuntime({
    platformPlugins: [weixinPlatform],
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-status-details-weixin-1',
    text: '/status details',
  });

  const lines = result.messages.map((message) => message.text ?? '');
  assert.ok(lines.some((line) => /微信上下文 token：无/.test(line)));
  assert.ok(lines.some((line) => /微信冷却剩余：42 分钟/.test(line)));
});

test('/usage shows account plus 5-hour and weekly remaining quota', async () => {
  const { runtime, openai } = makeRuntime();
  openai.usageReport = makeUsageReport();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-usage-1',
    text: '/usage',
  });

  const lines = result.messages.map((message) => message.text ?? '');
  assert.equal(lines[0], '用量 | openai-default');
  assert.ok(lines.includes('账号：ganxing@example.com (pro)'));
  assert.ok(lines.some((line) => /5 小时剩余：77%（1 小时后重置）/.test(line)));
  assert.ok(lines.some((line) => /本周剩余：58%（2 天后重置）/.test(line)));
});

test('/status includes account and compact usage summary when usage is available', async () => {
  const { runtime, openai } = makeRuntime();
  openai.usageReport = makeUsageReport();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-usage-status-1',
    text: 'hello',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-usage-status-1',
    text: '/status',
  });

  const lines = result.messages.map((message) => message.text ?? '');
  assert.ok(lines.includes('账号：ganxing@example.com (pro)'));
  assert.ok(lines.some((line) => /5 小时剩余：77%（1 小时后重置）/.test(line)));
  assert.ok(lines.some((line) => /本周剩余：58%（2 天后重置）/.test(line)));
});

test('/allow shows pending approval requests for the active turn', async () => {
  const { runtime } = makeRuntime();

  const initial = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-list-1',
    text: 'hello',
  });
  const session = initial.session;
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-list-1',
  };

  runtime.services.activeTurns.beginScopeTurn(scopeRef, {
    bridgeSessionId: session.bridgeSessionId,
    providerProfileId: session.providerProfileId,
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-pending`,
  });
  runtime.services.activeTurns.addPendingApproval(scopeRef, {
    requestId: 'approval-1',
    kind: 'command',
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-pending`,
    itemId: 'item-1',
    reason: 'command failed; retry without sandbox?',
    command: 'npm run build',
    cwd: '/home/ubuntu/dev/CodexBridge',
    availableDecisionKeys: ['accept', 'acceptForSession', 'decline'],
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-list-1',
    text: '/allow',
  });

  const text = result.messages.map((message) => message.text ?? '').join('\n');
  assert.match(text, /审批请求 \| 1 项/);
  assert.match(text, /command failed; retry without sandbox\?/);
  assert.match(text, /\/allow 1：仅批准这一次/);
  assert.match(text, /\/allow 2：在当前会话里记住这次批准/);
  assert.match(text, /\/deny：拒绝这次请求/);
});

test('/allow 2 replies to the provider approval request and clears it from the active turn', async () => {
  const { runtime, openai } = makeRuntime();

  const initial = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-approve-1',
    text: 'hello',
  });
  const session = initial.session;
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-approve-1',
  };

  runtime.services.activeTurns.beginScopeTurn(scopeRef, {
    bridgeSessionId: session.bridgeSessionId,
    providerProfileId: session.providerProfileId,
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-pending`,
  });
  runtime.services.activeTurns.addPendingApproval(scopeRef, {
    requestId: 'approval-2',
    kind: 'command',
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-pending`,
    itemId: 'item-2',
    reason: 'command failed; retry without sandbox?',
    command: 'npm run build',
    cwd: '/home/ubuntu/dev/CodexBridge',
    availableDecisionKeys: ['accept', 'acceptForSession', 'decline'],
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-approve-1',
    text: '/allow 2',
  });

  assert.equal(openai.respondToApprovalCalls.length, 1);
  assert.equal(openai.respondToApprovalCalls[0]?.option, 2);
  assert.equal(openai.respondToApprovalCalls[0]?.request?.requestId, 'approval-2');
  assert.equal(runtime.services.activeTurns.resolveScopeTurn(scopeRef), null);
  assert.match(result.messages[0]?.text ?? '', /已对当前会话记住这次命令执行批准/);
});

test('/allow acknowledges when provider turn has already ended after approval', async () => {
  const { runtime, openai } = makeRuntime();

  const initial = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-ended-1',
    text: 'hello',
  });
  const session = initial.session;
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-ended-1',
  };
  const turnId = `${session.codexThreadId}-turn-pending`;
  runtime.services.activeTurns.beginScopeTurn(scopeRef, {
    bridgeSessionId: session.bridgeSessionId,
    providerProfileId: session.providerProfileId,
    threadId: session.codexThreadId,
    turnId,
  });
  runtime.services.activeTurns.addPendingApproval(scopeRef, {
    requestId: 'approval-ended-1',
    kind: 'command',
    threadId: session.codexThreadId,
    turnId,
    itemId: 'item-ended-1',
    reason: 'command failed; retry without sandbox?',
    command: 'npm run build',
    cwd: '/home/ubuntu/dev/CodexBridge',
    availableDecisionKeys: ['accept', 'acceptForSession', 'decline'],
  });
  const thread = openai.threads.get(session.codexThreadId);
  assert.ok(thread);
  thread.turns = [
    {
      id: turnId,
      status: 'running',
      error: null,
      items: [],
    },
  ];
  openai.respondToApproval = async ({ providerProfile, request, option }) => {
    openai.respondToApprovalCalls.push({ providerProfile, request, option });
    thread.turns = [
      {
        id: turnId,
        status: 'interrupted',
        error: 'Conversation interrupted',
        items: [],
      },
    ];
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-ended-1',
    text: '/allow 2',
  });

  assert.equal(openai.respondToApprovalCalls.length, 1);
  assert.equal(runtime.services.activeTurns.resolveScopeTurn(scopeRef), null);
  assert.match(result.messages[0]?.text ?? '', /已对当前会话记住这次命令执行批准/);
  assert.match(result.messages[1]?.text ?? '', /该回合已经结束/);
});

test('/deny rejects the provider approval request and clears it from the active turn', async () => {
  const { runtime, openai } = makeRuntime();

  const initial = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-deny-1',
    text: 'hello',
  });
  const session = initial.session;
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-deny-1',
  };

  runtime.services.activeTurns.beginScopeTurn(scopeRef, {
    bridgeSessionId: session.bridgeSessionId,
    providerProfileId: session.providerProfileId,
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-pending`,
  });
  runtime.services.activeTurns.addPendingApproval(scopeRef, {
    requestId: 'approval-deny-1',
    kind: 'file_change',
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-pending`,
    itemId: 'item-deny-1',
    reason: 'apply this patch?',
    fileChanges: ['src/app.ts'],
    availableDecisionKeys: ['accept', 'acceptForSession', 'decline'],
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-deny-1',
    text: '/deny',
  });

  assert.equal(openai.respondToApprovalCalls.length, 1);
  assert.equal(openai.respondToApprovalCalls[0]?.option, 3);
  assert.equal(openai.respondToApprovalCalls[0]?.request?.requestId, 'approval-deny-1');
  assert.equal(runtime.services.activeTurns.resolveScopeTurn(scopeRef), null);
  assert.match(result.messages[0]?.text ?? '', /已拒绝这次文件改动请求/);
});

test('commands are blocked by pending approvals until /allow is handled', async () => {
  const { runtime } = makeRuntime();

  const initial = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-blocked-1',
    text: 'hello',
  });
  const session = initial.session;
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-blocked-1',
  };

  runtime.services.activeTurns.beginScopeTurn(scopeRef, {
    bridgeSessionId: session.bridgeSessionId,
    providerProfileId: session.providerProfileId,
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-pending`,
  });
  runtime.services.activeTurns.addPendingApproval(scopeRef, {
    requestId: 'approval-3',
    kind: 'permissions',
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-pending`,
    itemId: 'item-3',
    reason: 'Would you like to make the following edits?',
    networkPermission: true,
    fileReadPermissions: ['/tmp'],
    fileWritePermissions: ['/tmp'],
    availableDecisionKeys: ['accept', 'acceptForSession', 'decline'],
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-blocked-1',
    text: '/permissions full-access',
  });

  const lines = result.messages.map((message) => message.text ?? '');
  assert.ok(lines.some((line) => /当前有待处理的审批请求/.test(line)));
  assert.ok(lines.some((line) => /先用 \/allow 查看，再用 \/allow 1、\/allow 2 或 \/deny 处理/.test(line)));
});

test('stale active turns are reconciled before starting a new conversation turn', async () => {
  const { runtime, openai } = makeRuntime();

  const initial = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-stale-active-1',
    text: 'hello',
  });
  const session = initial.session;
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-stale-active-1',
  };
  const staleTurnId = `${session.codexThreadId}-turn-stale`;
  runtime.services.activeTurns.beginScopeTurn(scopeRef, {
    bridgeSessionId: session.bridgeSessionId,
    providerProfileId: session.providerProfileId,
    threadId: session.codexThreadId,
    turnId: staleTurnId,
  });
  const thread = openai.threads.get(session.codexThreadId);
  assert.ok(thread);
  thread.turns = [
    {
      id: staleTurnId,
      status: 'interrupted',
      error: 'Conversation interrupted',
      items: [],
    },
  ];

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-stale-active-1',
    text: 'hello again',
  });

  assert.match(result.messages[0]?.text ?? '', /openai: hello again/);
  assert.equal(runtime.services.activeTurns.resolveScopeTurn(scopeRef), null);
});

test('conversation turns remain blocked when the previous provider turn is still running', async () => {
  const { runtime, openai } = makeRuntime();
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-running-turn-1',
  };
  let runningTurnId = '';

  openai.startTurn = async ({ bridgeSession, onTurnStarted = null }) => {
    const parserResult = await maybeReturnArtifactIntentParserResult({
      bridgeSession,
      onTurnStarted,
      decision: {
        action: 'none',
        preferredKind: null,
        requestedFormat: null,
        explicit: false,
        confidence: 0.95,
        reason: '普通对话，不要求附件。',
      },
    });
    if (parserResult) {
      return parserResult;
    }
    openai.startTurnCalls.push({ bridgeSession });
    const thread = openai.threads.get(bridgeSession.codexThreadId);
    assert.ok(thread);
    runningTurnId = `${bridgeSession.codexThreadId}-turn-${thread.turns.length + 1}`;
    await onTurnStarted?.({
      turnId: runningTurnId,
      threadId: bridgeSession.codexThreadId,
    });
    thread.turns = [{
      id: runningTurnId,
      status: 'running',
      error: null,
      items: [],
    }];
    return {
      outputText: '',
      outputState: 'partial',
      previewText: 'still waiting',
      turnId: runningTurnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const firstResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: 'first request',
  });

  assert.equal(firstResult.meta?.codexTurn?.outputState, 'partial');
  assert.equal(runtime.services.activeTurns.resolveScopeTurn(scopeRef)?.turnId, runningTurnId);

  const secondResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: 'second request',
  });

  const combined = secondResult.messages.map((message) => message.text ?? '').join('\n');
  assert.match(combined, /当前已有一轮回复在进行中/);
  assert.equal(openai.startTurnCalls.length, 1);
});

test('/stop rebinds a phantom active turn id to the live in-progress provider turn', async () => {
  const { runtime, openai } = makeRuntime();

  const initial = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-phantom-stop-1',
    text: 'hello',
  });
  const session = initial.session;
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-phantom-stop-1',
  };
  const liveTurnId = `${session.codexThreadId}-turn-live`;

  runtime.services.activeTurns.beginScopeTurn(scopeRef, {
    bridgeSessionId: session.bridgeSessionId,
    providerProfileId: session.providerProfileId,
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-phantom`,
  });
  const thread = openai.threads.get(session.codexThreadId);
  assert.ok(thread);
  thread.turns = [{
    id: liveTurnId,
    status: 'running',
    error: null,
    items: [],
  }];

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: '/stop',
  });

  assert.equal(result.messages[0]?.text ?? '', '已请求中断当前回复。');
  assert.equal(openai.interruptTurnCalls.length, 1);
  assert.equal(openai.interruptTurnCalls[0]?.turnId, liveTurnId);
  assert.equal(runtime.services.activeTurns.resolveScopeTurn(scopeRef)?.turnId, liveTurnId);
});

test('/stop interrupts every non-terminal turn on the bound thread', async () => {
  const { runtime, openai } = makeRuntime();

  const initial = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-stop-thread-1',
    text: 'hello',
  });
  const session = initial.session;
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-stop-thread-1',
  };
  runtime.services.activeTurns.beginScopeTurn(scopeRef, {
    bridgeSessionId: session.bridgeSessionId,
    providerProfileId: session.providerProfileId,
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-2`,
  });
  runtime.services.activeTurns.addPendingApproval(scopeRef, {
    requestId: 'approval-stop-thread-1',
    kind: 'command',
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-2`,
    itemId: 'item-stop-thread-1',
    reason: 'command failed; retry without sandbox?',
    command: 'npm run build',
    cwd: '/home/ubuntu/dev/CodexBridge',
    availableDecisionKeys: ['accept', 'acceptForSession', 'decline'],
  });
  const thread = openai.threads.get(session.codexThreadId);
  assert.ok(thread);
  thread.turns = [
    {
      id: `${session.codexThreadId}-turn-1`,
      status: 'running',
      error: null,
      items: [],
    },
    {
      id: `${session.codexThreadId}-turn-2`,
      status: 'running',
      error: null,
      items: [],
    },
  ];
  openai.interruptTurn = async (params) => {
    openai.interruptTurnCalls.push(params);
    const currentThread = openai.threads.get(params.threadId);
    assert.ok(currentThread);
    currentThread.turns = currentThread.turns.map((turn) => (
      turn.id === params.turnId
        ? {
          ...turn,
          status: 'interrupted',
          error: 'Conversation interrupted',
          items: [],
        }
        : turn
    ));
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: '/stop',
  });

  assert.equal(openai.interruptTurnCalls.length, 2);
  assert.deepEqual(
    openai.interruptTurnCalls.map((entry) => entry.turnId).sort(),
    [`${session.codexThreadId}-turn-1`, `${session.codexThreadId}-turn-2`].sort(),
  );
  assert.equal(result.messages[0]?.text ?? '', '已请求停止当前线程上的 2 个进行中回合。');
  assert.equal(result.messages[1]?.text ?? '', '已同时清空 1 项待处理审批。');
});

test('/helps lists all supported slash commands and help entrypoints', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/helps',
  });

  const text = result.messages[0]?.text ?? '';
  assert.match(text, /斜杠命令/);
  assert.match(text, /\/helps \(\/help, \/h\) 查看所有斜杠命令/);
  assert.match(text, /\/usage \(\/us\) 查看当前 Codex 账号，以及 5 小时 \/ 本周剩余用量/);
  assert.match(text, /\/login \(\/lg\) 管理本机 Codex 登录账号/);
  assert.match(text, /\/stop \(\/sp\) 请求中断当前正在执行的回复/);
  assert.match(text, /\/review \(\/rv\) 对当前工作区改动运行原生 Codex 代码审查/);
  assert.match(text, /\/uploads \(\/up, \/ul\) 开启上传暂存模式/);
  assert.match(text, /\/as \(\/assistant\) 助理记录统一入口/);
  assert.match(text, /\/todo \(\/td\) 指定为待办类型的助理入口/);
  assert.match(text, /\/remind \(\/rmd\) 指定为提醒类型的助理入口/);
  assert.match(text, /\/note \(\/nt\) 指定为笔记类型的助理入口/);
  assert.match(text, /\/provider \(\/pd\) 查看可用 provider/);
  assert.match(text, /\/models \(\/ms\) 列出当前 provider 的可用模型/);
  assert.match(text, /\/model \(\/m\) 查看或切换当前 scope 的模型设置/);
  assert.match(text, /\/personality \(\/psn\) 查看或切换当前会话的 personality/);
  assert.match(text, /\/instructions \(\/ins\) 查看、起草或确认全局自定义指令/);
  assert.match(text, /\/fast 开启或关闭 Fast 模式/);
  assert.match(text, /\/threads \(\/th\) 线程命令统一入口：查看列表，并支持自然语言搜索、打开、预览、改名和批量管理/);
  assert.match(text, /\/search \(\/se\) 用自然语言搜索相关线程，并显示候选列表/);
  assert.match(text, /\/next \(\/nx\) 翻到当前线程列表的下一页/);
  assert.match(text, /\/prev \(\/pv\) 翻到当前线程列表的上一页/);
  assert.match(text, /\/rename \(\/rn\) 给线程设置本地显示名/);
  assert.match(text, /\/allow \(\/al\) 查看并批准当前回合中的审批请求/);
  assert.match(text, /\/deny \(\/dn\) 拒绝当前回合中的审批请求/);
  assert.match(text, /\/retry \(\/rt\) 在同一线程里重试上一条请求/);
  assert.match(text, /\/lang 查看\/切换当前会话的语言/);
  assert.match(text, /\/lang 查看\/切换当前会话的语言\n⭐️ \/ 本地续聊脉冲：若 bot 单独连续发送接近 10 条消息/u);
  assert.match(text, /说明：这不是严格的 shell CLI，而是借用 CLI 的帮助习惯做聊天命令。$/u);
  assert.match(text, /帮助：\/helps <命令>/);
  assert.match(text, /示例：\/helps threads  或  \/threads -h/);
});

test('/helps renders English help text when locale is set to en', async () => {
  const { runtime } = makeRuntime({ locale: 'en' });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-help-en-1',
    text: '/helps',
  });

  const text = result.messages[0]?.text ?? '';
  assert.match(text, /Slash Commands/);
  assert.match(text, /\/helps \(\/help, \/h\) Show all slash commands/);
  assert.match(text, /\/usage \(\/us\) Show the current Codex account plus 5-hour and weekly remaining usage/);
  assert.match(text, /\/login \(\/lg\) Manage the host Codex login account/);
  assert.match(text, /\/review \(\/rv\) Run a native Codex code review for the current workspace changes/);
  assert.match(text, /\/uploads \(\/up, \/ul\) Enter upload staging mode/);
  assert.match(text, /\/as \(\/assistant\) Unified assistant record entry/);
  assert.match(text, /\/todo \(\/td\) Typed assistant entry for todo records/);
  assert.match(text, /\/remind \(\/rmd\) Typed assistant entry for reminder records/);
  assert.match(text, /\/note \(\/nt\) Typed assistant entry for note records/);
  assert.match(text, /\/allow \(\/al\) Inspect and approve in-turn approval requests/);
  assert.match(text, /\/deny \(\/dn\) Deny the current in-turn approval request/);
  assert.match(text, /\/retry \(\/rt\) Retry the previous request in the same thread/);
  assert.match(text, /Help: \/helps <command>/);
  assert.match(text, /\/models \(\/ms\) List available models for the current provider/);
  assert.match(text, /\/model \(\/m\) View or switch model settings for the current scope/);
  assert.match(text, /\/personality \(\/psn\) View or switch the active session personality/);
  assert.match(text, /\/instructions \(\/ins\) View, draft, or confirm the global custom instructions/);
  assert.match(text, /\/fast Enable or disable Fast mode/);
  assert.match(text, /\/lang Show or switch the current language used for text replies/);
  assert.match(text, /\/lang Show or switch the current language used for text replies\n⭐️ \/ Local keepalive pulse: when the bot is about to send roughly 10 consecutive messages on its own/u);
  assert.match(text, /Note: this is not a strict shell CLI\. It borrows familiar CLI help conventions for chat commands\.$/u);
});

test('/login starts a pending Codex device login flow', async () => {
  const codexAuthManager = makeFakeCodexAuthManager();
  const { runtime } = makeRuntime({ codexAuthManager });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-login-start-1',
    text: '/login',
  });

  const text = result.messages.map((message) => message.text ?? '').join('\n');
  assert.match(text, /Codex 登录 \| 等待授权/);
  assert.match(text, /链接：https:\/\/auth\.openai\.com\/activate\?user_code=ABCD-EFGH/);
  assert.match(text, /验证码：ABCD-EFGH/);
  assert.match(text, /这是全局 Codex 登录/);
  assert.equal(codexAuthManager.startCalls.length, 1);
});

test('/login returns a friendly message when the OpenAI device endpoint is blocked', async () => {
  const codexAuthManager = makeFakeCodexAuthManager({
    startError: new Error('Device login request failed: <!DOCTYPE html><title>Just a moment...</title>'),
  });
  const { runtime } = makeRuntime({ codexAuthManager });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-login-start-blocked',
    text: '/login',
  });

  const text = result.messages.map((message) => message.text ?? '').join('\n');
  assert.match(text, /无法开始 Codex 登录/);
  assert.match(text, /被 Cloudflare 拦截/);
});

test('/login list shows saved Codex accounts and marks the active one', async () => {
  const codexAuthManager = makeFakeCodexAuthManager({
    accounts: [
      { id: 'acct-1', email: 'a@example.com', planType: 'pro' },
      { id: 'acct-2', email: 'b@example.com', planType: 'plus' },
    ],
    activeAccountId: 'acct-2',
  });
  const { runtime } = makeRuntime({ codexAuthManager });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-login-list-1',
    text: '/login list',
  });

  const text = result.messages.map((message) => message.text ?? '').join('\n');
  assert.match(text, /Codex 账号池 \| 2 个账号/);
  assert.match(text, /1\. a@example\.com \| pro/);
  assert.match(text, /2\. b@example\.com \| 当前 \| plus/);
  assert.match(text, /切换：\/login <序号>/);
});

test('/login reports completion when a pending authorization has just finished', async () => {
  const codexAuthManager = makeFakeCodexAuthManager({
    pendingLogin: {
      flowId: 'flow-1',
      verificationUriComplete: 'https://auth.openai.com/activate?user_code=ABCD-EFGH',
      userCode: 'ABCD-EFGH',
      expiresAt: Date.now() + 10_000,
    },
    refreshResults: [
      {
        status: 'completed',
        account: {
          id: 'acct-1',
          email: 'done@example.com',
          planType: 'pro',
        },
      },
    ],
  });
  const { runtime } = makeRuntime({ codexAuthManager });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-login-done-1',
    text: '/login',
  });

  const text = result.messages.map((message) => message.text ?? '').join('\n');
  assert.match(text, /Codex 登录已完成，并已保存到本机/);
  assert.match(text, /账号：done@example\.com/);
  assert.match(text, /套餐：pro/);
});

test('/login 1 switches the active Codex account and reconnects native providers', async () => {
  const codexAuthManager = makeFakeCodexAuthManager({
    accounts: [
      { id: 'acct-1', email: 'a@example.com', planType: 'pro' },
      { id: 'acct-2', email: 'b@example.com', planType: 'plus' },
    ],
    activeAccountId: 'acct-2',
  });
  const { runtime, openai } = makeRuntime({ codexAuthManager });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-login-switch-1',
    text: '/login 1',
  });

  const text = result.messages.map((message) => message.text ?? '').join('\n');
  assert.match(text, /Codex 登录账号已切换/);
  assert.match(text, /账号：a@example\.com/);
  assert.match(text, /已写入：\/tmp\/\.codex\/auth\.json/);
  assert.match(text, /已自动刷新 access token/);
  assert.match(text, /已刷新 1 个 OpenAI Native Codex 会话/);
  assert.equal(codexAuthManager.state.activeAccountId, 'acct-1');
  assert.equal(openai.reconnectProfileCalls.length, 1);
});

test('/login 1 is blocked when any active turn is still running', async () => {
  const codexAuthManager = makeFakeCodexAuthManager({
    accounts: [
      { id: 'acct-1', email: 'a@example.com', planType: 'pro' },
    ],
    activeAccountId: 'acct-1',
  });
  const { runtime } = makeRuntime({ codexAuthManager });
  runtime.services.activeTurns.beginScopeTurn({
    platform: 'weixin',
    externalScopeId: 'wx-user-login-busy-other',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-login-busy-current',
    text: '/login 1',
  });

  const text = result.messages.map((message) => message.text ?? '').join('\n');
  assert.match(text, /暂时不能切换全局登录账号/);
  assert.equal(codexAuthManager.switchCalls.length, 0);
});

test('/instructions shows current content, stages inline set, and applies it on ok', async () => {
  const codexInstructionsManager = makeFakeCodexInstructionsManager({
    content: 'Always explain tradeoffs first.\n',
    exists: true,
  });
  const { runtime, openai, minimax } = makeRuntime({ codexInstructionsManager });

  const status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-instructions-1',
    text: '/instructions',
  });
  const statusText = status.messages.map((message) => message.text ?? '').join('\n');
  assert.match(statusText, /当前自定义指令：开启/);
  assert.match(statusText, /Always explain tradeoffs first\./);

  const saved = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-instructions-1',
    text: '/instructions set Prefer concise final answers.',
  });
  const savedText = saved.messages.map((message) => message.text ?? '').join('\n');
  assert.match(savedText, /已生成自定义指令修改草案/);
  assert.match(savedText, /确认：\/instructions ok/);
  assert.equal(codexInstructionsManager.state.content, 'Always explain tradeoffs first.\n');
  assert.equal(openai.reconnectProfileCalls.length, 0);
  assert.equal(minimax.reconnectProfileCalls.length, 0);

  const confirmed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-instructions-1',
    text: '/instructions ok',
  });
  const confirmedText = confirmed.messages.map((message) => message.text ?? '').join('\n');
  assert.match(confirmedText, /自定义指令已更新/);
  assert.match(confirmedText, /已刷新 2 个 Codex 会话/);
  assert.equal(codexInstructionsManager.state.content, 'Prefer concise final answers.\n');
  assert.equal(openai.reconnectProfileCalls.length, 1);
  assert.equal(minimax.reconnectProfileCalls.length, 1);
});

test('/instructions edit capture and clear both require confirmation before mutating AGENTS.md', async () => {
  const codexInstructionsManager = makeFakeCodexInstructionsManager();
  const { runtime } = makeRuntime({ codexInstructionsManager });

  const armed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-instructions-2',
    text: '/instructions edit',
  });
  assert.match(armed.messages[0]?.text ?? '', /已进入自定义指令编辑模式/);

  const captured = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-instructions-2',
    text: 'Line 1\nLine 2',
  });
  const capturedText = captured.messages.map((message) => message.text ?? '').join('\n');
  assert.match(capturedText, /已生成自定义指令修改草案/);
  assert.match(capturedText, /Line 1/);
  assert.equal(codexInstructionsManager.state.content, '');

  const confirmedDraft = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-instructions-2',
    text: '/instructions ok',
  });
  assert.match(confirmedDraft.messages[0]?.text ?? '', /自定义指令已更新/);
  assert.equal(codexInstructionsManager.state.content, 'Line 1\nLine 2\n');

  const cleared = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-instructions-2',
    text: '/instructions clear',
  });
  const clearedText = cleared.messages.map((message) => message.text ?? '').join('\n');
  assert.match(clearedText, /已生成自定义指令修改草案/);
  assert.match(clearedText, /类型：清空/);
  assert.equal(codexInstructionsManager.state.exists, true);

  const confirmedClear = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-instructions-2',
    text: '/instructions ok',
  });
  assert.match(confirmedClear.messages[0]?.text ?? '', /自定义指令已清空/);
  assert.equal(codexInstructionsManager.state.exists, false);
});

test('/instructions skill-based drafts can be edited before confirmation and ok is blocked while an active turn is running', async () => {
  const codexInstructionsManager = makeFakeCodexInstructionsManager({
    content: '# AGENTS\n- Keep answers concise.\n',
    exists: true,
  });
  const { runtime, openai } = makeRuntime({ codexInstructionsManager });
  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (params: any) => {
    const parserInput = normalizeCommandSkillInput(params?.inputText);
    if (parserInput.includes('docs/command-skills/instructions.md') && parserInput.includes('"subcommand": "natural"')) {
      assert.match(parserInput, /"currentInstructions"/);
      return {
        outputText: JSON.stringify({
          schemaVersion: 'codexbridge.instructions-command-skill.v1',
          ok: true,
          action: 'propose_patch',
          confidence: 0.96,
          requiresConfirmation: true,
          summary: '补充中文微信文本回复规则。',
          changes: ['新增默认中文微信文本回复', '保持简短'],
          proposedContent: '# AGENTS\n- Keep answers concise.\n- Default to Chinese text replies on WeChat.\n',
        }),
      };
    }
    if (parserInput.includes('docs/command-skills/instructions.md') && parserInput.includes('"subcommand": "edit"')) {
      assert.match(parserInput, /"pendingDraft"/);
      return {
        outputText: JSON.stringify({
          schemaVersion: 'codexbridge.instructions-command-skill.v1',
          ok: true,
          action: 'update_pending_draft',
          confidence: 0.91,
          requiresConfirmation: true,
          proposalKind: 'patch',
          summary: '在草案中继续补充附件限制。',
          changes: ['补充不主动发送附件'],
          proposedContent: '# AGENTS\n- Keep answers concise.\n- Default to Chinese text replies on WeChat.\n- Do not send attachments unless the user explicitly asks.\n',
        }),
      };
    }
    return originalStartTurn(params);
  };

  const drafted = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-instructions-busy',
    text: '/instructions 把中文微信文本回复规则加进去',
  });
  const draftedText = drafted.messages.map((message) => message.text ?? '').join('\n');
  assert.match(draftedText, /补充中文微信文本回复规则/);
  assert.equal(codexInstructionsManager.state.content, '# AGENTS\n- Keep answers concise.\n');

  const edited = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-instructions-busy',
    text: '/instructions edit 再加一句不要主动发送附件',
  });
  const editedText = edited.messages.map((message) => message.text ?? '').join('\n');
  assert.match(editedText, /在草案中继续补充附件限制/);
  assert.match(editedText, /Do not send attachments unless the user explicitly asks/);

  runtime.services.activeTurns.beginScopeTurn({
    platform: 'weixin',
    externalScopeId: 'wx-user-some-running-turn',
  });
  const blocked = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-instructions-busy',
    text: '/instructions ok',
  });
  assert.match(blocked.messages[0]?.text ?? '', /暂时不能修改全局自定义指令/);
  assert.equal(codexInstructionsManager.state.content, '# AGENTS\n- Keep answers concise.\n');
});

test('/instructions ok is blocked while any active turn is running even for local clear drafts', async () => {
  const codexInstructionsManager = makeFakeCodexInstructionsManager();
  const { runtime } = makeRuntime({ codexInstructionsManager });
  runtime.services.activeTurns.beginScopeTurn({
    platform: 'weixin',
    externalScopeId: 'wx-user-instructions-busy',
  });

  const drafted = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-instructions-3',
    text: '/instructions clear',
  });
  assert.match(drafted.messages[0]?.text ?? '', /已生成自定义指令修改草案/);

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-instructions-3',
    text: '/instructions clear',
  });

  assert.match(result.messages[0]?.text ?? '', /已生成自定义指令修改草案/);
  const confirm = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-instructions-3',
    text: '/instructions ok',
  });
  assert.match(confirm.messages[0]?.text ?? '', /暂时不能修改全局自定义指令/);
  assert.equal(codexInstructionsManager.clears, 0);
});

test('/uploads starts upload mode and persists batch state without starting a turn', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-uploads-cwd-'));
  const { runtime, openai } = makeRuntime({ defaultCwd });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-1',
    text: '/uploads',
  });

  const joined = result.messages.map((message) => message.text ?? '').join('\n');
  assert.match(joined, /已进入上传模式/);
  assert.match(joined, /查看：\/up status/);
  assert.equal(openai.startTurnCalls.length, 0);

  const session = runtime.services.bridgeSessions.resolveScopeSession({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-1',
  });
  const settings = runtime.services.bridgeSessions.getSessionSettings(session.id);
  const uploadsState = settings?.metadata?.uploads as any;
  assert.equal(uploadsState?.active, true);
});

test('/uploads stages files, exposes status, and waits for text before starting a turn', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-uploads-stage-'));
  const sourceFile = createTempAttachment('diagram.png', 'png-data');
  const { runtime, openai } = makeRuntime({ defaultCwd });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-2',
    text: '/up',
  });

  const staged = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-2',
    text: '',
    attachments: [
      {
        kind: 'image',
        localPath: sourceFile,
        fileName: 'diagram.png',
        mimeType: 'image/png',
      },
    ],
  });

  const stagedText = staged.messages.map((message) => message.text ?? '').join('\n');
  assert.match(stagedText, /已暂存 1 个文件/);
  assert.equal(openai.startTurnCalls.length, 0);

  const status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-2',
    text: '/up status',
  });
  const statusText = status.messages.map((message) => message.text ?? '').join('\n');
  assert.match(statusText, /上传暂存 \| 1 个文件/);
  assert.match(statusText, /diagram\.png/);
  assert.match(statusText, /\.codexbridge[\\/]uploads[\\/]/);
});

test('/uploads submits staged files together with the next text prompt and clears staged state', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-uploads-submit-'));
  const sourceFile = createTempAttachment('report.pdf', 'pdf-data');
  const { runtime, openai } = makeRuntime({ defaultCwd });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-3',
    text: '/uploads',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-3',
    text: '',
    attachments: [
      {
        kind: 'file',
        localPath: sourceFile,
        fileName: 'report.pdf',
        mimeType: 'application/pdf',
      },
    ],
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-3',
    text: '请根据资料总结重点',
  });

  assert.match(result.messages[0]?.text ?? '', /openai: 请根据资料总结重点/);
  assert.equal(openai.startTurnCalls.length, 1);
  assert.equal(openai.startTurnCalls[0]?.inputText, '请根据资料总结重点');
  assert.equal(openai.startTurnCalls[0]?.event?.attachments?.length, 1);
  assert.match(openai.startTurnCalls[0]?.event?.attachments?.[0]?.localPath ?? '', /\.codexbridge[\\/]uploads[\\/]/);

  const session = runtime.services.bridgeSessions.resolveScopeSession({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-3',
  });
  const settings = runtime.services.bridgeSessions.getSessionSettings(session.id);
  assert.equal((settings?.metadata?.uploads as any) ?? null, null);
});

test('/uploads can be finalized by a voice attachment transcript when no text is present', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-uploads-voice-'));
  const sourceFile = createTempAttachment('sheet.xlsx', 'xlsx-data');
  const voiceFile = createTempAttachment('note.m4a', 'voice-data');
  const { runtime, openai } = makeRuntime({ defaultCwd });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-4',
    text: '/ul',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-4',
    text: '',
    attachments: [
      {
        kind: 'file',
        localPath: sourceFile,
        fileName: 'sheet.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    ],
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-4',
    text: '',
    attachments: [
      {
        kind: 'voice',
        localPath: voiceFile,
        fileName: 'note.m4a',
        mimeType: 'audio/mp4',
        transcriptText: '请结合这些文件说明差异',
        durationSeconds: 8,
      },
    ],
  });

  assert.equal(openai.startTurnCalls.length, 1);
  assert.equal(openai.startTurnCalls[0]?.inputText, '请结合这些文件说明差异');
  assert.equal(openai.startTurnCalls[0]?.event?.attachments?.length, 2);
});

test('/uploads cancel clears the staged batch', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-uploads-cancel-'));
  const sourceFile = createTempAttachment('clip.mp4', 'video-data');
  const { runtime } = makeRuntime({ defaultCwd });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-5',
    text: '/uploads',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-5',
    text: '',
    attachments: [
      {
        kind: 'video',
        localPath: sourceFile,
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
      },
    ],
  });

  const cancelled = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-5',
    text: '/up cancel',
  });
  const cancelText = cancelled.messages.map((message) => message.text ?? '').join('\n');
  assert.match(cancelText, /已取消上传模式/);
  assert.match(cancelText, /已清空 1 个暂存文件/);

  const status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-uploads-5',
    text: '/up status',
  });
  assert.equal(status.messages[0]?.text ?? '', '当前没有进行中的上传暂存。先发送 /uploads。');
});

test('/log saves and lists assistant log records', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-log-'));
  const { runtime } = makeRuntime({ defaultCwd });

  const saved = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-assistant-log-1',
    text: '/log 今天测试微信桥接，发现插件搜索需要更高相关度 #CodexBridge',
  });

  const savedText = saved.messages.map((message) => message.text ?? '').join('\n');
  assert.match(savedText, /助理记录待确认/);
  assert.match(savedText, /类型：日志/);
  assert.match(savedText, /确认：\/log ok/);

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-assistant-log-1',
    text: '/log ok',
  });

  const list = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-assistant-log-1',
    text: '/log',
  });
  const listText = list.messages.map((message) => message.text ?? '').join('\n');
  assert.match(listText, /助理记录 \| 日志/);
  assert.match(listText, /CodexBridge/);

  const records = runtime.repositories.assistantRecords.list();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.type, 'log');
  assert.deepEqual(records[0]?.tags, ['CodexBridge']);
});

test('/log uses model normalization and rewrites relative dates to absolute local dates', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-log-relative-'));
  const fixedNow = Date.UTC(2026, 3, 29, 9, 30, 0);
  const originalDateNow = Date.now;
  Date.now = () => fixedNow;
  try {
    const { runtime, openai } = makeRuntime({ defaultCwd });
    const originalStartTurn = openai.startTurn.bind(openai);
    openai.startTurn = async (args: any) => {
      openai.startTurnCalls.push(args);
      if (normalizeCommandSkillInput(args.inputText).includes('docs/command-skills/assistant-record.md') && normalizeCommandSkillInput(args.inputText).includes('"operation": "classify_new_record"')) {
        return {
          outputText: JSON.stringify({
            type: 'log',
            title: '昨天完成了停机坪的报价以及工程量的测算',
            content: '昨天完成了停机坪的报价以及工程量的测算',
            priority: 'normal',
            dueAt: null,
            remindAt: null,
            recurrence: null,
            project: null,
            tags: [],
            confidence: 0.91,
          }),
          turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
          threadId: args.bridgeSession.codexThreadId,
          title: args.bridgeSession.title,
        };
      }
      return originalStartTurn(args);
    };

    const saved = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-user-assistant-log-relative-1',
      text: '/log 昨天完成了停机坪的报价以及工程量的测算',
      metadata: {
        timezone: 'Etc/UTC',
      },
    });

    const savedText = saved.messages.map((message) => message.text ?? '').join('\n');
    assert.match(savedText, /助理记录待确认/);
    assert.match(savedText, /类型：日志/);
    assert.doesNotMatch(savedText, /标题：昨天完成了停机坪的报价以及工程量的测算/);
    assert.match(savedText, /内容：\n2026-04-28 UTC 完成了停机坪的报价以及工程量的测算/);

    const record = runtime.repositories.assistantRecords.list()[0];
    assert.equal(record?.type, 'log');
    assert.equal(record?.parsedJson?.normalizer, 'codex');
    assert.match(record?.title ?? '', /停机坪的报价以及工程量的测算/);
    assert.match(record?.content ?? '', /2026-04-28 UTC/);
    assert.doesNotMatch(record?.content ?? '', /昨天/);
    assert.ok(openai.startTurnCalls.some((call: any) => normalizeCommandSkillInput(call.inputText).includes('docs/command-skills/assistant-record.md') && normalizeCommandSkillInput(call.inputText).includes('"operation": "classify_new_record"')));
  } finally {
    Date.now = originalDateNow;
  }
});

test('/as uses Codex classification for required same-day work instead of local keyword rules', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-work-todo-'));
  const fixedNow = Date.UTC(2026, 3, 29, 9, 30, 0);
  const originalDateNow = Date.now;
  Date.now = () => fixedNow;
  try {
    const { runtime, openai } = makeRuntime({ defaultCwd });
    const originalStartTurn = openai.startTurn.bind(openai);
    openai.startTurn = async (args: any) => {
      openai.startTurnCalls.push(args);
      if (normalizeCommandSkillInput(args.inputText).includes('docs/command-skills/assistant-record.md') && normalizeCommandSkillInput(args.inputText).includes('"operation": "route_existing_record"')) {
        return {
          outputText: JSON.stringify({
            action: 'create',
            targetRecordId: null,
            targetIndex: null,
            type: 'reminder',
            reason: '用户描述的是邦杜库第四期签字版账单这个新提醒，不是已有的助理贝亚发票待办。',
            confidence: 0.96,
          }),
          turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
          threadId: args.bridgeSession.codexThreadId,
          title: args.bridgeSession.title,
        };
      }
      if (normalizeCommandSkillInput(args.inputText).includes('docs/command-skills/assistant-record.md') && normalizeCommandSkillInput(args.inputText).includes('"operation": "classify_new_record"')) {
        return {
          outputText: JSON.stringify({
            type: 'todo',
            title: '停机坪成本和报价测算',
            content: '今天要做停机坪的测算，包括成本和报价测算。这项工作今天必须做完。',
            priority: 'high',
            dueAt: null,
            remindAt: null,
            recurrence: null,
            project: null,
            tags: [],
            confidence: 0.94,
          }),
          turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
          threadId: args.bridgeSession.codexThreadId,
          title: args.bridgeSession.title,
        };
      }
      return originalStartTurn(args);
    };

    const saved = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-user-assistant-work-todo-1',
      text: '/as 今天要做停机坪的一个测算，包括成本和报价测算。这项工作今天必须做完，请把它提成一个比较高的优先级，给我列出来。',
    });

    const savedText = saved.messages.map((message) => message.text ?? '').join('\n');
    assert.match(savedText, /助理记录待确认/);
    assert.match(savedText, /类型：待办/);
    assert.match(savedText, /标题：停机坪成本和报价测算/);

    const record = runtime.repositories.assistantRecords.list()[0];
    const expectedToday = new Date(fixedNow).toISOString().slice(0, 10);
    assert.equal(record?.type, 'todo');
    assert.equal(record?.priority, 'high');
    assert.equal(record?.status, 'pending');
    assert.equal(record?.parsedJson?.normalizer, 'codex');
    assert.match(record?.content ?? '', /停机坪的测算/);
    assert.match(record?.content ?? '', new RegExp(`${expectedToday} UTC 必须做完`));
    assert.doesNotMatch(record?.content ?? '', /今天必须做完/);
    assert.doesNotMatch(record?.content ?? '', /给我列出来/);
    assert.doesNotMatch(record?.content ?? '', /高的优先级/);
    assert.ok(openai.startTurnCalls.some((call: any) => normalizeCommandSkillInput(call.inputText).includes('docs/command-skills/assistant-record.md') && normalizeCommandSkillInput(call.inputText).includes('"operation": "classify_new_record"')));
  } finally {
    Date.now = originalDateNow;
  }
});

test('/as creates a pending reminder and confirms it', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-remind-'));
  const { runtime } = makeRuntime({ defaultCwd });

  const draft = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-assistant-remind-1',
    text: '/as 明天上午10点提醒我给王总回电话',
  });
  const draftText = draft.messages.map((message) => message.text ?? '').join('\n');
  assert.match(draftText, /助理记录待确认/);
  assert.match(draftText, /类型：提醒/);
  assert.match(draftText, /确认：\/as ok/);

  const pending = runtime.repositories.assistantRecords.list()[0];
  assert.equal(pending?.status, 'pending');
  assert.equal(pending?.type, 'reminder');
  assert.equal(typeof pending?.remindAt, 'number');

  const confirmed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-assistant-remind-1',
    text: '/as ok',
  });
  const confirmedText = confirmed.messages.map((message) => message.text ?? '').join('\n');
  assert.match(confirmedText, /助理记录已保存/);

  const active = runtime.repositories.assistantRecords.list()[0];
  assert.equal(active?.status, 'active');
  assert.equal(active?.parseStatus, 'confirmed');
});

test('/as edit modifies the pending assistant record instead of replacing it', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-edit-'));
  const { runtime } = makeRuntime({ defaultCwd });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-assistant-edit-1',
    text: '/as 明天上午10点提醒我给王总回电话 #客户',
  });
  const before = runtime.repositories.assistantRecords.list()[0];
  assert.equal(before?.type, 'reminder');
  assert.match(before?.content ?? '', /王总/);

  const edited = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-assistant-edit-1',
    text: '/as edit 把王总改成李总，时间改成明天上午11点，加 #重要客户',
  });

  const editedText = edited.messages.map((message) => message.text ?? '').join('\n');
  assert.match(editedText, /助理记录待确认/);
  assert.match(editedText, /李总/);

  const after = runtime.repositories.assistantRecords.list()[0];
  assert.equal(after?.id, before?.id);
  assert.equal(after?.type, 'reminder');
  assert.equal(after?.status, 'pending');
  assert.match(after?.content ?? '', /提醒时间：\d{4}-\d{2}-\d{2} 11:00 UTC/);
  assert.match(after?.content ?? '', /李总/);
  assert.doesNotMatch(after?.content ?? '', /王总/);
  assert.doesNotMatch(after?.content ?? '', /明天上午11点/);
  assert.equal(new Date(after?.remindAt ?? 0).getHours(), 11);
  assert.deepEqual(after?.tags, ['客户', '重要客户']);
  assert.match(after?.originalText ?? '', /修改提示/);
});

test('/todo edit rewrites the pending todo through the assistant record command skill', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-todo-edit-skill-'));
  const { runtime, openai } = makeRuntime({ defaultCwd });
  const scopeId = 'wx-user-assistant-todo-edit-skill-1';
  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (args: any) => {
    openai.startTurnCalls.push(args);
    const input = normalizeCommandSkillInput(args.inputText);
    if (input.includes('docs/command-skills/assistant-record.md') && input.includes('"operation": "classify_new_record"')) {
      return {
        outputText: JSON.stringify({
          operation: 'classify_new_record',
          type: 'todo',
          title: '整理 CodexBridge 视频脚本',
          content: '下周五前整理 CodexBridge 视频脚本。',
          priority: 'normal',
          dueAt: '2026-05-08T23:59:00.000Z',
          remindAt: null,
          recurrence: null,
          project: null,
          tags: ['视频'],
          confidence: 0.5,
        }),
        turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
        threadId: args.bridgeSession.codexThreadId,
        title: args.bridgeSession.title,
      };
    }
    if (input.includes('docs/command-skills/assistant-record.md') && input.includes('"operation": "rewrite_record"')) {
      assert.match(input, /"command": "todo"/);
      assert.match(input, /"forcedType": "todo"/);
      assert.match(input, /"subcommand": "edit"/);
      return {
        outputText: JSON.stringify({
          operation: 'rewrite_record',
          action: 'update',
          type: 'todo',
          title: '整理 CodexBridge 视频脚本',
          content: '下周五前整理 CodexBridge 视频脚本，并补充口播提纲。',
          status: 'pending',
          priority: 'high',
          dueAt: '2026-05-08T23:59:00.000Z',
          remindAt: null,
          recurrence: null,
          project: null,
          tags: ['视频'],
          changeSummary: '补充口播提纲并提高优先级。',
          confidence: 0.94,
        }),
        turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
        threadId: args.bridgeSession.codexThreadId,
        title: args.bridgeSession.title,
      };
    }
    return originalStartTurn(args);
  };

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/todo 下周五前整理 CodexBridge 视频脚本 #视频',
  });
  const before = runtime.repositories.assistantRecords.list()[0];
  assert.equal(before?.type, 'todo');
  assert.equal(before?.status, 'pending');

  const edited = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/todo edit 补充口播提纲，并把优先级调高',
  });

  const editedText = edited.messages.map((message) => message.text ?? '').join('\n');
  assert.match(editedText, /助理记录待确认/);
  assert.match(editedText, /补充口播提纲/);

  const after = runtime.repositories.assistantRecords.list()[0];
  assert.equal(after?.id, before?.id);
  assert.equal(after?.type, 'todo');
  assert.equal(after?.status, 'pending');
  assert.equal(after?.priority, 'high');
  assert.match(after?.content ?? '', /口播提纲/);
  assert.deepEqual(after?.tags, ['视频']);
  const lastNaturalAction = after?.parsedJson?.lastNaturalAction as any;
  assert.equal(lastNaturalAction?.parser, 'codex-assistant-record-rewrite');
});

test('/todo natural language manages an existing todo through the assistant record command skill before confirmation', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-todo-natural-route-'));
  const { runtime, openai } = makeRuntime({ defaultCwd });
  const scopeId = 'wx-user-assistant-todo-natural-route-1';
  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (args: any) => {
    openai.startTurnCalls.push(args);
    const input = normalizeCommandSkillInput(args.inputText);
    if (input.includes('docs/command-skills/assistant-record.md') && input.includes('"operation": "classify_new_record"')) {
      return {
        outputText: JSON.stringify({
          operation: 'classify_new_record',
          type: 'todo',
          title: '跟踪丹达第四期发票提交',
          content: '跟踪丹达第四期发票提交。',
          priority: 'normal',
          dueAt: null,
          remindAt: null,
          recurrence: null,
          project: null,
          tags: [],
          confidence: 0.94,
        }),
        turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
        threadId: args.bridgeSession.codexThreadId,
        title: args.bridgeSession.title,
      };
    }
    if (input.includes('docs/command-skills/assistant-record.md') && input.includes('"operation": "route_existing_record"')) {
      assert.match(input, /"command": "todo"/);
      assert.match(input, /"forcedType": "todo"/);
      assert.match(input, /"index": 1/);
      return {
        outputText: JSON.stringify({
          operation: 'route_existing_record',
          action: 'update',
          targetRecordId: null,
          targetIndex: 1,
          type: 'todo',
          reason: '用户要把第一条已有待办的状态改为进行中。',
          confidence: 0.96,
        }),
        turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
        threadId: args.bridgeSession.codexThreadId,
        title: args.bridgeSession.title,
      };
    }
    if (input.includes('docs/command-skills/assistant-record.md') && input.includes('"operation": "rewrite_record"')) {
      assert.match(input, /"command": "todo"/);
      assert.match(input, /"forcedType": "todo"/);
      return {
        outputText: JSON.stringify({
          operation: 'rewrite_record',
          action: 'update',
          type: 'todo',
          title: '跟踪丹达第四期发票提交',
          content: '跟踪丹达第四期发票提交。',
          status: 'active',
          priority: 'normal',
          dueAt: null,
          remindAt: null,
          recurrence: null,
          project: null,
          tags: [],
          changeSummary: '将第一条待办状态改为进行中。',
          confidence: 0.94,
        }),
        turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
        threadId: args.bridgeSession.codexThreadId,
        title: args.bridgeSession.title,
      };
    }
    return originalStartTurn(args);
  };

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/todo 跟踪丹达第四期发票提交',
  });
  const pending = runtime.repositories.assistantRecords.list()[0];
  assert.equal(pending?.status, 'pending');

  const draft = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/todo 目前已有的第一条待办的状态修改为进行中',
  });
  const draftText = draft.messages.map((message) => message.text ?? '').join('\n');
  assert.match(draftText, /找到可能相关的助理记录/);
  assert.match(draftText, /匹配记录：跟踪丹达第四期发票提交/);
  assert.match(draftText, /动作：更新内容/);
  assert.match(draftText, /状态：进行中/);
  assert.match(draftText, /确认：\/todo ok/);
  assert.doesNotMatch(draftText, /助理记录已保存/);

  const unchanged = runtime.repositories.assistantRecords.list()[0];
  assert.equal(unchanged?.status, 'pending');

  const confirmed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/todo ok',
  });
  const confirmedText = confirmed.messages.map((message) => message.text ?? '').join('\n');
  assert.match(confirmedText, /助理记录已更新/);
  assert.match(confirmedText, /状态：进行中/);
  assert.match(confirmedText, /查看：\/todo show 1/);

  const after = runtime.repositories.assistantRecords.list()[0];
  assert.equal(after?.status, 'active');
  assert.equal(after?.type, 'todo');
});

test('/as strips assistant-only instructions and shows full organized content', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-invoice-'));
  const { runtime } = makeRuntime({ defaultCwd });
  const text = [
    '/as 助理贝亚 现在还欠我3张发票。关于要拿回来的发票，情况如下：',
    '',
    '1. 之前有一个被退回去的发票',
    '2. 我这个医药的发票（不知道有没有）',
    '3. 修马桶的发票',
    '',
    '应该是这三张发票，你帮我整理一下，看看放哪里比较合适，我之后还得记一下',
  ].join('\n');

  const pending = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-assistant-invoice-1',
    text,
  });

  const pendingText = pending.messages.map((message) => message.text ?? '').join('\n');
  assert.match(pendingText, /标题：助理贝亚待取回 3 张发票/);
  assert.match(pendingText, /内容：\n助理贝亚 现在还欠我3张发票/);
  assert.match(pendingText, /1\. 之前有一个被退回去的发票/);
  assert.match(pendingText, /3\. 修马桶的发票/);
  assert.doesNotMatch(pendingText, /你帮我整理一下/);
  assert.doesNotMatch(pendingText, /…/);

  const record = runtime.repositories.assistantRecords.list()[0];
  assert.equal(record?.type, 'todo');
  assert.equal(record?.title, '助理贝亚待取回 3 张发票');
  assert.doesNotMatch(record?.content ?? '', /看看放哪里比较合适/);
  assert.doesNotMatch(record?.content ?? '', /我之后还得记一下/);
  assert.equal(record?.parsedJson?.strippedAssistantInstruction, true);

  const confirmed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-assistant-invoice-1',
    text: '/as ok',
  });
  const confirmedText = confirmed.messages.map((message) => message.text ?? '').join('\n');
  assert.match(confirmedText, /助理记录已保存/);
  assert.match(confirmedText, /内容：\n助理贝亚 现在还欠我3张发票/);
  assert.doesNotMatch(confirmedText, /你帮我整理一下/);
});

test('/as natural language updates a matching assistant record after confirmation', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-natural-update-'));
  const { runtime, openai } = makeRuntime({ defaultCwd });
  const scopeId = 'wx-user-assistant-natural-update-1';
  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (args: any) => {
    openai.startTurnCalls.push(args);
    const input = normalizeCommandSkillInput(args.inputText);
    if (input.includes('docs/command-skills/assistant-record.md') && input.includes('"operation": "route_existing_record"')) {
      if (input.includes('完全新的内容')) {
        return {
          outputText: JSON.stringify({
            action: 'create',
            targetRecordId: null,
            targetIndex: null,
            type: 'reminder',
            reason: '用户明确说明这是完全新的提醒，不应更新原 todo。',
            confidence: 0.96,
          }),
          turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
          threadId: args.bridgeSession.codexThreadId,
          title: args.bridgeSession.title,
        };
      }
      return {
        outputText: JSON.stringify({
          action: 'update',
          targetRecordId: null,
          targetIndex: 1,
          type: 'todo',
          reason: '用户说明修马桶发票已经拿回来了，应更新已有发票待办。',
          confidence: 0.95,
        }),
        turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
        threadId: args.bridgeSession.codexThreadId,
        title: args.bridgeSession.title,
      };
    }
    if (input.includes('docs/command-skills/assistant-record.md') && input.includes('"operation": "rewrite_record"')) {
      return {
        outputText: JSON.stringify({
          action: 'update',
          type: 'todo',
          title: '助理贝亚待取回 3 张发票',
          content: [
            '助理贝亚 现在还欠我3张发票。关于要拿回来的发票，情况如下：',
            '1. 之前有一个被退回去的发票',
            '2. 我这个医药的发票（不知道有没有）',
            '3. 修马桶的发票',
            '补充修改：修马桶发票已经拿回来了',
          ].join('\n'),
          status: 'active',
          priority: 'normal',
          dueAt: null,
          remindAt: null,
          recurrence: null,
          project: null,
          tags: [],
          changeSummary: '补充修改：修马桶发票已经拿回来了',
          confidence: 0.94,
        }),
        turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
        threadId: args.bridgeSession.codexThreadId,
        title: args.bridgeSession.title,
      };
    }
    return originalStartTurn(args);
  };
  const text = [
    '/as 助理贝亚 现在还欠我3张发票。关于要拿回来的发票，情况如下：',
    '1. 之前有一个被退回去的发票',
    '2. 我这个医药的发票（不知道有没有）',
    '3. 修马桶的发票',
  ].join('\n');

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text,
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/as ok',
  });

  const before = runtime.repositories.assistantRecords.list()[0];
  assert.equal(before?.status, 'active');
  assert.doesNotMatch(before?.content ?? '', /修马桶发票已经拿回来了/);

  const draft = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/as 修马桶发票已经拿回来了',
  });
  const draftText = draft.messages.map((message) => message.text ?? '').join('\n');
  assert.match(draftText, /找到可能相关的助理记录/);
  assert.match(draftText, /匹配记录：助理贝亚待取回 3 张发票/);
  assert.match(draftText, /动作：更新内容/);
  assert.match(draftText, /补充修改：修马桶发票已经拿回来了/);
  assert.match(draftText, /确认：\/as ok/);

  const unchanged = runtime.repositories.assistantRecords.list()[0];
  assert.doesNotMatch(unchanged?.content ?? '', /修马桶发票已经拿回来了/);

  const confirmed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/as ok',
  });
  const confirmedText = confirmed.messages.map((message) => message.text ?? '').join('\n');
  assert.match(confirmedText, /助理记录已更新/);
  assert.match(confirmedText, /补充修改：修马桶发票已经拿回来了/);

  const after = runtime.repositories.assistantRecords.list()[0];
  assert.equal(after?.status, 'active');
  assert.match(after?.content ?? '', /修马桶发票已经拿回来了/);
});

test('/as explicit create wording does not match an existing assistant record', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-explicit-create-'));
  const { runtime } = makeRuntime({ defaultCwd });
  const scopeId = 'wx-user-assistant-explicit-create-1';

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/todo 阿尼比莱克鲁第二期账单发票下午要做',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/as 新增一个待办：阿尼比莱克鲁第二张单下午要做',
  });

  const text = result.messages.map((message) => message.text ?? '').join('\n');
  assert.doesNotMatch(text, /找到可能相关的助理记录/);
  assert.match(text, /助理记录待确认/);

  const records = runtime.repositories.assistantRecords.list();
  assert.equal(records.length, 2);
  assert.equal(records[1]?.type, 'todo');
  assert.match(records[1]?.content ?? '', /阿尼比莱克鲁第二张单下午要做/);
});

test('/as reminder wording creates a new reminder instead of merging into an unrelated invoice todo', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-reminder-create-'));
  const { runtime, openai } = makeRuntime({ defaultCwd });
  const scopeId = 'wx-user-assistant-reminder-create-1';
  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (args: any) => {
    openai.startTurnCalls.push(args);
    if (normalizeCommandSkillInput(args.inputText).includes('docs/command-skills/assistant-record.md') && normalizeCommandSkillInput(args.inputText).includes('"operation": "classify_new_record"')) {
      return {
        outputText: JSON.stringify({
          type: 'reminder',
          title: '提醒跟进邦杜库第四期签字版账单',
          content: '邦杜库第四期账单和发票已经收到，但账单缺少签字；已发回给业主，等待对方重新发送签字版。收到签字版后才能开始做发票。',
          priority: 'normal',
          dueAt: null,
          remindAt: '2026-04-28T11:00:00.000Z',
          recurrence: null,
          project: null,
          tags: [],
          confidence: 0.95,
        }),
        turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
        threadId: args.bridgeSession.codexThreadId,
        title: args.bridgeSession.title,
      };
    }
    return originalStartTurn(args);
  };

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/todo 助理贝亚还有 2 张发票需要处理：墨盒发票和马桶发票',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: [
      '/as 邦杜库第四期的账单和发票已经发过来了，但账单上缺少签字。我已经给业主发回去了，目前还在等待他们再次发送过来。',
      '我们需要等签字版发送过来之后，才能开始做发票。现在帮多库第四期就是这么一个情况。',
      '所以说，这个事情现在把它设置为一个提醒（remind）吧，明天早上 11:00 提醒我一下，好吧。',
    ].join('\n'),
  });

  const text = result.messages.map((message) => message.text ?? '').join('\n');
  assert.doesNotMatch(text, /找到可能相关的助理记录/);
  assert.match(text, /助理记录待确认/);
  assert.match(text, /类型：提醒/);
  assert.match(text, /提醒跟进邦杜库第四期签字版账单/);

  const records = runtime.repositories.assistantRecords.list();
  assert.equal(records.length, 2);
  assert.equal(records[0]?.type, 'todo');
  assert.equal(records[1]?.type, 'reminder');
  assert.equal(records[1]?.status, 'pending');
  assert.equal(records[1]?.parsedJson?.normalizer, 'codex');
  assert.match(records[1]?.content ?? '', /邦杜库第四期/);
  assert.doesNotMatch(records[1]?.content ?? '', /墨盒发票/);
  assert.ok(openai.startTurnCalls.some((call: any) => normalizeCommandSkillInput(call.inputText).includes('docs/command-skills/assistant-record.md') && normalizeCommandSkillInput(call.inputText).includes('"operation": "route_existing_record"')));
});

test('/as edit can abandon a wrong update draft and create a new reminder', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-edit-create-'));
  const { runtime, openai } = makeRuntime({ defaultCwd });
  const scopeId = 'wx-user-assistant-edit-create-1';
  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (args: any) => {
    openai.startTurnCalls.push(args);
    const input = normalizeCommandSkillInput(args.inputText);
    if (input.includes('docs/command-skills/assistant-record.md') && input.includes('"operation": "route_existing_record"')) {
      if (input.includes('完全新的内容')) {
        return {
          outputText: JSON.stringify({
            action: 'create',
            targetRecordId: null,
            targetIndex: null,
            type: 'reminder',
            reason: '用户明确说明这是完全新的提醒，不应更新原 todo。',
            confidence: 0.96,
          }),
          turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
          threadId: args.bridgeSession.codexThreadId,
          title: args.bridgeSession.title,
        };
      }
      return {
        outputText: JSON.stringify({
          action: 'update',
          targetRecordId: null,
          targetIndex: 1,
          type: 'todo',
          reason: '用户说修马桶发票已经拿回来了，应更新已有发票待办。',
          confidence: 0.95,
        }),
        turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
        threadId: args.bridgeSession.codexThreadId,
        title: args.bridgeSession.title,
      };
    }
    if (input.includes('docs/command-skills/assistant-record.md') && input.includes('"operation": "rewrite_record"')) {
      return {
        outputText: JSON.stringify({
          action: 'update',
          type: 'todo',
          title: '助理贝亚待处理发票',
          content: '助理贝亚还有 2 张发票需要处理：墨盒发票和马桶发票。\n补充修改：修马桶发票已经拿回来了',
          status: 'pending',
          priority: 'normal',
          dueAt: null,
          remindAt: null,
          recurrence: null,
          project: null,
          tags: [],
          changeSummary: '补充修马桶发票已经拿回来了。',
          confidence: 0.94,
        }),
        turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
        threadId: args.bridgeSession.codexThreadId,
        title: args.bridgeSession.title,
      };
    }
    return originalStartTurn(args);
  };

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/todo 助理贝亚还有 2 张发票需要处理：墨盒发票和马桶发票',
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/as 修马桶发票已经拿回来了',
  });

  const fixed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/as edit 我这是一个完全新的内容，跟那个todo完全没一点关系啊。我这是 remind 你，明天早上11点提醒我邦杜库第四期签字版账单。',
  });

  const text = fixed.messages.map((message) => message.text ?? '').join('\n');
  assert.doesNotMatch(text, /找到可能相关的助理记录/);
  assert.match(text, /助理记录待确认/);
  assert.match(text, /类型：提醒/);

  const records = runtime.repositories.assistantRecords.list();
  assert.equal(records.length, 2);
  assert.equal(records[0]?.type, 'todo');
  assert.equal(records[1]?.type, 'reminder');
  assert.equal(records[1]?.status, 'pending');
  assert.match(records[1]?.content ?? '', /邦杜库第四期/);
});

test('/as uses Codex rewrite to merge natural-language edits into the matched assistant record', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-codex-update-'));
  const fixedNow = Date.UTC(2026, 3, 29, 9, 30, 0);
  const originalDateNow = Date.now;
  Date.now = () => fixedNow;
  try {
    const { runtime, openai } = makeRuntime({ defaultCwd });
    const scopeId = 'wx-user-assistant-codex-update-1';
    const originalStartTurn = openai.startTurn.bind(openai);
    openai.startTurn = async (args: any) => {
      openai.startTurnCalls.push(args);
      if (normalizeCommandSkillInput(args.inputText).includes('docs/command-skills/assistant-record.md') && normalizeCommandSkillInput(args.inputText).includes('"operation": "route_existing_record"')) {
        return {
          outputText: JSON.stringify({
            action: 'update',
            targetRecordId: null,
            targetIndex: 1,
            type: 'todo',
            reason: '用户明确要求把原记录里的第二张单修正为第二期账单。',
            confidence: 0.94,
          }),
          turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
          threadId: args.bridgeSession.codexThreadId,
          title: args.bridgeSession.title,
        };
      }
      if (normalizeCommandSkillInput(args.inputText).includes('docs/command-skills/assistant-record.md') && normalizeCommandSkillInput(args.inputText).includes('"operation": "rewrite_record"')) {
        return {
          outputText: JSON.stringify({
            action: 'update',
            type: 'todo',
            title: '阿尼比莱克鲁第二期账单安排',
            content: [
              '阿尼比莱克鲁第二期账单发票下午要做。做好以后，第二期账单也安排在下午处理。',
              '',
              '具体安排：',
              '1. 下午发送给办事处',
              '2. 明天（周二）提交给业主',
            ].join('\n'),
            status: 'active',
            priority: 'normal',
            dueAt: null,
            remindAt: null,
            recurrence: null,
            project: null,
            tags: [],
            changeSummary: '把第二张单更正为第二期账单，并补充发送与提交安排。',
            confidence: 0.93,
          }),
          turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
          threadId: args.bridgeSession.codexThreadId,
          title: args.bridgeSession.title,
        };
      }
      return originalStartTurn(args);
    };

    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: scopeId,
      text: '/todo 阿尼比莱克鲁第二期账单发票下午要做。做好以后，第二张单也安排在下午处理。',
    });
    const before = runtime.repositories.assistantRecords.list()[0];
    assert.match(before?.content ?? '', /第二张单/);

    const draft = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: scopeId,
      text: [
        '/as 内容改一下，不是第二张单，是第二期账单。',
        '',
        '具体安排如下：',
        '1. 下午要发送给办事处',
        '2. 明天（周二）要提交给业主',
        '',
        '这个东西要记一下。',
      ].join('\n'),
    });

    const draftText = draft.messages.map((message) => message.text ?? '').join('\n');
    const expectedTomorrow = new Date(fixedNow + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    assert.match(draftText, /找到可能相关的助理记录/);
    assert.match(draftText, /匹配记录：阿尼比莱克鲁/);
    assert.match(draftText, /修改摘要：把第二张单更正为第二期账单/);
    assert.match(draftText, /内容：\n阿尼比莱克鲁第二期账单发票下午要做/);
    assert.match(draftText, new RegExp(`2\\. ${expectedTomorrow} UTC`));
    assert.doesNotMatch(draftText, /明天（周二）提交给业主/);
    assert.doesNotMatch(draftText, /这个东西要记一下/);
    assert.equal(openai.startTurnCalls.some((call: any) => normalizeCommandSkillInput(call.inputText).includes('docs/command-skills/assistant-record.md') && normalizeCommandSkillInput(call.inputText).includes('"operation": "rewrite_record"')), true);

    const unchanged = runtime.repositories.assistantRecords.list()[0];
    assert.match(unchanged?.content ?? '', /第二张单/);

    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: scopeId,
      text: '/as ok',
    });

    const after = runtime.repositories.assistantRecords.list()[0];
    assert.match(after?.content ?? '', /第二期账单也安排在下午处理/);
    assert.doesNotMatch(after?.content ?? '', /这个东西要记一下/);
  } finally {
    Date.now = originalDateNow;
  }
});

test('/as natural language content update preserves the matched record status', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-update-status-'));
  const { runtime, openai } = makeRuntime({ defaultCwd });
  const scopeId = 'wx-user-assistant-update-status-1';
  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (args: any) => {
    openai.startTurnCalls.push(args);
    const input = normalizeCommandSkillInput(args.inputText);
    if (input.includes('docs/command-skills/assistant-record.md') && input.includes('"operation": "route_existing_record"')) {
      return {
        outputText: JSON.stringify({
          action: 'update',
          targetRecordId: null,
          targetIndex: 1,
          type: 'todo',
          reason: '用户要更新丹达第四期发票提交这条待办。',
          confidence: 0.95,
        }),
        turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
        threadId: args.bridgeSession.codexThreadId,
        title: args.bridgeSession.title,
      };
    }
    if (input.includes('docs/command-skills/assistant-record.md') && input.includes('"operation": "rewrite_record"')) {
      return {
        outputText: JSON.stringify({
          action: 'update',
          type: 'todo',
          title: '确认丹达第四期发票提交',
          content: '确认丹达第四期发票的提交情况',
          status: 'pending',
          priority: 'normal',
          dueAt: null,
          remindAt: null,
          recurrence: null,
          project: null,
          tags: [],
          changeSummary: '将待办从跟踪丹达第四期发票提交改为确认丹达第四期发票提交。',
          confidence: 0.94,
        }),
        turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
        threadId: args.bridgeSession.codexThreadId,
        title: args.bridgeSession.title,
      };
    }
    return originalStartTurn(args);
  };

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/todo 跟踪丹达第四期发票提交',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/todo ok',
  });
  const before = runtime.repositories.assistantRecords.list()[0];
  assert.equal(before?.status, 'active');

  const draft = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/as 确认丹达第四期发票提交',
  });
  const draftText = draft.messages.map((message) => message.text ?? '').join('\n');
  assert.match(draftText, /找到可能相关的助理记录/);
  assert.match(draftText, /动作：更新内容/);
  assert.match(draftText, /状态：进行中/);

  const confirmed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/as ok',
  });
  const confirmedText = confirmed.messages.map((message) => message.text ?? '').join('\n');
  assert.match(confirmedText, /助理记录已更新/);
  assert.match(confirmedText, /状态：进行中/);

  const after = runtime.repositories.assistantRecords.list()[0];
  assert.equal(after?.status, 'active');
  assert.match(after?.content ?? '', /确认丹达第四期发票的提交情况/);
});

test('/as ok promotes a pending target to active when confirming an update draft', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-update-pending-target-'));
  const { runtime, openai } = makeRuntime({ defaultCwd });
  const scopeId = 'wx-user-assistant-update-pending-target-1';
  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (args: any) => {
    openai.startTurnCalls.push(args);
    const input = normalizeCommandSkillInput(args.inputText);
    if (input.includes('docs/command-skills/assistant-record.md') && input.includes('"operation": "classify_new_record"')) {
      return {
        outputText: JSON.stringify({
          action: 'create',
          type: 'todo',
          title: '跟踪丹达第四期发票提交',
          content: '跟踪丹达第四期发票提交。',
          priority: 'normal',
          dueAt: null,
          remindAt: null,
          recurrence: null,
          project: null,
          tags: [],
          confidence: 0.94,
        }),
        turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
        threadId: args.bridgeSession.codexThreadId,
        title: args.bridgeSession.title,
      };
    }
    if (input.includes('docs/command-skills/assistant-record.md') && input.includes('"operation": "route_existing_record"')) {
      return {
        outputText: JSON.stringify({
          action: 'update',
          targetRecordId: null,
          targetIndex: 1,
          type: 'todo',
          reason: '用户要更新这条待确认的丹达第四期发票提交记录。',
          confidence: 0.95,
        }),
        turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
        threadId: args.bridgeSession.codexThreadId,
        title: args.bridgeSession.title,
      };
    }
    if (input.includes('docs/command-skills/assistant-record.md') && input.includes('"operation": "rewrite_record"')) {
      return {
        outputText: JSON.stringify({
          action: 'update',
          type: 'todo',
          title: '确认丹达第四期发票提交',
          content: '确认丹达第四期发票的提交情况',
          status: 'pending',
          priority: 'normal',
          dueAt: null,
          remindAt: null,
          recurrence: null,
          project: null,
          tags: [],
          changeSummary: '将跟踪发票提交改为确认发票提交。',
          confidence: 0.94,
        }),
        turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
        threadId: args.bridgeSession.codexThreadId,
        title: args.bridgeSession.title,
      };
    }
    return originalStartTurn(args);
  };

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/as 跟踪丹达第四期发票提交',
  });
  const pending = runtime.repositories.assistantRecords.list()[0];
  assert.equal(pending?.status, 'pending');

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/as 确认丹达第四期发票提交',
  });

  const confirmed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/as ok',
  });
  const confirmedText = confirmed.messages.map((message) => message.text ?? '').join('\n');
  assert.match(confirmedText, /助理记录已更新/);
  assert.match(confirmedText, /状态：进行中/);

  const after = runtime.repositories.assistantRecords.list()[0];
  assert.equal(after?.status, 'active');
  assert.match(after?.content ?? '', /确认丹达第四期发票的提交情况/);
});

test('/note content edits that contain archive-like words do not change record status by mistake', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-note-status-false-positive-'));
  const { runtime, openai } = makeRuntime({ defaultCwd });
  const scopeId = 'wx-user-assistant-note-status-false-positive-1';
  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (args: any) => {
    openai.startTurnCalls.push(args);
    const input = normalizeCommandSkillInput(args.inputText);
    if (input.includes('docs/command-skills/assistant-record.md') && input.includes('"operation": "classify_new_record"')) {
      return {
        outputText: JSON.stringify({
          action: 'create',
          type: 'note',
          title: '旧邮箱入口说明',
          content: '旧邮箱入口说明在 mail.example.com',
          priority: 'normal',
          dueAt: null,
          remindAt: null,
          recurrence: null,
          project: null,
          tags: [],
          confidence: 0.94,
        }),
        turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
        threadId: args.bridgeSession.codexThreadId,
        title: args.bridgeSession.title,
      };
    }
    if (input.includes('docs/command-skills/assistant-record.md') && input.includes('"operation": "route_existing_record"')) {
      return {
        outputText: JSON.stringify({
          action: 'update',
          targetRecordId: null,
          targetIndex: 1,
          type: 'note',
          reason: '用户要修改旧邮箱入口说明这条笔记。',
          confidence: 0.95,
        }),
        turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
        threadId: args.bridgeSession.codexThreadId,
        title: args.bridgeSession.title,
      };
    }
    if (input.includes('docs/command-skills/assistant-record.md') && input.includes('"operation": "rewrite_record"')) {
      return {
        outputText: JSON.stringify({
          action: 'update',
          type: 'note',
          title: '删除旧邮箱入口说明',
          content: '删除旧邮箱入口说明在 mail.example.com',
          status: 'pending',
          priority: 'normal',
          dueAt: null,
          remindAt: null,
          recurrence: null,
          project: null,
          tags: [],
          changeSummary: '把标题改成删除旧邮箱入口说明。',
          confidence: 0.94,
        }),
        turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
        threadId: args.bridgeSession.codexThreadId,
        title: args.bridgeSession.title,
      };
    }
    return originalStartTurn(args);
  };

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/note 旧邮箱入口说明在 mail.example.com',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/note ok',
  });

  const before = runtime.repositories.assistantRecords.list()[0];
  assert.equal(before?.status, 'active');

  const draft = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/note 把标题改成删除旧邮箱入口说明',
  });
  const draftText = draft.messages.map((message) => message.text ?? '').join('\n');
  assert.match(draftText, /找到可能相关的助理记录/);
  assert.match(draftText, /动作：更新内容/);
  assert.match(draftText, /状态：进行中/);
  assert.doesNotMatch(draftText, /状态：已归档/);

  const confirmed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/note ok',
  });
  const confirmedText = confirmed.messages.map((message) => message.text ?? '').join('\n');
  assert.match(confirmedText, /助理记录已更新/);
  assert.match(confirmedText, /状态：进行中/);

  const after = runtime.repositories.assistantRecords.list()[0];
  assert.equal(after?.status, 'active');
  assert.equal(after?.title, '删除旧邮箱入口说明');
});

test('/as natural language can complete a matching assistant record after confirmation', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-natural-complete-'));
  const { runtime, openai } = makeRuntime({ defaultCwd });
  const scopeId = 'wx-user-assistant-natural-complete-1';
  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (args: any) => {
    openai.startTurnCalls.push(args);
    const input = normalizeCommandSkillInput(args.inputText);
    if (input.includes('docs/command-skills/assistant-record.md') && input.includes('"operation": "route_existing_record"')) {
      return {
        outputText: JSON.stringify({
          action: 'complete',
          targetRecordId: null,
          targetIndex: 1,
          type: 'todo',
          reason: '用户明确表示给王总回电话这件事已经完成。',
          confidence: 0.95,
        }),
        turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
        threadId: args.bridgeSession.codexThreadId,
        title: args.bridgeSession.title,
      };
    }
    return originalStartTurn(args);
  };

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/todo 给王总回电话',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/todo ok',
  });

  const draft = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/as 给王总回电话这件事已经完成了',
  });
  const draftText = draft.messages.map((message) => message.text ?? '').join('\n');
  assert.match(draftText, /找到可能相关的助理记录/);
  assert.match(draftText, /动作：标记完成/);
  assert.match(draftText, /状态：已完成/);

  const before = runtime.repositories.assistantRecords.list()[0];
  assert.equal(before?.status, 'active');

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/as ok',
  });

  const after = runtime.repositories.assistantRecords.list()[0];
  assert.equal(after?.status, 'done');
  assert.equal(typeof after?.completedAt, 'number');
});

test('/as natural language can cancel a matching assistant record after confirmation', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-natural-cancel-'));
  const { runtime, openai } = makeRuntime({ defaultCwd });
  const scopeId = 'wx-user-assistant-natural-cancel-1';
  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (args: any) => {
    openai.startTurnCalls.push(args);
    if (normalizeCommandSkillInput(args.inputText).includes('docs/command-skills/assistant-record.md') && normalizeCommandSkillInput(args.inputText).includes('"operation": "route_existing_record"')) {
      return {
        outputText: JSON.stringify({
          action: 'cancel',
          targetRecordId: null,
          targetIndex: 1,
          type: 'reminder',
          reason: '用户明确说合同附件这条提醒不用了。',
          confidence: 0.95,
        }),
        turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
        threadId: args.bridgeSession.codexThreadId,
        title: args.bridgeSession.title,
      };
    }
    return originalStartTurn(args);
  };

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/remind 明天上午10点提醒我跟进合同附件',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/remind ok',
  });

  const draft = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/as 合同附件这个提醒不用了',
  });
  const draftText = draft.messages.map((message) => message.text ?? '').join('\n');
  assert.match(draftText, /找到可能相关的助理记录/);
  assert.match(draftText, /动作：取消记录/);
  assert.match(draftText, /状态：已取消/);
  assert.match(draftText, /确认：\/as ok/);

  const before = runtime.repositories.assistantRecords.list()[0];
  assert.equal(before?.status, 'active');

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/as ok',
  });

  const after = runtime.repositories.assistantRecords.list()[0];
  assert.equal(after?.status, 'cancelled');
  assert.equal(typeof after?.cancelledAt, 'number');
});

test('/as natural language can archive a matching assistant record after confirmation', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-natural-archive-'));
  const { runtime, openai } = makeRuntime({ defaultCwd });
  const scopeId = 'wx-user-assistant-natural-archive-1';
  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (args: any) => {
    openai.startTurnCalls.push(args);
    if (normalizeCommandSkillInput(args.inputText).includes('docs/command-skills/assistant-record.md') && normalizeCommandSkillInput(args.inputText).includes('"operation": "route_existing_record"')) {
      return {
        outputText: JSON.stringify({
          action: 'archive',
          targetRecordId: null,
          targetIndex: 1,
          type: 'note',
          reason: '用户明确要求删除旧邮箱笔记。',
          confidence: 0.96,
        }),
        turnId: `${args.bridgeSession.codexThreadId}-turn-1`,
        threadId: args.bridgeSession.codexThreadId,
        title: args.bridgeSession.title,
      };
    }
    return originalStartTurn(args);
  };

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/note 旧邮箱入口在 mail.example.com',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/note ok',
  });

  const draft = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/as 把旧邮箱入口这个笔记删掉',
  });
  const draftText = draft.messages.map((message) => message.text ?? '').join('\n');
  assert.match(draftText, /找到可能相关的助理记录/);
  assert.match(draftText, /动作：删除\/归档/);
  assert.match(draftText, /状态：已归档/);
  assert.match(draftText, /确认：\/as ok/);

  const before = runtime.repositories.assistantRecords.list()[0];
  assert.equal(before?.status, 'active');

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/as ok',
  });

  const after = runtime.repositories.assistantRecords.list()[0];
  assert.equal(after?.status, 'archived');
  assert.equal(typeof after?.archivedAt, 'number');
});

test('/todo and /as natural language list queries stay local instead of creating records', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-todo-list-query-'));
  const { runtime, openai } = makeRuntime({ defaultCwd });
  const scopeId = 'wx-user-assistant-todo-list-query-1';

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/todo 检查服务器磁盘空间',
  });
  assert.equal(runtime.repositories.assistantRecords.list().length, 1);

  openai.startTurnCalls.length = 0;
  const typedList = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/todo 给我看看现在还有哪些待办',
  });
  const typedListText = typedList.messages.map((message) => message.text ?? '').join('\n');
  assert.match(typedListText, /助理记录 \| 待办/);
  assert.match(typedListText, /检查服务器磁盘空间/);
  assert.doesNotMatch(typedListText, /助理记录已保存/);
  assert.equal(runtime.repositories.assistantRecords.list().length, 1);
  assert.equal(openai.startTurnCalls.length, 0);

  const assistantList = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/as 给我看看现在还有哪些待办',
  });
  const assistantListText = assistantList.messages.map((message) => message.text ?? '').join('\n');
  assert.match(assistantListText, /助理记录 \| 待办/);
  assert.match(assistantListText, /检查服务器磁盘空间/);
  assert.doesNotMatch(assistantListText, /助理记录已保存/);
  assert.equal(runtime.repositories.assistantRecords.list().length, 1);
  assert.equal(openai.startTurnCalls.length, 0);

  const assistantFind = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeId,
    text: '/as 给我找找我的待办',
  });
  const assistantFindText = assistantFind.messages.map((message) => message.text ?? '').join('\n');
  assert.match(assistantFindText, /助理记录 \| 待办/);
  assert.match(assistantFindText, /检查服务器磁盘空间/);
  assert.doesNotMatch(assistantFindText, /助理记录已保存/);
  assert.equal(runtime.repositories.assistantRecords.list().length, 1);
  assert.equal(openai.startTurnCalls.length, 0);
});

test('/todo can complete assistant todo records by index', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-todo-'));
  const { runtime } = makeRuntime({ defaultCwd });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-assistant-todo-1',
    text: '/todo 检查服务器磁盘空间',
  });

  const done = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-assistant-todo-1',
    text: '/todo done 1',
  });
  assert.match(done.messages.map((message) => message.text ?? '').join('\n'), /已完成/);

  const record = runtime.repositories.assistantRecords.list()[0];
  assert.equal(record?.status, 'done');
  assert.equal(typeof record?.completedAt, 'number');
});

test('assistant reminder service claims due reminders once', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-due-'));
  const { runtime } = makeRuntime({ defaultCwd });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-assistant-due-1',
    text: '/remind 明天上午10点提醒我给王总回电话',
  });
  const record = runtime.repositories.assistantRecords.list()[0];
  runtime.services.assistantRecords.updateRecord(record.id, {
    remindAt: Date.now() - 1000,
    status: 'active',
  });

  const firstClaim = runtime.services.assistantRecords.claimDueReminders('weixin');
  assert.equal(firstClaim.length, 1);
  assert.match(firstClaim[0]?.content ?? '', /给王总回电话/);

  const secondClaim = runtime.services.assistantRecords.claimDueReminders('weixin');
  assert.equal(secondClaim.length, 0);
});

test('/uploads plus assistant command archives attachments onto assistant records', async () => {
  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbridge-assistant-upload-'));
  const sourceFile = createTempAttachment('contract.pdf', 'pdf-data');
  const { runtime, openai } = makeRuntime({ defaultCwd });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-assistant-upload-1',
    text: '/up',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-assistant-upload-1',
    text: '',
    attachments: [
      {
        kind: 'file',
        localPath: sourceFile,
        fileName: 'contract.pdf',
        mimeType: 'application/pdf',
      },
    ],
  });

  const saved = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-assistant-upload-1',
    text: '/note 把这些资料记录为合同附件 #合同',
  });
  const savedText = saved.messages.map((message) => message.text ?? '').join('\n');
  assert.match(savedText, /助理记录待确认/);
  assert.match(savedText, /附件：1 个/);
  assert.ok(openai.startTurnCalls.length >= 1);

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-assistant-upload-1',
    text: '/note ok',
  });

  const record = runtime.repositories.assistantRecords.list()[0];
  assert.equal(record?.type, 'note');
  assert.equal(record?.attachments.length, 1);
  assert.notEqual(record?.parsedJson?.normalizer, 'forced-local');
  assert.match(record?.attachments[0]?.storagePath ?? '', /assistant[\\/]attachments[\\/]/);
  assert.equal(fs.existsSync(record?.attachments[0]?.storagePath ?? ''), true);

  const session = runtime.services.bridgeSessions.resolveScopeSession({
    platform: 'weixin',
    externalScopeId: 'wx-user-assistant-upload-1',
  });
  const settings = runtime.services.bridgeSessions.getSessionSettings(session.id);
  assert.equal((settings?.metadata?.uploads as any) ?? null, null);
});

test('/models lists available models for the current provider', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-models-1',
    text: '/models',
  });

  const text = result.messages.map((message) => message.text ?? '').join('\n');
  assert.match(text, /可用模型：openai-default/);
  assert.match(text, /当前生效模型：gpt-5.4/);
  assert.match(text, /模型来源：provider 默认/);
  assert.match(text, /模型列表：/);
  assert.match(text, /1\. gpt-5\.4 .*（当前）.*（默认）/);
  assert.match(text, /2\. gpt-5.2-codex/);
  assert.match(text, /最新 frontier/);
});

test('/model shows current model and updates model setting for the next turn', async () => {
  const { runtime, openai } = makeRuntime();

  const empty = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-1',
    text: '/model',
  });
  const emptyText = empty.messages.map((message) => message.text ?? '').join('\n');
  assert.match(emptyText, /当前 provider：openai-default/);
  assert.match(emptyText, /当前生效模型：gpt-5.4/);
  assert.match(emptyText, /模型来源：provider 默认/);
  assert.match(emptyText, /模型说明：最新 frontier/);
  assert.match(emptyText, /当前生效思考深度：medium/);
  assert.match(emptyText, /思考深度来源：模型默认/);
  assert.match(emptyText, /模型默认思考深度：medium/);
  assert.match(emptyText, /支持思考深度：low, medium, high, xhigh/);

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-1',
    text: 'start conversation',
  });

  const updated = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-1',
    text: '/model gpt-5.2-codex',
  });
  assert.equal(updated.messages[0]?.text ?? '', '模型已更新为：gpt-5.2-codex');
  assert.equal(updated.messages[1]?.text ?? '', '下一轮生效。');

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-1',
    text: 'next turn',
  });
  assert.equal(openai.startTurnCalls.at(-1)?.sessionSettings?.model, 'gpt-5.2-codex');

  const current = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-1',
    text: '/model',
  });
  const currentText = current.messages.map((message) => message.text ?? '').join('\n');
  assert.match(currentText, /当前生效模型：gpt-5.2-codex/);
  assert.match(currentText, /模型来源：当前会话显式设置/);
  assert.match(currentText, /当前生效思考深度：medium/);
  assert.match(currentText, /思考深度来源：模型默认/);
});

test('/model can switch models by list index', async () => {
  const { runtime, openai } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-index-1',
    text: 'start conversation',
  });

  const updated = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-index-1',
    text: '/model 2',
  });
  assert.equal(updated.messages[0]?.text ?? '', '模型已更新为：gpt-5.2-codex');
  assert.equal(updated.messages[1]?.text ?? '', '下一轮生效。');

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-index-1',
    text: 'next turn',
  });
  assert.equal(openai.startTurnCalls.at(-1)?.sessionSettings?.model, 'gpt-5.2-codex');

  const updatedWithEffort = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-index-1',
    text: '/model 1 xhigh',
  });
  assert.equal(updatedWithEffort.messages[0]?.text ?? '', '模型已更新为：gpt-5.4');
  assert.equal(updatedWithEffort.messages[1]?.text ?? '', '思考深度已更新为：xhigh');
});

test('/model sets reasoning effort for the current/default model', async () => {
  const { runtime, openai } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-effort-1',
    text: 'start conversation',
  });

  const effortOnly = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-effort-1',
    text: '/model high',
  });
  assert.equal(effortOnly.messages[0]?.text ?? '', '思考深度已更新为：high');

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-effort-1',
    text: 'next turn',
  });
  assert.equal(openai.startTurnCalls.at(-1)?.sessionSettings?.reasoningEffort, 'high');
});

test('/model supports model and reasoning effort together, with validation', async () => {
  const { runtime, openai } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-effort-1',
    text: 'hello first',
  });

  const updated = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-effort-1',
    text: '/model gpt-5.4 xhigh',
  });
  assert.equal(updated.messages[0]?.text ?? '', '模型已更新为：gpt-5.4');
  assert.equal(updated.messages[1]?.text ?? '', '思考深度已更新为：xhigh');

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-effort-1',
    text: 'next turn',
  });
  const latestSessionSettings = openai.startTurnCalls.at(-1)?.sessionSettings ?? null;
  assert.equal(latestSessionSettings?.model, 'gpt-5.4');
  assert.equal(latestSessionSettings?.reasoningEffort, 'xhigh');

  const invalid = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-effort-1',
    text: '/model gpt-5.1-codex-mini xhigh',
  });
  assert.match(invalid.messages[0]?.text ?? '', /不支持该模型|不支持|不支持的思考深度/);
});

test('/model requires a space between model and reasoning effort', async () => {
  const { runtime } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-separator-1',
    text: 'seed conversation',
  });

  const merged = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-separator-1',
    text: '/model gpt-5.4xhigh',
  });
  assert.match(merged.messages[0]?.text ?? '', /模型和思考深度需要用空格分隔/);
});

test('/model supports reset and unknown-model handling', async () => {
  const { runtime, openai } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-2',
    text: 'hello first',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-2',
    text: '/model gpt-5.2-codex',
  });

  const reset = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-2',
    text: '/model default',
  });
  assert.equal(reset.messages[0]?.text ?? '', '模型已重置为默认');

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-2',
    text: 'after reset',
  });
  assert.equal(openai.startTurnCalls.at(-1)?.sessionSettings?.model ?? null, null);

  const unknown = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-model-2',
    text: '/model unknown-model',
  });
  assert.match(unknown.messages[0]?.text ?? '', /未知模型：unknown-model/);
});

test('/personality shows current value and updates the next turn', async () => {
  const { runtime, openai } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-personality-1',
    text: 'hello first',
  });

  const current = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-personality-1',
    text: '/personality',
  });
  assert.equal(current.messages[0]?.text ?? '', '当前 personality：（默认）');

  const updated = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-personality-1',
    text: '/personality pragmatic',
  });
  assert.equal(updated.messages[0]?.text ?? '', 'personality 已更新为：pragmatic');
  assert.equal(updated.messages[1]?.text ?? '', '下一轮生效。');

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-personality-1',
    text: 'next turn',
  });
  assert.equal(openai.startTurnCalls.at(-1)?.sessionSettings?.personality, 'pragmatic');

  const status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-personality-1',
    text: '/status details',
  });
  const statusText = status.messages.map((message) => message.text ?? '').join('\n');
  assert.match(statusText, /Personality：pragmatic/);
});

test('/personality validates values and requires a bound session', async () => {
  const { runtime } = makeRuntime();

  const noSession = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-personality-2',
    text: '/personality friendly',
  });
  assert.match(noSession.messages[0]?.text ?? '', /当前还没有绑定会话/);

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-personality-2',
    text: 'seed',
  });
  const invalid = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-personality-2',
    text: '/personality loud',
  });
  assert.equal(invalid.messages[0]?.text ?? '', '用法：/personality [friendly|pragmatic|none]');
});

test('/fast enables fast service tier and creates a session when needed', async () => {
  const { runtime, openai } = makeRuntime();

  const enabled = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-fast-1',
    text: '/fast',
  });

  assert.equal(enabled.messages[0]?.text ?? '', 'Fast 模式已开启。');
  assert.equal(enabled.messages[1]?.text ?? '', '当前速度模式：fast');
  assert.equal(enabled.messages[2]?.text ?? '', '服务层级：fast');
  assert.equal(enabled.messages[3]?.text ?? '', '下一轮生效。');

  const session = runtime.services.bridgeSessions.resolveScopeSession({
    platform: 'weixin',
    externalScopeId: 'wx-user-fast-1',
  });
  assert.ok(session);

  const status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-fast-1',
    text: '/status details',
  });
  const statusLines = status.messages.map((message) => message.text ?? '');
  assert.ok(statusLines.includes('速度模式：fast'));
  assert.ok(statusLines.includes('服务层级：fast'));

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-fast-1',
    text: 'hello with fast mode',
  });

  assert.equal(openai.startTurnCalls.at(-1)?.sessionSettings?.serviceTier, 'fast');
});

test('/fast off forces flex service tier for the next turn', async () => {
  const { runtime, openai } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-fast-2',
    text: '/fast',
  });

  const disabled = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-fast-2',
    text: '/fast off',
  });

  assert.equal(disabled.messages[0]?.text ?? '', 'Fast 模式已关闭，已恢复普通模式。');
  assert.equal(disabled.messages[1]?.text ?? '', '当前速度模式：normal');
  assert.equal(disabled.messages[2]?.text ?? '', '服务层级：flex');
  assert.equal(disabled.messages[3]?.text ?? '', '下一轮生效。');

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-fast-2',
    text: 'hello with normal mode',
  });

  assert.equal(openai.startTurnCalls.at(-1)?.sessionSettings?.serviceTier, 'flex');
});

test('/plan shows current mode and updates the next turn collaboration mode', async () => {
  const { runtime, openai } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plan-1',
    text: '/new /home/ubuntu/dev/CodexBridge',
  });

  const current = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plan-1',
    text: '/plan',
  });
  assert.equal(current.messages[0]?.text ?? '', '当前计划模式：（默认）');

  const enabled = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plan-1',
    text: '/plan on',
  });
  assert.equal(enabled.messages[0]?.text ?? '', '计划模式已开启。');
  assert.equal(enabled.messages[1]?.text ?? '', '当前计划模式：开启');

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plan-1',
    text: '请先规划一下这个改动',
  });
  assert.equal(openai.startTurnCalls.at(-1)?.sessionSettings?.collaborationMode, 'plan');

  const status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plan-1',
    text: '/status details',
  });
  const statusText = status.messages.map((message) => message.text ?? '').join('\n');
  assert.match(statusText, /计划模式：开启/);

  const disabled = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plan-1',
    text: '/plan off',
  });
  assert.equal(disabled.messages[0]?.text ?? '', '计划模式已关闭，已恢复默认协作模式。');
  assert.equal(disabled.messages[1]?.text ?? '', '当前计划模式：（默认）');
});

test('legacy service tier values are normalized to fast/flex in status output', async () => {
  const { runtime, openai } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-fast-legacy-1',
    text: 'hello legacy tier',
  });

  const session = runtime.services.bridgeSessions.resolveScopeSession({
    platform: 'weixin',
    externalScopeId: 'wx-user-fast-legacy-1',
  });
  assert.ok(session);

  runtime.services.bridgeSessions.upsertSessionSettings(session.id, {
    serviceTier: 'priority',
  });
  let status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-fast-legacy-1',
    text: '/status details',
  });
  let statusLines = status.messages.map((message) => message.text ?? '');
  assert.ok(statusLines.includes('服务层级：fast'));

  runtime.services.bridgeSessions.upsertSessionSettings(session.id, {
    serviceTier: 'default',
  });

  status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-fast-legacy-1',
    text: '/status details',
  });
  statusLines = status.messages.map((message) => message.text ?? '');
  assert.ok(statusLines.includes('服务层级：flex'));
});

test('/lang displays current language when no locale argument is provided', async () => {
  const { runtime } = makeRuntime({ locale: 'en' });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-lang-1',
    text: '/lang',
  });

  assert.equal(result.messages[0]?.text ?? '', 'Current language: English');
});

test('/lang persists command locale for scope and overrides env', async () => {
  const { runtime } = makeRuntime({ locale: 'en' });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-lang-2',
    text: '/lang zh',
  });

  const status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-lang-2',
    text: '/status',
  });

  const lines = status.messages.map((message) => message.text ?? '');
  assert.ok(lines.includes('接口配置：openai-default'));
  assert.ok(lines.includes('默认工作目录：（未设置）'));
  assert.ok(lines.includes('模型：gpt-5.4'));
  assert.ok(lines.includes('完整信息：/status details'));
});

test('/lang rejects invalid language values', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-lang-3',
    text: '/lang jp',
  });

  assert.equal(result.messages[0]?.text ?? '', '不支持的语言：jp');
  assert.equal(result.messages[1]?.text ?? '', '用法：/lang <zh-CN|en>');
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
  assert.match(text, /说明：线程命令统一入口：查看列表，并支持自然语言搜索、打开、预览、改名和批量管理/);
  assert.match(text, /用法：/);
  assert.match(text, /\/threads$/m);
  assert.match(text, /\/th 打开昨天那个发票线程/);
  assert.match(text, /\/th all/);
  assert.match(text, /\/th pin/);
  assert.match(text, /\/th del 2/);
  assert.match(text, /\/th del 发票相关旧线程/);
  assert.match(text, /\/th restore 2/);
  assert.match(text, /\/th restore 刚刚归档的发票线程/);
  assert.match(text, /\/th pin 2/);
  assert.match(text, /\/th pin DailyWork 相关线程/);
  assert.match(text, /\/th unpin 2/);
  assert.match(text, /\/th confirm/);
  assert.match(text, /\/th cancel/);
  assert.match(text, /\/th -h/);
  assert.match(text, /\/open 2/);
  assert.match(text, /\/th 把那个线程改名为微信桥接排障/);
  assert.match(text, /现在既是线程列表命令，也是这整组线程子命令的自然语言统一入口/);
});

test('/helps help entry explains the local keepalive slash pulse', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-help-helps-1',
    text: '/helps helps',
  });

  const text = result.messages[0]?.text ?? '';
  assert.match(text, /主动单独发送裸 \/ 作为本地 keepalive/);
  assert.match(text, /不会转发给 Codex/);
  assert.match(text, /不会触发回复/);
  assert.match(text, /像 \/retry 这样的命令仍按正常命令处理/);
});

test('/use without enough arguments returns the full use help page', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-help-use-1',
    text: '/use',
  });

  const text = result.messages[0]?.text ?? '';
  assert.match(text, /命令：\/use/u);
  assert.match(text, /用法：\/use <插件别名\|插件名\.\.\.> <需求>/u);
  assert.match(text, /\/use gm gc 把重要事情都记录到谷歌日历中/u);
  assert.match(text, /用@gm 查看最新的邮件，并用@gc把重要事情都记录到谷歌日历中/u);
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
  assert.match(text, /\/threads$/m);
  assert.match(text, /\/th 打开昨天那个发票线程/);
  assert.match(text, /\/th pin/);
  assert.match(text, /\/th del 2/);
  assert.match(text, /\/th del 发票相关旧线程/);
  assert.match(text, /\/th restore 2/);
  assert.match(text, /\/th restore 刚刚归档的发票线程/);
  assert.match(text, /\/th pin 2/);
  assert.match(text, /\/th pin DailyWork 相关线程/);
  assert.match(text, /\/th unpin 2/);
  assert.match(text, /\/th confirm/);
  assert.match(text, /\/th cancel/);
  assert.match(text, /\/th -h/);
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

  const uploadsHelpResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/h up',
  });
  assert.match(uploadsHelpResult.messages[0]?.text ?? '', /命令：\/uploads/);
  assert.match(uploadsHelpResult.messages[0]?.text ?? '', /别名：\/up \/ul/);

  const providerResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/pd',
  });
  assert.match(providerResult.messages[0]?.text ?? '', /当前 Provider 配置：openai-default/);

  const searchResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/se bridge',
  });
  assert.match(searchResult.messages[0]?.text ?? '', /没有找到匹配的线程|线程列表 \|/);
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

test('/allow -h and /deny -h mention the full-access workaround for approval issues', async () => {
  const { runtime } = makeRuntime();

  const allowResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-allow-help-1',
    text: '/allow -h',
  });
  const denyResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-deny-help-1',
    text: '/deny -h',
  });

  const allowText = allowResult.messages[0]?.text ?? '';
  const denyText = denyResult.messages[0]?.text ?? '';
  assert.match(allowText, /\/perm full-access/);
  assert.match(allowText, /只对下一轮生效/);
  assert.match(denyText, /\/perm full-access/);
  assert.match(denyText, /只对下一轮生效/);
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
  /** @type {(value?: unknown) => void} */
  let releaseTurn: (value?: unknown) => void = () => {};
  const turnGate = new Promise((resolve) => {
    releaseTurn = resolve;
  });
  let interrupted = false;

  openai.startTurn = async ({ bridgeSession, inputText, onTurnStarted = null }) => {
    const parserResult = await maybeReturnArtifactIntentParserResult({
      bridgeSession,
      onTurnStarted,
      decision: {
        action: 'none',
        preferredKind: null,
        requestedFormat: null,
        explicit: false,
        confidence: 0.95,
        reason: '普通对话，不要求附件。',
      },
    });
    if (parserResult) {
      return parserResult;
    }
    const existingThread = openai.threads.get(bridgeSession.codexThreadId);
    assert.ok(existingThread);
    const turnId = `${bridgeSession.codexThreadId}-turn-${(existingThread?.turns.length ?? 0) + 1}`;
    await onTurnStarted?.({
      turnId,
      threadId: bridgeSession.codexThreadId,
    });
    existingThread.turns = [
      {
        id: turnId,
        status: 'running',
        error: null,
        items: [],
      },
    ];
    await turnGate;
    existingThread.turns = [
      {
        id: turnId,
        status: interrupted ? 'interrupted' : 'complete',
        error: interrupted ? 'Conversation interrupted' : null,
        items: interrupted
          ? []
          : [
            { role: 'user', text: inputText, type: 'message', phase: 'final' },
            { role: 'assistant', text: `openai: ${inputText}`, type: 'message', phase: 'final' },
          ],
      },
    ];
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
    const thread = openai.threads.get(params.threadId);
    if (thread) {
      thread.turns = [
        {
          id: params.turnId,
          status: 'interrupted',
          error: 'Conversation interrupted',
          items: [],
        },
      ];
    }
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
  /** @type {(value?: unknown) => void} */
  let releaseStart: (value?: unknown) => void = () => {};
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  /** @type {(value?: unknown) => void} */
  let releaseFinish: (value?: unknown) => void = () => {};
  const finishGate = new Promise((resolve) => {
    releaseFinish = resolve;
  });

  openai.startTurn = async ({ bridgeSession, onTurnStarted = null }) => {
    const parserResult = await maybeReturnArtifactIntentParserResult({
      bridgeSession,
      onTurnStarted,
      decision: {
        action: 'none',
        preferredKind: null,
        requestedFormat: null,
        explicit: false,
        confidence: 0.95,
        reason: '普通对话，不要求附件。',
      },
    });
    if (parserResult) {
      return parserResult;
    }
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
  /** @type {(value?: unknown) => void} */
  let releaseTurn: (value?: unknown) => void = () => {};
  const turnGate = new Promise((resolve) => {
    releaseTurn = resolve;
  });

  openai.startTurn = async ({ bridgeSession, inputText, onTurnStarted = null }) => {
    const parserResult = await maybeReturnArtifactIntentParserResult({
      bridgeSession,
      onTurnStarted,
      decision: {
        action: 'none',
        preferredKind: null,
        requestedFormat: null,
        explicit: false,
        confidence: 0.95,
        reason: '普通对话，不要求附件。',
      },
    });
    if (parserResult) {
      return parserResult;
    }
    const thread = openai.threads.get(bridgeSession.codexThreadId);
    assert.ok(thread);
    await onTurnStarted?.({
      turnId: `${bridgeSession.codexThreadId}-turn-1`,
      threadId: bridgeSession.codexThreadId,
    });
    thread.turns = [
      {
        id: `${bridgeSession.codexThreadId}-turn-1`,
        status: 'running',
        error: null,
        items: [],
      },
    ];
    await turnGate;
    thread.turns = [
      {
        id: `${bridgeSession.codexThreadId}-turn-1`,
        status: 'complete',
        error: null,
        items: [
          { role: 'user', text: inputText, type: 'message', phase: 'final' },
          { role: 'assistant', text: `openai: ${inputText}`, type: 'message', phase: 'final' },
        ],
      },
    ];
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
    text: '/status details',
  });

  const lines = status.messages.map((message) => message.text ?? '');
  assert.ok(lines.some((line) => /当前 Turn：.*turn-1/.test(line)));
  assert.ok(lines.includes('Turn 状态：运行中'));
  assert.ok(lines.includes('Turn 控制：/stop'));

  releaseTurn();
  await firstTurn;
});

test('bridge coordinator blocks new conversation turns while another turn is already active', async () => {
  const { runtime, openai } = makeRuntime();
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-3',
  };
  /** @type {(value?: unknown) => void} */
  let releaseTurn: (value?: unknown) => void = () => {};
  const turnGate = new Promise((resolve) => {
    releaseTurn = resolve;
  });

  openai.startTurn = async ({ bridgeSession, inputText, onTurnStarted = null }) => {
    const thread = openai.threads.get(bridgeSession.codexThreadId);
    assert.ok(thread);
    await onTurnStarted?.({
      turnId: `${bridgeSession.codexThreadId}-turn-1`,
      threadId: bridgeSession.codexThreadId,
    });
    thread.turns = [
      {
        id: `${bridgeSession.codexThreadId}-turn-1`,
        status: 'running',
        error: null,
        items: [],
      },
    ];
    await turnGate;
    thread.turns = [
      {
        id: `${bridgeSession.codexThreadId}-turn-1`,
        status: 'complete',
        error: null,
        items: [
          { role: 'user', text: inputText, type: 'message', phase: 'final' },
          { role: 'assistant', text: `openai: ${inputText}`, type: 'message', phase: 'final' },
        ],
      },
    ];
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
  /** @type {(value?: unknown) => void} */
  let releaseTurn: (value?: unknown) => void = () => {};
  const turnGate = new Promise((resolve) => {
    releaseTurn = resolve;
  });

  openai.startTurn = async ({ bridgeSession, inputText, onTurnStarted = null }) => {
    const thread = openai.threads.get(bridgeSession.codexThreadId);
    assert.ok(thread);
    await onTurnStarted?.({
      turnId: `${bridgeSession.codexThreadId}-turn-1`,
      threadId: bridgeSession.codexThreadId,
    });
    thread.turns = [
      {
        id: `${bridgeSession.codexThreadId}-turn-1`,
        status: 'running',
        error: null,
        items: [],
      },
    ];
    await turnGate;
    thread.turns = [
      {
        id: `${bridgeSession.codexThreadId}-turn-1`,
        status: 'complete',
        error: null,
        items: [
          { role: 'user', text: inputText, type: 'message', phase: 'final' },
          { role: 'assistant', text: `openai: ${inputText}`, type: 'message', phase: 'final' },
        ],
      },
    ];
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
    ['/provider compat-default', '当前有回复在进行中，暂时不能切换 provider。请先等待，或使用 /stop 中断。'],
    ['/model gpt-5.4', '当前有回复在进行中，暂时不能切换模型。请先等待，或使用 /stop 中断。'],
    ['/personality friendly', '当前有回复在进行中，暂时不能切换 personality。请先等待，或使用 /stop 中断。'],
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
  /** @type {(value?: unknown) => void} */
  let releaseTurn: (value?: unknown) => void = () => {};
  const turnGate = new Promise((resolve) => {
    releaseTurn = resolve;
  });
  let interrupted = false;

  openai.startTurn = async ({ bridgeSession, onTurnStarted = null }) => {
    const parserResult = await maybeReturnArtifactIntentParserResult({
      bridgeSession,
      onTurnStarted,
      decision: {
        action: 'none',
        preferredKind: null,
        requestedFormat: null,
        explicit: false,
        confidence: 0.95,
        reason: '普通对话，不要求附件。',
      },
    });
    if (parserResult) {
      return parserResult;
    }
    const thread = openai.threads.get(bridgeSession.codexThreadId);
    assert.ok(thread);
    await onTurnStarted?.({
      turnId: `${bridgeSession.codexThreadId}-turn-1`,
      threadId: bridgeSession.codexThreadId,
    });
    thread.turns = [
      {
        id: `${bridgeSession.codexThreadId}-turn-1`,
        status: 'running',
        error: null,
        items: [],
      },
    ];
    await turnGate;
    thread.turns = [
      {
        id: `${bridgeSession.codexThreadId}-turn-1`,
        status: interrupted ? 'interrupted' : 'complete',
        error: interrupted ? 'Conversation interrupted' : null,
        items: [],
      },
    ];
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
    text: '/provider compat-default',
  });

  assert.equal(blocked.messages[0]?.text ?? '', '已请求中断，请等待当前回复停止后再切换 provider。');

  const status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: '/status details',
  });

  const lines = status.messages.map((message) => message.text ?? '');
  assert.ok(lines.some((line) => /当前 Turn：.*turn-1/.test(line)));
  assert.ok(lines.includes('Turn 状态：已请求中断'));
  assert.ok(lines.includes('Turn 控制：/stop'));

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
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/personality pragmatic',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/plan on',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/new',
  });
  const rebound = runtime.services.bridgeSessions.resolveScopeSession({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
  });

  assert.match(result.messages[0]?.text ?? '', /已创建新的 Bridge 会话/);
  assert.equal(openai.startThreadCalls.length, 2);
  assert.ok(rebound);
  assert.equal(
    runtime.services.bridgeSessions.getSessionSettings(rebound.id)?.personality,
    'pragmatic',
  );
  assert.equal(
    runtime.services.bridgeSessions.getSessionSettings(rebound.id)?.collaborationMode,
    'plan',
  );
});

test('/provider switches the scope to a new provider-backed session', async () => {
  const { runtime, minimax } = makeRuntime();
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: 'hello',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/personality friendly',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/plan on',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/model gpt-5.4 xhigh',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/fast',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/provider compat-default',
  });
  const rebound = runtime.services.bridgeSessions.resolveScopeSession({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
  });

  assert.match(result.messages[0]?.text ?? '', /已切换到 Provider 配置：compat-default/);
  assert.equal(result.session?.providerProfileId, 'compat-default');
  assert.equal(minimax.startThreadCalls.length, 1);
  assert.ok(rebound);
  assert.equal(
    runtime.services.bridgeSessions.getSessionSettings(rebound.id)?.personality,
    'friendly',
  );
  assert.equal(
    runtime.services.bridgeSessions.getSessionSettings(rebound.id)?.collaborationMode,
    'plan',
  );
  const reboundSettings = runtime.services.bridgeSessions.getSessionSettings(rebound.id);
  assert.equal(reboundSettings?.model, null);
  assert.equal(reboundSettings?.reasoningEffort, null);
  assert.equal(reboundSettings?.serviceTier, null);
});

test('/provider keeps WeChat-facing command UX stable across multiple provider profiles', async () => {
  const providerProfiles = [
    makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default'),
    makeProviderProfile('deepseek', 'openai-compatible', 'DeepSeek'),
    makeProviderProfile('minimax', 'openai-compatible', 'MiniMax'),
    makeProviderProfile('qwen', 'openai-compatible', 'Qwen'),
    makeProviderProfile('openrouter', 'openai-compatible', 'OpenRouter'),
  ];
  const { runtime, openai, compatible } = makeRuntime({
    providerProfiles,
    defaultProviderProfileId: 'openai-default',
    defaultCwd: '/tmp/provider-proof',
  });
  const scope = {
    platform: 'weixin' as const,
    externalScopeId: 'wx-user-provider-proof-1',
  };
  const seenSessionIds = new Set<string>();
  const seenThreadIds = new Set<string>();

  const initial = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scope,
    text: 'hello provider proof',
  });
  assert.equal(initial.session?.providerProfileId, 'openai-default');
  assert.ok(initial.session?.bridgeSessionId);
  assert.ok(initial.session?.codexThreadId);
  seenSessionIds.add(initial.session?.bridgeSessionId ?? '');
  seenThreadIds.add(initial.session?.codexThreadId ?? '');

  for (const profileId of ['deepseek', 'minimax', 'qwen', 'openrouter', 'openai-default']) {
    const switchResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
      ...scope,
      text: `/provider ${profileId}`,
    });
    const rebound = runtime.services.bridgeSessions.resolveScopeSession(scope);

    assert.match(switchResult.messages[0]?.text ?? '', new RegExp(`已切换到 Provider 配置：${profileId}`));
    assert.equal(switchResult.session?.providerProfileId, profileId);
    assert.ok(rebound);
    assert.equal(rebound?.providerProfileId, profileId);
    assert.ok(rebound?.id);
    assert.ok(rebound?.codexThreadId);
    assert.ok(!seenSessionIds.has(rebound?.id ?? ''), `expected fresh session for ${profileId}`);
    assert.ok(!seenThreadIds.has(rebound?.codexThreadId ?? ''), `expected fresh thread for ${profileId}`);
    seenSessionIds.add(rebound?.id ?? '');
    seenThreadIds.add(rebound?.codexThreadId ?? '');

    const status = await runtime.services.bridgeCoordinator.handleInboundEvent({
      ...scope,
      text: '/status',
    });
    const statusLines = status.messages.map((message) => message.text ?? '');
    assert.ok(statusLines.includes(`接口配置：${profileId}`));
    assert.ok(statusLines.some((line) => /^会话标题：/.test(line)));
    assert.ok(statusLines.includes('工作目录：/tmp/provider-proof'));
    assert.ok(statusLines.includes('速度模式：normal'));
    assert.ok(statusLines.includes('模型：gpt-5.4'));
    assert.ok(statusLines.includes('推理强度：'));
    assert.ok(statusLines.includes('权限预设：'));
    assert.ok(statusLines.includes('完整信息：/status details'));
    assert.ok(statusLines.every((line) => !/Scope：/.test(line)));
    assert.ok(statusLines.every((line) => !/当前 Turn：/.test(line)));
    assert.ok(statusLines.every((line) => !/Turn 状态：/.test(line)));
    assert.ok(statusLines.every((line) => !/Bridge 会话：/.test(line)));
    assert.ok(statusLines.every((line) => !/Codex 线程：/.test(line)));

    const models = await runtime.services.bridgeCoordinator.handleInboundEvent({
      ...scope,
      text: '/models',
    });
    const modelsText = models.messages.map((message) => message.text ?? '').join('\n');
    assert.match(modelsText, new RegExp(`可用模型：${profileId}`));
    assert.match(modelsText, /当前生效模型：gpt-5\.4/);
    assert.match(modelsText, /模型来源：provider 默认/);
    assert.match(modelsText, /模型列表：/);
    assert.match(modelsText, /1\. gpt-5\.4 .*（当前）.*（默认）/);
  }

  assert.equal(openai.startThreadCalls.length, 2);
  assert.equal(compatible.startThreadCalls.length, 4);
});

test('/open preserves plan mode when rebinding to another thread', async () => {
  const { runtime, openai } = makeRuntime();
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-open-plan-1',
    text: 'hello',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-open-plan-1',
    text: '/plan on',
  });

  const created = await openai.startThread({
    providerProfile: makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default'),
    cwd: '/home/ubuntu/dev/CodexBridge',
    title: 'Second thread',
    metadata: {},
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-open-plan-1',
    text: `/open ${created.threadId}`,
  });

  const rebound = runtime.services.bridgeSessions.resolveScopeSession({
    platform: 'weixin',
    externalScopeId: 'wx-user-open-plan-1',
  });
  assert.ok(rebound);
  assert.equal(
    runtime.services.bridgeSessions.getSessionSettings(rebound.id)?.collaborationMode,
    'plan',
  );
});

test('/provider without args lists current and available profiles', async () => {
  const { runtime } = makeRuntime();

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-1',
    text: '/provider',
  });

  assert.match(result.messages[0]?.text ?? '', /当前 Provider 配置：openai-default/);
  assert.match(result.messages[1]?.text ?? '', /可用的 Provider 配置/);
  assert.match(result.messages[2]?.text ?? '', /openai-default/);
  assert.match(result.messages[3]?.text ?? '', /compat-default/);
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
  assert.match(text, /线程列表 \| openai-default/);
  assert.match(text, /当前绑定：OpenAI Default thread 1/);
  assert.match(text, /\* \d+\. OpenAI Default thread 1/);
  assert.match(text, /预览：hello from wx/);
  assert.match(text, /操作：\/open \d+  \/peek \d+  \/rename \d+ 新名字  \/threads del \d+  \/threads pin \d+  \/threads all  \/threads pin  \/search 关键词/);
});

test('/threads shows thread id in current binding when the current thread has no title', async () => {
  const { runtime, openai } = makeRuntime();

  const first = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-threads-untitled-1',
    text: 'first thread',
  });

  const currentSession = runtime.services.bridgeSessions.resolveScopeSession({
    platform: 'weixin',
    externalScopeId: 'wx-user-threads-untitled-1',
  });
  runtime.services.bridgeSessions.updateSession(currentSession.id, {
    title: null,
  });
  const currentThread = openai.threads.get(first.session?.codexThreadId);
  openai.threads.set(first.session?.codexThreadId, {
    ...currentThread,
    title: null,
  });

  for (let index = 0; index < 5; index += 1) {
    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'telegram',
      externalScopeId: `tg-topic-untitled-${index}`,
      text: `newer thread ${index}`,
    });
  }

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-threads-untitled-1',
    text: '/threads',
  });

  const text = result.messages[0]?.text ?? '';
  assert.match(text, new RegExp(`当前绑定：未命名线程 \\(${first.session?.codexThreadId}\\)`));
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

test('/search natural language uses the thread command skill for semantic candidate selection', async () => {
  const { runtime, openai } = makeRuntime();

  const invoiceThread = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-search-skill-invoice',
    text: '丹达第四期发票提交跟进',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-search-skill-build',
    text: '构建日志排查',
  });

  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (params: any) => {
    const parserInput = normalizeCommandSkillInput(params?.inputText);
    if (parserInput.includes('docs/command-skills/threads.md') && parserInput.includes('"command": "search"')) {
      assert.deepEqual(params?.event?.metadata?.codexbridge?.developerPromptContext, {
        mode: 'command-skill-parser',
        title: 'Thread Command Skill',
        source: 'thread-command-skill',
        command: 'search',
        subcommand: 'search',
        operation: 'search',
      });
      assert.match(parserInput, /"supportedActions": \[/);
      assert.match(parserInput, /"threadId": "openai-default-thread-1"/);
      return {
        outputText: JSON.stringify({
          schemaVersion: 'codexbridge.thread-command-skill.v1',
          ok: true,
          action: 'search_threads',
          confidence: 0.94,
          requiresConfirmation: false,
          summary: '找到最相关的发票线程。',
          candidateThreadIds: [invoiceThread.session?.codexThreadId],
        }),
      };
    }
    return originalStartTurn(params);
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-search-skill-browser',
    text: '/search 找昨天那个发票线程',
  });

  const text = result.messages[0]?.text ?? '';
  assert.match(text, /搜索：找昨天那个发票线程/);
  assert.match(text, /丹达第四期发票提交跟进/);
  assert.doesNotMatch(text, /构建日志排查/);
  assert.ok(openai.startThreadCalls.some((call: any) =>
    call.title === 'Thread Command Skill' && call.ephemeral === true));
});

test('/threads natural language can route to local open and rename actions through the thread command skill', async () => {
  const { runtime, openai } = makeRuntime();

  const target = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-thread-natural-open-target',
    text: '昨天的发票线程',
  });

  const originalStartTurn = openai.startTurn.bind(openai);
  let renameInvocationCount = 0;
  openai.startTurn = async (params: any) => {
    const parserInput = normalizeCommandSkillInput(params?.inputText);
    if (parserInput.includes('docs/command-skills/threads.md') && parserInput.includes('"subcommand": "natural"')) {
      if (parserInput.includes('打开昨天那个发票线程')) {
        return {
          outputText: JSON.stringify({
            schemaVersion: 'codexbridge.thread-command-skill.v1',
            ok: true,
            action: 'open_thread',
            confidence: 0.95,
            requiresConfirmation: false,
            summary: '打开昨天那个发票线程。',
            candidateThreadIds: [target.session?.codexThreadId],
          }),
        };
      }
      if (parserInput.includes('改名为微信桥接排障')) {
        renameInvocationCount += 1;
        return {
          outputText: JSON.stringify({
            schemaVersion: 'codexbridge.thread-command-skill.v1',
            ok: true,
            action: 'rename_thread',
            confidence: 0.93,
            requiresConfirmation: false,
            summary: '把目标线程改名为微信桥接排障。',
            newName: '微信桥接排障',
            candidateThreadIds: [target.session?.codexThreadId],
          }),
        };
      }
    }
    return originalStartTurn(params);
  };

  const opened = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-thread-natural-browser',
    text: '/threads 打开昨天那个发票线程',
  });
  assert.equal(opened.session?.codexThreadId, target.session?.codexThreadId);
  assert.match(opened.messages[0]?.text ?? '', /已打开 Codex 线程/);

  const renamed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-thread-natural-browser',
    text: '/threads 把那个线程改名为微信桥接排障',
  });
  const renamedText = renamed.messages[0]?.text ?? '';
  assert.equal(renameInvocationCount, 1);
  assert.match(renamedText, /已更新线程显示名/);
  assert.match(renamedText, /名称：微信桥接排障/);

  const threadsView = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-thread-natural-browser',
    text: '/threads',
  });
  assert.match(threadsView.messages[0]?.text ?? '', /微信桥接排障/);
});

test('/weibo returns the requested hot-search top list', async () => {
  const { runtime } = makeRuntime({
    weiboHotSearch: {
      async getTop({ limit = 10 } = {}) {
        assert.equal(limit, 3);
        return {
          fetchedAt: Date.UTC(2026, 3, 24, 11, 30, 0),
          items: [
            { position: 1, title: '话题一', label: '爆', category: '综艺', hotValue: 22854505 },
            { position: 2, title: '话题二', label: '新', category: null, hotValue: 2236764 },
            { position: 3, title: '话题三', label: null, category: null, hotValue: null },
          ],
        };
      },
    },
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-weibo-1',
    text: '/weibo top 3',
  });

  assert.equal(result.type, 'message');
  const text = result.messages.map((message) => String(message.text ?? '')).join('\n');
  assert.match(text, /微博热搜 Top 3/);
  assert.match(text, /1\. 话题一 \(爆 \| 综艺 \| 热度 22,854,505\)/);
  assert.match(text, /2\. 话题二 \(新 \| 热度 2,236,764\)/);
  assert.match(text, /3\. 话题三/);
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

  assert.match(result.messages[0]?.text ?? '', new RegExp(`已打开 Codex 线程 ${original.session?.codexThreadId}`));
  assert.match(result.messages[3]?.text ?? '', /线程预览：/);
  assert.match(result.messages[3]?.text ?? '', /最近 1 轮：/);
  assert.match(result.messages[3]?.text ?? '', /你：hello from telegram/);
  assert.equal(result.session?.codexThreadId, original.session?.codexThreadId);
  assert.equal(result.session?.bridgeSessionId, original.session?.bridgeSessionId);

  const status = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-2',
    text: '/status details',
  });

  const lines = status.messages.map((message) => message.text ?? '');
  assert.ok(lines.some((line) => new RegExp(`Codex 线程：${original.session?.codexThreadId}`).test(line)));
  assert.ok(lines.some((line) => /工作目录：/.test(line)));
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

test('/open shows recent turns when Codex thread items use userMessage/agentMessage without explicit roles', async () => {
  const { runtime, openai } = makeRuntime();

  const created = await openai.startThread({
    providerProfile: makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default'),
    cwd: '/home/ubuntu/dev/CodexBridge',
    title: 'CodexBridge',
    metadata: {},
  });
  const existing = openai.threads.get(created.threadId);
  openai.threads.set(created.threadId, {
    ...existing,
    preview: '为什么我的命令无效？我都指定了路径/new /home/ubuntu/dev/CodexBridge',
    turns: [
      {
        id: `${created.threadId}-turn-1`,
        status: 'completed',
        error: null,
        items: [
          { type: 'userMessage', role: null, phase: null, text: '为什么我的命令无效？我都指定了路径/new /home/ubuntu/dev/CodexBridge' },
          { type: 'agentMessage', role: null, phase: 'commentary', text: '我先检查一下当前线程绑定和命令解析路径。' },
          { type: 'agentMessage', role: null, phase: 'final_answer', text: '问题在于 `/new` 前面缺少空格，导致整段被当成普通文本。' },
        ],
      },
      {
        id: `${created.threadId}-turn-2`,
        status: 'completed',
        error: null,
        items: [
          { type: 'userMessage', role: null, phase: null, text: '那你直接帮我处理吧。' },
          { type: 'agentMessage', role: null, phase: 'final_answer', text: '我已经帮你切到正确目录，并准备继续处理。' },
        ],
      },
    ],
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-open-null-role',
    text: `/open ${created.threadId}`,
  });

  assert.match(result.messages[3]?.text ?? '', /线程预览：/);
  assert.match(result.messages[3]?.text ?? '', /最近 2 轮：/);
  assert.match(result.messages[3]?.text ?? '', /你：为什么我的命令无效/);
  assert.match(result.messages[3]?.text ?? '', /Codex：问题在于 `\/new` 前面缺少空格/);
  assert.match(result.messages[3]?.text ?? '', /你：那你直接帮我处理吧/);
  assert.match(result.messages[3]?.text ?? '', /Codex：我已经帮你切到正确目录/);
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

test('/threads del archives a thread from the default list, and /threads restore revives it from the all view', async () => {
  const { runtime, openai } = makeRuntime();

  const older = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-archive-older',
    text: 'older thread',
  });
  const newer = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-archive-newer',
    text: 'newer thread',
  });

  const firstList = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser-archive',
    text: '/threads',
  });
  assert.match(firstList.messages[0]?.text ?? '', /newer thread/);

  const archived = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser-archive',
    text: '/threads del 1',
  });
  assert.match(archived.messages[0]?.text ?? '', new RegExp(`已归档线程：${newer.session?.codexThreadId}`));
  assert.deepEqual(openai.archiveThreadCalls, [{ threadId: newer.session?.codexThreadId }]);

  const hiddenFromDefault = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser-archive',
    text: '/threads',
  });
  assert.doesNotMatch(hiddenFromDefault.messages[0]?.text ?? '', /newer thread/);
  assert.match(hiddenFromDefault.messages[0]?.text ?? '', /older thread/);

  const allView = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser-archive',
    text: '/threads all',
  });
  assert.match(allView.messages[0]?.text ?? '', /视图：全部（含已归档）/);
  assert.match(allView.messages[0]?.text ?? '', /OpenAI Default thread 2 \[已归档\]/);
  assert.match(allView.messages[0]?.text ?? '', /预览：newer thread/);
  assert.match(allView.messages[0]?.text ?? '', /\/threads restore 1/);

  const restored = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser-archive',
    text: '/threads restore 1',
  });
  assert.match(restored.messages[0]?.text ?? '', new RegExp(`已恢复线程：${newer.session?.codexThreadId}`));
  assert.deepEqual(openai.unarchiveThreadCalls, [{ threadId: newer.session?.codexThreadId }]);

  const visibleAgain = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser-archive',
    text: '/threads',
  });
  assert.match(visibleAgain.messages[0]?.text ?? '', /newer thread/);
  assert.doesNotMatch(visibleAgain.messages[0]?.text ?? '', /\[已归档\]/);
  assert.ok(older.session?.codexThreadId);
});

test('/threads del and /threads restore accept multiple indexes from the current page without index drift', async () => {
  const { runtime } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-batch-1',
    text: 'thread one',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-batch-2',
    text: 'thread two',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-batch-3',
    text: 'thread three',
  });

  const list = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser-batch',
    text: '/threads',
  });
  const listText = list.messages[0]?.text ?? '';
  assert.match(listText, /预览：thread three/);
  assert.match(listText, /预览：thread two/);
  assert.match(listText, /预览：thread one/);

  const archived = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser-batch',
    text: '/threads del 1 3',
  });
  const archivedText = archived.messages.map((message) => message.text ?? '').join('\n');
  assert.match(archivedText, /已归档线程：openai-default-thread-3/);
  assert.match(archivedText, /已归档线程：openai-default-thread-1/);

  const defaultView = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser-batch',
    text: '/threads',
  });
  const defaultText = defaultView.messages[0]?.text ?? '';
  assert.doesNotMatch(defaultText, /thread three/);
  assert.match(defaultText, /thread two/);
  assert.doesNotMatch(defaultText, /thread one/);

  const allView = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser-batch',
    text: '/threads all',
  });
  const allText = allView.messages[0]?.text ?? '';
  assert.match(allText, /OpenAI Default thread 3 \[已归档\]/);
  assert.match(allText, /OpenAI Default thread 1 \[已归档\]/);

  const restored = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser-batch',
    text: '/threads restore 1 3',
  });
  const restoredText = restored.messages.map((message) => message.text ?? '').join('\n');
  assert.match(restoredText, /已恢复线程：openai-default-thread-3/);
  assert.match(restoredText, /已恢复线程：openai-default-thread-1/);

  const visibleAgain = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-browser-batch',
    text: '/threads',
  });
  const visibleAgainText = visibleAgain.messages[0]?.text ?? '';
  assert.match(visibleAgainText, /thread three/);
  assert.match(visibleAgainText, /thread two/);
  assert.match(visibleAgainText, /thread one/);
});

test('/threads pin and /threads unpin keep pinned threads at the top and support pinned-only view', async () => {
  const { runtime } = makeRuntime();

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-pin-1',
    text: 'alpha thread',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-pin-2',
    text: 'beta thread',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-pin-3',
    text: 'gamma thread',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-pin-browser',
    text: '/threads',
  });

  const pinned = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-pin-browser',
    text: '/threads pin 2 3',
  });
  const pinnedText = pinned.messages.map((message) => message.text ?? '').join('\n');
  assert.match(pinnedText, /已置顶线程：openai-default-thread-2/);
  assert.match(pinnedText, /已置顶线程：openai-default-thread-1/);

  const defaultView = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-pin-browser',
    text: '/threads',
  });
  const defaultText = defaultView.messages[0]?.text ?? '';
  assert.match(defaultText, /1\. OpenAI Default thread [12] \[置顶\]/u);
  assert.match(defaultText, /2\. OpenAI Default thread [12] \[置顶\]/u);
  assert.match(defaultText, /3\. OpenAI Default thread 3/u);

  const pinnedView = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-pin-browser',
    text: '/threads pin',
  });
  const pinnedViewText = pinnedView.messages[0]?.text ?? '';
  assert.match(pinnedViewText, /视图：仅置顶/);
  assert.match(pinnedViewText, /OpenAI Default thread 2 \[置顶\]/);
  assert.match(pinnedViewText, /OpenAI Default thread 1 \[置顶\]/);
  assert.doesNotMatch(pinnedViewText, /OpenAI Default thread 3/);
  assert.match(pinnedViewText, /\/threads unpin 1/);

  const unpinned = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-pin-browser',
    text: '/threads unpin 1',
  });
  assert.match(unpinned.messages[0]?.text ?? '', /已取消置顶：openai-default-thread-2/);

  const pinnedViewAfterUnpin = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-pin-browser',
    text: '/threads pin',
  });
  const pinnedAfterText = pinnedViewAfterUnpin.messages[0]?.text ?? '';
  assert.doesNotMatch(pinnedAfterText, /OpenAI Default thread 2 \[置顶\]/);
  assert.match(pinnedAfterText, /OpenAI Default thread 1 \[置顶\]/);
});

test('/threads del natural language creates a pending batch draft and /threads confirm applies it', async () => {
  const { runtime, openai } = makeRuntime();

  const invoiceOne = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-thread-skill-archive-1',
    text: '丹达第四期发票提交',
  });
  const invoiceTwo = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-thread-skill-archive-2',
    text: '发票补充资料整理',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-thread-skill-archive-3',
    text: '构建回归排查',
  });

  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (params: any) => {
    const parserInput = normalizeCommandSkillInput(params?.inputText);
    if (parserInput.includes('docs/command-skills/threads.md') && parserInput.includes('"command": "threads"')) {
      assert.deepEqual(params?.event?.metadata?.codexbridge?.developerPromptContext, {
        mode: 'command-skill-parser',
        title: 'Thread Command Skill',
        source: 'thread-command-skill',
        command: 'threads',
        subcommand: 'archive',
        operation: 'archive',
      });
      return {
        outputText: JSON.stringify({
          schemaVersion: 'codexbridge.thread-command-skill.v1',
          ok: true,
          action: 'propose_archive_threads',
          confidence: 0.92,
          requiresConfirmation: true,
          summary: '归档发票相关旧线程。',
          reason: '这些线程都与发票跟进有关。',
          candidateThreadIds: [
            invoiceOne.session?.codexThreadId,
            invoiceTwo.session?.codexThreadId,
          ],
        }),
      };
    }
    return originalStartTurn(params);
  };

  const draft = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-thread-skill-browser',
    text: '/threads del 把发票相关旧线程归档',
  });
  const draftText = draft.messages.map((message) => message.text ?? '').join('\n');
  assert.match(draftText, /线程批量操作待确认/);
  assert.match(draftText, /动作：归档线程/);
  assert.match(draftText, /摘要：归档发票相关旧线程/);
  assert.match(draftText, /丹达第四期发票提交/);
  assert.match(draftText, /发票补充资料整理/);
  assert.match(draftText, /确认：\/threads confirm/);
  assert.match(draftText, /取消：\/threads cancel/);

  const confirmed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-thread-skill-browser',
    text: '/threads confirm',
  });
  const confirmedText = confirmed.messages.map((message) => message.text ?? '').join('\n');
  assert.match(confirmedText, new RegExp(`已归档线程：${invoiceOne.session?.codexThreadId}`));
  assert.match(confirmedText, new RegExp(`已归档线程：${invoiceTwo.session?.codexThreadId}`));
  assert.deepEqual(openai.archiveThreadCalls.map((call: any) => call.threadId).sort(), [
    invoiceOne.session?.codexThreadId,
    invoiceTwo.session?.codexThreadId,
  ].sort());

  const defaultView = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-thread-skill-browser',
    text: '/threads',
  });
  const defaultText = defaultView.messages[0]?.text ?? '';
  assert.doesNotMatch(defaultText, /丹达第四期发票提交/);
  assert.doesNotMatch(defaultText, /发票补充资料整理/);
  assert.match(defaultText, /构建回归排查/);

  const allView = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-thread-skill-browser',
    text: '/threads all',
  });
  const allText = allView.messages[0]?.text ?? '';
  assert.match(allText, /视图：全部（含已归档）/);
  assert.match(allText, /OpenAI Default thread 1 \[已归档\]/);
  assert.match(allText, /OpenAI Default thread 2 \[已归档\]/);
});

test('/threads cancel clears a pending natural-language batch draft', async () => {
  const { runtime, openai } = makeRuntime();

  const pinnedCandidate = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-thread-skill-pin-1',
    text: 'DailyWork 周报整理',
  });

  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (params: any) => {
    const parserInput = normalizeCommandSkillInput(params?.inputText);
    if (parserInput.includes('docs/command-skills/threads.md') && parserInput.includes('"subcommand": "pin"')) {
      return {
        outputText: JSON.stringify({
          schemaVersion: 'codexbridge.thread-command-skill.v1',
          ok: true,
          action: 'propose_pin_threads',
          confidence: 0.9,
          requiresConfirmation: true,
          summary: '置顶 DailyWork 相关线程。',
          reason: '它是当前反复查看的工作线程。',
          candidateThreadIds: [pinnedCandidate.session?.codexThreadId],
        }),
      };
    }
    return originalStartTurn(params);
  };

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-thread-skill-pin-browser',
    text: '/threads pin DailyWork 相关线程',
  });
  const cancelled = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-thread-skill-pin-browser',
    text: '/threads cancel',
  });
  assert.match(cancelled.messages[0]?.text ?? '', /已取消当前线程批量操作草案/);

  const confirmAfterCancel = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-thread-skill-pin-browser',
    text: '/threads confirm',
  });
  assert.match(confirmAfterCancel.messages[0]?.text ?? '', /当前没有待确认的线程批量操作/);
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

test('/retry resumes the same thread and reruns the previous request on the same binding', async () => {
  const { runtime, openai } = makeRuntime();

  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-retry-1',
    text: 'hello retry',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-retry-1',
    text: '/retry',
  });

  assert.equal(openai.resumeThreadCalls.length, 1);
  assert.equal(openai.startTurnCalls.length, 2);
  assert.equal(openai.startTurnCalls[1]?.inputText, 'hello retry');
  assert.equal(openai.startTurnCalls[1]?.event?.metadata?.codexbridge?.retryContext?.threadId, original.session?.codexThreadId);
  assert.equal(result.messages[0]?.text ?? '', 'openai: hello retry');
  assert.equal(result.session?.bridgeSessionId, original.session?.bridgeSessionId);
  assert.equal(result.session?.codexThreadId, original.session?.codexThreadId);
});

test('/retry stops live turns before rerunning the previous request', async () => {
  const { runtime, openai } = makeRuntime();

  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-retry-stop-1',
    text: 'hello retry stop',
  });
  const session = original.session;
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-retry-stop-1',
  };
  runtime.services.activeTurns.beginScopeTurn(scopeRef, {
    bridgeSessionId: session.bridgeSessionId,
    providerProfileId: session.providerProfileId,
    threadId: session.codexThreadId,
    turnId: `${session.codexThreadId}-turn-live`,
  });
  const thread = openai.threads.get(session.codexThreadId);
  assert.ok(thread);
  thread.turns = [{
    id: `${session.codexThreadId}-turn-live`,
    status: 'running',
    error: null,
    items: [],
  }];
  openai.interruptTurn = async (params) => {
    openai.interruptTurnCalls.push(params);
    const currentThread = openai.threads.get(params.threadId);
    assert.ok(currentThread);
    currentThread.turns = [{
      id: params.turnId,
      status: 'interrupted',
      error: 'Conversation interrupted',
      items: [],
    }];
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    ...scopeRef,
    text: '/retry',
  });

  assert.equal(openai.interruptTurnCalls.length, 1);
  assert.equal(openai.resumeThreadCalls.length, 1);
  assert.equal(openai.startTurnCalls.at(-1)?.inputText, 'hello retry stop');
  assert.deepEqual(
    openai.startTurnCalls.at(-1)?.event?.metadata?.codexbridge?.retryContext?.interruptedTurnIds,
    [`${session.codexThreadId}-turn-live`],
  );
  assert.equal(result.messages[0]?.text ?? '', 'openai: hello retry stop');
});

test('/review runs a native review for uncommitted changes without rebinding the current session thread', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  const first = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-review-1',
    text: 'hello review',
  });
  const originalThreadId = first.session?.codexThreadId;

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-review-1',
    text: '/review',
  });

  assert.equal(openai.startReviewCalls.length, 1);
  assert.deepEqual(openai.startReviewCalls[0]?.target, {
    type: 'uncommittedChanges',
  });
  assert.equal(openai.startReviewCalls[0]?.bridgeSession?.codexThreadId, originalThreadId);
  assert.equal(result.session?.codexThreadId, originalThreadId);
  assert.match(result.messages[0]?.text ?? '', /代码审查 \| 未提交改动/);
  assert.match(result.messages[0]?.text ?? '', /已按当前语言输出代码审查结果/);
});

test('/review base main targets base-branch review and can run without an existing session', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-review-2',
    text: '/review base main',
  });

  assert.equal(openai.startReviewCalls.length, 1);
  assert.equal(openai.startReviewCalls[0]?.cwd, '/tmp/openai-default');
  assert.deepEqual(openai.startReviewCalls[0]?.target, {
    type: 'baseBranch',
    branch: 'main',
  });
  assert.equal(result.session ?? null, null);
  assert.match(result.messages[0]?.text ?? '', /代码审查 \| 相对分支 main/);
  assert.match(result.messages[0]?.text ?? '', /已按当前语言输出代码审查结果/);
});

test('/review emits an immediate localized progress update before waiting for the native review result', async () => {
  const { runtime } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  const progressEvents: Array<{ text: string; outputKind: string }> = [];

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-review-progress-1',
    text: '/review',
  }, {
    onProgress: async (progress: any) => {
      progressEvents.push({
        text: String(progress?.text ?? ''),
        outputKind: String(progress?.outputKind ?? ''),
      });
    },
  });

  assert.equal(progressEvents.length >= 1, true);
  assert.match(progressEvents[0]?.text ?? '', /正在运行代码审查：代码审查 \| 未提交改动。/);
  assert.equal(progressEvents[0]?.outputKind ?? '', 'commentary');
  assert.match(result.messages[0]?.text ?? '', /代码审查 \| 未提交改动/);
});

test('/review forwards the active session locale into the native review request', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-review-locale-1',
    text: '/lang en',
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-review-locale-1',
    text: '/review',
  });

  assert.equal(openai.startReviewCalls.length, 1);
  assert.equal(openai.startReviewCalls[0]?.locale, 'en');
});

test('/review keeps English native review text when locale is en', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-review-en-result-1',
    text: '/lang en',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-review-en-result-1',
    text: '/review base main',
  });

  assert.equal(openai.startReviewCalls.length, 1);
  assert.match(result.messages[0]?.text ?? '', /Code review \| Base branch main/);
  assert.match(result.messages[0]?.text ?? '', /openai review: base main/);
  assert.doesNotMatch(result.messages[0]?.text ?? '', /已按当前语言输出代码审查结果/);
});

test('/review clears the active scope turn if the initial progress delivery fails', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  const scopeRef = {
    platform: 'weixin',
    externalScopeId: 'wx-user-review-progress-fail-1',
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: scopeRef.externalScopeId,
    text: '/review',
  }, {
    onProgress: async () => {
      throw new Error('preview send failed');
    },
  });

  assert.match(result.messages[0]?.text ?? '', /代码审查失败：preview send failed/);
  assert.equal(openai.startReviewCalls.length, 0);
  assert.equal(runtime.services.activeTurns.resolveScopeTurn(scopeRef), null);
});

test('/review custom <instructions> targets the explicit custom review path without invoking the parser skill', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-review-custom-1',
    text: '/review custom 只审查测试目录里的改动',
  });

  assert.equal(openai.startTurnCalls.some((call: any) => normalizeCommandSkillInput(call.inputText).includes('docs/command-skills/review.md')), false);
  assert.equal(openai.startReviewCalls.length, 1);
  assert.deepEqual(openai.startReviewCalls[0]?.target, {
    type: 'custom',
    instructions: '只审查测试目录里的改动',
  });
  assert.match(result.messages[0]?.text ?? '', /代码审查 \| 自定义目标/);
  assert.match(result.messages[0]?.text ?? '', /已按当前语言输出代码审查结果/);
});

test('/review natural language uses the review command skill and preserves structured custom options', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (params: any) => {
    const parserInput = normalizeCommandSkillInput(params?.inputText);
    if (parserInput.includes('docs/command-skills/review.md') && parserInput.includes('"command": "review"')) {
      assert.deepEqual(params?.event?.metadata?.codexbridge?.developerPromptContext, {
        mode: 'command-skill-parser',
        title: 'Review Command Skill',
        source: 'review-command-skill',
        command: 'review',
        subcommand: 'natural',
        operation: null,
      });
      assert.match(parserInput, /"customOptions": \[/);
      assert.doesNotMatch(parserInput, /outputLanguage/);
      return {
        outputText: JSON.stringify({
          schemaVersion: 'codexbridge.review-command-skill.v1',
          ok: true,
          action: 'run_review',
          confidence: 0.96,
          requiresConfirmation: false,
          target: {
            type: 'custom',
            instructions: '只审查 Agent 状态流转相关的改动，重点看回归风险。',
            focus: ['状态流转', '回归风险'],
            includePaths: ['src/core/bridge_coordinator.ts', 'test/core/bridge_coordinator.test.ts'],
            excludePaths: ['docs/'],
          },
        }),
      };
    }
    return originalStartTurn(params);
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-review-natural-1',
    text: '/review 重点看 Agent 状态流转相关改动的回归风险',
  });

  assert.equal(openai.startReviewCalls.length, 1);
  assert.deepEqual(openai.startReviewCalls[0]?.target, {
    type: 'custom',
    instructions: '只审查 Agent 状态流转相关的改动，重点看回归风险。',
    focus: ['状态流转', '回归风险'],
    includePaths: ['src/core/bridge_coordinator.ts', 'test/core/bridge_coordinator.test.ts'],
    excludePaths: ['docs/'],
  });
  assert.match(result.messages[0]?.text ?? '', /代码审查 \| 自定义目标/);
  assert.match(result.messages[0]?.text ?? '', /已按当前语言输出代码审查结果/);
});

test('/review natural language does not silently downgrade malformed skill targets to uncommitted changes', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (params: any) => {
    const parserInput = normalizeCommandSkillInput(params?.inputText);
    if (parserInput.includes('docs/command-skills/review.md') && parserInput.includes('"command": "review"')) {
      return {
        outputText: JSON.stringify({
          schemaVersion: 'codexbridge.review-command-skill.v1',
          ok: true,
          action: 'run_review',
          confidence: 0.91,
          requiresConfirmation: false,
          target: {
            branch: 'main',
          },
        }),
      };
    }
    return originalStartTurn(params);
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-review-natural-malformed-1',
    text: '/review 跟 main 比一下',
  });

  assert.equal(openai.startReviewCalls.length, 1);
  assert.deepEqual(openai.startReviewCalls[0]?.target, {
    type: 'custom',
    instructions: '跟 main 比一下',
  });
  assert.match(result.messages[0]?.text ?? '', /代码审查 \| 自定义目标/);
});

test('/review custom output follows locale and stays English when locale is en', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-review-explicit-zh-1',
    text: '/lang en',
  });

  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (params: any) => {
    const parserInput = normalizeCommandSkillInput(params?.inputText);
    if (parserInput.includes('docs/command-skills/review.md') && parserInput.includes('"command": "review"')) {
      return {
        outputText: JSON.stringify({
          schemaVersion: 'codexbridge.review-command-skill.v1',
          ok: true,
          action: 'run_review',
          confidence: 0.96,
          requiresConfirmation: false,
          target: {
            type: 'custom',
            instructions: 'Review Agent state-transition changes.',
            focus: ['状态流转'],
          },
        }),
      };
    }
    return originalStartTurn(params);
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-review-explicit-zh-1',
    text: '/review Review Agent state-transition changes',
  });

  assert.equal(openai.startReviewCalls.length, 1);
  assert.equal(openai.startReviewCalls[0]?.locale, 'en');
  assert.deepEqual(openai.startReviewCalls[0]?.target, {
    type: 'custom',
    instructions: 'Review Agent state-transition changes.',
    focus: ['状态流转'],
  });
  assert.equal(openai.startTurnCalls.some((call: any) =>
    normalizeCommandSkillInput(call.inputText).includes('CodexBridge review result localizer.'),
  ), false);
  assert.match(result.messages[0]?.text ?? '', /Code review \| Custom target/);
  assert.match(result.messages[0]?.text ?? '', /openai review: custom/);
});

test('/review natural language can reject execution requests and avoids starting review', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (params: any) => {
    const parserInput = normalizeCommandSkillInput(params?.inputText);
    if (parserInput.includes('docs/command-skills/review.md') && parserInput.includes('"command": "review"')) {
      return {
        outputText: JSON.stringify({
          schemaVersion: 'codexbridge.review-command-skill.v1',
          ok: false,
          action: 'reject',
          confidence: 0.98,
          requiresConfirmation: false,
          reason: '这是执行或修复请求，不是只读审查。应该使用 /agent。',
        }),
      };
    }
    return originalStartTurn(params);
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-review-reject-1',
    text: '/review 顺手把发现的问题也修了',
  });

  assert.equal(openai.startReviewCalls.length, 0);
  assert.match(result.messages[0]?.text ?? '', /应该使用 \/agent/);
});

test('/agent drafts, confirms, runs, verifies, and records a background job', async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const { runtime, openai } = makeRuntime({ defaultCwd: '/repo' });
    const draft = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-1',
      text: '/agent 检查当前项目测试并修复失败项',
    });
    const draftText = draft.messages.map((message) => message.text).join('\n');
    assert.match(draftText, /Agent 草案/);
    assert.match(draftText, /确认：\/agent confirm/);

    const created = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-1',
      text: '/agent confirm',
    });
    assert.match(created.messages.map((message) => message.text).join('\n'), /等待启动确认/);
    assert.match(created.messages.map((message) => message.text).join('\n'), /初版 checklist/);
    assert.equal(created.meta?.systemAction, undefined);

    const checklistConfirmed = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-1',
      text: '/agent confirm 1',
    });
    assert.match(checklistConfirmed.messages.map((message) => message.text).join('\n'), /immutable prompt/);
    assert.equal(checklistConfirmed.meta?.systemAction, undefined);

    const confirmed = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-1',
      text: '/agent confirm 1',
    });
    assert.match(confirmed.messages.map((message) => message.text).join('\n'), /Agent 任务已.*排队/);
    assert.equal(confirmed.meta?.systemAction?.kind, 'run_agent_sweep');

    const [job] = runtime.services.agentJobs.listForScope({
      platform: 'weixin',
      externalScopeId: 'wx-agent-1',
    });
    assert.equal(job.status, 'queued');
    assert.equal(job.maxAttempts, 2);

    const response = await runtime.services.bridgeCoordinator.runAgentJob(job);
    const responseText = response.messages.map((message) => message.text).join('\n');
    assert.match(responseText, /Agent 任务已完成/);
    assert.match(responseText, /基础检查通过/);

    const completed = runtime.services.agentJobs.getById(job.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.attemptCount, 1);
    assert.match(completed.resultText ?? '', /后台 Agent 任务/);
    assert.equal(openai.startTurnCalls.some((call) => String(call.inputText).includes('后台 Agent 任务')), true);

    const fullResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-1',
      text: '/agent result 1',
    });
    assert.match(fullResult.messages.map((message) => message.text).join('\n'), /Agent 结果/);
    assert.match(fullResult.messages.map((message) => message.text).join('\n'), /后台 Agent 任务/);

    const previewOnly = runtime.services.agentJobs.getById(job.id).lastResultPreview;
    runtime.services.agentJobs.updateJob(job.id, { resultText: previewOnly });
    const recoveredFromPreview = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-1',
      text: '/agent result 1',
    });
    const recoveredText = recoveredFromPreview.messages.map((message) => message.text).join('\n');
    assert.match(recoveredText, /Agent 结果/);
    assert.match(recoveredText, /最终回复必须包含/);
    assert.notEqual(runtime.services.agentJobs.getById(job.id).resultText, previewOnly);
  } finally {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  }
});

test('/agent edit updates the pending agent draft instead of replacing it', async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const { runtime, openai } = makeRuntime({ defaultCwd: '/repo' });
    const originalStartTurn = openai.startTurn.bind(openai);
    openai.startTurn = async (params: any) => {
      const parserInput = normalizeCommandSkillInput(params?.inputText);
      if (parserInput.includes('docs/command-skills/agent.md') && parserInput.includes('"subcommand": "natural"')) {
        assert.match(parserInput, /"command": "agent"/);
        return {
          outputText: JSON.stringify({
            action: 'create_draft',
            draft: {
              title: '修复测试失败项',
              goal: '检查当前项目测试并修复失败项',
              expectedOutput: '代码修复和测试结果',
              plan: ['检查测试失败日志', '修复失败代码', '重新运行测试并汇总结果'],
              category: 'code',
              riskLevel: 'medium',
              mode: 'codex',
            },
            confidence: 0.94,
            requiresConfirmation: true,
          }),
        };
      }
      if (parserInput.includes('docs/command-skills/agent.md') && parserInput.includes('"subcommand": "edit"')) {
        assert.match(parserInput, /"pendingDraft":/);
        assert.match(parserInput, /检查当前项目测试并修复失败项/);
        assert.match(parserInput, /只做方案，不改代码/);
        return {
          outputText: JSON.stringify({
            action: 'update_pending_draft',
            draft: {
              title: '测试修复方案',
              goal: '检查当前项目测试并修复失败项',
              expectedOutput: '一份修复方案和执行建议，不直接改代码',
              plan: ['检查测试失败范围', '整理可行修复思路', '输出建议的执行顺序和风险'],
              category: 'code',
              riskLevel: 'medium',
              mode: 'hybrid',
            },
            changes: ['限制为只做方案'],
            confidence: 0.94,
            requiresConfirmation: true,
          }),
        };
      }
      return originalStartTurn(params);
    };

    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-edit-1',
      text: '/agent 检查当前项目测试并修复失败项',
    });

    const edited = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-edit-1',
      text: '/agent edit 只做方案，不改代码',
    });

    const editText = edited.messages.map((message) => message.text).join('\n');
    assert.match(editText, /Agent 草案 \| 测试修复方案/);
    assert.match(editText, /目标：检查当前项目测试并修复失败项/);
    assert.match(editText, /交付物：一份修复方案和执行建议，不直接改代码/);
    assert.match(editText, /修改：\/agent edit <修改提示>/);

    const pending = runtime.services.bridgeCoordinator.getPendingAgentDraft({
      platform: 'weixin',
      externalScopeId: 'wx-agent-edit-1',
    });
    assert.ok(pending);
    assert.match(pending?.rawInput ?? '', /检查当前项目测试并修复失败项/);
    assert.match(pending?.rawInput ?? '', /Edit: 只做方案，不改代码/);
  } finally {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  }
});

test('/agent edit honors command skill reject without falling back to draft editing', async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const { runtime, openai } = makeRuntime({ defaultCwd: '/repo' });
    const originalStartTurn = openai.startTurn.bind(openai);
    openai.startTurn = async (params: any) => {
      const parserInput = normalizeCommandSkillInput(params?.inputText);
      if (parserInput.includes('docs/command-skills/agent.md') && parserInput.includes('"subcommand": "natural"')) {
        return {
          outputText: JSON.stringify({
            action: 'create_draft',
            draft: {
              title: '检查发票流程',
              goal: '检查发票流程并输出处理建议',
              expectedOutput: '发票流程检查结果',
              plan: ['检查相关记录', '整理处理建议'],
              category: 'ops',
              riskLevel: 'medium',
              mode: 'codex',
            },
            confidence: 0.94,
            requiresConfirmation: true,
          }),
        };
      }
      if (parserInput.includes('docs/command-skills/agent.md') && parserInput.includes('"subcommand": "edit"')) {
        return {
          outputText: JSON.stringify({
            action: 'reject',
            reason: '这是定时任务，应该使用 /auto add 创建自动化。',
            confidence: 0.98,
            requiresConfirmation: false,
          }),
        };
      }
      return originalStartTurn(params);
    };

    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-edit-reject-1',
      text: '/agent 检查发票流程并输出处理建议',
    });

    const rejected = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-edit-reject-1',
      text: '/agent edit 改成每天上午9点自动检查',
    });

    const rejectedText = rejected.messages.map((message) => message.text).join('\n');
    assert.match(rejectedText, /这是定时任务，应该使用 \/auto add 创建自动化/);
    assert.doesNotMatch(rejectedText, /Agent 草案/);
    assert.doesNotMatch(rejectedText, /无法理解 Agent 请求/);

    const pending = runtime.services.bridgeCoordinator.getPendingAgentDraft({
      platform: 'weixin',
      externalScopeId: 'wx-agent-edit-reject-1',
    });
    assert.ok(pending);
    assert.equal(pending?.title, '检查发票流程');
    assert.doesNotMatch(pending?.rawInput ?? '', /每天上午9点自动检查/);
  } finally {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  }
});

test('/agent natural language list query uses the command skill instead of creating a draft', async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const { runtime, openai } = makeRuntime({ defaultCwd: '/repo' });
    const originalStartTurn = openai.startTurn.bind(openai);
    openai.startTurn = async (params: any) => {
      const parserInput = normalizeCommandSkillInput(params?.inputText);
      if (parserInput.includes('docs/command-skills/agent.md') && parserInput.includes('"subcommand": "natural"')) {
        if (parserInput.includes('看看现在有哪些 Agent 任务')) {
          return {
            outputText: JSON.stringify({
              action: 'query_jobs',
              query: {
                filterText: null,
              },
              confidence: 0.96,
              requiresConfirmation: false,
            }),
          };
        }
        return {
          outputText: JSON.stringify({
            action: 'create_draft',
            draft: {
              title: '项目总结',
              goal: '写一份项目总结',
              expectedOutput: '项目总结正文，并返回当前微信会话。',
              plan: ['梳理项目背景', '整理关键进展', '输出总结和风险'],
              category: 'doc',
              riskLevel: 'low',
              mode: 'agents',
            },
            confidence: 0.94,
            requiresConfirmation: true,
          }),
        };
      }
      return originalStartTurn(params);
    };

    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-natural-list-1',
      text: '/agent 写一份项目总结',
    });
    await fullyConfirmLatestAgentJob(runtime, 'wx-agent-natural-list-1');

    const listed = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-natural-list-1',
      text: '/agent 看看现在有哪些 Agent 任务',
    });

    const listedText = listed.messages.map((message) => message.text).join('\n');
    assert.match(listedText, /Agent 任务 \| 1 项/);
    assert.match(listedText, /项目总结/);
    assert.doesNotMatch(listedText, /Agent 草案/);
  } finally {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  }
});

test('/agent natural language falls back locally after one unparseable command skill result', async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const { runtime, openai } = makeRuntime({ defaultCwd: '/repo' });
    let commandSkillTurns = 0;
    const originalStartTurn = openai.startTurn.bind(openai);
    openai.startTurn = async (params: any) => {
      const parserInput = normalizeCommandSkillInput(params?.inputText);
      if (parserInput.includes('docs/command-skills/agent.md') && parserInput.includes('"subcommand": "natural"')) {
        commandSkillTurns += 1;
        return {
          outputText: 'not json',
        };
      }
      return originalStartTurn(params);
    };

    const response = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-parser-null-1',
      text: '/agent 检查项目测试失败原因并给我结论',
    });

    const responseText = response.messages.map((message) => message.text).join('\n');
    assert.equal(commandSkillTurns, 1);
    assert.match(responseText, /Agent 草案/);
    assert.doesNotMatch(responseText, /无法理解 Agent 请求/);
  } finally {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  }
});

test('/agent natural language proposes and confirms existing job management operations', async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const { runtime, openai } = makeRuntime({ defaultCwd: '/repo' });
    const originalStartTurn = openai.startTurn.bind(openai);
    openai.startTurn = async (params: any) => {
      const parserInput = normalizeCommandSkillInput(params?.inputText);
      if (parserInput.includes('docs/command-skills/agent.md') && parserInput.includes('"subcommand": "natural"')) {
        if (parserInput.includes('"userInput": "写一份项目总结"')) {
          return {
            outputText: JSON.stringify({
              action: 'create_draft',
              draft: {
                title: '项目总结',
                goal: '写一份项目总结',
                expectedOutput: '项目总结正文，并返回当前微信会话。',
                plan: ['梳理项目背景', '整理关键进展', '输出总结和风险'],
                category: 'doc',
                riskLevel: 'low',
                mode: 'agents',
              },
              confidence: 0.94,
              requiresConfirmation: true,
            }),
          };
        }
        if (parserInput.includes('"userInput": "把项目总结交付物改成只输出摘要，风险改成中"')) {
          return {
            outputText: JSON.stringify({
              action: 'propose_update_job',
              target: {
                index: 1,
                matchText: '项目总结',
              },
              patch: {
                expectedOutput: '项目总结摘要，并返回当前微信会话。',
                riskLevel: 'medium',
              },
              changes: ['Changed expected output to summary only.', 'Changed risk to medium.'],
              confidence: 0.93,
              requiresConfirmation: true,
            }),
          };
        }
        if (parserInput.includes('"userInput": "把项目总结改名成月度总结"')) {
          return {
            outputText: JSON.stringify({
              action: 'propose_rename_job',
              target: {
                index: 1,
                matchText: '项目总结',
              },
              newTitle: '月度总结',
              confidence: 0.93,
              requiresConfirmation: true,
            }),
          };
        }
        if (parserInput.includes('"userInput": "重跑月度总结"')) {
          return {
            outputText: JSON.stringify({
              action: 'propose_retry_job',
              target: {
                matchText: '月度总结',
              },
              reason: '用户要求重新执行该 Agent 任务。',
              confidence: 0.92,
              requiresConfirmation: true,
            }),
          };
        }
        if (parserInput.includes('"userInput": "删掉月度总结"')) {
          return {
            outputText: JSON.stringify({
              action: 'propose_delete_job',
              target: {
                matchText: '月度总结',
              },
              reason: '用户要求删除这个 Agent 任务记录。',
              confidence: 0.92,
              requiresConfirmation: true,
            }),
          };
        }
      }
      return originalStartTurn(params);
    };

    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-natural-manage-1',
      text: '/agent 写一份项目总结',
    });
    await fullyConfirmLatestAgentJob(runtime, 'wx-agent-natural-manage-1');

    const updateDraft = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-natural-manage-1',
      text: '/agent 把项目总结交付物改成只输出摘要，风险改成中',
    });
    const updateDraftText = updateDraft.messages.map((message) => message.text).join('\n');
    assert.match(updateDraftText, /Agent 操作草案 \| 更新任务/);
    assert.match(updateDraftText, /交付物：项目总结摘要/);
    assert.match(updateDraftText, /风险：中/);
    assert.equal(runtime.services.agentJobs.listForScope({
      platform: 'weixin',
      externalScopeId: 'wx-agent-natural-manage-1',
    })[0]?.expectedOutput, '项目总结正文，并返回当前微信会话。');

    const updated = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-natural-manage-1',
      text: '/agent confirm',
    });
    assert.match(updated.messages.map((message) => message.text).join('\n'), /Agent 任务已更新/);
    const updatedJob = runtime.services.agentJobs.listForScope({
      platform: 'weixin',
      externalScopeId: 'wx-agent-natural-manage-1',
    })[0];
    assert.equal(updatedJob?.title, '项目总结');
    assert.equal(updatedJob?.expectedOutput, '项目总结摘要，并返回当前微信会话。');
    assert.equal(updatedJob?.riskLevel, 'medium');

    const renameDraft = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-natural-manage-1',
      text: '/agent 把项目总结改名成月度总结',
    });
    const renameDraftText = renameDraft.messages.map((message) => message.text).join('\n');
    assert.match(renameDraftText, /Agent 操作草案 \| 重命名任务/);
    assert.match(renameDraftText, /标题：月度总结/);
    assert.equal(runtime.services.agentJobs.listForScope({
      platform: 'weixin',
      externalScopeId: 'wx-agent-natural-manage-1',
    })[0]?.title, '项目总结');

    const pendingPreview = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-natural-manage-1',
      text: '/agent',
    });
    assert.match(pendingPreview.messages.map((message) => message.text).join('\n'), /Agent 操作草案 \| 重命名任务/);

    const renamed = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-natural-manage-1',
      text: '/agent confirm',
    });
    assert.match(renamed.messages.map((message) => message.text).join('\n'), /Agent 任务标题已更新/);
    assert.equal(runtime.services.agentJobs.listForScope({
      platform: 'weixin',
      externalScopeId: 'wx-agent-natural-manage-1',
    })[0]?.title, '月度总结');

    const retryDraft = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-natural-manage-1',
      text: '/agent 重跑月度总结',
    });
    assert.match(retryDraft.messages.map((message) => message.text).join('\n'), /Agent 操作草案 \| 重试任务/);

    const retried = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-natural-manage-1',
      text: '/agent confirm',
    });
    assert.match(retried.messages.map((message) => message.text).join('\n'), /Agent 任务已重新排队/);
    assert.deepEqual(retried.meta?.systemAction, { kind: 'run_agent_sweep' });

    const deleteDraft = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-natural-manage-1',
      text: '/agent 删掉月度总结',
    });
    assert.match(deleteDraft.messages.map((message) => message.text).join('\n'), /Agent 操作草案 \| 删除任务/);

    const deleted = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-natural-manage-1',
      text: '/agent confirm',
    });
    assert.match(deleted.messages.map((message) => message.text).join('\n'), /Agent 任务已删除/);
    assert.equal(runtime.services.agentJobs.listForScope({
      platform: 'weixin',
      externalScopeId: 'wx-agent-natural-manage-1',
    }).length, 0);
  } finally {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  }
});

test('/agent natural language rejects malformed update patch enums instead of silently coercing them', async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const { runtime, openai } = makeRuntime({ defaultCwd: '/repo' });
    const originalStartTurn = openai.startTurn.bind(openai);
    openai.startTurn = async (params: any) => {
      const parserInput = normalizeCommandSkillInput(params?.inputText);
      if (parserInput.includes('docs/command-skills/agent.md') && parserInput.includes('"subcommand": "natural"')) {
        if (parserInput.includes('"userInput": "写一份项目总结"')) {
          return {
            outputText: JSON.stringify({
              action: 'create_draft',
              draft: {
                title: '项目总结',
                goal: '写一份项目总结',
                expectedOutput: '项目总结正文，并返回当前微信会话。',
                plan: ['梳理项目背景', '整理关键进展', '输出总结和风险'],
                category: 'doc',
                riskLevel: 'low',
                mode: 'agents',
              },
              confidence: 0.94,
              requiresConfirmation: true,
            }),
          };
        }
        if (parserInput.includes('"userInput": "把项目总结风险改成中并把模式改成plan"')) {
          return {
            outputText: JSON.stringify({
              action: 'propose_update_job',
              target: {
                index: 1,
                matchText: '项目总结',
              },
              patch: {
                riskLevel: '中',
                mode: 'plan',
              },
              changes: ['Changed risk and mode.'],
              confidence: 0.92,
              requiresConfirmation: true,
            }),
          };
        }
      }
      return originalStartTurn(params);
    };

    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-invalid-update-1',
      text: '/agent 写一份项目总结',
    });
    await fullyConfirmLatestAgentJob(runtime, 'wx-agent-invalid-update-1');

    const rejected = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-invalid-update-1',
      text: '/agent 把项目总结风险改成中并把模式改成plan',
    });
    const rejectedText = rejected.messages.map((message) => message.text).join('\n');
    assert.match(rejectedText, /这条 Agent 请求没有被大模型可靠整理成草案/);

    const pendingOperation = runtime.services.bridgeCoordinator.getPendingAgentOperation({
      platform: 'weixin',
      externalScopeId: 'wx-agent-invalid-update-1',
    });
    assert.equal(pendingOperation, null);

    const job = runtime.services.agentJobs.listForScope({
      platform: 'weixin',
      externalScopeId: 'wx-agent-invalid-update-1',
    })[0];
    assert.equal(job?.riskLevel, 'low');
    assert.equal(job?.mode, 'agents');
  } finally {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  }
});

test('/agent natural language can show, export, and resend existing job outputs', async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-natural-output-'));
    const reportPath = path.join(tempDir, 'report.txt');
    fs.writeFileSync(reportPath, 'report file');
    const { runtime, openai } = makeRuntime({ defaultCwd: tempDir });
    const originalStartTurn = openai.startTurn.bind(openai);
    openai.startTurn = async (params: any) => {
      const parserInput = normalizeCommandSkillInput(params?.inputText);
      if (parserInput.includes('docs/command-skills/agent.md') && parserInput.includes('"subcommand": "natural"')) {
        if (parserInput.includes('"userInput": "生成报告"')) {
          return {
            outputText: JSON.stringify({
              action: 'create_draft',
              draft: {
                title: '报告任务',
                goal: '生成一份报告',
                expectedOutput: '报告正文和附件。',
                plan: ['整理材料', '生成报告', '返回结果'],
                category: 'doc',
                riskLevel: 'low',
                mode: 'agents',
              },
              confidence: 0.94,
              requiresConfirmation: true,
            }),
          };
        }
        if (parserInput.includes('"userInput": "查看报告结果"')) {
          return {
            outputText: JSON.stringify({
              action: 'show_result',
              target: {
                index: 1,
                matchText: '报告任务',
              },
              confidence: 0.93,
              requiresConfirmation: false,
            }),
          };
        }
        if (parserInput.includes('"userInput": "导出报告结果"')) {
          return {
            outputText: JSON.stringify({
              action: 'export_result',
              target: {
                index: 1,
                matchText: '报告任务',
              },
              confidence: 0.93,
              requiresConfirmation: false,
            }),
          };
        }
        if (parserInput.includes('"userInput": "把报告附件再发我"')) {
          return {
            outputText: JSON.stringify({
              action: 'send_attachments',
              target: {
                index: 1,
                matchText: '报告任务',
              },
              confidence: 0.93,
              requiresConfirmation: false,
            }),
          };
        }
      }
      return originalStartTurn(params);
    };

    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-natural-output-1',
      text: '/agent 生成报告',
    });
    await fullyConfirmLatestAgentJob(runtime, 'wx-agent-natural-output-1');
    const [job] = runtime.services.agentJobs.listForScope({
      platform: 'weixin',
      externalScopeId: 'wx-agent-natural-output-1',
    });
    runtime.services.agentJobs.updateJob(job.id, {
      status: 'completed',
      resultText: '这是完整报告结果。',
      lastResultPreview: '这是完整报告结果。',
      resultArtifacts: [{
        kind: 'file',
        path: reportPath,
        displayName: 'report.txt',
        mimeType: 'text/plain',
        sizeBytes: 11,
        caption: '报告附件',
        source: 'bridge_declared',
        turnId: null,
      }],
    });

    const shown = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-natural-output-1',
      text: '/agent 查看报告结果',
    });
    assert.match(shown.messages.map((message) => message.text).join('\n'), /Agent 结果/);
    assert.match(shown.messages.map((message) => message.text).join('\n'), /这是完整报告结果/);

    const exported = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-natural-output-1',
      text: '/agent 导出报告结果',
    });
    assert.match(exported.messages.map((message) => message.text).join('\n'), /TXT 附件/);
    assert.equal(exported.messages.some((message) => message.mediaPath?.endsWith('.txt')), true);

    const resent = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-natural-output-1',
      text: '/agent 把报告附件再发我',
    });
    assert.match(resent.messages.map((message) => message.text).join('\n'), /正在重新发送 Agent 附件/);
    assert.equal(resent.messages.some((message) => message.mediaPath === reportPath), true);
  } finally {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  }
});

test('/agent stores generated attachments and can resend them', async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const { runtime, openai } = makeRuntime({ defaultCwd: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-artifacts-')) });
    openai.startTurn = async ({ providerProfile, bridgeSession, sessionSettings, event, inputText, onTurnStarted = null }) => {
      const parserResult = await maybeReturnArtifactIntentParserResult({
        bridgeSession,
        onTurnStarted,
        decision: {
          action: 'deliver_file',
          preferredKind: 'file',
          requestedFormat: 'docx',
          explicit: true,
          confidence: 0.99,
          reason: '任务明确要求返回一份 Word 报告。',
        },
      });
      if (parserResult) {
        return parserResult;
      }
      openai.startTurnCalls.push({ providerProfile, bridgeSession, sessionSettings, event, inputText });
      const turnId = 'agent-artifact-turn-1';
      await onTurnStarted?.({
        turnId,
        threadId: bridgeSession.codexThreadId,
      });
      const context = event?.metadata?.codexbridge?.turnArtifactContext;
      assert.ok(context?.artifactDir);
      const reportPath = path.join(context.artifactDir, 'report.docx');
      fs.writeFileSync(reportPath, 'fake docx');
      return {
        outputText: `已生成报告。\n\n\`\`\`codexbridge-artifacts\n[{"path":${JSON.stringify(reportPath)},"kind":"file","displayName":"report.docx","caption":"Word 报告"}]\n\`\`\``,
        outputState: 'complete',
        turnId,
        threadId: bridgeSession.codexThreadId,
        title: bridgeSession.title,
      };
    };

    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-artifacts-1',
      text: '/agent 生成一份 Word 报告发给我',
    });
    await fullyConfirmLatestAgentJob(runtime, 'wx-agent-artifacts-1');
    const [job] = runtime.services.agentJobs.listForScope({
      platform: 'weixin',
      externalScopeId: 'wx-agent-artifacts-1',
    });

    const response = await runtime.services.bridgeCoordinator.runAgentJob(job);
    const responseText = response.messages.map((message) => message.text).filter(Boolean).join('\n');
    assert.match(responseText, /Agent 任务已完成/);
    assert.match(responseText, /附件：1 个，正在发送。/);
    assert.doesNotMatch(responseText, /codexbridge-artifacts/);
    assert.equal(response.messages.some((message) => message.mediaPath?.endsWith('report.docx')), true);

    const completed = runtime.services.agentJobs.getById(job.id);
    assert.equal(completed.resultArtifacts?.length, 1);
    assert.equal(completed.resultArtifacts?.[0]?.displayName, 'report.docx');
    assert.match(completed.resultText ?? '', /已生成报告/);

    const show = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-artifacts-1',
      text: '/agent show 1',
    });
    assert.match(show.messages.map((message) => message.text).join('\n'), /附件：/);
    assert.match(show.messages.map((message) => message.text).join('\n'), /report\.docx/);

    runtime.services.agentJobs.updateJob(job.id, { resultText: null });
    const recoveredResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-artifacts-1',
      text: '/agent result 1',
    });
    assert.match(recoveredResult.messages.map((message) => message.text).join('\n'), /Agent 结果/);
    assert.match(recoveredResult.messages.map((message) => message.text).join('\n'), /已生成报告/);

    const resultFile = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-artifacts-1',
      text: '/agent result 1 file',
    });
    assert.match(resultFile.messages.map((message) => message.text).join('\n'), /TXT 附件/);
    assert.equal(resultFile.messages.some((message) => message.mediaPath?.endsWith('.txt')), true);

    const resend = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-artifacts-1',
      text: '/agent send 1',
    });
    assert.match(resend.messages.map((message) => message.text).join('\n'), /正在重新发送 Agent 附件/);
    assert.equal(resend.messages.some((message) => message.mediaPath?.endsWith('report.docx')), true);
  } finally {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  }
});

test('/agent show, retry, rename, stop, and delete manage queued jobs', async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const { runtime } = makeRuntime({ defaultCwd: '/repo' });
    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-2',
      text: '/agent 写一份项目总结',
    });
    await fullyConfirmLatestAgentJob(runtime, 'wx-agent-2');
    const show = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-2',
      text: '/agent show 1',
    });
    const showText = show.messages.map((message) => message.text).join('\n');
    assert.match(showText, /Agent 详情/);
    assert.match(showText, /工作流：/);

    const renamed = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-2',
      text: '/agent rename 1 项目总结',
    });
    assert.match(renamed.messages.map((message) => message.text).join('\n'), /项目总结/);

    const stopped = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-2',
      text: '/agent stop 1',
    });
    assert.match(stopped.messages.map((message) => message.text).join('\n'), /Agent 任务已请求停止/);

    const retried = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-2',
      text: '/agent retry 1',
    });
    assert.match(retried.messages.map((message) => message.text).join('\n'), /Agent 任务已重新排队/);

    const deleted = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-2',
      text: '/agent del 1',
    });
    assert.match(deleted.messages.map((message) => message.text).join('\n'), /Agent 任务已删除/);
  } finally {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  }
});

test('/agent list, show, result, stop, and retry prefer Mission Control runtime state over stale compatibility fields', async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const { runtime } = makeRuntime({ defaultCwd: '/repo' });
    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-mission-state-1',
      text: '/agent 汇总当前修复进展并给出最终结论',
    });
    await fullyConfirmLatestAgentJob(runtime, 'wx-agent-mission-state-1');

    const [job] = runtime.services.agentJobs.listForScope({
      platform: 'weixin',
      externalScopeId: 'wx-agent-mission-state-1',
    });
    assert.ok(job);
    const session = runtime.services.bridgeSessions.getSessionById(job.bridgeSessionId);
    const missionUpdatedAt = Date.now();
    const attemptId = `${job.id}-mission-attempt-1`;
    const runtimeArtifactPath = path.join(os.tmpdir(), `${job.id}-mission-runtime-report.md`);
    fs.writeFileSync(runtimeArtifactPath, '# Mission Control report\n');
    const completedState = {
      mission: {
        id: job.id,
        source: 'weixin',
        sourceRef: job.id,
        platform: job.platform,
        externalScopeId: job.externalScopeId,
        title: job.title,
        goal: job.goal,
        expectedOutput: job.expectedOutput,
        acceptanceCriteria: [job.expectedOutput],
        plan: [...job.plan],
        status: 'completed',
        priority: 'normal',
        riskLevel: job.riskLevel,
        cwd: job.cwd,
        workspacePath: null,
        workflowPath: null,
        providerProfileId: job.providerProfileId,
        bridgeSessionId: job.bridgeSessionId,
        codexThreadId: session?.codexThreadId ?? null,
        activeAttemptId: attemptId,
        attemptCount: 1,
        maxAttempts: job.maxAttempts,
        maxTurns: 8,
        lastRunAt: missionUpdatedAt - 500,
        completedAt: missionUpdatedAt,
        archivedAt: null,
        stoppedAt: null,
        lastResultPreview: 'Mission Control 已完成结果。',
        resultText: 'Mission Control 已完成结果。\n\n验证通过，所有验收项已满足。',
        resultArtifacts: [{
          type: 'file',
          path: runtimeArtifactPath,
          name: 'mission-runtime-report.md',
          mimeType: 'text/markdown',
          caption: 'Mission Control report',
        }],
        lastError: null,
        statusReason: '修复已通过验证。',
        pendingApproval: null,
        lease: null,
        workpad: {
          summary: 'Mission Control 最终摘要。',
          latestPlan: [...job.plan],
          latestBlocker: null,
          latestVerifierSummary: '修复已通过验证。',
          finalResultSummary: 'Mission Control 已完成结果。',
          notes: [],
          updatedAt: missionUpdatedAt,
        },
        createdAt: job.createdAt,
        updatedAt: missionUpdatedAt,
      },
      attempts: [
        {
          id: attemptId,
          missionId: job.id,
          index: 1,
          status: 'completed',
          providerRunId: 'provider-run-1',
          providerThreadId: session?.codexThreadId ?? null,
          promptDigest: 'digest-1',
          verifierVerdict: 'complete',
          verifierSummary: '修复已通过验证。',
          missingAcceptanceCriteria: [],
          outputPreview: 'Mission Control 已完成结果。',
          error: null,
          startedAt: missionUpdatedAt - 500,
          endedAt: missionUpdatedAt,
          createdAt: missionUpdatedAt - 600,
          updatedAt: missionUpdatedAt,
        },
      ],
      events: [],
    };
    runtime.services.agentJobs.updateJob(job.id, {
      status: 'queued',
      running: false,
      attemptCount: 0,
      lastRunAt: null,
      completedAt: null,
      lastResultPreview: 'stale preview',
      resultText: 'stale wrong result',
      resultArtifacts: [{
        kind: 'file',
        path: '/tmp/stale-artifact.txt',
        displayName: 'stale-artifact.txt',
        mimeType: 'text/plain',
        sizeBytes: 12,
        caption: 'stale artifact',
        source: 'provider_native',
        turnId: null,
      }],
      lastError: 'stale error',
      verificationSummary: 'stale verification',
      missionWorkpadLatestBlocker: 'stale blocker',
      missionWorkpadLatestVerifierSummary: 'stale verifier',
      missionWorkpadFinalResultSummary: 'stale final summary',
      missionAttemptHistory: [],
      missionRuntimeState: completedState,
    });

    const listed = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-mission-state-1',
      text: '/agent',
    });
    const listedText = listed.messages.map((message) => message.text).join('\n');
    assert.match(listedText, /状态：已完成/);
    assert.match(listedText, /Mission Control 已完成结果。/);
    assert.doesNotMatch(listedText, /stale preview/);

    const showCompleted = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-mission-state-1',
      text: '/agent show 1',
    });
    const showCompletedText = showCompleted.messages.map((message) => message.text).join('\n');
    assert.match(showCompletedText, /Mission Control 最终摘要。/);
    assert.match(showCompletedText, /修复已通过验证。/);
    assert.match(showCompletedText, /mission-runtime-report\.md/);
    assert.doesNotMatch(showCompletedText, /stale-artifact\.txt/);
    assert.doesNotMatch(showCompletedText, /stale verification/);

    const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-mission-state-1',
      text: '/agent result 1',
    });
    const resultText = result.messages.map((message) => message.text).join('\n');
    assert.match(resultText, /Mission Control 已完成结果。/);
    assert.match(resultText, /所有验收项已满足。/);
    assert.doesNotMatch(resultText, /stale wrong result/);

    const waitingUserState = structuredClone(completedState);
    (waitingUserState.mission as Record<string, unknown>).status = 'waiting_user';
    (waitingUserState.mission as Record<string, unknown>).completedAt = null;
    (waitingUserState.mission as Record<string, unknown>).statusReason = '等待用户确认。';
    (waitingUserState.mission as Record<string, unknown>).lastError = '等待用户确认。';
    (waitingUserState.mission as Record<string, unknown>).workpad = {
      ...(waitingUserState.mission as any).workpad,
      latestBlocker: '等待用户确认。',
      latestVerifierSummary: '等待用户确认。',
      updatedAt: missionUpdatedAt + 1,
    };
    (waitingUserState.mission as Record<string, unknown>).updatedAt = missionUpdatedAt + 1;
    (waitingUserState.attempts[0] as Record<string, unknown>).status = 'waiting_user';
    (waitingUserState.attempts[0] as Record<string, unknown>).endedAt = null;
    (waitingUserState.attempts[0] as Record<string, unknown>).updatedAt = missionUpdatedAt + 1;
    const waitingChecklistSnapshot = createMissionChecklistSnapshot(waitingUserState.mission as any, {
      at: missionUpdatedAt + 1,
    });
    (waitingUserState as Record<string, unknown>).checklistSnapshots = [waitingChecklistSnapshot];
    (waitingUserState as Record<string, unknown>).events = [{
      id: `${job.id}-waiting-user-event-1`,
      missionId: job.id,
      attemptId,
      generationId: waitingChecklistSnapshot.generationId,
      generationIndex: 1,
      kind: 'mission.waiting_user',
      summary: '等待用户确认发布窗口。',
      detail: null,
      metadata: {
        cycleResult: createMissionCycleResult({
          mission: waitingUserState.mission as any,
          attempt: waitingUserState.attempts[0] as any,
          checklistSnapshot: waitingChecklistSnapshot,
          cycle: 2,
          status: 'waiting_user',
          stage: 'verifier.waiting_user',
          progress: '等待用户确认发布窗口。',
          nextStep: '等待用户提供发布时间窗口后再继续。',
          verifierSummary: '等待用户确认发布窗口。',
          blocker: '发布窗口尚未确认。',
          needUserAction: '请确认发布时间窗口。',
          eventSeq: 1,
          updatedAt: missionUpdatedAt + 1,
        }),
      },
      createdAt: missionUpdatedAt + 1,
    }];
    runtime.services.agentJobs.updateJob(job.id, {
      status: 'completed',
      running: false,
      stopRequested: false,
      missionRuntimeState: waitingUserState,
    });

    const showWaiting = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-mission-state-1',
      text: '/agent show 1',
    });
    const showWaitingText = showWaiting.messages.map((message) => message.text).join('\n');
    assert.match(showWaitingText, /当前循环：2/);
    assert.match(showWaitingText, /当前阶段：verifier\.waiting_user/);
    assert.match(showWaitingText, /当前进展：等待用户确认发布窗口。/);
    assert.match(showWaitingText, /总体完成：0%/);
    assert.match(showWaitingText, /当前清单项：/);
    assert.match(showWaitingText, /下一步：等待用户提供发布时间窗口后再继续。/);
    assert.match(showWaitingText, /需补充信息：请确认发布时间窗口。/);
    assert.match(showWaitingText, /补充信息并继续：\/agent confirm 1 <补充信息>/);
    assert.match(showWaitingText, /满足继续条件后：\/agent confirm 1/);
    assert.match(showWaitingText, /阻塞：等待用户确认。|阻塞：发布窗口尚未确认。/);
    assert.match(showWaitingText, /验证：等待用户确认。/);

    const resumed = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-mission-state-1',
      text: '/agent confirm 1 发布时间窗口改为今晚 21:00 UTC',
    });
    assert.match(resumed.messages.map((message) => message.text).join('\n'), /Agent 任务已确认继续，现已重新排队/);
    assert.match(resumed.messages.map((message) => message.text).join('\n'), /已记录补充信息：发布时间窗口改为今晚 21:00 UTC/);
    assert.equal(resumed.meta?.systemAction?.kind, 'run_agent_sweep');

    const resumedJob = runtime.services.agentJobs.getById(job.id);
    assert.equal((resumedJob?.missionRuntimeState?.mission as Record<string, unknown> | null)?.status, 'queued');
    assert.equal((resumedJob?.missionRuntimeState?.mission as Record<string, unknown> | null)?.activeGenerationIndex, 1);
    assert.equal(resumedJob?.missionRuntimeState?.attempts.length ?? -1, 1);
    assert.match(
      String((resumedJob?.missionRuntimeState?.mission as any)?.workpad?.notes?.at(-1) ?? ''),
      /发布时间窗口改为今晚 21:00 UTC/,
    );

    const maxLoopsState = structuredClone(completedState);
    (maxLoopsState.mission as Record<string, unknown>).status = 'max_loops_reached';
    (maxLoopsState.mission as Record<string, unknown>).completedAt = null;
    (maxLoopsState.mission as Record<string, unknown>).statusReason = 'Mission loop budget exhausted: max cycles reached (1/1).';
    (maxLoopsState.mission as Record<string, unknown>).lastError = 'Mission loop budget exhausted: max cycles reached (1/1).';
    (maxLoopsState.mission as Record<string, unknown>).workpad = {
      ...(maxLoopsState.mission as any).workpad,
      latestBlocker: 'Mission loop budget exhausted: max cycles reached (1/1).',
      latestVerifierSummary: 'Mission loop budget exhausted: max cycles reached (1/1).',
      updatedAt: missionUpdatedAt + 2,
    };
    (maxLoopsState.mission as Record<string, unknown>).updatedAt = missionUpdatedAt + 2;
    (maxLoopsState as Record<string, unknown>).events = [{
      id: `${job.id}-max-loops-event-1`,
      missionId: job.id,
      attemptId,
      generationId: (maxLoopsState.mission as any).activeGenerationId,
      generationIndex: 1,
      kind: 'mission.max_loops_reached',
      summary: 'Mission loop budget exhausted: max cycles reached (1/1).',
      detail: null,
      metadata: {
        cycleResult: createMissionCycleResult({
          mission: maxLoopsState.mission as any,
          attempt: maxLoopsState.attempts[0] as any,
          checklistSnapshot: createMissionChecklistSnapshot(maxLoopsState.mission as any, {
            at: missionUpdatedAt + 2,
          }),
          cycle: 3,
          status: 'failed',
          stage: 'runtime.max_cycles',
          progress: 'Mission loop budget exhausted: max cycles reached (1/1).',
          nextStep: 'Retry the mission to open a new generation with a fresh cycle budget.',
          verifierSummary: 'Mission loop budget exhausted: max cycles reached (1/1).',
          blocker: 'Mission loop budget exhausted: max cycles reached (1/1).',
          eventSeq: 2,
          updatedAt: missionUpdatedAt + 2,
        }),
      },
      createdAt: missionUpdatedAt + 2,
    }];
    runtime.services.agentJobs.getMissionRepository().saveMission(maxLoopsState.mission as any);
    runtime.services.agentJobs.getMissionRepository().appendEvent((maxLoopsState.events as any[])[0] as any);
    runtime.services.agentJobs.updateJob(job.id, {
      status: 'completed',
      running: false,
      stopRequested: false,
      missionRuntimeState: maxLoopsState,
    });

    const showMaxLoops = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-mission-state-1',
      text: '/agent show 1',
    });
    const showMaxLoopsText = showMaxLoops.messages.map((message) => message.text).join('\n');
    assert.match(showMaxLoopsText, /状态：已达到循环上限/);
    assert.match(showMaxLoopsText, /当前阶段：runtime\.max_cycles/);
    assert.match(showMaxLoopsText, /下一步：Retry the mission to open a new generation with a fresh cycle budget\./);

    runtime.services.agentJobs.updateJob(job.id, {
      status: 'completed',
      running: false,
      stopRequested: false,
      missionRuntimeState: structuredClone(waitingUserState),
    });
    runtime.services.agentJobs.getMissionRepository().saveMission(waitingUserState.mission as any);

    const stopped = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-mission-state-1',
      text: '/agent stop 1',
    });
    assert.match(stopped.messages.map((message) => message.text).join('\n'), /Agent 任务已请求停止/);

    const showStopped = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-mission-state-1',
      text: '/agent show 1',
    });
    const showStoppedText = showStopped.messages.map((message) => message.text).join('\n');
    assert.match(showStoppedText, /状态：已停止/);

    const retried = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-mission-state-1',
      text: '/agent retry 1',
    });
    assert.match(retried.messages.map((message) => message.text).join('\n'), /Agent 任务已重新排队/);

    const retriedJob = runtime.services.agentJobs.getById(job.id);
    assert.equal((retriedJob?.missionRuntimeState?.mission as Record<string, unknown> | null)?.status, 'queued');
    assert.equal(retriedJob?.missionRuntimeState?.attempts.length ?? -1, 1);
    assert.equal((retriedJob?.missionRuntimeState?.mission as Record<string, unknown> | null)?.activeGenerationIndex, 2);

    const showRetried = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-mission-state-1',
      text: '/agent show 1',
    });
    const showRetriedText = showRetried.messages.map((message) => message.text).join('\n');
    assert.match(showRetriedText, /状态：排队中/);
    assert.doesNotMatch(showRetriedText, /所有验收项已满足。/);
  } finally {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  }
});

test('/agent show and confirm resolve package-backed scope change proposals without new host commands', async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const { runtime } = makeRuntime({ defaultCwd: '/repo' });
    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-plan-change-1',
      text: '/agent 检查发布流程并补上 dry-run 验证',
    });
    const { index } = await fullyConfirmLatestAgentJob(runtime, 'wx-agent-plan-change-1');
    const [job] = runtime.services.agentJobs.listForScope({
      platform: 'weixin',
      externalScopeId: 'wx-agent-plan-change-1',
    });
    const runningDetail = runtime.services.agentJobs.getMissionDetail(job.id);
    const running = transitionMission(runningDetail!.mission, 'running', {
      at: (runningDetail?.mission.updatedAt ?? 0) + 1,
      activeAttemptId: `${job.id}-attempt-scope-change-1`,
    });
    running.attemptCount = 1;
    runtime.services.agentJobs.getMissionRepository().saveMission(running);

    runtime.services.agentJobs.proposePlanChange(job.id, {
      rationale: '需要把 release dry-run 纳入验收条件。',
      proposedExpectedOutput: '一份验证通过的修复总结，并附 release dry-run 结果。',
      proposedAcceptanceCriteria: ['补丁存在', '测试通过', 'release dry-run 通过'],
      proposedPlan: ['检查发布流程', '补齐 dry-run 验证', '重新核对验收条件'],
    });

    const showPending = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-plan-change-1',
      text: `/agent show ${index}`,
    });
    const showPendingText = showPending.messages.map((message) => message.text).join('\n');
    assert.match(showPendingText, /状态：等待确认范围变更/);
    assert.match(showPendingText, /待确认范围变更：/);
    assert.match(showPendingText, /变更原因：需要把 release dry-run 纳入验收条件。/);
    assert.match(showPendingText, /拟更新交付物：一份验证通过的修复总结，并附 release dry-run 结果。/);
    assert.match(showPendingText, /拟更新验收条件：/);
    assert.match(showPendingText, /批准并继续：\/agent confirm 1/);
    assert.match(showPendingText, /拒绝并继续当前清单：\/agent confirm 1 reject/);

    const rejected = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-plan-change-1',
      text: `/agent confirm ${index} reject`,
    });
    assert.match(rejected.messages.map((message) => message.text).join('\n'), /范围变更已拒绝/);
    assert.equal(rejected.meta?.systemAction?.kind, 'run_agent_sweep');

    const rejectedDetail = runtime.services.agentJobs.getMissionDetail(job.id);
    assert.equal(rejectedDetail?.mission.status, 'queued');
    assert.equal(rejectedDetail?.currentChecklistSnapshot?.version, 1);
    assert.equal(rejectedDetail?.planChangeRequests.at(-1)?.status, 'rejected');

    const rerunning = transitionMission(rejectedDetail!.mission, 'running', {
      at: rejectedDetail!.mission.updatedAt + 1,
      activeAttemptId: `${job.id}-attempt-scope-change-2`,
    });
    rerunning.attemptCount = 2;
    runtime.services.agentJobs.getMissionRepository().saveMission(rerunning);

    runtime.services.agentJobs.proposePlanChange(job.id, {
      rationale: '确认后把 dry-run 结果正式纳入交付和验收。',
      proposedExpectedOutput: '一份验证通过的修复总结，并附 release dry-run 结果。',
      proposedAcceptanceCriteria: ['补丁存在', '测试通过', 'release dry-run 通过'],
      proposedPlan: ['检查发布流程', '补齐 dry-run 验证', '重新核对验收条件'],
    });

    const approved = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-plan-change-1',
      text: `/agent confirm ${index}`,
    });
    assert.match(approved.messages.map((message) => message.text).join('\n'), /范围变更已确认/);
    assert.equal(approved.meta?.systemAction?.kind, 'run_agent_sweep');

    const approvedDetail = runtime.services.agentJobs.getMissionDetail(job.id);
    assert.equal(approvedDetail?.mission.status, 'queued');
    assert.equal(approvedDetail?.mission.expectedOutput, '一份验证通过的修复总结，并附 release dry-run 结果。');
    assert.deepEqual(
      approvedDetail?.mission.acceptanceCriteria,
      ['补丁存在', '测试通过', 'release dry-run 通过'],
    );
    assert.equal(approvedDetail?.currentChecklistSnapshot?.version, 2);
    assert.equal(approvedDetail?.planChangeRequests.at(-1)?.status, 'applied');
  } finally {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  }
});

test('/agent show and confirm can submit paused approval decisions with attached input without shell-log inspection', async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const { runtime } = makeRuntime({ defaultCwd: '/repo' });
    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-paused-approval-1',
      text: '/agent 准备发布说明并等待我确认发布时间窗',
    });
    const { index } = await fullyConfirmLatestAgentJob(runtime, 'wx-agent-paused-approval-1');
    const [job] = runtime.services.agentJobs.listForScope({
      platform: 'weixin',
      externalScopeId: 'wx-agent-paused-approval-1',
    });
    const detail = runtime.services.agentJobs.getMissionDetail(job.id);
    const running = transitionMission(detail!.mission, 'running', {
      at: detail!.mission.updatedAt + 1,
      activeAttemptId: `${job.id}-attempt-paused-approval-1`,
    });
    running.attemptCount = 1;
    const waiting = transitionMission(running, 'waiting_user', {
      at: running.updatedAt + 1,
      activeAttemptId: `${job.id}-attempt-paused-approval-1`,
      reason: 'Need approval on the deployment window before continuing.',
      lastError: 'Need approval on the deployment window before continuing.',
      pendingApproval: {
        requestId: `${job.id}-approval-paused-1`,
        kind: 'manual',
        summary: 'Approve or reject the deployment window before continuing.',
        options: [
          { index: 1, label: 'Approve window' },
          { index: 2, label: 'Reject window' },
        ],
        createdAt: running.updatedAt + 1,
      },
    });
    waiting.workpad.summary = 'Mission paused pending deployment-window approval.';
    waiting.workpad.latestBlocker = 'Need approval on the deployment window before continuing.';
    waiting.workpad.latestVerifierSummary = 'Waiting for the deployment-window decision.';
    runtime.services.agentJobs.getMissionRepository().saveMission(waiting);

    const showPending = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-paused-approval-1',
      text: `/agent show ${index}`,
    });
    const showPendingText = showPending.messages.map((message) => message.text).join('\n');
    assert.match(showPendingText, /待确认事项：Approve or reject the deployment window before continuing\./);
    assert.match(showPendingText, /确认并继续：\/agent confirm 1/);
    assert.match(showPendingText, /拒绝并继续：\/agent confirm 1 reject/);
    assert.match(showPendingText, /补充信息并继续：\/agent confirm 1 <补充信息>/);

    const rejected = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-paused-approval-1',
      text: `/agent confirm ${index} reject 今天先不要发，等明早 09:00 UTC`,
    });
    const rejectedText = rejected.messages.map((message) => message.text ?? '').join('\n');
    assert.match(rejectedText, /已记录拒绝决定/);
    assert.match(rejectedText, /已记录补充信息：今天先不要发，等明早 09:00 UTC/);
    assert.equal(rejected.meta?.systemAction?.kind, 'run_agent_sweep');

    const rejectedDetail = runtime.services.agentJobs.getMissionDetail(job.id);
    assert.equal(rejectedDetail?.mission.status, 'queued');
    assert.match(rejectedDetail?.workpadStatus.notes.at(-1) ?? '', /今天先不要发，等明早 09:00 UTC/);
  } finally {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  }
});

test('/agent runAgentJob retries after an interrupted provider turn and completes on the next attempt', async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const { runtime, openai } = makeRuntime({ defaultCwd: '/repo' });
    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-interrupted-1',
      text: '/agent 检查当前项目测试并修复失败项',
    });
    await fullyConfirmLatestAgentJob(runtime, 'wx-agent-interrupted-1');
    const [job] = runtime.services.agentJobs.listForScope({
      platform: 'weixin',
      externalScopeId: 'wx-agent-interrupted-1',
    });
    let executionAttempts = 0;
    const originalStartTurn = openai.startTurn.bind(openai);
    openai.startTurn = async (params: any) => {
      const inputText = String(params?.inputText ?? '');
      if (inputText.includes('你正在执行 CodexBridge 后台 Agent 任务。')) {
        executionAttempts += 1;
        const turnId = `${params.bridgeSession.codexThreadId}-agent-attempt-${executionAttempts}`;
        await params.onTurnStarted?.({
          turnId,
          threadId: params.bridgeSession.codexThreadId,
        });
        if (executionAttempts === 1) {
          return {
            outputText: '第一次执行中断。',
            outputState: 'interrupted',
            turnId,
            threadId: params.bridgeSession.codexThreadId,
            title: params.bridgeSession.title,
          };
        }
        return {
          outputText: '第二次执行完成，基础检查通过。',
          outputState: 'complete',
          turnId,
          threadId: params.bridgeSession.codexThreadId,
          title: params.bridgeSession.title,
        };
      }
      return originalStartTurn(params);
    };

    const response = await runtime.services.bridgeCoordinator.runAgentJob(job);
    const responseText = response.messages.map((message) => message.text).join('\n');
    assert.match(responseText, /Agent 任务已完成/);
    assert.match(responseText, /基础检查通过/);
    assert.equal(executionAttempts, 2);

    const completed = runtime.services.agentJobs.getById(job.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.attemptCount, 2);

    const show = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-interrupted-1',
      text: '/agent show 1',
    });
    const showText = show.messages.map((message) => message.text).join('\n');
    assert.match(showText, /尝试记录：/);
    assert.match(showText, /#2 completed/);
  } finally {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  }
});

test('/agent runAgentJob continues the same attempt after a normal partial provider exit', async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const { runtime, openai } = makeRuntime({ defaultCwd: '/repo' });
    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-continuation-1',
      text: '/agent 检查当前项目测试并修复失败项',
    });
    await fullyConfirmLatestAgentJob(runtime, 'wx-agent-continuation-1');
    const [job] = runtime.services.agentJobs.listForScope({
      platform: 'weixin',
      externalScopeId: 'wx-agent-continuation-1',
    });
    let executionTurns = 0;
    const capturedInputs: string[] = [];
    const originalStartTurn = openai.startTurn.bind(openai);
    openai.startTurn = async (params: any) => {
      const inputText = String(params?.inputText ?? '');
      if (inputText.includes('你正在执行 CodexBridge 后台 Agent 任务。')) {
        capturedInputs.push(inputText);
        executionTurns += 1;
        const turnId = `${params.bridgeSession.codexThreadId}-agent-continuation-${executionTurns}`;
        await params.onTurnStarted?.({
          turnId,
          threadId: params.bridgeSession.codexThreadId,
        });
        if (executionTurns === 1) {
          return {
            outputText: '已收集日志，但还没有完成最终验证。',
            previewText: '已收集日志，但还没有完成最终验证。',
            outputState: 'partial',
            turnId,
            threadId: params.bridgeSession.codexThreadId,
            title: params.bridgeSession.title,
          };
        }
        return {
          outputText: '继续同一次尝试后完成修复，并附上验证结果。',
          outputState: 'complete',
          turnId,
          threadId: params.bridgeSession.codexThreadId,
          title: params.bridgeSession.title,
        };
      }
      return originalStartTurn(params);
    };

    const response = await runtime.services.bridgeCoordinator.runAgentJob(job);
    const responseText = response.messages.map((message) => message.text).join('\n');
    assert.match(responseText, /Agent 任务已完成/);
    assert.match(responseText, /继续同一次尝试后完成修复/);
    assert.equal(executionTurns, 2);
    assert.match(capturedInputs[1] ?? '', /Continuation contract/);

    const completed = runtime.services.agentJobs.getById(job.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.attemptCount, 1);
    assert.ok(completed.missionRuntimeState);
    assert.equal(Array.isArray(completed.missionRuntimeState?.attempts), true);
    assert.equal(completed.missionRuntimeState?.attempts.length, 1);
    const providerTurnEvents = Array.isArray(completed.missionRuntimeState?.events)
      ? completed.missionRuntimeState.events.filter((event: any) => event?.kind === 'attempt.started' && event?.metadata?.providerTurn === true)
      : [];
    assert.equal(providerTurnEvents.length, 2);
  } finally {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  }
});

test('/agent runAgentJob loads WORKFLOW.md and routes it into the mission-controlled execution prompt', async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-workflow-prompt-'));
  const workflowPath = path.join(cwd, '.codexbridge', 'mission', 'WORKFLOW.md');
  fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
  fs.writeFileSync(workflowPath, `---
version: 1
maxTurns: 5
finalReportSections:
  - summary
  - verification
  - handoff
---
Always mention the workflow checkpoint before the final answer.
Stop and hand off when you need human approval.
`);
  try {
    const { runtime, openai } = makeRuntime({ defaultCwd: cwd });
    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-workflow-1',
      text: '/agent 检查当前项目测试并修复失败项',
    });
    await fullyConfirmLatestAgentJob(runtime, 'wx-agent-workflow-1');
    const [job] = runtime.services.agentJobs.listForScope({
      platform: 'weixin',
      externalScopeId: 'wx-agent-workflow-1',
    });
    let capturedInputText = '';
    const originalStartTurn = openai.startTurn.bind(openai);
    openai.startTurn = async (params: any) => {
      const inputText = String(params?.inputText ?? '');
      if (inputText.includes('你正在执行 CodexBridge 后台 Agent 任务。')) {
        capturedInputText = inputText;
        const turnId = `${params.bridgeSession.codexThreadId}-agent-workflow-turn-1`;
        await params.onTurnStarted?.({
          turnId,
          threadId: params.bridgeSession.codexThreadId,
        });
        return {
          outputText: '已按 workflow 执行并完成验证。',
          outputState: 'complete',
          turnId,
          threadId: params.bridgeSession.codexThreadId,
          title: params.bridgeSession.title,
        };
      }
      return originalStartTurn(params);
    };

    const response = await runtime.services.bridgeCoordinator.runAgentJob(job);
    const responseText = response.messages.map((message) => message.text).join('\n');
    assert.match(responseText, /Agent 任务已完成/);
    assert.match(capturedInputText, /Workflow source:/);
    assert.match(capturedInputText, /Always mention the workflow checkpoint before the final answer/);
    assert.match(capturedInputText, /Final report contract/);
  } finally {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  }
});

test('/agent runAgentJob forwards provider approval requests to the supplied approval callback', async () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const { runtime, openai } = makeRuntime({ defaultCwd: '/repo' });
    await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: 'wx-agent-approval-1',
      text: '/agent 检查当前项目测试并修复失败项',
    });
    await fullyConfirmLatestAgentJob(runtime, 'wx-agent-approval-1');
    const [job] = runtime.services.agentJobs.listForScope({
      platform: 'weixin',
      externalScopeId: 'wx-agent-approval-1',
    });
    const approvalRequests: any[] = [];
    const originalStartTurn = openai.startTurn.bind(openai);
    openai.startTurn = async (params: any) => {
      const inputText = String(params?.inputText ?? '');
      if (inputText.includes('你正在执行 CodexBridge 后台 Agent 任务。')) {
        const turnId = `${params.bridgeSession.codexThreadId}-agent-approval-turn-1`;
        await params.onTurnStarted?.({
          turnId,
          threadId: params.bridgeSession.codexThreadId,
        });
        await params.onApprovalRequest?.({
          requestId: 'approval-agent-1',
          command: 'npm test',
          reason: 'Need to run the requested verification command.',
          options: [
            { index: 1, label: 'Approve' },
            { index: 2, label: 'Deny' },
          ],
        });
        return {
          outputText: '审批后执行完成，基础检查通过。',
          outputState: 'complete',
          turnId,
          threadId: params.bridgeSession.codexThreadId,
          title: params.bridgeSession.title,
        };
      }
      return originalStartTurn(params);
    };

    const response = await runtime.services.bridgeCoordinator.runAgentJob(job, {
      onApprovalRequest: (request) => {
        approvalRequests.push(request);
      },
    });
    const responseText = response.messages.map((message) => message.text).join('\n');
    assert.match(responseText, /Agent 任务已完成/);
    assert.equal(approvalRequests.length, 1);
    assert.equal(approvalRequests[0]?.requestId, 'approval-agent-1');
  } finally {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  }
});

test('resolveOpenAIAgentRuntimeConfig supports OpenAI-compatible MiniMax settings', () => {
  const config = resolveOpenAIAgentRuntimeConfig({
    CODEXBRIDGE_AGENT_API_KEY: 'mini-key',
    CODEXBRIDGE_AGENT_BASE_URL: 'https://api.minimaxi.com/v1',
    CODEXBRIDGE_AGENT_MODEL: 'MiniMax-M2.7',
  } as NodeJS.ProcessEnv);

  assert.equal(config.apiKey, 'mini-key');
  assert.equal(config.baseURL, 'https://api.minimaxi.com/v1');
  assert.equal(config.model, 'MiniMax-M2.7');
  assert.equal(config.useResponses, false);
});

test('resolveOpenAIAgentRuntimeConfig lets explicit API mode override defaults', () => {
  const responsesConfig = resolveOpenAIAgentRuntimeConfig({
    OPENAI_API_KEY: 'openai-key',
    CODEXBRIDGE_AGENT_API: 'responses',
  } as NodeJS.ProcessEnv);
  const chatCompletionsConfig = resolveOpenAIAgentRuntimeConfig({
    OPENAI_API_KEY: 'openai-key',
    CODEXBRIDGE_AGENT_API: 'chat_completions',
  } as NodeJS.ProcessEnv);

  assert.equal(responsesConfig.useResponses, true);
  assert.equal(chatCompletionsConfig.useResponses, false);
});

test('/skills lists visible skills for the current cwd and /skills show explains the selected skill', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  openai.skillEntries = [
    {
      name: 'news-digest',
      displayName: 'News Digest',
      description: '汇总新闻并生成中文摘要。',
      shortDescription: '每天抓新闻并做摘要',
      enabled: true,
      path: '/tmp/skills/news-digest/SKILL.md',
      scope: 'user',
      defaultPrompt: '总结今天的重要新闻',
      dependencies: [{ type: 'tool', value: 'news' }],
    },
    {
      name: 'deploy-watch',
      description: '检查部署状态并回报异常。',
      shortDescription: '部署巡检',
      enabled: false,
      path: '/tmp/skills/deploy-watch/SKILL.md',
      scope: 'repo',
      dependencies: [],
    },
  ];

  const listResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-skills-1',
    text: '/skills',
  });
  const listText = listResult.messages.map((entry) => entry.text ?? '').join('\n');

  assert.match(listText, /可用技能 \| \/tmp\/openai-default \| 2 项/);
  assert.match(listText, /1\. News Digest \[开启\] \[user\]/);
  assert.match(listText, /2\. deploy-watch \[关闭\] \[repo\]/);

  const showResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-skills-1',
    text: '/skills show 1',
  });
  const showText = showResult.messages.map((entry) => entry.text ?? '').join('\n');

  assert.match(showText, /技能详情 \| 1\. News Digest/);
  assert.match(showText, /用途：汇总新闻并生成中文摘要。/);
  assert.match(showText, /默认提示：总结今天的重要新闻/);
  assert.match(showText, /依赖：tool:news/);
});

test('/skills search uses broad matching and /skills on-off toggles the selected skill', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  openai.skillEntries = [
    {
      name: 'daily-news',
      description: '每天抓取新闻并汇总重点。',
      shortDescription: '新闻摘要',
      enabled: false,
      path: '/tmp/skills/daily-news/SKILL.md',
      scope: 'user',
      dependencies: [],
    },
    {
      name: 'repo-review',
      description: '审查当前仓库的改动。',
      shortDescription: '代码审查',
      enabled: true,
      path: '/tmp/skills/repo-review/SKILL.md',
      scope: 'repo',
      dependencies: [],
    },
  ];

  const searchResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-skills-2',
    text: '/skills search 新闻',
  });
  const searchText = searchResult.messages.map((entry) => entry.text ?? '').join('\n');
  assert.match(searchText, /搜索：新闻/);
  assert.match(searchText, /1\. daily-news \[关闭\] \[user\]/);
  assert.doesNotMatch(searchText, /repo-review/);

  const enableResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-skills-2',
    text: '/skills on 1',
  });
  assert.equal(openai.setSkillEnabledCalls.length, 1);
  assert.equal(openai.setSkillEnabledCalls[0]?.enabled, true);
  assert.equal(openai.setSkillEnabledCalls[0]?.path, '/tmp/skills/daily-news/SKILL.md');
  assert.match(enableResult.messages[0]?.text ?? '', /已启用 skill。/);
  assert.match(enableResult.messages[2]?.text ?? '', /状态：开启/);

  const disableResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-skills-2',
    text: '/skills off daily-news',
  });
  assert.equal(openai.setSkillEnabledCalls.length, 2);
  assert.equal(openai.setSkillEnabledCalls[1]?.enabled, false);
  assert.match(disableResult.messages[0]?.text ?? '', /已禁用 skill。/);
  assert.match(disableResult.messages[2]?.text ?? '', /状态：关闭/);
});

test('/skills returns a visible error when provider skill lookup fails', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  openai.listSkillsError = new Error('Timed out connecting to ws://127.0.0.1:36867 after launching "codex".');

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-skills-3',
    text: '/skills',
  });

  assert.equal(result.type, 'message');
  assert.match(result.messages[0]?.text ?? '', /读取 skills 失败：Timed out connecting/u);
});

test('/plugins shows featured plugins, category summaries, category items, and plugin detail', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  openai.pluginCatalog = {
    featuredPluginIds: ['google-drive@openai-curated', 'openai-docs@openai-curated'],
    marketplaceLoadErrors: [],
    marketplaces: [{
      name: 'openai-curated',
      path: null,
      displayName: 'OpenAI Curated',
      plugins: [
        {
          id: 'google-drive@openai-curated',
          name: 'google-drive',
          installed: true,
          enabled: true,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_USE',
          marketplaceName: 'openai-curated',
          marketplacePath: null,
          marketplaceDisplayName: 'OpenAI Curated',
          displayName: 'Google Drive',
          shortDescription: 'Drive workflows',
        },
        {
          id: 'openai-docs@openai-curated',
          name: 'openai-docs',
          installed: false,
          enabled: false,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_USE',
          marketplaceName: 'openai-curated',
          marketplacePath: null,
          marketplaceDisplayName: 'OpenAI Curated',
          displayName: 'OpenAI Docs',
          shortDescription: 'Search official OpenAI docs',
        },
        {
          id: 'github@openai-curated',
          name: 'github',
          installed: true,
          enabled: true,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_INSTALL',
          marketplaceName: 'openai-curated',
          marketplacePath: null,
          marketplaceDisplayName: 'OpenAI Curated',
          displayName: 'GitHub',
          shortDescription: 'Repo plus MCP bundle',
        },
      ],
    }],
  };
  openai.pluginDetails.set('google-drive', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[0],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Drive workflows',
    apps: [{
      id: 'google-drive',
      name: 'Google Drive',
      needsAuth: true,
      description: 'Drive connector',
    }],
    mcpServers: [],
    skills: [],
  });
  openai.pluginDetails.set('openai-docs', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[1],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Search official OpenAI docs',
    apps: [],
    mcpServers: ['openai-docs'],
    skills: [],
  });
  openai.pluginDetails.set('github', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[2],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Repo plus MCP bundle',
    apps: [{
      id: 'github',
      name: 'GitHub',
      needsAuth: true,
      description: 'GitHub connector',
    }],
    mcpServers: ['github'],
    skills: [{
      name: 'github-helper',
      path: '/tmp/skills/github-helper/SKILL.md',
      description: 'Help with GitHub',
      enabled: true,
      displayName: 'GitHub Helper',
    }],
  });
  openai.appEntries = [
    {
      id: 'google-drive',
      name: 'Google Drive',
      isAccessible: true,
      isEnabled: true,
      pluginDisplayNames: ['Google Drive'],
    },
    {
      id: 'github',
      name: 'GitHub',
      isAccessible: false,
      isEnabled: true,
      pluginDisplayNames: ['GitHub'],
    },
  ];
  openai.mcpServerStatuses = [
    {
      name: 'openai-docs',
      isEnabled: true,
      authStatus: 'bearerToken',
      toolCount: 2,
      resourceCount: 1,
      resourceTemplateCount: 0,
    },
    {
      name: 'github',
      isEnabled: true,
      authStatus: 'notLoggedIn',
      toolCount: 4,
      resourceCount: 0,
      resourceTemplateCount: 0,
    },
  ];

  const featured = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugins-1',
    text: '/pg',
  });
  const featuredText = featured.messages.map((message) => message.text ?? '').join('\n');
  assert.match(featuredText, /推荐插件/u);
  assert.match(featuredText, /1\. Google Drive \[已安装 \/ 已启用\]/u);
  assert.match(featuredText, /2\. OpenAI Docs \[未安装\]/u);

  const categories = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugins-1',
    text: '/pg list',
  });
  const categoryText = categories.messages.map((message) => message.text ?? '').join('\n');
  assert.match(categoryText, /插件种类/u);
  assert.match(categoryText, /1\. App \/ Connector \| 1/u);
  assert.match(categoryText, /2\. MCP 服务 \| 1/u);
  assert.match(categoryText, /3\. 混合型 \| 1/u);

  const categoryItems = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugins-1',
    text: '/pg list 1',
  });
  const categoryItemsText = categoryItems.messages.map((message) => message.text ?? '').join('\n');
  assert.match(categoryItemsText, /插件列表/u);
  assert.match(categoryItemsText, /Google Drive \[已安装 \/ 已启用\] \[App\]/u);

  const detail = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugins-1',
    text: '/pg show 1',
  });
  const detailText = detail.messages.map((message) => message.text ?? '').join('\n');
  assert.match(detailText, /插件详情/u);
  assert.match(detailText, /Google Drive/u);
  assert.match(detailText, /Apps \/ Connectors：1/u);
  assert.match(detailText, /Google Drive \| 开启 \| 可访问/u);
});

test('/plugins search uses mixed semantic and fuzzy matching and updates numeric selection context', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  openai.pluginCatalog = {
    featuredPluginIds: [],
    marketplaceLoadErrors: [],
    marketplaces: [{
      name: 'openai-curated',
      path: null,
      displayName: 'OpenAI Curated',
      plugins: [
        {
          id: 'notion@openai-curated',
          name: 'notion',
          installed: true,
          enabled: true,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_USE',
          marketplaceName: 'openai-curated',
          marketplacePath: null,
          marketplaceDisplayName: 'OpenAI Curated',
          displayName: 'Notion',
          shortDescription: 'Workspace databases, notes, journals, and task lists',
        },
        {
          id: 'google-drive@openai-curated',
          name: 'google-drive',
          installed: false,
          enabled: false,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_USE',
          marketplaceName: 'openai-curated',
          marketplacePath: null,
          marketplaceDisplayName: 'OpenAI Curated',
          displayName: 'Google Drive',
          shortDescription: 'Docs, Sheets, and cloud drive workflows',
        },
        {
          id: 'logtail@openai-curated',
          name: 'logtail',
          installed: false,
          enabled: false,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_USE',
          marketplaceName: 'openai-curated',
          marketplacePath: null,
          marketplaceDisplayName: 'OpenAI Curated',
          displayName: 'Logtail',
          shortDescription: 'Operational logs and observability pipelines',
        },
      ],
    }],
  };
  openai.pluginDetails.set('notion', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[0],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Capture diary entries, todo lists, task databases, and project notes in a workspace.',
    apps: [{
      id: 'notion',
      name: 'Notion',
      needsAuth: true,
      description: 'Workspace database connector',
    }],
    mcpServers: [],
    skills: [],
  });
  openai.pluginDetails.set('google-drive', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[1],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Google Docs, Sheets, and Drive file workflows.',
    apps: [{
      id: 'google-drive',
      name: 'Google Drive',
      needsAuth: true,
      description: 'Drive connector',
    }],
    mcpServers: [],
    skills: [],
  });
  openai.pluginDetails.set('logtail', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[2],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Search operational logs and production telemetry.',
    apps: [],
    mcpServers: ['logtail'],
    skills: [],
  });

  const semantic = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugins-search',
    text: '/pg search 日记',
  });
  const semanticText = semantic.messages.map((message) => message.text ?? '').join('\n');
  assert.match(semanticText, /插件搜索/u);
  assert.match(semanticText, /1\. Notion/u);
  assert.doesNotMatch(semanticText, /Logtail/u);

  const semanticDetail = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugins-search',
    text: '/pg show 1',
  });
  assert.match(semanticDetail.messages[0]?.text ?? '', /插件详情 \| 1\. Notion/u);

  const fuzzy = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugins-search',
    text: '/pg search gogle drve',
  });
  const fuzzyText = fuzzy.messages.map((message) => message.text ?? '').join('\n');
  assert.match(fuzzyText, /1\. Google Drive/u);
});

test('/plugins only manage package install/uninstall and redirect runtime toggles to dedicated surfaces', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  openai.pluginCatalog = {
    featuredPluginIds: ['google-drive@openai-curated', 'openai-docs@openai-curated', 'github@openai-curated'],
    marketplaceLoadErrors: [],
    marketplaces: [{
      name: 'openai-curated',
      path: null,
      displayName: 'OpenAI Curated',
      plugins: [
        {
          id: 'google-drive@openai-curated',
          name: 'google-drive',
          installed: true,
          enabled: true,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_USE',
          marketplaceName: 'openai-curated',
          marketplacePath: null,
          marketplaceDisplayName: 'OpenAI Curated',
          displayName: 'Google Drive',
          shortDescription: 'Drive workflows',
        },
        {
          id: 'openai-docs@openai-curated',
          name: 'openai-docs',
          installed: false,
          enabled: false,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_USE',
          marketplaceName: 'openai-curated',
          marketplacePath: null,
          marketplaceDisplayName: 'OpenAI Curated',
          displayName: 'OpenAI Docs',
          shortDescription: 'Search docs',
        },
        {
          id: 'github@openai-curated',
          name: 'github',
          installed: true,
          enabled: true,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_INSTALL',
          marketplaceName: 'openai-curated',
          marketplacePath: null,
          marketplaceDisplayName: 'OpenAI Curated',
          displayName: 'GitHub',
          shortDescription: 'Repo plus MCP bundle',
        },
      ],
    }],
  };
  openai.pluginDetails.set('google-drive', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[0],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Drive workflows',
    apps: [{
      id: 'google-drive',
      name: 'Google Drive',
      needsAuth: true,
      description: 'Drive connector',
    }],
    mcpServers: [],
    skills: [],
  });
  openai.pluginDetails.set('openai-docs', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[1],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Search docs',
    apps: [{
      id: 'openai-docs-app',
      name: 'OpenAI Docs',
      needsAuth: true,
      description: 'Docs connector',
    }],
    mcpServers: ['openai-docs'],
    skills: [],
  });
  openai.pluginDetails.set('github', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[2],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Repo plus MCP bundle',
    apps: [{
      id: 'github',
      name: 'GitHub',
      needsAuth: true,
      description: 'GitHub connector',
    }],
    mcpServers: ['github'],
    skills: [{
      name: 'github-helper',
      path: '/tmp/skills/github-helper/SKILL.md',
      description: 'Help with GitHub',
      enabled: true,
      displayName: 'GitHub Helper',
    }],
  });
  openai.appEntries = [
    {
      id: 'google-drive',
      name: 'Google Drive',
      isAccessible: true,
      isEnabled: true,
      pluginDisplayNames: ['Google Drive'],
    },
    {
      id: 'github',
      name: 'GitHub',
      isAccessible: false,
      isEnabled: true,
      pluginDisplayNames: ['GitHub'],
    },
  ];
  openai.mcpServerStatuses = [
    {
      name: 'openai-docs',
      isEnabled: true,
      authStatus: 'bearerToken',
      toolCount: 2,
      resourceCount: 1,
      resourceTemplateCount: 0,
    },
    {
      name: 'github',
      isEnabled: true,
      authStatus: 'notLoggedIn',
      toolCount: 4,
      resourceCount: 0,
      resourceTemplateCount: 0,
    },
  ];

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugins-2',
    text: '/pg',
  });

  const installResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugins-2',
    text: '/pg add 2',
  });
  const installText = installResult.messages.map((message) => message.text ?? '').join('\n');
  assert.equal(openai.installPluginCalls.length, 1);
  assert.equal(openai.installPluginCalls[0]?.pluginName, 'openai-docs');
  assert.match(installText, /已安装插件：OpenAI Docs/u);
  assert.match(installText, /安装后有 1 个 App 需要认证/u);
  assert.match(installText, /\/apps auth openai-docs-app/u);

  const removedSubcommand = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugins-2',
    text: '/pg off github',
  });
  const removedSubcommandText = removedSubcommand.messages.map((message) => message.text ?? '').join('\n');
  assert.equal(openai.setAppEnabledCalls.length, 0);
  assert.equal(openai.setSkillEnabledCalls.length, 0);
  assert.equal(openai.setMcpServerEnabledCalls.length, 0);
  assert.match(removedSubcommandText, /命令：\/plugins/u);
  assert.match(removedSubcommandText, /\/pg add/u);
  assert.doesNotMatch(removedSubcommandText, /\/pg off/u);

  const uninstallResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugins-2',
    text: '/pg del openai-docs',
  });
  const uninstallText = uninstallResult.messages.map((message) => message.text ?? '').join('\n');
  assert.equal(openai.uninstallPluginCalls.length, 1);
  assert.equal(openai.uninstallPluginCalls[0]?.pluginId, 'openai-docs@openai-curated');
  assert.match(uninstallText, /已卸载插件：OpenAI Docs/u);
});

test('/plugins auto-generated aliases are shown and can be used for plugin selection', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  openai.pluginCatalog = {
    featuredPluginIds: ['github@openai-curated', 'google-drive@openai-curated'],
    marketplaceLoadErrors: [],
    marketplaces: [{
      name: 'openai-curated',
      path: null,
      displayName: 'OpenAI Curated',
      plugins: [
        {
          id: 'github@openai-curated',
          name: 'github',
          installed: false,
          enabled: false,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_INSTALL',
          marketplaceName: 'openai-curated',
          marketplacePath: null,
          marketplaceDisplayName: 'OpenAI Curated',
          displayName: 'GitHub',
          shortDescription: 'Repo plus MCP bundle',
        },
        {
          id: 'google-drive@openai-curated',
          name: 'google-drive',
          installed: true,
          enabled: true,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_USE',
          marketplaceName: 'openai-curated',
          marketplacePath: null,
          marketplaceDisplayName: 'OpenAI Curated',
          displayName: 'Google Drive',
          shortDescription: 'Drive workflows',
        },
      ],
    }],
  };
  openai.pluginDetails.set('github', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[0],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Repo plus MCP bundle',
    apps: [],
    mcpServers: [],
    skills: [],
  });
  openai.pluginDetails.set('google-drive', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[1],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Drive workflows',
    apps: [],
    mcpServers: [],
    skills: [],
  });

  const featured = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugin-auto-alias-1',
    text: '/pg',
  });
  const featuredText = featured.messages.map((message) => message.text ?? '').join('\n');
  assert.match(featuredText, /GitHub \[未安装\] \[别名：gh\]/u);
  assert.match(featuredText, /Google Drive \[已安装 \/ 已启用\] \[别名：gd\]/u);

  const detail = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugin-auto-alias-1',
    text: '/pg show gh',
  });
  const detailText = detail.messages.map((message) => message.text ?? '').join('\n');
  assert.match(detailText, /插件详情 \| 1\. GitHub/u);
  assert.match(detailText, /短别名：gh/u);
});

test('/plugins numeric selection does not reuse cached indexes after switching provider', async () => {
  const { runtime, openai, minimax } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  openai.pluginCatalog = {
    featuredPluginIds: ['github@openai-curated'],
    marketplaceLoadErrors: [],
    marketplaces: [{
      name: 'openai-curated',
      path: null,
      displayName: 'OpenAI Curated',
      plugins: [{
        id: 'github@openai-curated',
        name: 'github',
        installed: false,
        enabled: false,
        installPolicy: 'AVAILABLE',
        authPolicy: 'ON_INSTALL',
        marketplaceName: 'openai-curated',
        marketplacePath: null,
        marketplaceDisplayName: 'OpenAI Curated',
        displayName: 'GitHub',
        shortDescription: 'Repo workflows',
      }],
    }],
  };
  openai.pluginDetails.set('github', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[0],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Repo workflows',
    apps: [],
    mcpServers: [],
    skills: [],
  });

  minimax.pluginCatalog = {
    featuredPluginIds: ['google-drive@openai-curated'],
    marketplaceLoadErrors: [],
    marketplaces: [{
      name: 'openai-curated',
      path: null,
      displayName: 'OpenAI Curated',
      plugins: [{
        id: 'google-drive@openai-curated',
        name: 'google-drive',
        installed: false,
        enabled: false,
        installPolicy: 'AVAILABLE',
        authPolicy: 'ON_USE',
        marketplaceName: 'openai-curated',
        marketplacePath: null,
        marketplaceDisplayName: 'OpenAI Curated',
        displayName: 'Google Drive',
        shortDescription: 'Drive workflows',
      }],
    }],
  };
  minimax.pluginDetails.set('google-drive', {
    summary: minimax.pluginCatalog.marketplaces[0].plugins[0],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Drive workflows',
    apps: [],
    mcpServers: [],
    skills: [],
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugin-provider-switch-1',
    text: '/pg',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugin-provider-switch-1',
    text: '/provider compat-default',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugin-provider-switch-1',
    text: '/pg show 1',
  });
  const text = result.messages.map((message) => message.text ?? '').join('\n');
  assert.match(text, /Google Drive/u);
  assert.doesNotMatch(text, /GitHub/u);
});

test('/plugins alias lets users stage unique short aliases and revalidates uniqueness on confirm', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  openai.pluginCatalog = {
    featuredPluginIds: ['google-drive@openai-curated', 'github@openai-curated'],
    marketplaceLoadErrors: [],
    marketplaces: [{
      name: 'openai-curated',
      path: null,
      displayName: 'OpenAI Curated',
      plugins: [
        {
          id: 'google-drive@openai-curated',
          name: 'google-drive',
          installed: true,
          enabled: true,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_USE',
          marketplaceName: 'openai-curated',
          marketplacePath: null,
          marketplaceDisplayName: 'OpenAI Curated',
          displayName: 'Google Drive',
          shortDescription: 'Drive workflows',
        },
        {
          id: 'github@openai-curated',
          name: 'github',
          installed: true,
          enabled: true,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_INSTALL',
          marketplaceName: 'openai-curated',
          marketplacePath: null,
          marketplaceDisplayName: 'OpenAI Curated',
          displayName: 'GitHub',
          shortDescription: 'Repo plus MCP bundle',
        },
      ],
    }],
  };
  openai.pluginDetails.set('google-drive', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[0],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Drive workflows',
    apps: [],
    mcpServers: [],
    skills: [],
  });
  openai.pluginDetails.set('github', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[1],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Repo plus MCP bundle',
    apps: [],
    mcpServers: [],
    skills: [],
  });

  const staged = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugin-alias-1',
    text: '/pg alias google-drive GD',
  });
  assert.match(staged.messages[0]?.text ?? '', /待确认：将插件 Google Drive 的短别名设为 gd/u);

  const confirmed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugin-alias-1',
    text: '/pg alias confirm',
  });
  assert.match(confirmed.messages[0]?.text ?? '', /已设置插件短别名：gd -> Google Drive/u);

  const detail = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugin-alias-1',
    text: '/pg show gd',
  });
  const detailText = detail.messages.map((message) => message.text ?? '').join('\n');
  assert.match(detailText, /插件详情/u);
  assert.match(detailText, /Google Drive/u);
  assert.match(detailText, /短别名：gd/u);

  const conflict = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugin-alias-1',
    text: '/pg alias github gd',
  });
  assert.match(conflict.messages[0]?.text ?? '', /短别名 gd 已被插件 Google Drive 使用/u);

  const restaged = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugin-alias-1',
    text: '/pg alias github gh',
  });
  assert.match(restaged.messages[0]?.text ?? '', /待确认：将插件 GitHub 的短别名设为 gh/u);

  runtime.repositories.pluginAliases.save({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugin-alias-1',
    providerProfileId: 'openai-default',
    alias: 'gh',
    pluginId: 'google-drive@openai-curated',
    pluginName: 'google-drive',
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    displayName: 'Google Drive',
    updatedAt: Date.now(),
  });
  const rejectedAtConfirm = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugin-alias-1',
    text: '/pg alias confirm',
  });
  assert.match(rejectedAtConfirm.messages[0]?.text ?? '', /短别名 gh 已被插件 Google Drive 使用/u);

  const replaced = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugin-alias-1',
    text: '/pg alias google-drive drive',
  });
  assert.match(replaced.messages[0]?.text ?? '', /待确认：将插件 Google Drive 的短别名设为 drive/u);
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugin-alias-1',
    text: '/pg alias confirm',
  });
  const listed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugin-alias-1',
    text: '/pg alias',
  });
  const listText = listed.messages.map((message) => message.text ?? '').join('\n');
  assert.match(listText, /drive -> Google Drive/u);
  assert.doesNotMatch(listText, /gd -> Google Drive/u);
});

test('explicit plugin targeting syntaxes rewrite the task text and attach plugin hints', async () => {
  const cases = [
    {
      scopeId: 'wx-user-plugin-use-slash-1',
      text: '/use gm 查今天未读邮件',
      syntax: 'slash_use',
    },
    {
      scopeId: 'wx-user-plugin-use-at-1',
      text: '@gm 查今天未读邮件',
      syntax: 'at_alias',
    },
    {
      scopeId: 'wx-user-plugin-use-zh-1',
      text: '用 gm 查今天未读邮件',
      syntax: 'zh_alias',
    },
  ] as const;

  for (const { scopeId, text, syntax } of cases) {
    const { runtime, openai } = makeRuntime({
      defaultCwd: '/tmp/openai-default',
    });
    openai.pluginCatalog = {
      featuredPluginIds: ['gmail@openai-curated'],
      marketplaceLoadErrors: [],
      marketplaces: [{
        name: 'openai-curated',
        path: null,
        displayName: 'OpenAI Curated',
        plugins: [{
          id: 'gmail@openai-curated',
          name: 'gmail',
          installed: true,
          enabled: true,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_USE',
          marketplaceName: 'openai-curated',
          marketplacePath: null,
          marketplaceDisplayName: 'OpenAI Curated',
          displayName: 'Gmail',
          shortDescription: 'Read and manage Gmail',
        }],
      }],
    };
    openai.pluginDetails.set('gmail', {
      summary: openai.pluginCatalog.marketplaces[0].plugins[0],
      marketplaceName: 'openai-curated',
      marketplacePath: null,
      description: 'Read and manage Gmail',
      apps: [],
      mcpServers: [],
      skills: [],
    });

    const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
      platform: 'weixin',
      externalScopeId: scopeId,
      text,
    });

    assert.equal(result.messages[0]?.text ?? '', 'openai: 查今天未读邮件');
    assert.equal(openai.startTurnCalls.length, 1);
    assert.equal(openai.startTurnCalls[0]?.inputText, '查今天未读邮件');
    assert.equal(openai.startTurnCalls[0]?.event?.metadata?.codexbridge?.explicitPluginTarget?.pluginId, 'gmail@openai-curated');
    assert.equal(openai.startTurnCalls[0]?.event?.metadata?.codexbridge?.explicitPluginTarget?.alias, 'gm');
    assert.equal(openai.startTurnCalls[0]?.event?.metadata?.codexbridge?.explicitPluginTarget?.syntax, syntax);
    assert.equal(openai.startTurnCalls[0]?.event?.metadata?.codexbridge?.explicitPluginTargets?.length, 1);
  }
});

test('explicit plugin targeting returns a visible app auth hint instead of silently starting a turn', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  openai.pluginCatalog = {
    featuredPluginIds: ['gmail@openai-curated'],
    marketplaceLoadErrors: [],
    marketplaces: [{
      name: 'openai-curated',
      path: null,
      displayName: 'OpenAI Curated',
      plugins: [{
        id: 'gmail@openai-curated',
        name: 'gmail',
        installed: true,
        enabled: true,
        installPolicy: 'AVAILABLE',
        authPolicy: 'ON_USE',
        marketplaceName: 'openai-curated',
        marketplacePath: null,
        marketplaceDisplayName: 'OpenAI Curated',
        displayName: 'Gmail',
        shortDescription: 'Read and manage Gmail',
      }],
    }],
  };
  openai.pluginDetails.set('gmail', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[0],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Read and manage Gmail',
    apps: [{
      id: 'gmail',
      name: 'Gmail',
      needsAuth: true,
      description: 'Gmail connector',
    }],
    mcpServers: [],
    skills: [],
  });
  openai.appEntries = [{
    id: 'gmail',
    name: 'Gmail',
    description: 'Gmail connector',
    isAccessible: false,
    isEnabled: true,
    pluginDisplayNames: ['Gmail'],
  }];

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugin-auth-hint-1',
    text: '@gm 查询最近发送的邮件',
  });

  const responseText = result.messages.map((message) => message.text ?? '').join('\n');
  assert.equal(openai.startTurnCalls.length, 0);
  assert.match(responseText, /插件 Gmail 当前不能直接使用/u);
  assert.match(responseText, /\/apps auth gmail/u);
  assert.match(responseText, /\/pg show gmail/u);
  assert.match(responseText, /重发原请求即可/u);
});

test('explicit plugin targeting returns a visible MCP auth hint instead of silently starting a turn', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  openai.pluginCatalog = {
    featuredPluginIds: ['openai-docs@openai-curated'],
    marketplaceLoadErrors: [],
    marketplaces: [{
      name: 'openai-curated',
      path: null,
      displayName: 'OpenAI Curated',
      plugins: [{
        id: 'openai-docs@openai-curated',
        name: 'openai-docs',
        installed: true,
        enabled: true,
        installPolicy: 'AVAILABLE',
        authPolicy: 'ON_USE',
        marketplaceName: 'openai-curated',
        marketplacePath: null,
        marketplaceDisplayName: 'OpenAI Curated',
        displayName: 'OpenAI Docs',
        shortDescription: 'Search official OpenAI docs',
      }],
    }],
  };
  openai.pluginDetails.set('openai-docs', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[0],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Search official OpenAI docs',
    apps: [],
    mcpServers: ['openai-docs'],
    skills: [],
  });
  openai.mcpServerStatuses = [{
    name: 'openai-docs',
    isEnabled: true,
    authStatus: 'notLoggedIn',
    toolCount: 0,
    resourceCount: 0,
    resourceTemplateCount: 0,
  }];

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugin-auth-hint-2',
    text: '/use openai-docs 查最新模型',
  });

  const responseText = result.messages.map((message) => message.text ?? '').join('\n');
  assert.equal(openai.startTurnCalls.length, 0);
  assert.match(responseText, /插件 OpenAI Docs 当前不能直接使用/u);
  assert.match(responseText, /\/mcp auth openai-docs/u);
  assert.match(responseText, /\/pg show openai-docs/u);
  assert.match(responseText, /重发原请求即可/u);
});

test('/use supports multiple plugin targets in order and forwards them as a hint list', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  openai.pluginCatalog = {
    featuredPluginIds: ['gmail@openai-curated', 'google-calendar@openai-curated'],
    marketplaceLoadErrors: [],
    marketplaces: [{
      name: 'openai-curated',
      path: null,
      displayName: 'OpenAI Curated',
      plugins: [
        {
          id: 'gmail@openai-curated',
          name: 'gmail',
          installed: true,
          enabled: true,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_USE',
          marketplaceName: 'openai-curated',
          marketplacePath: null,
          marketplaceDisplayName: 'OpenAI Curated',
          displayName: 'Gmail',
          shortDescription: 'Read and manage Gmail',
        },
        {
          id: 'google-calendar@openai-curated',
          name: 'google-calendar',
          installed: true,
          enabled: true,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_USE',
          marketplaceName: 'openai-curated',
          marketplacePath: null,
          marketplaceDisplayName: 'OpenAI Curated',
          displayName: 'Google Calendar',
          shortDescription: 'Manage calendar events',
        },
      ],
    }],
  };
  openai.pluginDetails.set('gmail', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[0],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Read and manage Gmail',
    apps: [],
    mcpServers: [],
    skills: [],
  });
  openai.pluginDetails.set('google-calendar', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[1],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Manage calendar events',
    apps: [],
    mcpServers: [],
    skills: [],
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugin-use-multi-1',
    text: '/use gm gc 把重要事情都记录到谷歌日历中',
  });

  assert.equal(result.messages[0]?.text ?? '', 'openai: 把重要事情都记录到谷歌日历中');
  assert.equal(openai.startTurnCalls.length, 1);
  assert.equal(openai.startTurnCalls[0]?.inputText, '把重要事情都记录到谷歌日历中');
  assert.deepEqual(
    openai.startTurnCalls[0]?.event?.metadata?.codexbridge?.explicitPluginTargets?.map((entry: any) => entry.pluginId),
    ['gmail@openai-curated', 'google-calendar@openai-curated'],
  );
});

test('inline multiple @plugin aliases are rewritten and forwarded as multiple plugin hints', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  openai.pluginCatalog = {
    featuredPluginIds: ['gmail@openai-curated', 'google-calendar@openai-curated'],
    marketplaceLoadErrors: [],
    marketplaces: [{
      name: 'openai-curated',
      path: null,
      displayName: 'OpenAI Curated',
      plugins: [
        {
          id: 'gmail@openai-curated',
          name: 'gmail',
          installed: true,
          enabled: true,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_USE',
          marketplaceName: 'openai-curated',
          marketplacePath: null,
          marketplaceDisplayName: 'OpenAI Curated',
          displayName: 'Gmail',
          shortDescription: 'Read and manage Gmail',
        },
        {
          id: 'google-calendar@openai-curated',
          name: 'google-calendar',
          installed: true,
          enabled: true,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_USE',
          marketplaceName: 'openai-curated',
          marketplacePath: null,
          marketplaceDisplayName: 'OpenAI Curated',
          displayName: 'Google Calendar',
          shortDescription: 'Manage calendar events',
        },
      ],
    }],
  };
  openai.pluginDetails.set('gmail', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[0],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Read and manage Gmail',
    apps: [],
    mcpServers: [],
    skills: [],
  });
  openai.pluginDetails.set('google-calendar', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[1],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Manage calendar events',
    apps: [],
    mcpServers: [],
    skills: [],
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugin-inline-multi-1',
    text: '用@gm 查看最新的邮件，并用@gc把重要事情都记录到谷歌日历中',
  });

  assert.equal(result.messages[0]?.text ?? '', 'openai: 用Gmail 查看最新的邮件，并用Google Calendar把重要事情都记录到谷歌日历中');
  assert.equal(openai.startTurnCalls[0]?.inputText, '用Gmail 查看最新的邮件，并用Google Calendar把重要事情都记录到谷歌日历中');
  assert.deepEqual(
    openai.startTurnCalls[0]?.event?.metadata?.codexbridge?.explicitPluginTargets?.map((entry: any) => entry.pluginId),
    ['gmail@openai-curated', 'google-calendar@openai-curated'],
  );
});

test('unknown @alias prefixes remain ordinary conversation text', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  openai.pluginCatalog = {
    featuredPluginIds: ['gmail@openai-curated'],
    marketplaceLoadErrors: [],
    marketplaces: [{
      name: 'openai-curated',
      path: null,
      displayName: 'OpenAI Curated',
      plugins: [{
        id: 'gmail@openai-curated',
        name: 'gmail',
        installed: true,
        enabled: true,
        installPolicy: 'AVAILABLE',
        authPolicy: 'ON_USE',
        marketplaceName: 'openai-curated',
        marketplacePath: null,
        marketplaceDisplayName: 'OpenAI Curated',
        displayName: 'Gmail',
        shortDescription: 'Read and manage Gmail',
      }],
    }],
  };
  openai.pluginDetails.set('gmail', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[0],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Read and manage Gmail',
    apps: [],
    mcpServers: [],
    skills: [],
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugin-use-at-unknown-1',
    text: '@john 帮我整理一下这个需求',
  });

  assert.equal(result.messages[0]?.text ?? '', 'openai: @john 帮我整理一下这个需求');
  assert.equal(openai.startTurnCalls[0]?.inputText, '@john 帮我整理一下这个需求');
  assert.equal(openai.startTurnCalls[0]?.event?.metadata?.codexbridge?.explicitPluginTarget ?? null, null);
});

test('inline plugin alias rewriting ignores email addresses', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  openai.pluginCatalog = {
    featuredPluginIds: ['gmail@openai-curated'],
    marketplaceLoadErrors: [],
    marketplaces: [{
      name: 'openai-curated',
      path: null,
      displayName: 'OpenAI Curated',
      plugins: [{
        id: 'gmail@openai-curated',
        name: 'gmail',
        installed: true,
        enabled: true,
        installPolicy: 'AVAILABLE',
        authPolicy: 'ON_USE',
        marketplaceName: 'openai-curated',
        marketplacePath: null,
        marketplaceDisplayName: 'OpenAI Curated',
        displayName: 'Gmail',
        shortDescription: 'Read and manage Gmail',
      }],
    }],
  };
  openai.pluginDetails.set('gmail', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[0],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Read and manage Gmail',
    apps: [],
    mcpServers: [],
    skills: [],
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugin-email-1',
    text: '联系 alice@gm.com 并汇总一下邮件情况',
  });

  assert.equal(result.messages[0]?.text ?? '', 'openai: 联系 alice@gm.com 并汇总一下邮件情况');
  assert.equal(openai.startTurnCalls[0]?.inputText, '联系 alice@gm.com 并汇总一下邮件情况');
  assert.equal(openai.startTurnCalls[0]?.event?.metadata?.codexbridge?.explicitPluginTarget ?? null, null);
});

test('/plugins runtime auth subcommand is removed and MCP reload stays under /mcp', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  openai.pluginCatalog = {
    featuredPluginIds: ['google-drive@openai-curated', 'openai-docs@openai-curated'],
    marketplaceLoadErrors: [],
    marketplaces: [{
      name: 'openai-curated',
      path: null,
      displayName: 'OpenAI Curated',
      plugins: [
        {
          id: 'google-drive@openai-curated',
          name: 'google-drive',
          installed: true,
          enabled: true,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_USE',
          marketplaceName: 'openai-curated',
          marketplacePath: null,
          marketplaceDisplayName: 'OpenAI Curated',
          displayName: 'Google Drive',
          shortDescription: 'Drive workflows',
        },
        {
          id: 'openai-docs@openai-curated',
          name: 'openai-docs',
          installed: true,
          enabled: true,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_USE',
          marketplaceName: 'openai-curated',
          marketplacePath: null,
          marketplaceDisplayName: 'OpenAI Curated',
          displayName: 'OpenAI Docs',
          shortDescription: 'Search docs',
        },
      ],
    }],
  };
  openai.pluginDetails.set('google-drive', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[0],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Drive workflows',
    apps: [{
      id: 'google-drive',
      name: 'Google Drive',
      needsAuth: true,
      description: 'Drive connector',
      installUrl: 'https://example.com/apps/google-drive',
    }],
    mcpServers: [],
    skills: [],
  });
  openai.pluginDetails.set('openai-docs', {
    summary: openai.pluginCatalog.marketplaces[0].plugins[1],
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Search docs',
    apps: [],
    mcpServers: ['openai-docs'],
    skills: [],
  });
  openai.appEntries = [{
    id: 'google-drive',
    name: 'Google Drive',
    installUrl: 'https://example.com/apps/google-drive',
    isAccessible: false,
    isEnabled: true,
    pluginDisplayNames: ['Google Drive'],
  }];
  openai.mcpServerStatuses = [{
    name: 'openai-docs',
    isEnabled: true,
    authStatus: 'notLoggedIn',
    toolCount: 2,
    resourceCount: 1,
    resourceTemplateCount: 0,
  }];

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugins-auth-1',
    text: '/pg',
  });

  const appAuth = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugins-auth-1',
    text: '/pg auth google-drive',
  });
  const appAuthText = appAuth.messages.map((message) => message.text ?? '').join('\n');
  assert.match(appAuthText, /命令：\/plugins/u);
  assert.match(appAuthText, /\/apps/u);
  assert.doesNotMatch(appAuthText, /https:\/\/example\.com\/apps\/google-drive/u);

  const mcpAuth = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugins-auth-1',
    text: '/pg auth openai-docs',
  });
  const mcpAuthText = mcpAuth.messages.map((message) => message.text ?? '').join('\n');
  assert.equal(openai.startMcpServerOauthLoginCalls.length, 0);
  assert.match(mcpAuthText, /命令：\/plugins/u);
  assert.doesNotMatch(mcpAuthText, /https:\/\/example\.com\/oauth\/openai-docs/u);

  const reloaded = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugins-auth-1',
    text: '/pg reload',
  });
  const reloadText = reloaded.messages.map((message) => message.text ?? '').join('\n');
  assert.equal(openai.reloadMcpServersCalls.length, 0);
  assert.match(reloadText, /已刷新插件目录/u);
  assert.match(reloadText, /推荐插件/u);
});

test('/apps lists visible apps and manages show, enablement, and auth separately from /pg', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  openai.pluginCatalog = {
    featuredPluginIds: ['google-drive@openai-curated'],
    marketplaceLoadErrors: [],
    marketplaces: [{
      name: 'openai-curated',
      path: null,
      interface: { displayName: 'OpenAI Curated' },
      plugins: [{
        id: 'google-drive@openai-curated',
        name: 'google-drive',
        installed: true,
        enabled: true,
        installPolicy: 'AVAILABLE',
        authPolicy: 'ON_USE',
        interface: {
          displayName: 'Google Drive',
          shortDescription: 'Drive workflows',
          capabilities: ['app'],
        },
        source: {
          type: 'marketplace',
          marketplaceName: 'openai-curated',
        },
      }],
    }],
  };
  openai.appEntries = [
    {
      id: 'google-drive',
      name: 'Google Drive',
      description: 'Drive connector',
      installUrl: 'https://example.com/apps/google-drive',
      isAccessible: false,
      isEnabled: false,
      pluginDisplayNames: ['Google Drive'],
      categories: ['productivity'],
      developer: 'OpenAI',
    },
    {
      id: 'github',
      name: 'GitHub',
      description: 'GitHub connector',
      installUrl: null,
      isAccessible: true,
      isEnabled: false,
      pluginDisplayNames: ['GitHub'],
      categories: ['developer-tools'],
      developer: 'OpenAI',
    },
    {
      id: 'slack',
      name: 'Slack',
      description: 'Team chat connector',
      installUrl: null,
      isAccessible: false,
      isEnabled: true,
      pluginDisplayNames: ['Slack'],
      categories: ['communication'],
      developer: 'OpenAI',
    },
    {
      id: 'az-links',
      name: 'A-Z Links',
      description: 'Easy accessible links in chat',
      installUrl: 'https://example.com/apps/az-links',
      isAccessible: false,
      isEnabled: true,
      pluginDisplayNames: [],
      categories: ['productivity'],
      developer: 'Catalog Vendor',
    },
  ];

  const listed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-apps-1',
    text: '/apps',
  });
  const listText = listed.messages.map((message) => message.text ?? '').join('\n');
  assert.match(listText, /Apps \/ Connectors \| 4 项/u);
  assert.match(listText, /视图：已装插件相关/u);
  assert.match(listText, /A-Z Links/u);
  assert.match(listText, /Slack/u);
  assert.match(listText, /GitHub \[关闭\] \[可访问\]/u);
  assert.match(listText, /Google Drive \[关闭\] \[未接通\]/u);

  const detail = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-apps-1',
    text: '/apps show google-drive',
  });
  const detailText = detail.messages.map((message) => message.text ?? '').join('\n');
  assert.match(detailText, /App 详情 \| .*Google Drive/u);
  assert.match(detailText, /认证链接：https:\/\/example\.com\/apps\/google-drive/u);

  const enabled = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-apps-1',
    text: '/apps on github',
  });
  const enabledText = enabled.messages.map((message) => message.text ?? '').join('\n');
  assert.equal(openai.setAppEnabledCalls.length, 1);
  assert.equal(openai.setAppEnabledCalls[0]?.appId, 'github');
  assert.equal(openai.setAppEnabledCalls[0]?.enabled, true);
  assert.match(enabledText, /已启用 App：GitHub/u);
  assert.match(enabledText, /GitHub \[开启\] \[可访问\]/u);

  const auth = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-apps-1',
    text: '/apps auth google-drive',
  });
  const authText = auth.messages.map((message) => message.text ?? '').join('\n');
  assert.match(authText, /https:\/\/example\.com\/apps\/google-drive/u);
  assert.match(authText, /只有显示“连接：可访问”才算真的接通/u);
});

test('/apps all and /apps search expose the full app catalog while keeping default view focused', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  openai.pluginCatalog = {
    featuredPluginIds: ['gmail@openai-curated'],
    marketplaceLoadErrors: [],
    marketplaces: [{
      name: 'openai-curated',
      path: null,
      interface: { displayName: 'OpenAI Curated' },
      plugins: [{
        id: 'gmail@openai-curated',
        name: 'gmail',
        installed: true,
        enabled: true,
        installPolicy: 'AVAILABLE',
        authPolicy: 'ON_USE',
        interface: {
          displayName: 'Gmail',
          shortDescription: 'Inbox workflows',
          capabilities: ['app'],
        },
        source: {
          type: 'marketplace',
          marketplaceName: 'openai-curated',
        },
      }],
    }],
  };
  openai.appEntries = [
    {
      id: 'gmail',
      name: 'Gmail',
      description: 'Inbox connector',
      installUrl: null,
      isAccessible: true,
      isEnabled: true,
      pluginDisplayNames: ['Gmail'],
      categories: ['mail'],
      developer: 'OpenAI',
    },
    {
      id: 'google-calendar',
      name: 'Google Calendar',
      description: 'Calendar connector',
      installUrl: 'https://example.com/apps/google-calendar',
      isAccessible: false,
      isEnabled: false,
      pluginDisplayNames: ['Google Calendar'],
      categories: ['calendar'],
      developer: 'OpenAI',
    },
    {
      id: 'slack',
      name: 'Slack',
      description: 'Team chat connector',
      installUrl: null,
      isAccessible: false,
      isEnabled: true,
      pluginDisplayNames: ['Slack'],
      categories: ['communication'],
      developer: 'OpenAI',
    },
    {
      id: 'az-links',
      name: 'A-Z Links',
      description: 'Easy accessible links in chat',
      installUrl: 'https://example.com/apps/az-links',
      isAccessible: false,
      isEnabled: true,
      pluginDisplayNames: [],
      categories: ['productivity'],
      developer: 'Catalog Vendor',
    },
  ];

  const defaultList = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-apps-all-1',
    text: '/apps',
  });
  const defaultText = defaultList.messages.map((message) => message.text ?? '').join('\n');
  assert.match(defaultText, /Apps \/ Connectors \| 3 项/u);
  assert.match(defaultText, /视图：已装插件相关/u);
  assert.match(defaultText, /Gmail/u);
  assert.match(defaultText, /Slack/u);
  assert.match(defaultText, /A-Z Links/u);
  assert.doesNotMatch(defaultText, /Google Calendar/u);

  const allList = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-apps-all-1',
    text: '/apps all',
  });
  const allText = allList.messages.map((message) => message.text ?? '').join('\n');
  assert.match(allText, /Apps \/ Connectors \| 4 项/u);
  assert.match(allText, /视图：全部可见/u);
  assert.match(allText, /Google Calendar/u);
  assert.match(allText, /Slack/u);
  assert.match(allText, /A-Z Links/u);

  const searchResult = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-apps-all-1',
    text: '/apps search calendar',
  });
  const searchText = searchResult.messages.map((message) => message.text ?? '').join('\n');
  assert.match(searchText, /视图：搜索结果/u);
  assert.match(searchText, /搜索：calendar/u);
  assert.match(searchText, /1\. Google Calendar \[关闭\] \[未接通\]/u);
  assert.doesNotMatch(searchText, /Gmail/u);

  const detail = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-apps-all-1',
    text: '/apps show 1',
  });
  const detailText = detail.messages.map((message) => message.text ?? '').join('\n');
  assert.match(detailText, /App 详情 \| 1\. Google Calendar/u);

  const alreadyConnectedAuth = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-apps-all-1',
    text: '/apps auth gmail',
  });
  assert.match(alreadyConnectedAuth.messages[0]?.text ?? '', /当前没有待处理认证项/u);

  const enabled = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-apps-all-1',
    text: '/apps on 1',
  });
  const enabledText = enabled.messages.map((message) => message.text ?? '').join('\n');
  assert.equal(openai.setAppEnabledCalls.length, 1);
  assert.equal(openai.setAppEnabledCalls[0]?.appId, 'google-calendar');
  assert.equal(openai.setAppEnabledCalls[0]?.enabled, true);
  assert.match(enabledText, /已启用 App：Google Calendar/u);
  assert.match(enabledText, /搜索：calendar/u);
});

test('/apps default view keeps enabled but currently inaccessible apps visible', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  openai.pluginCatalog = {
    featuredPluginIds: [],
    marketplaceLoadErrors: [],
    marketplaces: [],
  };
  openai.appEntries = [
    {
      id: 'gmail',
      name: 'Gmail',
      description: 'Inbox connector',
      installUrl: null,
      isAccessible: true,
      isEnabled: true,
      pluginDisplayNames: ['Gmail'],
      categories: ['mail'],
      developer: 'OpenAI',
    },
    {
      id: 'slack',
      name: 'Slack',
      description: 'Team chat connector',
      installUrl: null,
      isAccessible: false,
      isEnabled: true,
      pluginDisplayNames: [],
      categories: ['communication'],
      developer: 'OpenAI',
    },
    {
      id: 'google-calendar',
      name: 'Google Calendar',
      description: 'Calendar connector',
      installUrl: 'https://example.com/apps/google-calendar',
      isAccessible: false,
      isEnabled: false,
      pluginDisplayNames: ['Google Calendar'],
      categories: ['calendar'],
      developer: 'OpenAI',
    },
  ];

  const listed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-apps-enabled-1',
    text: '/apps',
  });
  const listText = listed.messages.map((message) => message.text ?? '').join('\n');
  assert.match(listText, /Apps \/ Connectors \| 2 项/u);
  assert.match(listText, /1\. Gmail \[开启\] \[可访问\]/u);
  assert.match(listText, /2\. Slack \[开启\] \[未接通\]/u);
  assert.doesNotMatch(listText, /Google Calendar/u);
});

test('/apps paginates long app lists and uses the current page for numeric selection', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  openai.appEntries = Array.from({ length: 25 }, (_, index) => {
    const number = String(index + 1).padStart(2, '0');
    return {
      id: `app-${number}`,
      name: `App ${number}`,
      description: `Connector ${number}`,
      installUrl: null,
      isAccessible: true,
      isEnabled: true,
      pluginDisplayNames: [`Plugin ${number}`],
    };
  });

  const firstPage = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-apps-pages-1',
    text: '/apps',
  });
  const firstPageText = firstPage.messages.map((message) => message.text ?? '').join('\n');
  assert.match(firstPageText, /Apps \/ Connectors \| 25 项 \| 第 1\/3 页/u);
  assert.match(firstPageText, /1\. App 01 \[开启\] \[可访问\]/u);
  assert.match(firstPageText, /12\. App 12 \[开启\] \[可访问\]/u);
  assert.doesNotMatch(firstPageText, /App 13/u);
  assert.match(firstPageText, /\/apps list 2/u);

  const secondPage = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-apps-pages-1',
    text: '/apps list 2',
  });
  const secondPageText = secondPage.messages.map((message) => message.text ?? '').join('\n');
  assert.match(secondPageText, /Apps \/ Connectors \| 25 项 \| 第 2\/3 页/u);
  assert.match(secondPageText, /1\. App 13 \[开启\] \[可访问\]/u);
  assert.match(secondPageText, /12\. App 24 \[开启\] \[可访问\]/u);
  assert.doesNotMatch(secondPageText, /App 01/u);

  const detail = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-apps-pages-1',
    text: '/apps show 1',
  });
  const detailText = detail.messages.map((message) => message.text ?? '').join('\n');
  assert.match(detailText, /App 详情 \| 1\. App 13/u);

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-apps-pages-1',
    text: '/apps off 1',
  });
  assert.equal(openai.setAppEnabledCalls.length, 1);
  assert.equal(openai.setAppEnabledCalls[0]?.appId, 'app-13');
  assert.equal(openai.setAppEnabledCalls[0]?.enabled, false);
});

test('/apps list keeps the current search view when paginating', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  openai.appEntries = [
    ...Array.from({ length: 15 }, (_, index) => ({
      id: `mail-${index + 1}`,
      name: `Mail App ${String(index + 1).padStart(2, '0')}`,
      description: 'Mail workflow',
      installUrl: null,
      isAccessible: false,
      isEnabled: false,
      pluginDisplayNames: ['Mail'],
    })),
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `drive-${index + 1}`,
      name: `Drive App ${String(index + 1).padStart(2, '0')}`,
      description: 'Drive workflow',
      installUrl: null,
      isAccessible: false,
      isEnabled: false,
      pluginDisplayNames: ['Drive'],
    })),
  ];

  const firstPage = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-apps-search-pages-1',
    text: '/apps search mail',
  });
  const firstPageText = firstPage.messages.map((message) => message.text ?? '').join('\n');
  assert.match(firstPageText, /Apps \/ Connectors \| 15 项 \| 第 1\/2 页/u);
  assert.match(firstPageText, /搜索：mail/u);
  assert.match(firstPageText, /1\. Mail App 01/u);
  assert.doesNotMatch(firstPageText, /Drive App/u);

  const secondPage = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-apps-search-pages-1',
    text: '/apps list 2',
  });
  const secondPageText = secondPage.messages.map((message) => message.text ?? '').join('\n');
  assert.match(secondPageText, /Apps \/ Connectors \| 15 项 \| 第 2\/2 页/u);
  assert.match(secondPageText, /搜索：mail/u);
  assert.match(secondPageText, /1\. Mail App 13/u);
  assert.doesNotMatch(secondPageText, /Drive App/u);
});

test('/mcp lists visible servers and manages enablement, auth, and reload separately from /pg', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  openai.mcpServerStatuses = [
    {
      name: 'browsermcp',
      isEnabled: true,
      authStatus: 'unsupported',
      toolCount: 12,
      resourceCount: 0,
      resourceTemplateCount: 0,
    },
    {
      name: 'google_workspace',
      isEnabled: false,
      authStatus: 'notLoggedIn',
      toolCount: 8,
      resourceCount: 1,
      resourceTemplateCount: 2,
    },
  ];

  const listed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-mcp-1',
    text: '/mcp',
  });
  const listText = listed.messages.map((message) => message.text ?? '').join('\n');
  assert.match(listText, /MCP 服务器 \| 2 项/u);
  assert.match(listText, /1\. browsermcp \[已启用\] \[无需认证\]/u);
  assert.match(listText, /2\. google_workspace \[已禁用\] \[未登录\]/u);

  const enabled = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-mcp-1',
    text: '/mcp on 2',
  });
  const enabledText = enabled.messages.map((message) => message.text ?? '').join('\n');
  assert.equal(openai.setMcpServerEnabledCalls.length, 1);
  assert.equal(openai.setMcpServerEnabledCalls[0]?.name, 'google_workspace');
  assert.equal(openai.setMcpServerEnabledCalls[0]?.enabled, true);
  assert.match(enabledText, /已启用 MCP server：google_workspace/u);
  assert.match(enabledText, /google_workspace \[已启用\] \[未登录\]/u);

  const auth = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-mcp-1',
    text: '/mcp auth google_workspace',
  });
  const authText = auth.messages.map((message) => message.text ?? '').join('\n');
  assert.equal(openai.startMcpServerOauthLoginCalls.length, 1);
  assert.equal(openai.startMcpServerOauthLoginCalls[0]?.name, 'google_workspace');
  assert.match(authText, /https:\/\/example\.com\/oauth\/google_workspace/u);

  const reloaded = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-mcp-1',
    text: '/mcp reload',
  });
  const reloadText = reloaded.messages.map((message) => message.text ?? '').join('\n');
  assert.equal(openai.reloadMcpServersCalls.length, 1);
  assert.match(reloadText, /已刷新 MCP servers 状态/u);
});

test('/plugins category listing falls back to summary capabilities and paginates long groups', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/openai-default',
  });
  const appPlugins = Array.from({ length: 25 }, (_, index) => ({
    id: `app-${index + 1}@openai-curated`,
    name: `app-${index + 1}`,
    installed: false,
    enabled: false,
    installPolicy: 'AVAILABLE',
    authPolicy: 'ON_USE',
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    marketplaceDisplayName: 'OpenAI Curated',
    displayName: `App ${index + 1}`,
    shortDescription: `App plugin ${index + 1}`,
    category: 'Productivity',
    capabilities: ['Interactive', 'Write'],
  }));
  const mcpPlugin = {
    id: 'docs@openai-curated',
    name: 'docs',
    installed: false,
    enabled: false,
    installPolicy: 'AVAILABLE',
    authPolicy: 'ON_USE',
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    marketplaceDisplayName: 'OpenAI Curated',
    displayName: 'Docs MCP',
    shortDescription: 'Docs MCP plugin',
    category: 'Documentation',
    capabilities: ['Read'],
  };
  openai.pluginCatalog = {
    featuredPluginIds: [appPlugins[0].id],
    marketplaceLoadErrors: [],
    marketplaces: [{
      name: 'openai-curated',
      path: null,
      displayName: 'OpenAI Curated',
      plugins: [...appPlugins, mcpPlugin],
    }],
  };
  for (const plugin of appPlugins) {
    openai.pluginDetails.set(plugin.name, {
      summary: plugin,
      marketplaceName: 'openai-curated',
      marketplacePath: null,
      description: plugin.shortDescription,
      apps: [],
      mcpServers: [],
      skills: [],
    });
  }
  openai.pluginDetails.set('docs', {
    summary: mcpPlugin,
    marketplaceName: 'openai-curated',
    marketplacePath: null,
    description: 'Docs MCP plugin',
    apps: [],
    mcpServers: [],
    skills: [],
  });

  const categories = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugins-category-1',
    text: '/pg list',
  });
  const categoryText = categories.messages.map((message) => message.text ?? '').join('\n');
  assert.match(categoryText, /1\. Productivity \| 25/u);
  assert.match(categoryText, /2\. Documentation \| 1/u);

  const page1 = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugins-category-1',
    text: '/pg list 1',
  });
  const page1Text = page1.messages.map((message) => message.text ?? '').join('\n');
  assert.match(page1Text, /Productivity/u);
  assert.match(page1Text, /第 1\/2 页/u);
  assert.match(page1Text, /1\. App 1 \[未安装\]/u);
  assert.doesNotMatch(page1Text, /21\. App 21/u);
  assert.match(page1Text, /\/pg list 1 2/u);

  const page2 = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-plugins-category-1',
    text: '/pg list 1 2',
  });
  const page2Text = page2.messages.map((message) => message.text ?? '').join('\n');
  assert.match(page2Text, /第 2\/2 页/u);
  assert.match(page2Text, /1\. App 5 \[未安装\]/u);
  assert.match(page2Text, /\/pg list 1 1/u);
  assert.doesNotMatch(page2Text, /\/pg list 1 2  查看下一页/u);
});

test('/auto add creates a draft first and /auto confirm persists the standalone automation job', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/codexbridge-auto-standalone',
  });

  const drafted = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-1',
    text: '/auto add every 30m | 检查部署状态，有变化再告诉我',
  });

  assert.equal(openai.startThreadCalls.length, 0);
  assert.match(drafted.messages[0]?.text ?? '', /自动化草案 \| 检查部署状态，有变化再告诉我/);
  assert.match(drafted.messages[1]?.text ?? '', /模式：独立执行/);
  assert.match(drafted.messages[2]?.text ?? '', /计划：every 30m/);
  assert.match(drafted.messages[6]?.text ?? '', /确认：\/auto confirm/);

  const added = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-1',
    text: '/auto confirm',
  });

  assert.equal(openai.startThreadCalls.length, 1);
  assert.match(added.messages[0]?.text ?? '', /自动化任务已创建/);
  assert.match(added.messages[1]?.text ?? '', /标题：检查部署状态，有变化再告诉我/);

  const listed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-1',
    text: '/auto list',
  });

  const text = listed.messages.map((entry: any) => entry.text).join('\n');
  assert.match(text, /自动化任务 \| 1 项/);
  assert.match(text, /1\. 检查部署状态，有变化再告诉我/);
  assert.match(text, /模式：独立执行/);
  assert.match(text, /计划：every 30m/);
});

test('/auto add natural language produces a draft through provider normalization before /auto confirm', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/codexbridge-auto-natural',
  });
  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (params: any) => {
    const parserInput = normalizeCommandSkillInput(params?.inputText);
    if (parserInput.includes('docs/command-skills/auto.md')) {
      return {
        outputText: JSON.stringify({
          action: 'create_draft',
          title: 'news 早报',
          mode: 'standalone',
          schedule: {
            kind: 'daily',
            hour: 7,
            minute: 0,
          },
          task: '调用 news skill 给我发送到微信',
        }),
      };
    }
    return originalStartTurn(params);
  };

  const drafted = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-natural-1',
    text: '/auto add 每天早上7点调用 news skill 给我发送到微信',
  });

  const draftText = drafted.messages.map((entry: any) => entry.text ?? '').join('\n');
  assert.match(draftText, /自动化草案 \| news 早报/);
  assert.match(draftText, /计划：daily 07:00 UTC/);
  assert.match(draftText, /任务：调用 news skill 给我发送到微信/);
  assert.equal(openai.startThreadCalls.length, 1);

  const confirmed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-natural-1',
    text: '/auto confirm',
  });
  const confirmText = confirmed.messages.map((entry: any) => entry.text ?? '').join('\n');
  assert.match(confirmText, /自动化任务已创建/);
  assert.match(confirmText, /标题：news 早报/);
  assert.equal(openai.startThreadCalls.length, 2);
});

test('/auto add natural language can create multiple daily schedules from one request', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/codexbridge-auto-multi-natural',
  });
  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (params: any) => {
    const parserInput = normalizeCommandSkillInput(params?.inputText);
    if (parserInput.includes('docs/command-skills/auto.md')) {
      return {
        outputText: JSON.stringify({
          action: 'create_draft',
          title: '待办事项整理',
          mode: 'standalone',
          schedules: [
            { kind: 'daily', hour: 8, minute: 0 },
            { kind: 'daily', hour: 13, minute: 0 },
            { kind: 'daily', hour: 17, minute: 30 },
          ],
          task: '把待办事项整理以后发送到我的微信上',
        }),
      };
    }
    return originalStartTurn(params);
  };

  const drafted = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-multi-natural-1',
    text: '/auto add 每天早上 8:00、中午 13:00 以及下午 17:30，都把待办事项整理以后，发到我的微信上',
  });

  const draftText = drafted.messages.map((entry: any) => entry.text ?? '').join('\n');
  assert.match(draftText, /自动化草案 \| 待办事项整理/);
  assert.match(draftText, /计划：daily 08:00 UTC；daily 13:00 UTC；daily 17:30 UTC/);
  assert.match(draftText, /任务：把待办事项整理以后发送到我的微信上/);

  const confirmed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-multi-natural-1',
    text: '/auto confirm',
  });
  const confirmText = confirmed.messages.map((entry: any) => entry.text ?? '').join('\n');
  assert.match(confirmText, /自动化任务已创建：3 项/);
  assert.match(confirmText, /计划：daily 08:00 UTC；daily 13:00 UTC；daily 17:30 UTC/);

  const listed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-multi-natural-1',
    text: '/auto list',
  });
  const listText = listed.messages.map((entry: any) => entry.text ?? '').join('\n');
  assert.match(listText, /自动化任务 \| 3 项/);
  assert.match(listText, /待办事项整理 \(daily 08:00 UTC\)/);
  assert.match(listText, /待办事项整理 \(daily 13:00 UTC\)/);
  assert.match(listText, /待办事项整理 \(daily 17:30 UTC\)/);
});

test('/auto edit updates the pending automation draft instead of replacing it', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/codexbridge-auto-edit-natural',
  });
  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (params: any) => {
    const parserInput = normalizeCommandSkillInput(params?.inputText);
    if (parserInput.includes('docs/command-skills/auto.md') && parserInput.includes('"subcommand": "add"')) {
      return {
        outputText: JSON.stringify({
          action: 'create_draft',
          title: '待办事项整理',
          mode: 'standalone',
          schedules: [
            { kind: 'daily', hour: 8, minute: 0 },
            { kind: 'daily', hour: 13, minute: 0 },
            { kind: 'daily', hour: 17, minute: 30 },
          ],
          task: '把待办事项整理以后发送到我的微信上',
        }),
      };
    }
    if (parserInput.includes('docs/command-skills/auto.md') && parserInput.includes('"subcommand": "edit"')) {
      assert.match(parserInput, /pendingDraft/);
      assert.match(parserInput, /把待办事项整理以后发送到我的微信上/);
      assert.match(parserInput, /只把时间改成每天早上9点，任务内容不变/);
      return {
        outputText: JSON.stringify({
          action: 'update_pending_draft',
          title: '待办事项整理',
          mode: 'standalone',
          schedules: [
            { kind: 'daily', hour: 9, minute: 0 },
          ],
          task: '把待办事项整理以后发送到我的微信上',
        }),
      };
    }
    return originalStartTurn(params);
  };

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-edit-natural-1',
    text: '/auto add 每天早上 8:00、中午 13:00 以及下午 17:30，都把待办事项整理以后，发到我的微信上',
  });

  const edited = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-edit-natural-1',
    text: '/auto edit 只把时间改成每天早上9点，任务内容不变',
  });

  const editText = edited.messages.map((entry: any) => entry.text ?? '').join('\n');
  assert.match(editText, /自动化草案 \| 待办事项整理/);
  assert.match(editText, /计划：daily 09:00 UTC/);
  assert.doesNotMatch(editText, /daily 08:00 UTC/);
  assert.match(editText, /任务：把待办事项整理以后发送到我的微信上/);

  const confirmed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-edit-natural-1',
    text: '/auto confirm',
  });
  const confirmText = confirmed.messages.map((entry: any) => entry.text ?? '').join('\n');
  assert.match(confirmText, /自动化任务已创建/);
  assert.match(confirmText, /计划：daily 09:00 UTC/);
});

test('/auto rename and /auto del update and remove automation jobs', async () => {
  const { runtime } = makeRuntime({
    defaultCwd: '/tmp/codexbridge-auto-rename',
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-2',
    text: '/auto add daily 09:00 | 每天整理昨天的提交摘要',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-2',
    text: '/auto confirm',
  });

  const renamed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-2',
    text: '/auto rename 1 晚间汇总',
  });
  assert.match(renamed.messages[0]?.text ?? '', /自动化任务标题已更新/);
  assert.match(renamed.messages[1]?.text ?? '', /标题：晚间汇总/);

  const deleted = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-2',
    text: '/auto del 1',
  });
  assert.match(deleted.messages[0]?.text ?? '', /自动化任务已删除/);

  const listed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-2',
    text: '/auto',
  });
  assert.equal(listed.messages[0]?.text ?? '', '自动化任务 | 0 项');
});

test('/auto pause and /auto resume update automation job status', async () => {
  const { runtime } = makeRuntime({
    defaultCwd: '/tmp/codexbridge-auto-pause-resume',
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-pause-resume',
    text: '/auto add daily 09:00 | 每天整理昨天的提交摘要',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-pause-resume',
    text: '/auto confirm',
  });

  const paused = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-pause-resume',
    text: '/auto pause 1',
  });
  assert.match(paused.messages[0]?.text ?? '', /自动化任务已暂停/);

  let [job] = runtime.services.automationJobs.listForScope({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-pause-resume',
  });
  assert.equal(job.status, 'paused');

  const resumed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-pause-resume',
    text: '/auto resume 1',
  });
  assert.match(resumed.messages[0]?.text ?? '', /自动化任务已恢复/);

  [job] = runtime.services.automationJobs.listForScope({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-pause-resume',
  });
  assert.equal(job.status, 'active');
});

test('/auto natural language proposes deleting a matching job before confirm', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/codexbridge-auto-natural-delete',
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-natural-delete',
    text: '/auto add every 5m | 把微博热搜前10条发给我',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-natural-delete',
    text: '/auto confirm',
  });

  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (params: any) => {
    const parserInput = normalizeCommandSkillInput(params?.inputText);
    if (parserInput.includes('docs/command-skills/auto.md') && parserInput.includes('"subcommand": "natural"')) {
      assert.match(parserInput, /微博热搜前10条/);
      return {
        outputText: JSON.stringify({
          action: 'propose_delete_job',
          confidence: 0.93,
          requiresConfirmation: true,
          target: {
            index: 1,
            matchText: '微博热搜',
          },
          reason: '用户要求不要再发送微博热搜自动化。',
        }),
      };
    }
    return originalStartTurn(params);
  };

  const proposed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-natural-delete',
    text: '/auto 不要再发微博热搜了',
  });
  const proposedText = proposed.messages.map((entry: any) => entry.text ?? '').join('\n');
  assert.match(proposedText, /自动化操作草案 \| 删除任务/);
  assert.match(proposedText, /确认：\/auto confirm/);

  const confirmed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-natural-delete',
    text: '/auto confirm',
  });
  assert.match(confirmed.messages[0]?.text ?? '', /自动化任务已删除/);

  const listed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-natural-delete',
    text: '/auto list',
  });
  assert.equal(listed.messages[0]?.text ?? '', '自动化任务 | 0 项');
});

test('/auto show without args opens the only automation job and shows a future next-run time', async () => {
  const { runtime } = makeRuntime({
    defaultCwd: '/tmp/codexbridge-auto-show-single',
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-show-single',
    text: '/auto add every 30m | 检查系统状态并发给我',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-show-single',
    text: '/auto confirm',
  });

  const detail = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-show-single',
    text: '/auto show',
  });

  const text = detail.messages.map((entry: any) => entry.text ?? '').join('\n');
  assert.match(text, /自动化详情 \| 检查系统状态并发给我/);
  assert.match(text, /下次执行：/);
  assert.match(text, /后|202\d-\d\d-\d\d/);
});

test('/auto show without args asks for an index when multiple automation jobs exist', async () => {
  const { runtime } = makeRuntime({
    defaultCwd: '/tmp/codexbridge-auto-show-multi',
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-show-multi',
    text: '/auto add every 30m | 检查系统状态并发给我',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-show-multi',
    text: '/auto confirm',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-show-multi',
    text: '/auto add daily 09:00 | 每天整理昨天的提交摘要',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-show-multi',
    text: '/auto confirm',
  });

  const detail = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-show-multi',
    text: '/auto show',
  });

  assert.equal(detail.messages[0]?.text ?? '', '请指定自动化任务序号，例如：/auto show 1');
});

test('/auto add thread requires an existing bound session', async () => {
  const { runtime } = makeRuntime({
    defaultCwd: '/tmp/codexbridge-auto-thread',
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-3',
    text: '/auto add thread every 10m | 继续跟进当前线程里的部署情况',
  });

  assert.equal(result.messages[0]?.text ?? '', 'thread 模式需要当前 scope 已绑定会话。先发送普通消息或 /new 建立会话后再试。');
});

test('/auto cancel clears the pending automation draft', async () => {
  const { runtime } = makeRuntime({
    defaultCwd: '/tmp/codexbridge-auto-cancel',
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-cancel-1',
    text: '/auto add every 30m | 检查系统状态并发给我',
  });

  const cancelled = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-cancel-1',
    text: '/auto cancel',
  });
  assert.match(cancelled.messages[0]?.text ?? '', /已取消当前自动化草案/);

  const confirmed = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-cancel-1',
    text: '/auto confirm',
  });
  assert.match(confirmed.messages[0]?.text ?? '', /当前没有待确认的自动化草案/);
});

test('/auto scheduled runs stay on the one-shot automation path and do not persist Mission Control state', async () => {
  const { runtime, openai } = makeRuntime({
    defaultCwd: '/tmp/codexbridge-auto-mission-run',
  });

  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-mission-run',
    text: '/auto add every 30m | 检查部署状态并发给我',
  });
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-mission-run',
    text: '/auto confirm',
  });

  const [job] = runtime.services.automationJobs.listForScope({
    platform: 'weixin',
    externalScopeId: 'wx-user-auto-mission-run',
  });
  assert.ok(job);

  openai.startTurn = async ({ bridgeSession, onTurnStarted }) => {
    const turnId = `${bridgeSession.codexThreadId}-turn-auto-mission-1`;
    await onTurnStarted?.({
      turnId,
      threadId: bridgeSession.codexThreadId,
    });
    return {
      outputText: '部署状态正常，未发现异常。',
      turnId,
      threadId: bridgeSession.codexThreadId,
      title: bridgeSession.title,
    };
  };

  const response = await runtime.services.bridgeCoordinator.runAutomationJob(job);
  const liveJob = runtime.services.automationJobs.getById(job.id) as any;

  assert.match(response.messages[0]?.text ?? '', /部署状态正常，未发现异常/);
  assert.equal('missionRuntimeState' in liveJob, false);
  assert.equal('missionAttemptHistory' in liveJob, false);
});

test('ordinary messages after /stop do not eagerly resume the thread when startTurn succeeds', async () => {
  const { runtime, openai } = makeRuntime();

  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-stop-resume-1',
    text: 'hello stop',
  });
  runtime.services.bridgeCoordinator.storeStopCheckpoint(original.session.bridgeSessionId, {
    threadId: original.session.codexThreadId,
    stoppedAt: Date.now(),
    interruptedTurnIds: [`${original.session.codexThreadId}-turn-paused`],
    pendingApprovalCount: 0,
    interruptErrors: [],
    requestedWhileStarting: false,
    settled: true,
  });

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-stop-resume-1',
    text: 'hello after stop',
  });

  assert.equal(openai.resumeThreadCalls.length, 0);
  assert.equal(openai.startTurnCalls.length, 2);
  assert.equal(result.messages[0]?.text ?? '', 'openai: hello after stop');

  const settings = runtime.services.bridgeSessions.getSessionSettings(original.session.bridgeSessionId);
  assert.equal((settings?.metadata?.lastStopCheckpoint as any) ?? null, null);
});

test('ordinary messages after /stop lazily resume the same thread when Codex asks for recovery', async () => {
  const { runtime, openai } = makeRuntime();

  const original = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-stop-resume-2',
    text: 'hello stop resume',
  });
  runtime.services.bridgeCoordinator.storeStopCheckpoint(original.session.bridgeSessionId, {
    threadId: original.session.codexThreadId,
    stoppedAt: Date.now(),
    interruptedTurnIds: [`${original.session.codexThreadId}-turn-paused`],
    pendingApprovalCount: 0,
    interruptErrors: [],
    requestedWhileStarting: false,
    settled: true,
  });

  let injected = false;
  const originalStartTurn = openai.startTurn.bind(openai);
  openai.startTurn = async (args) => {
    if (!injected && args.bridgeSession.codexThreadId === original.session.codexThreadId && args.inputText === 'hello after lazy resume') {
      injected = true;
      throw new Error(`failed to load rollout '/tmp/${original.session.codexThreadId}.jsonl' for thread ${original.session.codexThreadId}: empty session file`);
    }
    return originalStartTurn(args);
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-stop-resume-2',
    text: 'hello after lazy resume',
  });

  assert.equal(openai.resumeThreadCalls.length, 1);
  assert.equal(openai.startTurnCalls.length, 2);
  assert.equal(result.messages[0]?.text ?? '', 'openai: hello after lazy resume');
  assert.equal(result.session?.bridgeSessionId, original.session?.bridgeSessionId);
  assert.equal(result.session?.codexThreadId, original.session?.codexThreadId);

  const settings = runtime.services.bridgeSessions.getSessionSettings(original.session.bridgeSessionId);
  assert.equal((settings?.metadata?.lastStopCheckpoint as any) ?? null, null);
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

test('bridge coordinator rewrites approved execution stalls into a workaround hint', async () => {
  const { runtime, openai } = makeRuntime();
  await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-approval-stall-1',
    text: 'hello',
  });

  openai.startTurn = async () => {
    throw new Error('Approval was accepted, but the approved command (node resend-file.js) produced no follow-up signal for 300 seconds. The provider may be stuck; use /retry to try again.');
  };

  const result = await runtime.services.bridgeCoordinator.handleInboundEvent({
    platform: 'weixin',
    externalScopeId: 'wx-user-approval-stall-1',
    text: 'hello again',
  });

  assert.equal(result.meta?.codexTurn?.outputState, 'provider_error');
  assert.equal(
    result.meta?.codexTurn?.errorMessage,
    '审批已通过，但 Codex 未继续执行。可先 /stop，再发送 /perm full-access，然后 /retry 重新执行；该设置仅对下一轮生效。',
  );
});

// ---------------------------------------------------------------------------
// Command Skill schema round-trip tests
// ---------------------------------------------------------------------------

function extractMarkdownTableActions(markdown: string): Set<string> {
  const actions = new Set<string>();
  for (const line of markdown.split('\n')) {
    const match = line.match(/^\|\s*`([a-z_]+)`\s*\|/);
    if (match) {
      actions.add(match[1]);
    }
  }
  return actions;
}

function extractMarkdownInlineActions(markdown: string): Set<string> {
  const actions = new Set<string>();
  for (const line of markdown.split('\n')) {
    const inlineMatch = line.match(/"action":\s*"([a-z_]+(?:\s*\|\s*[a-z_]+)*)"/);
    if (inlineMatch) {
      for (const action of inlineMatch[1].split('|').map((s) => s.trim())) {
        actions.add(action);
      }
    }
  }
  return actions;
}

test('AGENT_COMMAND_SKILL_ACTIONS matches actions declared in docs/command-skills/agent.md', () => {
  const docPath = path.resolve('docs/command-skills/agent.md');
  const markdown = fs.readFileSync(docPath, 'utf-8');
  const docActions = extractMarkdownTableActions(markdown);

  assert.ok(docActions.size > 0, 'should extract at least one action from agent.md action table');

  const missingInCode = [...docActions].filter((a) => !AGENT_COMMAND_SKILL_ACTIONS.has(a as any));
  const missingInDoc = [...AGENT_COMMAND_SKILL_ACTIONS].filter((a) => !docActions.has(a));

  assert.deepEqual(
    missingInCode,
    [],
    `Actions declared in agent.md but missing from AGENT_COMMAND_SKILL_ACTIONS: ${missingInCode.join(', ')}`,
  );
  assert.deepEqual(
    missingInDoc,
    [],
    `Actions in AGENT_COMMAND_SKILL_ACTIONS but missing from agent.md: ${missingInDoc.join(', ')}`,
  );
});

test('AUTO_COMMAND_SKILL_ACTIONS matches actions declared in docs/command-skills/auto.md', () => {
  const docPath = path.resolve('docs/command-skills/auto.md');
  const markdown = fs.readFileSync(docPath, 'utf-8');
  const inlineActions = extractMarkdownInlineActions(markdown);

  assert.ok(inlineActions.size > 0, 'should extract at least one action from auto.md');

  const missingInCode = [...inlineActions].filter((a) => !AUTO_COMMAND_SKILL_ACTIONS.has(a as any));
  const missingInDoc = [...AUTO_COMMAND_SKILL_ACTIONS].filter((a) => !inlineActions.has(a));

  assert.deepEqual(
    missingInCode,
    [],
    `Actions declared in auto.md but missing from AUTO_COMMAND_SKILL_ACTIONS: ${missingInCode.join(', ')}`,
  );
  assert.deepEqual(
    missingInDoc,
    [],
    `Actions in AUTO_COMMAND_SKILL_ACTIONS but missing from auto.md: ${missingInDoc.join(', ')}`,
  );
});

test('REVIEW_COMMAND_SKILL_ACTIONS matches actions declared in docs/command-skills/review.md', () => {
  const docPath = path.resolve('docs/command-skills/review.md');
  const markdown = fs.readFileSync(docPath, 'utf-8');

  const inlineActions = extractMarkdownInlineActions(markdown);

  assert.ok(inlineActions.size > 0, 'should extract at least one action from review.md');

  const missingInCode = [...inlineActions].filter((a) => !REVIEW_COMMAND_SKILL_ACTIONS.has(a as any));
  const missingInDoc = [...REVIEW_COMMAND_SKILL_ACTIONS].filter((a) => !inlineActions.has(a));

  assert.deepEqual(
    missingInCode,
    [],
    `Actions declared in review.md but missing from REVIEW_COMMAND_SKILL_ACTIONS: ${missingInCode.join(', ')}`,
  );
  assert.deepEqual(
    missingInDoc,
    [],
    `Actions in REVIEW_COMMAND_SKILL_ACTIONS but missing from review.md: ${missingInDoc.join(', ')}`,
  );
});

test('INSTRUCTIONS_COMMAND_SKILL_ACTIONS matches actions declared in docs/command-skills/instructions.md', () => {
  const docPath = path.resolve('docs/command-skills/instructions.md');
  const markdown = fs.readFileSync(docPath, 'utf-8');
  const docActions = extractMarkdownTableActions(markdown);

  assert.ok(docActions.size > 0, 'should extract at least one action from instructions.md action table');

  const missingInCode = [...docActions].filter((a) => !INSTRUCTIONS_COMMAND_SKILL_ACTIONS.has(a as any));
  const missingInDoc = [...INSTRUCTIONS_COMMAND_SKILL_ACTIONS].filter((a) => !docActions.has(a));

  assert.deepEqual(
    missingInCode,
    [],
    `Actions declared in instructions.md but missing from INSTRUCTIONS_COMMAND_SKILL_ACTIONS: ${missingInCode.join(', ')}`,
  );
  assert.deepEqual(
    missingInDoc,
    [],
    `Actions in INSTRUCTIONS_COMMAND_SKILL_ACTIONS but missing from instructions.md: ${missingInDoc.join(', ')}`,
  );
});

test('THREAD_COMMAND_SKILL_ACTIONS matches actions declared in docs/command-skills/threads.md', () => {
  const docPath = path.resolve('docs/command-skills/threads.md');
  const markdown = fs.readFileSync(docPath, 'utf-8');
  const docActions = extractMarkdownTableActions(markdown);

  assert.ok(docActions.size > 0, 'should extract at least one action from threads.md action table');

  const missingInCode = [...docActions].filter((a) => !THREAD_COMMAND_SKILL_ACTIONS.has(a as any));
  const missingInDoc = [...THREAD_COMMAND_SKILL_ACTIONS].filter((a) => !docActions.has(a));

  assert.deepEqual(
    missingInCode,
    [],
    `Actions declared in threads.md but missing from THREAD_COMMAND_SKILL_ACTIONS: ${missingInCode.join(', ')}`,
  );
  assert.deepEqual(
    missingInDoc,
    [],
    `Actions in THREAD_COMMAND_SKILL_ACTIONS but missing from threads.md: ${missingInDoc.join(', ')}`,
  );
});
