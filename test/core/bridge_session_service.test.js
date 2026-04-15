import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexBridgeRuntime } from '../../src/runtime/bootstrap.js';

class FakeProviderPlugin {
  constructor(kind) {
    this.kind = kind;
    this.calls = [];
    this.counter = 0;
  }

  async startThread({ providerProfile, cwd, title, metadata }) {
    this.counter += 1;
    this.calls.push({ providerProfile, cwd, title, metadata });
    return {
      threadId: `${providerProfile.id}-thread-${this.counter}`,
      cwd: cwd ?? `/tmp/${providerProfile.id}`,
      title: title ?? `${providerProfile.displayName} thread ${this.counter}`,
    };
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

test('resolveOrCreateScopeSession reuses the same session for the same platform scope', async () => {
  const openaiPlugin = new FakeProviderPlugin('openai-native');
  const runtime = createCodexBridgeRuntime({
    providerPlugins: [openaiPlugin],
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

test('multiple platform scopes can bind to the same bridge session', async () => {
  const openaiPlugin = new FakeProviderPlugin('openai-native');
  const runtime = createCodexBridgeRuntime({
    providerPlugins: [openaiPlugin],
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
  const minimaxPlugin = new FakeProviderPlugin('minimax-via-cliproxy');
  const runtime = createCodexBridgeRuntime({
    providerPlugins: [openaiPlugin, minimaxPlugin],
    providerProfiles: [
      makeProviderProfile('openai-default', 'openai-native', 'OpenAI Default'),
      makeProviderProfile('minimax-default', 'minimax-via-cliproxy', 'MiniMax Default'),
    ],
  });

  const scopeRef = { platform: 'weixin', externalScopeId: 'wx-user-1' };
  const original = await runtime.services.bridgeSessions.createSessionForScope(scopeRef, {
    providerProfileId: 'openai-default',
  });
  const switched = await runtime.services.bridgeSessions.switchScopeProvider(scopeRef, {
    nextProviderProfileId: 'minimax-default',
  });
  const resolved = runtime.services.bridgeSessions.requireScopeSession(scopeRef);

  assert.notEqual(original.id, switched.id);
  assert.equal(original.providerProfileId, 'openai-default');
  assert.equal(switched.providerProfileId, 'minimax-default');
  assert.equal(resolved.id, switched.id);
  assert.equal(openaiPlugin.calls.length, 1);
  assert.equal(minimaxPlugin.calls.length, 1);
});
