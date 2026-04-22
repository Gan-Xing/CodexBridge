import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WeixinAccountStore } from './platforms/weixin/account_store.js';
import { WEIXIN_DEFAULT_BASE_URL, defaultCodexBridgeStateDir } from './platforms/weixin/config.js';
import { WeixinPlatformPlugin } from './platforms/weixin/plugin.js';
import { DEFAULT_ILINK_BOT_TYPE, officialQrLogin } from './platforms/weixin/official/login.js';
import { clearContextTokensForAccount } from './platforms/weixin/official/context_tokens.js';
import { createCodexBridgeRuntime } from './runtime/bootstrap.js';
import { createFileJsonRepositories } from './store/file_json/create_file_json_repositories.js';
import { loadCodexProfilesFromEnv } from './providers/codex/config.js';
import { CodexAccountManager } from './providers/codex/account_manager.js';
import { OpenAINativeProviderPlugin } from './providers/openai_native/plugin.js';
import { MiniMaxViaCLIProxyProviderPlugin } from './providers/minimax/plugin.js';
import { WeixinBridgeRuntime } from './runtime/weixin_bridge_runtime.js';
import { createI18n } from './i18n/index.js';

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

async function main(argv: string[] = process.argv.slice(2)) {
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
      new MiniMaxViaCLIProxyProviderPlugin(),
    ],
    providerProfiles: codexProfiles.profiles,
    defaultProviderProfileId: codexProfiles.defaultProviderProfileId,
    defaultCwd,
    locale: i18n.locale,
    repositories,
    codexAuthManager,
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
    onError: (async (error: unknown) => {
      process.stderr.write(`[weixin] ${formatError(error)}\n`);
    }) as any,
    locale: i18n.locale,
  } as any);

  process.stdout.write(`${i18n.t('cli.serve.starting')}\n`);
  process.stdout.write(`state_dir: ${stateDir}\n`);
  process.stdout.write(`default_provider_profile: ${runtime.config.defaultProviderProfileId}\n`);
  process.stdout.write(`serve_lock: ${serveLock.lockPath}\n`);
  process.stdout.write(`${i18n.t('cli.serve.defaultCwd', { value: runtime.config.defaultCwd ?? i18n.t('common.none') })}\n`);

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
    } finally {
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
    await bridgeRuntime.start();
  } finally {
    await serveLock.release();
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
      const response = await fetch(qrcodeImageContent);
      if (response.ok) {
        const contentType = response.headers.get('content-type') ?? 'image/png';
        const extension = mimeToExtension(contentType);
        const filePath = path.join(outputDir, `${sanitizeFileSegment(qrcode)}.${extension}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        await fsp.writeFile(filePath, buffer);
        return { filePath, sourceUrl: qrcodeImageContent };
      }
    } catch {
      return { filePath: null, sourceUrl: qrcodeImageContent };
    }
    return { filePath: null, sourceUrl: qrcodeImageContent };
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
  try {
    const child = spawn('systemd-run', [
      '--user',
      '--unit', unitName,
      '--collect',
      '/bin/bash',
      scriptPath,
    ], {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
    });
    child.unref();
    return;
  } catch {}

  const fallback = spawn('/bin/bash', [scriptPath], {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
  });
  fallback.unref();
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

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
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
  parseWeixinClearContextArgs,
  parseWeixinLoginArgs,
  parseWeixinServeArgs,
  readPendingRestartNotifications,
  resolveClearContextAccountId,
};
