import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { WeixinAccountStore } from './platforms/weixin/account_store.js';
import { WEIXIN_DEFAULT_BASE_URL, defaultCodexBridgeStateDir } from './platforms/weixin/config.js';
import { WeixinPlatformPlugin } from './platforms/weixin/plugin.js';
import { DEFAULT_ILINK_BOT_TYPE, officialQrLogin } from './platforms/weixin/official/login.js';
import { clearContextTokensForAccount } from './platforms/weixin/official/context_tokens.js';
import { createCodexBridgeRuntime } from './runtime/bootstrap.js';
import { createFileJsonRepositories } from './store/file_json/create_file_json_repositories.js';
import { loadCodexProfilesFromEnv } from './providers/codex/config.js';
import { CodexAccountManager } from './providers/codex/account_manager.js';
import { CodexGoalManager } from './providers/codex/goal_state.js';
import { CodexNativeApiService } from './providers/codex/native_api_service.js';
import { OpenAINativeProviderPlugin } from './providers/openai_native/plugin.js';
import { OpenAICompatibleProviderPlugin } from './providers/openai_compatible/plugin.js';
import { WeixinBridgeRuntime } from './runtime/weixin_bridge_runtime.js';
import { createI18n } from './i18n/index.js';

const CLI_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(CLI_FILE), '..');

interface WeixinLoginArgs {
  baseUrl: string | null;
  stateDir: string | null;
  botType: string;
  timeoutSeconds: number;
}

interface WeixinServeArgs {
  stateDir: string | null;
  cwd: string | null;
}

interface WeixinClearContextArgs {
  stateDir: string | null;
  accountId: string | null;
}

interface CodexCleanupInternalThreadsArgs {
  stateDir: string | null;
  cwd: string | null;
  dryRun: boolean;
  limit: number;
}

interface CodexNativeApiServeArgs {
  stateDir: string | null;
  cwd: string | null;
  host: string | null;
  port: number | null;
  providerProfileId: string | null;
}

interface EmbeddedCodexNativeApiOptions {
  enabled: boolean;
  host: string;
  port: number;
  providerProfileId: string;
  authToken: string | null;
  defaultModel: string | null;
  requestTitlePrefix: string | null;
}

interface ServeLockPayload {
  pid: number;
  startedAt: string;
  cwd: string;
}

interface ServeLock {
  lockPath: string;
  release(): Promise<void>;
  releaseSync(): void;
}

interface PendingRestartNotification {
  externalScopeId: string;
  content: string;
  queuedAt: string;
}

const DEFAULT_CODEX_NATIVE_API_HOST = '127.0.0.1';
const DEFAULT_CODEX_NATIVE_API_PORT = 43182;

async function main(argv: string[] = process.argv.slice(2)) {
  loadRepoEnvDefaults();
  const [group, command, ...args] = argv;
  if (group === 'weixin' && command === 'login') {
    return runWeixinLogin(args);
  }
  if (group === 'weixin' && command === 'serve') {
    return runWeixinServe(args);
  }
  if (group === 'weixin' && command === 'clear-context') {
    return runWeixinClearContext(args);
  }
  if (group === 'codex' && command === 'cleanup-internal-threads') {
    return runCodexCleanupInternalThreads(args);
  }
  if (group === 'codex' && command === 'native-api-serve') {
    return runCodexNativeApiServe(args);
  }
  printUsage();
  process.exitCode = 1;
}

