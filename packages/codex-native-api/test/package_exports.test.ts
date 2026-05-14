import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CODEX_NATIVE_API_PACKAGE_NAME,
  CODEX_NATIVE_API_PACKAGE_PHASE,
  CODEX_NATIVE_API_RELEASE_CHANNEL,
  CodexNativeApiService,
  CodexNativeApiServer,
  CodexNativeRuntime,
  InMemoryCodexNativeApiContinuationRegistry,
  loadDefaultCodexNativeProviderProfile,
} from '../src/index.js';
import { parseCliArgs } from '../src/cli.js';
import {
  buildDaemonInstallPlan,
  buildWindowsInstallScript,
  resolveDaemonLayout,
} from '../src/daemon_manager.js';

function parseSsePayloads(raw: string): any[] {
  return raw
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const dataLine = block
        .split('\n')
        .find((line) => line.startsWith('data: '));
      return dataLine ? dataLine.slice(6) : null;
    })
    .filter((line): line is string => Boolean(line) && line !== '[DONE]')
    .map((line) => JSON.parse(line));
}

test('package exports the first extraction metadata', () => {
  assert.equal(CODEX_NATIVE_API_PACKAGE_NAME, 'codex-native-api');
  assert.equal(CODEX_NATIVE_API_PACKAGE_PHASE, 'public-core-preview');
  assert.equal(CODEX_NATIVE_API_RELEASE_CHANNEL, 'public-preview');
});

test('package exports the core localhost runtime surface', () => {
  const registry = new InMemoryCodexNativeApiContinuationRegistry();
  assert.equal(registry.describe().persistence, 'in_process');
  assert.equal(typeof CodexNativeRuntime, 'function');
  assert.equal(typeof CodexNativeApiServer, 'function');
  assert.equal(typeof CodexNativeApiService, 'function');
});

test('service can bootstrap the default Codex provider and auth path automatically', () => {
  const profile = loadDefaultCodexNativeProviderProfile({
    CODEX_HOME: '/tmp/codex-native-api-home',
    PATH: process.env.PATH ?? '',
  });
  assert.equal(profile.id, 'openai-default');
  assert.equal(profile.providerKind, 'openai-native');
  assert.equal(profile.displayName, 'Codex OpenAI');

  const service = new CodexNativeApiService({
    env: {
      CODEX_HOME: '/tmp/codex-native-api-home',
      PATH: process.env.PATH ?? '',
    },
  });
  assert.deepEqual(service.describeBinding(), {
    providerProfileId: 'openai-default',
    providerKind: 'openai-native',
    providerDisplayName: 'Codex OpenAI',
    authPath: '/tmp/codex-native-api-home/auth.json',
  });
});

