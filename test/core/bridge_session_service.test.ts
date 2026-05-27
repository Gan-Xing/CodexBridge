import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexBridgeRuntime } from '../../src/runtime/bootstrap.js';

class FakeProviderPlugin {
  kind: string;

  calls: Array<Record<string, unknown>>;

  counter: number;
  threads: Map<string, any>;
  archivedThreadIds: Set<string>;
  archiveThreadCalls: string[];
  unarchiveThreadCalls: string[];

  constructor(kind: string) {
    this.kind = kind;
    this.calls = [];
    this.counter = 0;
    this.threads = new Map();
    this.archivedThreadIds = new Set();
    this.archiveThreadCalls = [];
    this.unarchiveThreadCalls = [];
  }

  async startThread({ providerProfile, cwd, title, metadata, ephemeral = null }: {
    providerProfile: { id: string; displayName: string };
    cwd?: string | null;
    title?: string | null;
    ephemeral?: boolean | null;
    metadata?: Record<string, unknown>;
  }) {
    this.counter += 1;
    this.calls.push({ providerProfile, cwd, title, metadata, ephemeral });
    const thread = {
      threadId: `${providerProfile.id}-thread-${this.counter}`,
      cwd: cwd ?? `/tmp/${providerProfile.id}`,
      title: title ?? `${providerProfile.displayName} thread ${this.counter}`,
      updatedAt: Date.now() + this.counter,
      preview: '',
    };
    this.threads.set(thread.threadId, thread);
    return thread;
  }

  async listThreads({ archived = false } = {}) {
    return {
      items: [...this.threads.values()].filter((thread) => archived
        ? this.archivedThreadIds.has(thread.threadId)
        : !this.archivedThreadIds.has(thread.threadId)),
      nextCursor: null,
    };
  }

  async archiveThread({ threadId }: { threadId: string }) {
    this.archiveThreadCalls.push(threadId);
    this.archivedThreadIds.add(threadId);
  }