async function runWeixinLogin(args: string[]) {
  const i18n = createI18n();
  const options = parseWeixinLoginArgs(args);
  const stateDir = path.resolve(options.stateDir ?? defaultCodexBridgeStateDir());
  const accountsDir = path.join(stateDir, 'weixin', 'accounts');
  const accountStore = new WeixinAccountStore({ rootDir: accountsDir });
  let qrFilePath: string | null = null;

  const credentials = await officialQrLogin({
    accountStore,
    accountsDir,
    botType: options.botType ?? DEFAULT_ILINK_BOT_TYPE,
    timeoutSeconds: options.timeoutSeconds,
    onQrCode: async ({ qrcode, qrcodeImageContent }) => {
      const output = await materializeQrArtifact({
        stateDir,
        qrcode,
        qrcodeImageContent,
      });
      qrFilePath = output.filePath ?? null;
      process.stdout.write(`${i18n.t('cli.login.qrGenerated')}\n`);
      process.stdout.write(`qrcode: ${qrcode}\n`);
      if (output.filePath) {
        process.stdout.write(`file: ${output.filePath}\n`);
      }
      if (output.sourceUrl) {
        process.stdout.write(`url: ${output.sourceUrl}\n`);
      }
      if (!output.filePath && !output.sourceUrl && qrcodeImageContent) {
        process.stdout.write(`content: ${truncate(qrcodeImageContent, 400)}\n`);
      }
      process.stdout.write(`${i18n.t('cli.login.scanPrompt')}\n`);
    },
    onStatus: async ({ status }) => {
      process.stdout.write(`status: ${status}\n`);
    },
  });

  if (!credentials) {
    process.stderr.write(`${i18n.t('cli.login.timeout')}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`${i18n.t('cli.login.success')}\n`);
  process.stdout.write(`account_id: ${credentials.account_id}\n`);
  process.stdout.write(`user_id: ${credentials.user_id || ''}\n`);
  process.stdout.write(`base_url: ${credentials.base_url}\n`);
  process.stdout.write(`saved_account_file: ${path.join(accountsDir, `${credentials.account_id}.json`)}\n`);
  if (qrFilePath) {
    process.stdout.write(`qr_file: ${qrFilePath}\n`);
  }
}

async function runWeixinClearContext(args: string[]) {
  const i18n = createI18n();
  const options = parseWeixinClearContextArgs(args);
  const stateDir = path.resolve(options.stateDir ?? defaultCodexBridgeStateDir());
  const accountsDir = path.join(stateDir, 'weixin', 'accounts');
  const accountStore = new WeixinAccountStore({ rootDir: accountsDir });
  const allAccounts = accountStore.listAccounts();

  if (allAccounts.length === 0) {
    process.stderr.write(`${i18n.t('cli.clearContext.noAccounts')}\n`);
    process.exitCode = 1;
    return;
  }

  const accountId = resolveClearContextAccountId({
    requestedAccountId: options.accountId,
    allAccounts,
  });
  if (!accountId) {
    process.stderr.write(`${i18n.t('cli.clearContext.accountRequired')}\n`);
    process.exitCode = 1;
    return;
  }
  if (!allAccounts.includes(accountId)) {
    process.stderr.write(`${i18n.t('cli.clearContext.accountNotFound', { accountId })}\n`);
    process.exitCode = 1;
    return;
  }

  clearContextTokensForAccount(accountsDir, accountId);
  process.stdout.write(`${i18n.t('cli.clearContext.success')}\n`);
  process.stdout.write(`${i18n.t('cli.clearContext.account', { value: accountId })}\n`);
}

async function runWeixinServe(args: string[]) {
  const i18n = createI18n();
  const options = parseWeixinServeArgs(args);
  const stateDir = path.resolve(options.stateDir ?? defaultCodexBridgeStateDir());
  const defaultCwd = path.resolve(options.cwd ?? process.env.CODEXBRIDGE_DEFAULT_CWD ?? process.cwd());
  const accountsDir = path.join(stateDir, 'weixin', 'accounts');
  const accountStore = new WeixinAccountStore({ rootDir: accountsDir });
  const serveLock = await acquireServeLock(path.join(stateDir, 'runtime', 'weixin-serve.lock'));
  const repositories = createFileJsonRepositories(path.join(stateDir, 'runtime'));
  const codexProfiles = loadCodexProfilesFromEnv();
  const codexAuthManager = createWeixinServeCodexAuthManager(stateDir);
  const runtime = createCodexBridgeRuntime({
    platformPlugins: [
      new WeixinPlatformPlugin({ accountStore }),
    ],
    providerPlugins: [
      new OpenAINativeProviderPlugin(),
      new OpenAICompatibleProviderPlugin(),
    ],
    providerProfiles: codexProfiles.profiles,
    defaultProviderProfileId: codexProfiles.defaultProviderProfileId,
    defaultCwd,
    locale: i18n.locale,
    repositories,
    assistantAttachmentRoot: path.join(stateDir, 'assistant', 'attachments'),
    codexAuthManager,
    codexGoalManager: createWeixinServeCodexGoalManager(stateDir),
    restartBridge: async ({ event }) => {
      await queueWeixinBridgeRestart({
        stateDir,
        externalScopeId: event?.externalScopeId ?? null,
      });
    },
  });
  const platformPlugin = runtime.registry.getPlatform('weixin') as WeixinPlatformPlugin;
  const bridgeRuntime = new WeixinBridgeRuntime({
    platformPlugin,
    bridgeCoordinator: runtime.services.bridgeCoordinator,
    automationJobs: runtime.services.automationJobs,
    agentJobs: runtime.services.agentJobs,
    assistantRecords: runtime.services.assistantRecords,
    onError: (async (error: unknown) => {
      process.stderr.write(`[weixin] ${formatError(error)}\n`);
    }) as any,
    locale: i18n.locale,
  } as any);
  const embeddedNativeApiOptions = resolveEmbeddedCodexNativeApiOptions({
    env: process.env,
    defaultProviderProfileId: runtime.config.defaultProviderProfileId,
  });
  const nativeApi = embeddedNativeApiOptions.enabled
    ? new CodexNativeApiService({
      providerProfiles: runtime.repositories.providerProfiles,
      providerRegistry: runtime.registry,
      defaultProviderProfileId: runtime.config.defaultProviderProfileId,
      providerProfileId: embeddedNativeApiOptions.providerProfileId,
      authPath: codexAuthManager.authPath,
      env: process.env,
      host: embeddedNativeApiOptions.host,
      port: embeddedNativeApiOptions.port,
      authToken: embeddedNativeApiOptions.authToken,
      defaultModel: embeddedNativeApiOptions.defaultModel,
      defaultCwd,
      defaultLocale: i18n.locale,
      requestTitlePrefix: embeddedNativeApiOptions.requestTitlePrefix,
    })
    : null;

  process.stdout.write(`${i18n.t('cli.serve.starting')}\n`);
  process.stdout.write(`state_dir: ${stateDir}\n`);
  process.stdout.write(`default_provider_profile: ${runtime.config.defaultProviderProfileId}\n`);
  process.stdout.write(`serve_lock: ${serveLock.lockPath}\n`);
  process.stdout.write(`${i18n.t('cli.serve.defaultCwd', { value: runtime.config.defaultCwd ?? i18n.t('common.none') })}\n`);
  process.stdout.write(`native_api_enabled: ${nativeApi ? 'true' : 'false'}\n`);

  let stopped = false;
  process.once('exit', () => {
    serveLock.releaseSync();
  });
  const stop = async (signal: string) => {
    if (stopped) {
      return;
    }
    stopped = true;
    process.stdout.write(`${i18n.t('cli.serve.stopping', { signal })}\n`);
    try {
      await bridgeRuntime.stop();
      await nativeApi?.stop().catch(() => {});
    } finally {
      await stopRuntimeProviderPlugins(runtime.registry.listProviders());
      await serveLock.release();
      process.exit(0);
    }
  };

  process.on('SIGINT', () => { void stop('SIGINT'); });
  process.on('SIGTERM', () => { void stop('SIGTERM'); });

  try {
    await flushPendingRestartNotifications({
      stateDir,
      platformPlugin,
    });
    if (nativeApi) {
      const binding = await nativeApi.start();
      process.stdout.write(`native_api_base_url: ${nativeApi.baseUrl}\n`);
      process.stdout.write(`native_api_provider_profile: ${binding.providerProfileId}\n`);
      process.stdout.write(`native_api_provider_kind: ${binding.providerKind}\n`);
      process.stdout.write(`native_api_auth_mode: ${embeddedNativeApiOptions.authToken ? i18n.t('common.enabled') : i18n.t('common.disabled')}\n`);
    }
    await bridgeRuntime.start();
  } finally {
    await nativeApi?.stop().catch(() => {});
    await stopRuntimeProviderPlugins(runtime.registry.listProviders());
    await serveLock.release();
  }
}

async function runCodexCleanupInternalThreads(args: string[]) {
  const i18n = createI18n();
  const options = parseCodexCleanupInternalThreadsArgs(args);
  const stateDir = path.resolve(options.stateDir ?? defaultCodexBridgeStateDir());
  const defaultCwd = path.resolve(options.cwd ?? process.env.CODEXBRIDGE_DEFAULT_CWD ?? process.cwd());
  const repositories = createFileJsonRepositories(path.join(stateDir, 'runtime'));
  const codexProfiles = loadCodexProfilesFromEnv();
  const runtime = createCodexBridgeRuntime({
    providerPlugins: [
      new OpenAINativeProviderPlugin(),
      new OpenAICompatibleProviderPlugin(),
    ],
    providerProfiles: codexProfiles.profiles,
    defaultProviderProfileId: codexProfiles.defaultProviderProfileId,
    defaultCwd,
    locale: i18n.locale,
    repositories,
    assistantAttachmentRoot: path.join(stateDir, 'assistant', 'attachments'),
    codexAuthManager: createWeixinServeCodexAuthManager(stateDir),
    codexGoalManager: createWeixinServeCodexGoalManager(stateDir),
  });

  process.stdout.write(`${i18n.t('cli.cleanupInternalThreads.starting')}\n`);
  process.stdout.write(`mode: ${options.dryRun ? 'dry-run' : 'apply'}\n`);
  process.stdout.write(`state_dir: ${stateDir}\n`);
  process.stdout.write(`default_cwd: ${defaultCwd}\n`);
  process.stdout.write(`limit: ${options.limit}\n`);

  try {
    const reports = await runtime.services.bridgeCoordinator.cleanupInternalProviderThreads({
      dryRun: options.dryRun,
      limit: options.limit,
    });
    let totalScanned = 0;
    let totalMatched = 0;
    let totalArchived = 0;
    let totalFailed = 0;

    for (const report of reports) {
      const failed = Array.isArray(report.failed) ? report.failed : [];
      const matches = Array.isArray(report.matches) ? report.matches : [];
      totalScanned += Number(report.scanned ?? 0);
      totalMatched += Number(report.matched ?? 0);
      totalArchived += Number(report.archived ?? 0);
      totalFailed += failed.length;
      process.stdout.write(`\nprofile: ${report.providerProfileId}\n`);
      process.stdout.write(`scanned: ${Number(report.scanned ?? 0)}\n`);
      process.stdout.write(`matched: ${Number(report.matched ?? 0)}\n`);
      process.stdout.write(`archived: ${Number(report.archived ?? 0)}\n`);
      if (matches.length > 0) {
        process.stdout.write('matches:\n');
        for (const match of matches.slice(0, 20)) {
          process.stdout.write(`  - ${match.threadId} ${match.title ?? ''}\n`);
        }
        if (matches.length > 20) {
          process.stdout.write(`  ... ${matches.length - 20} more\n`);
        }
      }
      if (failed.length > 0) {
        process.stdout.write('failed:\n');
        for (const item of failed) {
          process.stdout.write(`  - ${item.threadId || '(profile)'} ${item.error}\n`);
        }
      }
    }

    process.stdout.write('\nsummary:\n');
    process.stdout.write(`scanned: ${totalScanned}\n`);
    process.stdout.write(`matched: ${totalMatched}\n`);
    process.stdout.write(`archived: ${totalArchived}\n`);
    process.stdout.write(`failed: ${totalFailed}\n`);
    if (options.dryRun) {
      process.stdout.write(`${i18n.t('cli.cleanupInternalThreads.dryRunHint')}\n`);
    }
    if (totalFailed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await stopRuntimeProviderPlugins(runtime.registry.listProviders());
  }
}

async function runCodexNativeApiServe(args: string[]) {
  const i18n = createI18n();
  const options = parseCodexNativeApiServeArgs(args);
  const stateDir = path.resolve(options.stateDir ?? defaultCodexBridgeStateDir());
  const defaultCwd = path.resolve(options.cwd ?? process.env.CODEXBRIDGE_DEFAULT_CWD ?? process.cwd());
  const serveLock = await acquireServeLock(path.join(stateDir, 'runtime', 'codex-native-api-serve.lock'));
  const repositories = createFileJsonRepositories(path.join(stateDir, 'runtime'));
  const codexProfiles = loadCodexProfilesFromEnv();
  const codexAuthManager = createWeixinServeCodexAuthManager(stateDir);
  const runtime = createCodexBridgeRuntime({
    providerPlugins: [
      new OpenAINativeProviderPlugin(),
      new OpenAICompatibleProviderPlugin(),
    ],
    providerProfiles: codexProfiles.profiles,
    defaultProviderProfileId: codexProfiles.defaultProviderProfileId,
    defaultCwd,
    locale: i18n.locale,
    repositories,
    assistantAttachmentRoot: path.join(stateDir, 'assistant', 'attachments'),
    codexAuthManager,
    codexGoalManager: createWeixinServeCodexGoalManager(stateDir),
  });
  const host = options.host
    ?? normalizeCliString(process.env.CODEX_NATIVE_API_HOST)
    ?? DEFAULT_CODEX_NATIVE_API_HOST;
  const port = options.port
    ?? parseOptionalNonNegativeInt(process.env.CODEX_NATIVE_API_PORT)
    ?? DEFAULT_CODEX_NATIVE_API_PORT;
  const providerProfileId = options.providerProfileId
    ?? normalizeCliString(process.env.CODEX_NATIVE_API_PROVIDER_PROFILE_ID)
    ?? null;
  const authToken = normalizeCliString(process.env.CODEX_NATIVE_API_AUTH_TOKEN);
  const defaultModel = normalizeCliString(process.env.CODEX_NATIVE_API_DEFAULT_MODEL);
  const requestTitlePrefix = normalizeCliString(process.env.CODEX_NATIVE_API_TITLE_PREFIX);
  const nativeApi = new CodexNativeApiService({
    providerProfiles: runtime.repositories.providerProfiles,
    providerRegistry: runtime.registry,
    defaultProviderProfileId: runtime.config.defaultProviderProfileId,
    providerProfileId,
    authPath: codexAuthManager.authPath,
    env: process.env,
    host,
    port,
    authToken,
    defaultModel,
    defaultCwd,
    defaultLocale: i18n.locale,
    requestTitlePrefix,
  });

  process.once('exit', () => {
    serveLock.releaseSync();
  });

  let stopped = false;
  let resolveStopped: (() => void) | null = null;
  const stoppedPromise = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });
  const stop = async (signal: string) => {
    if (stopped) {
      return;
    }
    stopped = true;
    process.stdout.write(`${i18n.t('cli.nativeApiServe.stopping', { signal })}\n`);
    try {
      await nativeApi.stop();
    } finally {
      await stopRuntimeProviderPlugins(runtime.registry.listProviders());
      await serveLock.release();
      resolveStopped?.();
    }
  };
  process.on('SIGINT', () => { void stop('SIGINT'); });
  process.on('SIGTERM', () => { void stop('SIGTERM'); });

  try {
    const binding = await nativeApi.start();
    process.stdout.write(`${i18n.t('cli.nativeApiServe.starting')}\n`);
    process.stdout.write(`state_dir: ${stateDir}\n`);
    process.stdout.write(`default_cwd: ${defaultCwd}\n`);
    process.stdout.write(`host: ${host}\n`);
    process.stdout.write(`port: ${port}\n`);
    process.stdout.write(`base_url: ${nativeApi.baseUrl}\n`);
    process.stdout.write(`provider_profile: ${binding.providerProfileId}\n`);
    process.stdout.write(`provider_kind: ${binding.providerKind}\n`);
    process.stdout.write(`provider_display_name: ${binding.providerDisplayName}\n`);
    process.stdout.write(`auth_mode: ${authToken ? i18n.t('common.enabled') : i18n.t('common.disabled')}\n`);
    process.stdout.write(`auth_path: ${binding.authPath ?? i18n.t('common.none')}\n`);
    await stoppedPromise;
  } finally {
    if (!stopped) {
      await nativeApi.stop().catch(() => {});
      await stopRuntimeProviderPlugins(runtime.registry.listProviders());
      await serveLock.release();
    }
  }
}

function parseWeixinLoginArgs(args: string[]): WeixinLoginArgs {
  const options: WeixinLoginArgs = {
    baseUrl: null,
    stateDir: null,
    botType: '3',
    timeoutSeconds: 480,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === '--base-url' && next) {
      options.baseUrl = next;
      index += 1;
      continue;
    }
    if (arg === '--state-dir' && next) {
      options.stateDir = next;
      index += 1;
      continue;
    }
    if (arg === '--bot-type' && next) {
      options.botType = next;
      index += 1;
      continue;
    }
    if (arg === '--timeout-sec' && next) {
      const value = Number.parseInt(next, 10);
      if (Number.isFinite(value) && value > 0) {
        options.timeoutSeconds = value;
      }
      index += 1;
      continue;
    }
  }
  return options;
}

function parseWeixinServeArgs(args: string[]): WeixinServeArgs {
  const options: WeixinServeArgs = {
    stateDir: null,
    cwd: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === '--state-dir' && next) {
      options.stateDir = next;
      index += 1;
      continue;
    }
    if (arg === '--cwd' && next) {
      options.cwd = next;
      index += 1;
    }
  }
  return options;
}

function parseWeixinClearContextArgs(args: string[]): WeixinClearContextArgs {
  const options: WeixinClearContextArgs = {
    stateDir: null,
    accountId: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === '--state-dir' && next) {
      options.stateDir = next;
      index += 1;
      continue;
    }
    if (arg === '--account-id' && next) {
      options.accountId = next;
      index += 1;
    }
  }
  return options;
}

function parseCodexCleanupInternalThreadsArgs(args: string[]): CodexCleanupInternalThreadsArgs {
  const options: CodexCleanupInternalThreadsArgs = {
    stateDir: null,
    cwd: null,
    dryRun: true,
    limit: 100_000,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === '--state-dir' && next) {
      options.stateDir = next;
      index += 1;
      continue;
    }
    if (arg === '--cwd' && next) {
      options.cwd = next;
      index += 1;
      continue;
    }
    if (arg === '--limit' && next) {
      const limit = Number.parseInt(next, 10);
      if (Number.isFinite(limit) && limit > 0) {
        options.limit = limit;
      }
      index += 1;
      continue;
    }
    if (arg === '--apply') {
      options.dryRun = false;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
    }
  }
  return options;
}

function parseCodexNativeApiServeArgs(args: string[]): CodexNativeApiServeArgs {
  const options: CodexNativeApiServeArgs = {
    stateDir: null,
    cwd: null,
    host: null,
    port: null,
    providerProfileId: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === '--state-dir' && next) {
      options.stateDir = next;
      index += 1;
      continue;
    }
    if (arg === '--cwd' && next) {
      options.cwd = next;
      index += 1;
      continue;
    }
    if (arg === '--host' && next) {
      options.host = next;
      index += 1;
      continue;
    }
    if (arg === '--port' && next) {
      options.port = parseOptionalNonNegativeInt(next);
      index += 1;
      continue;
    }
    if (arg === '--provider-profile' && next) {
      options.providerProfileId = next;
      index += 1;
    }
  }
  return options;
}

async function materializeQrArtifact({ stateDir, qrcode, qrcodeImageContent }: {
  stateDir: string;
  qrcode: string;
  qrcodeImageContent: string | null | undefined;
}) {
  const outputDir = path.join(stateDir, 'weixin', 'login');
  await fsp.mkdir(outputDir, { recursive: true });
  if (typeof qrcodeImageContent === 'string' && qrcodeImageContent.startsWith('data:image/')) {
    const match = qrcodeImageContent.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/u);
    if (!match) {
      return { filePath: null, sourceUrl: null };
    }
    const extension = mimeToExtension(match[1]);
    const filePath = path.join(outputDir, `${sanitizeFileSegment(qrcode)}.${extension}`);
    await fsp.writeFile(filePath, Buffer.from(match[2], 'base64'));
    return { filePath, sourceUrl: null };
  }
  if (typeof qrcodeImageContent === 'string' && /^https?:\/\//u.test(qrcodeImageContent)) {
    try {
      const filePath = path.join(outputDir, `${sanitizeFileSegment(qrcode)}.png`);
      const buffer = await QRCode.toBuffer(qrcodeImageContent, {
        type: 'png',
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 512,
      });
      await fsp.writeFile(filePath, buffer);
      return { filePath, sourceUrl: qrcodeImageContent };
    } catch {
      return { filePath: null, sourceUrl: qrcodeImageContent };
    }
  }
  return { filePath: null, sourceUrl: null };
}

function mimeToExtension(contentType: string) {
  const value = String(contentType).toLowerCase();
  if (value.includes('svg')) {
    return 'svg';
  }
  if (value.includes('jpeg') || value.includes('jpg')) {
    return 'jpg';
  }
  if (value.includes('webp')) {
    return 'webp';
  }
  if (value.includes('gif')) {
    return 'gif';
  }
  return 'png';
}

function sanitizeFileSegment(value: unknown) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/gu, '-').slice(0, 120) || 'weixin-qr';
}

function truncate(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

async function acquireServeLock(lockPath: string): Promise<ServeLock> {
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    return await createServeLock(lockPath);
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error) || error.code !== 'EEXIST') {
      throw error;
    }
  }

  const existing = readServeLock(lockPath);
  if (existing?.pid && isProcessAlive(existing.pid)) {
    throw new Error(createI18n().t('cli.lock.alreadyRunning', {
      lockPath,
      pid: existing.pid,
    }));
  }

  await fsp.rm(lockPath, { force: true });
  return createServeLock(lockPath);
}

async function createServeLock(lockPath: string): Promise<ServeLock> {
  const handle = await fsp.open(lockPath, 'wx');
  const payload: ServeLockPayload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
  };
  await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  let released = false;

  return {
    lockPath,
    async release() {
      if (released) {
        return;
      }
      released = true;
      try {
        await handle.close();
      } catch {}
      await fsp.rm(lockPath, { force: true });
    },
    releaseSync() {
      if (released) {
        return;
      }
      released = true;
      try {
        handle.close().catch(() => {});
      } catch {}
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {}
    },
  };
}

function readServeLock(lockPath: string): ServeLockPayload | null {
  if (!fs.existsSync(lockPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function queueWeixinBridgeRestart({
  stateDir = defaultCodexBridgeStateDir(),
  externalScopeId = null,
}: {
  stateDir?: string;
  externalScopeId?: string | null;
} = {}) {
  const i18n = createI18n();
  if (externalScopeId) {
    await enqueuePendingRestartNotification({
      stateDir,
      externalScopeId,
      content: i18n.t('cli.serve.restartCompleted'),
    });
  }
  const scriptPath = path.resolve(process.cwd(), 'scripts/service/restart-systemd-user.sh');
  const unitName = `codexbridge-weixin-restart-${Date.now()}`;
  const cwd = process.cwd();
  const systemdStarted = await spawnDetached('systemd-run', [
    '--user',
    '--unit', unitName,
    '--collect',
    '/bin/bash',
    scriptPath,
  ], { cwd });
  if (systemdStarted) {
    return;
  }

  const fallbackStarted = await spawnDetached('/bin/bash', [scriptPath], { cwd });
  if (!fallbackStarted) {
    throw new Error(`Failed to schedule Weixin bridge restart with systemd-run or /bin/bash: ${scriptPath}`);
  }
}

function spawnDetached(command: string, args: string[], { cwd }: { cwd: string }): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (started: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(started);
    };
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        cwd,
      });
    } catch {
      settle(false);
      return;
    }
    child.once('spawn', () => {
      child.unref();
      settle(true);
    });
    child.once('error', () => {
      settle(false);
    });
  });
}

async function flushPendingRestartNotifications({
  stateDir,
  platformPlugin,
}: {
  stateDir: string;
  platformPlugin: {
    start(): Promise<void>;
    sendText(params: { externalScopeId: string; content: string }): Promise<{
      success: boolean;
    } | null | undefined>;
  };
}) {
  const filePath = pendingRestartNotificationsFile(stateDir);
  const queued = readPendingRestartNotifications(filePath);
  if (queued.length === 0) {
    return;
  }
  const remaining: PendingRestartNotification[] = [];
  await platformPlugin.start();
  for (const item of queued) {
    try {
      const result = await platformPlugin.sendText({
        externalScopeId: item.externalScopeId,
        content: item.content,
      });
      if (!result?.success) {
        remaining.push(item);
      }
    } catch {
      remaining.push(item);
    }
  }
  writePendingRestartNotifications(filePath, remaining);
}

async function enqueuePendingRestartNotification({
  stateDir,
  externalScopeId,
  content,
}: {
  stateDir: string;
  externalScopeId: string;
  content: string;
}) {
  const filePath = pendingRestartNotificationsFile(stateDir);
  const current = readPendingRestartNotifications(filePath)
    .filter((item) => item.externalScopeId !== externalScopeId);
  current.push({
    externalScopeId,
    content,
    queuedAt: new Date().toISOString(),
  });
  writePendingRestartNotifications(filePath, current);
}

function pendingRestartNotificationsFile(stateDir: string) {
  return path.join(stateDir, 'runtime', 'weixin-restart-notifications.json');
}

function readPendingRestartNotifications(filePath: string): PendingRestartNotification[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item) => item && typeof item.externalScopeId === 'string' && typeof item.content === 'string');
  } catch {
    return [];
  }
}

function writePendingRestartNotifications(filePath: string, items: PendingRestartNotification[]) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
}

function printUsage() {
  process.stdout.write([
    createI18n().t('cli.usage.title'),
    createI18n().t('cli.usage.login'),
    createI18n().t('cli.usage.clearContext'),
    createI18n().t('cli.usage.serve'),
    createI18n().t('cli.usage.cleanupInternalThreads'),
    createI18n().t('cli.usage.nativeApiServe'),
  ].join('\n'));
}

function resolveClearContextAccountId({
  requestedAccountId,
  allAccounts,
}: {
  requestedAccountId: string | null;
  allAccounts: string[];
}): string | null {
  if (requestedAccountId) {
    return requestedAccountId;
  }
  return allAccounts.length === 1 ? allAccounts[0] : null;
}

function codexLoginStateDir(stateDir: string) {
  return path.join(path.resolve(stateDir), 'runtime', 'codex-login');
}

function createWeixinServeCodexAuthManager(stateDir: string) {
  return new CodexAccountManager({
    rootDir: codexLoginStateDir(stateDir),
  });
}

function createWeixinServeCodexGoalManager(stateDir: string) {
  return new CodexGoalManager({
    filePath: path.join(path.resolve(stateDir), 'runtime', 'codex-goal.txt'),
  });
}

async function stopRuntimeProviderPlugins(providerPlugins: any[]) {
  await Promise.allSettled(providerPlugins.map((plugin) => plugin?.stop?.()));
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

function normalizeCliString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function resolveEmbeddedCodexNativeApiOptions({
  env,
  defaultProviderProfileId,
}: {
  env: NodeJS.ProcessEnv;
  defaultProviderProfileId: string | null;
}): EmbeddedCodexNativeApiOptions {
  const enabled = parseBooleanEnv(env.CODEX_NATIVE_API_ENABLE, true);
  const host = normalizeCliString(env.CODEX_NATIVE_API_HOST) ?? DEFAULT_CODEX_NATIVE_API_HOST;
  const port = parseOptionalNonNegativeInt(env.CODEX_NATIVE_API_PORT) ?? DEFAULT_CODEX_NATIVE_API_PORT;
  const preferredCodexProviderProfileId = defaultProviderProfileId === 'openai-default'
    ? defaultProviderProfileId
    : null;
  const providerProfileId = preferredCodexProviderProfileId
    ?? 'openai-default';
  return {
    enabled,
    host,
    port,
    providerProfileId,
    authToken: normalizeCliString(env.CODEX_NATIVE_API_AUTH_TOKEN),
    defaultModel: normalizeCliString(env.CODEX_NATIVE_API_DEFAULT_MODEL),
    requestTitlePrefix: normalizeCliString(env.CODEX_NATIVE_API_TITLE_PREFIX),
  };
}

function parseOptionalNonNegativeInt(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function parseBooleanEnv(value: unknown, defaultValue = false): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  if (
    normalized === '0'
    || normalized === 'false'
    || normalized === 'no'
    || normalized === 'off'
  ) {
    return false;
  }
  return normalized === '1'
    || normalized === 'true'
    || normalized === 'yes'
    || normalized === 'on';
}

function loadRepoEnvDefaults() {
  const combined = {
    ...parseEnvFile(path.join(REPO_ROOT, '.env')),
    ...parseEnvFile(path.join(REPO_ROOT, '.env.local')),
  };
  for (const [key, value] of Object.entries(combined)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const env: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const index = line.indexOf('=');
    if (index <= 0) {
      continue;
    }
    const key = line.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      continue;
    }
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

if (process.argv[1] && path.resolve(process.argv[1]) === CLI_FILE) {
  await main();
}

export {
  acquireServeLock,
  enqueuePendingRestartNotification,
  flushPendingRestartNotifications,
  main,
  materializeQrArtifact,
  codexLoginStateDir,
  createWeixinServeCodexAuthManager,
  pendingRestartNotificationsFile,
  parseCodexCleanupInternalThreadsArgs,
  parseCodexNativeApiServeArgs,
  resolveEmbeddedCodexNativeApiOptions,
  parseWeixinClearContextArgs,
  parseWeixinLoginArgs,
  parseWeixinServeArgs,
  readPendingRestartNotifications,
  resolveClearContextAccountId,
};