test('package metadata and root entrypoint keep a stable public boundary', () => {
  const packageJsonPath = path.resolve(import.meta.dirname, '../package.json');
  const indexPath = path.resolve(import.meta.dirname, '../src/index.ts');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    name?: string;
    private?: boolean;
    main?: string;
    types?: string;
    bin?: Record<string, string>;
    exports?: Record<string, { types?: string; default?: string } | string>;
    files?: string[];
    devDependencies?: Record<string, string>;
  };
  const source = fs.readFileSync(indexPath, 'utf8');

  assert.equal(packageJson.name, 'codex-native-api');
  assert.equal(packageJson.private, false);
  assert.equal(packageJson.main, './dist/index.js');
  assert.equal(packageJson.types, './dist/index.d.ts');
  assert.equal(packageJson.bin?.['codex-native-api'], './dist/cli.js');
  assert.deepEqual(Object.keys(packageJson.exports ?? {}).sort(), ['.', './package.json']);
  assert.equal((packageJson.exports?.['.'] as { types?: string })?.types, './dist/index.d.ts');
  assert.equal((packageJson.exports?.['.'] as { default?: string })?.default, './dist/index.js');
  assert.deepEqual(packageJson.files, ['dist', 'README.md']);
  assert.equal(typeof packageJson.devDependencies?.typescript, 'string');
  assert.equal(typeof packageJson.devDependencies?.tsx, 'string');
  assert.equal(typeof packageJson.devDependencies?.['@types/node'], 'string');
  assert.equal(source.includes('export * from'), false);
  assert.match(source, /export \{\s*[\s\S]*CodexNativeRuntime/);
  assert.match(source, /export type \{\s*[\s\S]*ProviderPluginContract/);
});

test('package cli keeps a minimal standalone startup surface', () => {
  assert.deepEqual(parseCliArgs([
    '--port', '4242',
    '--public',
    '--cwd', '/tmp/work',
    '--default-model', 'gpt-5.5',
  ]), {
    host: null,
    port: 4242,
    authPath: null,
    authToken: null,
    cwd: '/tmp/work',
    providerProfileId: null,
    defaultModel: 'gpt-5.5',
    publicBind: true,
  });
});

test('server health metadata reports public exposure when bound to 0.0.0.0', async () => {
  const providerProfile = {
    id: 'openai-default',
    providerKind: 'openai-native',
    displayName: 'Codex OpenAI',
    config: {},
    createdAt: 0,
    updatedAt: 0,
  };
  const providerPlugin = {
    kind: 'openai-native',
    displayName: 'Codex OpenAI',
    async startThread() {
      throw new Error('unused in health check');
    },
    async readThread() {
      return null;
    },
    async listThreads() {
      return { items: [], nextCursor: null };
    },
    async startTurn() {
      throw new Error('unused in health check');
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
  };
  const runtime = new CodexNativeRuntime({
    readAccountIdentity: () => ({
      accountId: 'acct_test',
      email: 'test@example.com',
      name: 'Test User',
      plan: 'plus',
      authMode: 'chatgpt',
      authPath: '/tmp/codex-native-api-auth.json',
    }),
  });
  const server = new CodexNativeApiServer({
    runtime,
    host: '0.0.0.0',
    port: 0,
    resolveRuntimeContext: () => ({
      providerProfile,
      providerPlugin,
      authPathOrOptions: {},
    }),
  });

  await server.start();
  try {
    const port = new URL(server.baseUrl).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/health`);
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      localhost_only?: boolean;
      native_api?: { localhost_only?: boolean };
    };
    assert.equal(payload.localhost_only, false);
    assert.equal(payload.native_api?.localhost_only, false);
  } finally {
    await server.stop();
  }
});

test('responses requests normalize builtin web_search tools and pass a constrained tool policy into the runtime', async () => {
  const calls: Array<{ kind: string; payload: any }> = [];
  const runtime = new CodexNativeRuntime({
    now: () => 777_000,
    createSessionId: () => 'session-native-tools-1',
    readAccountIdentity: () => ({
      accountId: 'acct_test',
      email: 'test@example.com',
      name: 'Test User',
      plan: 'plus',
      authMode: 'chatgpt',
      authPath: '/tmp/codex-native-api-auth.json',
    }),
  });
  const providerProfile = {
    id: 'openai-default',
    providerKind: 'openai-native',
    displayName: 'Codex OpenAI',
    config: {},
    createdAt: 0,
    updatedAt: 0,
  };
  const providerPlugin = {
    kind: 'openai-native',
    displayName: 'Codex OpenAI',
    async startThread(params: any) {
      calls.push({ kind: 'startThread', payload: params });
      return {
        threadId: 'thread-native-tools-1',
        cwd: params.cwd,
        title: params.title,
      };
    },
    async readThread() {
      return null;
    },
    async listThreads() {
      return { items: [], nextCursor: null };
    },
    async startTurn(params: any) {
      calls.push({ kind: 'startTurn', payload: params });
      return {
        outputText: 'searched answer',
        previewText: '',
        threadId: params.bridgeSession.codexThreadId,
        turnId: 'turn-native-tools-1',
      };
    },
    async listModels() {
      calls.push({ kind: 'listModels', payload: null });
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
  };
  const server = new CodexNativeApiServer({
    runtime,
    defaultLocale: 'en-US',
    resolveRuntimeContext: () => ({
      providerProfile,
      providerPlugin,
      authPathOrOptions: {},
    }),
    createResponseId: () => 'resp_native_tools_1',
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        input: 'Find current Codex news.',
        tools: [{
          type: 'web_search_preview_2025_03_11',
        }],
        tool_choice: {
          type: 'allowed_tools',
          tools: [{
            type: 'web_search_preview',
          }],
        },
      }),
    });
    const body = await response.json() as any;

    assert.equal(response.status, 200);
    assert.equal(body.tools[0].type, 'web_search');
    assert.equal(body.tool_choice.type, 'allowed_tools');
    assert.equal(body.tool_choice.tools[0].type, 'web_search');
    assert.match(
      calls[2]?.payload.developerInstructions,
      /only supported built-in tool for this turn is web_search/i,
    );
    assert.match(
      calls[2]?.payload.developerInstructions,
      /Do not substitute shell commands, file edits, MCP tools, plugins, or image generation for web_search\./,
    );
    assert.equal(calls[2]?.payload.inputText, 'Find current Codex news.');
  } finally {
    await server.stop();
  }
});

test('responses rejects function tools until external tool calling is wired', async () => {
  const server = new CodexNativeApiServer({
    resolveRuntimeContext: () => {
      throw new Error('resolver should not run');
    },
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: 'Call a custom function.',
        tools: [{
          type: 'function',
          function: {
            name: 'lookup',
            parameters: { type: 'object' },
          },
        }],
      }),
    });
    const body = await response.json() as any;

    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'unsupported_responses_tooling');
    assert.match(body.error.message, /only the built-in web_search tool/i);
  } finally {
    await server.stop();
  }
});

test('responses output preserves provider tool transcript items and filters commentary-only assistant messages', async () => {
  const runtime = new CodexNativeRuntime({
    now: () => 888_000,
    createSessionId: () => 'session-native-transcript-1',
    readAccountIdentity: () => ({
      accountId: 'acct_test',
      email: 'test@example.com',
      name: 'Test User',
      plan: 'plus',
      authMode: 'chatgpt',
      authPath: '/tmp/codex-native-api-auth.json',
    }),
  });
  const providerProfile = {
    id: 'openai-default',
    providerKind: 'openai-native',
    displayName: 'Codex OpenAI',
    config: {},
    createdAt: 0,
    updatedAt: 0,
  };
  const providerPlugin = {
    kind: 'openai-native',
    displayName: 'Codex OpenAI',
    async startThread(params: any) {
      return {
        threadId: 'thread-native-transcript-1',
        cwd: params.cwd,
        title: params.title,
      };
    },
    async readThread() {
      return null;
    },
    async listThreads() {
      return { items: [], nextCursor: null };
    },
    async startTurn(params: any) {
      return {
        outputText: '',
        previewText: '',
        threadId: params.bridgeSession.codexThreadId,
        turnId: 'turn-native-transcript-1',
        responseItems: [{
          type: 'message',
          role: 'assistant',
          phase: 'commentary',
          content: [{ type: 'output_text', text: 'hidden commentary' }],
        }, {
          type: 'function_call',
          call_id: 'call_web_1',
          name: 'web_search',
          arguments: '{"query":"codex native api"}',
        }, {
          type: 'function_call_output',
          call_id: 'call_web_1',
          output: '{"hits":1}',
        }, {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'final tool-backed answer' }],
        }],
      };
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
  };
  const server = new CodexNativeApiServer({
    runtime,
    defaultLocale: 'en-US',
    resolveRuntimeContext: () => ({
      providerProfile,
      providerPlugin,
      authPathOrOptions: {},
    }),
    createResponseId: () => 'resp_native_transcript_1',
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        input: 'Search for Codex native API status.',
      }),
    });
    const body = await response.json() as any;

    assert.equal(response.status, 200);
    assert.equal(body.status, 'completed');
    assert.deepEqual(body.output.map((item: any) => item.type), [
      'function_call',
      'function_call_output',
      'message',
    ]);
    assert.equal(body.output[0].call_id, 'call_web_1');
    assert.equal(body.output[0].name, 'web_search');
    assert.equal(body.output[1].output, '{"hits":1}');
    assert.equal(body.output[2].content[0].text, 'final tool-backed answer');
  } finally {
    await server.stop();
  }
});

test('streaming responses completed event includes recovered provider tool transcript output', async () => {
  const runtime = new CodexNativeRuntime({
    now: () => 889_000,
    createSessionId: () => 'session-native-stream-transcript-1',
    readAccountIdentity: () => ({
      accountId: 'acct_test',
      email: 'test@example.com',
      name: 'Test User',
      plan: 'plus',
      authMode: 'chatgpt',
      authPath: '/tmp/codex-native-api-auth.json',
    }),
  });
  const providerProfile = {
    id: 'openai-default',
    providerKind: 'openai-native',
    displayName: 'Codex OpenAI',
    config: {},
    createdAt: 0,
    updatedAt: 0,
  };
  const providerPlugin = {
    kind: 'openai-native',
    displayName: 'Codex OpenAI',
    async startThread(params: any) {
      return {
        threadId: 'thread-native-stream-transcript-1',
        cwd: params.cwd,
        title: params.title,
      };
    },
    async readThread() {
      return null;
    },
    async listThreads() {
      return { items: [], nextCursor: null };
    },
    async startTurn(params: any) {
      return {
        outputText: '',
        previewText: '',
        threadId: params.bridgeSession.codexThreadId,
        turnId: 'turn-native-stream-transcript-1',
        responseItems: [{
          type: 'function_call',
          call_id: 'call_web_stream_1',
          name: 'web_search',
          arguments: '{"query":"codex bridge"}',
        }, {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'streamed final answer' }],
        }],
      };
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
  };
  const server = new CodexNativeApiServer({
    runtime,
    defaultLocale: 'en-US',
    resolveRuntimeContext: () => ({
      providerProfile,
      providerPlugin,
      authPathOrOptions: {},
    }),
    createResponseId: () => 'resp_native_stream_transcript_1',
  });

  await server.start();
  try {
    const response = await fetch(`${server.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.5',
        input: 'Stream Codex bridge status.',
        stream: true,
      }),
    });
    const raw = await response.text();
    const events = parseSsePayloads(raw);
    const completed = events.find((event) => event.type === 'response.completed');

    assert.equal(response.status, 200);
    assert.ok(completed);
    assert.deepEqual(completed.response.output.map((item: any) => item.type), [
      'function_call',
      'message',
    ]);
    assert.equal(completed.response.output[0].call_id, 'call_web_stream_1');
    assert.equal(completed.response.output[1].content[0].text, 'streamed final answer');
  } finally {
    await server.stop();
  }
});