  async unarchiveThread({ threadId }: { threadId: string }) {
    this.unarchiveThreadCalls.push(threadId);
    this.archivedThreadIds.delete(threadId);
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

test('resolveOrCreateScopeSession reuses the same session for the same platform scope', async () => {
  const openaiPlugin = new FakeProviderPlugin('openai-native');
  const runtime = createCodexBridgeRuntime({
    providerPlugins: [openaiPlugin as any],
    providerProfiles: [makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default')],
  });

  const scopeRef = { platform: 'weixin', externalScopeId: 'wx-user-1' };
  const created = await runtime.services.bridgeSessions.resolveOrCreateScopeSession(scopeRef, {
    providerProfileId: 'openai-default',
  });
  const resolved = await runtime.services.bridgeSessions.resolveOrCreateScopeSession(scopeRef, {
    providerProfileId: 'openai-default',
  });

  assert.equal(created.id, resolved.id);
  assert.equal(openaiPlugin.calls.length, 1);
});

test('createSessionForScope assigns cumulative default readable titles when none is provided', async () => {
  const openaiPlugin = new FakeProviderPlugin('openai-native');
  const runtime = createCodexBridgeRuntime({
    providerPlugins: [openaiPlugin as any],
    providerProfiles: [makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default')],
  });

  const first = await runtime.services.bridgeSessions.createSessionForScope(
    { platform: 'weixin', externalScopeId: 'wx-user-1' },
    { providerProfileId: 'openai-default' },
  );
  const second = await runtime.services.bridgeSessions.createSessionForScope(
    { platform: 'weixin', externalScopeId: 'wx-user-2' },
    { providerProfileId: 'openai-default' },
  );

  assert.equal(first.title, '新线程00001');
  assert.equal(second.title, '新线程00002');
  assert.equal(openaiPlugin.calls[0]?.title, '新线程00001');
  assert.equal(openaiPlugin.calls[1]?.title, '新线程00002');
});

test('resolveOrCreateScopeSession backfills cwd onto an existing bound session', async () => {
  const openaiPlugin = new FakeProviderPlugin('openai-native');
  const runtime = createCodexBridgeRuntime({
    providerPlugins: [openaiPlugin as any],
    providerProfiles: [makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default')],
  });

  const scopeRef = { platform: 'weixin', externalScopeId: 'wx-user-1' };
  const created = await runtime.services.bridgeSessions.createSessionForScope(scopeRef, {
    providerProfileId: 'openai-default',
    cwd: null,
  });
  runtime.services.bridgeSessions.updateSession(created.id, { cwd: null });

  const resolved = await runtime.services.bridgeSessions.resolveOrCreateScopeSession(scopeRef, {
    providerProfileId: 'openai-default',
    cwd: '/tmp/project',
  });

  assert.equal(resolved.id, created.id);
  assert.equal(resolved.cwd, '/tmp/project');
  assert.equal(runtime.repositories.bridgeSessions.get(created.id)?.cwd, '/tmp/project');
});

test('multiple platform scopes can bind to the same bridge session', async () => {
  const openaiPlugin = new FakeProviderPlugin('openai-native');
  const runtime = createCodexBridgeRuntime({
    providerPlugins: [openaiPlugin as any],
    providerProfiles: [makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default')],
  });

  const session = await runtime.services.bridgeSessions.createSessionForScope(
    { platform: 'weixin', externalScopeId: 'wx-user-1' },
    { providerProfileId: 'openai-default' },
  );

  runtime.services.bridgeSessions.bindScopeToExistingSession(
    { platform: 'telegram', externalScopeId: '-100xx::1417' },
    session.id,
  );

  const weixinSession = runtime.services.bridgeSessions.requireScopeSession({ platform: 'weixin', externalScopeId: 'wx-user-1' });
  const telegramSession = runtime.services.bridgeSessions.requireScopeSession({ platform: 'telegram', externalScopeId: '-100xx::1417' });

  assert.equal(weixinSession.id, session.id);
  assert.equal(telegramSession.id, session.id);
  assert.equal(runtime.services.sessionRouter.listBindingsForSession(session.id).length, 2);
});

test('switchScopeProvider creates a new session and keeps provider boundaries isolated', async () => {
  const openaiPlugin = new FakeProviderPlugin('openai-native');
  const compatiblePlugin = new FakeProviderPlugin('openai-compatible');
  const runtime = createCodexBridgeRuntime({
    providerPlugins: [openaiPlugin as any, compatiblePlugin as any],
    providerProfiles: [
      makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default'),
      makeProviderProfile('compat-default', 'openai-compatible', 'Compatible Default'),
    ],
  });

  const scopeRef = { platform: 'weixin', externalScopeId: 'wx-user-1' };
  const original = await runtime.services.bridgeSessions.createSessionForScope(scopeRef, {
    providerProfileId: 'openai-default',
  });
  const switched = await runtime.services.bridgeSessions.switchScopeProvider(scopeRef, {
    nextProviderProfileId: 'compat-default',
  });
  const resolved = runtime.services.bridgeSessions.requireScopeSession(scopeRef);

  assert.notEqual(original.id, switched.id);
  assert.equal(original.providerProfileId, 'openai-default');
  assert.equal(switched.providerProfileId, 'compat-default');
  assert.equal(resolved.id, switched.id);
  assert.equal(openaiPlugin.calls.length, 1);
  assert.equal(compatiblePlugin.calls.length, 1);
});

test('listProviderThreads includes provider-archived threads only in archived view', async () => {
  const openaiPlugin = new FakeProviderPlugin('openai-native');
  const runtime = createCodexBridgeRuntime({
    providerPlugins: [openaiPlugin as any],
    providerProfiles: [makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default')],
  });
  const first = await runtime.services.bridgeSessions.createDetachedSession({
    providerProfileId: 'openai-default',
    title: 'normal',
  });
  const second = await runtime.services.bridgeSessions.createDetachedSession({
    providerProfileId: 'openai-default',
    title: 'old parser',
  });

  await runtime.services.bridgeSessions.updateProviderThreadArchiveState('openai-default', second.codexThreadId, true);

  const defaultView = await runtime.services.bridgeSessions.listProviderThreads('openai-default', { includeArchived: false });
  const allView = await runtime.services.bridgeSessions.listProviderThreads('openai-default', { includeArchived: true });

  assert.deepEqual(defaultView.items.map((item) => item.threadId), [first.codexThreadId]);
  assert.ok(allView.items.some((item) => item.threadId === second.codexThreadId && typeof item.archivedAt === 'number'));
  assert.deepEqual(openaiPlugin.archiveThreadCalls, [second.codexThreadId]);
});

test('listProviderThreads includes local sessions missing from provider list', async () => {
  const openaiPlugin = new FakeProviderPlugin('openai-native');
  const runtime = createCodexBridgeRuntime({
    providerPlugins: [openaiPlugin as any],
    providerProfiles: [makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default')],
  });
  const session = await runtime.services.bridgeSessions.createSessionForScope(
    { platform: 'weixin', externalScopeId: 'wx-user-1' },
    { providerProfileId: 'openai-default' },
  );
  openaiPlugin.threads.delete(session.codexThreadId);

  const threads = await runtime.services.bridgeSessions.listProviderThreads('openai-default');

  assert.ok(threads.items.some((item) => item.threadId === session.codexThreadId));
  assert.equal(threads.items.find((item) => item.threadId === session.codexThreadId)?.title, session.title);
});

test('archiveInternalProviderThreads archives parser-like CodexBridge threads', async () => {
  const openaiPlugin = new FakeProviderPlugin('openai-native');
  const runtime = createCodexBridgeRuntime({
    providerPlugins: [openaiPlugin as any],
    providerProfiles: [makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default')],
  });
  await runtime.services.bridgeSessions.createDetachedSession({
    providerProfileId: 'openai-default',
    title: 'User thread',
  });
  const internal = await runtime.services.bridgeSessions.createDetachedSession({
    providerProfileId: 'openai-default',
    title: 'Review Command Skill',
  });

  const report = await runtime.services.bridgeSessions.archiveInternalProviderThreads('openai-default');

  assert.equal(report.matched, 1);
  assert.equal(report.archived, 1);
  assert.deepEqual(openaiPlugin.archiveThreadCalls, [internal.codexThreadId]);
});

test('listProviderThreads hides internal rewrite threads matched by Chinese preview text', async () => {
  const openaiPlugin = new FakeProviderPlugin('openai-native');
  const runtime = createCodexBridgeRuntime({
    providerPlugins: [openaiPlugin as any],
    providerProfiles: [makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default')],
  });

  openaiPlugin.threads.set('thread-user', {
    threadId: 'thread-user',
    cwd: '/tmp/openai-default',
    title: 'User thread',
    updatedAt: Date.now(),
    preview: '正常用户线程',
  });
  openaiPlugin.threads.set('thread-internal', {
    threadId: 'thread-internal',
    cwd: '/tmp/openai-default',
    title: null,
    updatedAt: Date.now() + 1,
    preview: '你是 CodexBridge 助理记录更新规范化器。请用中文理解用户的修改意图。',
  });

  const listed = await runtime.services.bridgeSessions.listProviderThreads('openai-default');

  assert.deepEqual(listed.items.map((item) => item.threadId), ['thread-user']);
});

test('archiveInternalProviderThreads archives rewrite threads matched by Chinese preview text even when title is missing', async () => {
  const openaiPlugin = new FakeProviderPlugin('openai-native');
  const runtime = createCodexBridgeRuntime({
    providerPlugins: [openaiPlugin as any],
    providerProfiles: [makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default')],
  });

  openaiPlugin.threads.set('thread-user', {
    threadId: 'thread-user',
    cwd: '/tmp/openai-default',
    title: 'User thread',
    updatedAt: Date.now(),
    preview: '正常用户线程',
  });
  openaiPlugin.threads.set('thread-internal', {
    threadId: 'thread-internal',
    cwd: '/tmp/openai-default',
    title: null,
    updatedAt: Date.now() + 1,
    preview: '你是 CodexBridge 助理记录更新规范化器。请用中文理解用户的修改意图。',
  });

  const report = await runtime.services.bridgeSessions.archiveInternalProviderThreads('openai-default');

  assert.equal(report.matched, 1);
  assert.equal(report.archived, 1);
  assert.deepEqual(report.matches.map((item) => item.threadId), ['thread-internal']);
  assert.deepEqual(openaiPlugin.archiveThreadCalls, ['thread-internal']);
});