test('daemon layout resolves platform-specific service paths', () => {
  const darwin = resolveDaemonLayout({
    HOME: '/tmp/darwin-home',
  }, {
    platform: 'darwin',
  });
  assert.equal(darwin.envFile, '/tmp/darwin-home/.config/codex-native-api/service.env');
  assert.equal(darwin.launchdPlistPath, '/tmp/darwin-home/Library/LaunchAgents/com.codexbridge.codex-native-api.plist');

  const linux = resolveDaemonLayout({
    HOME: '/tmp/linux-home',
  }, {
    platform: 'linux',
  });
  assert.equal(linux.systemdUnitPath, '/tmp/linux-home/.config/systemd/user/codex-native-api.service');

  const win32 = resolveDaemonLayout({
    USERPROFILE: 'C:\\Users\\GanXing',
    APPDATA: 'C:\\Users\\GanXing\\AppData\\Roaming',
  }, {
    platform: 'win32',
  });
  assert.equal(win32.envFile, 'C:\\Users\\GanXing\\AppData\\Roaming\\codex-native-api\\service.env');
  assert.equal(win32.windowsTaskName, 'CodexNativeApi');
});

test('daemon install plans render launchd, systemd, and windows service artifacts', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-api-daemon-'));

  const darwinPlan = await buildDaemonInstallPlan({
    serveOptions: {
      host: null,
      port: 4242,
      authPath: null,
      authToken: null,
      cwd: '/tmp/codex-work',
      providerProfileId: null,
      defaultModel: null,
      publicBind: true,
    },
    restartSec: 3,
    codexHome: null,
    codexRealBin: '/usr/local/bin/codex',
    launchCommand: null,
    autolaunch: false,
  }, {
    platform: 'darwin',
    env: {
      HOME: path.join(tempRoot, 'darwin-home'),
      PATH: '/usr/local/bin:/usr/bin:/bin',
    },
    currentWorkingDirectory: '/tmp/codex-work',
    entryPath: '/opt/codex-native-api/dist/cli.js',
    nodeBin: '/usr/local/bin/node',
  });

  assert.equal(darwinPlan.layout.launchdLabel, 'com.codexbridge.codex-native-api');
  assert.ok(darwinPlan.generatedAuthToken);
  assert.match(darwinPlan.serviceEnvFileContent, /CODEX_NATIVE_API_PUBLIC=1/);
  assert.match(darwinPlan.serviceEnvFileContent, /CODEX_NATIVE_API_PORT=4242/);
  assert.match(darwinPlan.artifactContent ?? '', /daemon-supervisor/);
  assert.match(darwinPlan.artifactContent ?? '', /KeepAlive/);

  const linuxPlan = await buildDaemonInstallPlan({
    serveOptions: {
      host: null,
      port: 4243,
      authPath: null,
      authToken: 'secret-token',
      cwd: '/srv/codex',
      providerProfileId: 'openai-default',
      defaultModel: 'gpt-5.5',
      publicBind: false,
    },
    restartSec: 5,
    codexHome: '/srv/.codex',
    codexRealBin: '/usr/bin/codex',
    launchCommand: 'codex-app',
    autolaunch: true,
  }, {
    platform: 'linux',
    env: {
      HOME: path.join(tempRoot, 'linux-home'),
      USER: 'ganxing',
      LOGNAME: 'ganxing',
      PATH: '/usr/local/bin:/usr/bin:/bin',
    },
    currentWorkingDirectory: '/srv/codex',
    entryPath: '/opt/codex-native-api/dist/cli.js',
    nodeBin: '/usr/bin/node',
  });

  assert.match(linuxPlan.serviceEnvFileContent, /CODEX_NATIVE_API_PORT=4243/);
  assert.match(linuxPlan.serviceEnvFileContent, /CODEX_APP_AUTOLAUNCH=true/);
  assert.match(linuxPlan.artifactContent ?? '', /Restart=always/);
  assert.match(linuxPlan.artifactContent ?? '', /EnvironmentFile=/);
  assert.match(linuxPlan.artifactContent ?? '', /daemon-supervisor/);

  const windowsPlan = await buildDaemonInstallPlan({
    serveOptions: {
      host: null,
      port: 4244,
      authPath: null,
      authToken: null,
      cwd: 'C:\\Work',
      providerProfileId: null,
      defaultModel: null,
      publicBind: false,
    },
    restartSec: 2,
    codexHome: 'C:\\Users\\GanXing\\.codex',
    codexRealBin: 'C:\\Program Files\\nodejs\\codex.cmd',
    launchCommand: null,
    autolaunch: false,
  }, {
    platform: 'win32',
    env: {
      USERPROFILE: 'C:\\Users\\GanXing',
      APPDATA: 'C:\\Users\\GanXing\\AppData\\Roaming',
      PATH: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
    },
    currentWorkingDirectory: 'C:\\Work',
    entryPath: 'C:\\pkg\\codex-native-api\\dist\\cli.js',
    nodeBin: 'C:\\Program Files\\nodejs\\node.exe',
  });

  const windowsScript = buildWindowsInstallScript(windowsPlan);
  assert.match(windowsPlan.serviceEnvFileContent, /CODEX_NATIVE_API_PORT=4244/);
  assert.match(windowsScript, /Register-ScheduledTask/);
  assert.match(windowsScript, /RestartCount 999/);
  assert.match(windowsScript, /daemon-supervisor/);
});
