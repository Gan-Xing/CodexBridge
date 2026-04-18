import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WeixinAccountStore } from './platforms/weixin/account_store.js';
import { WEIXIN_DEFAULT_BASE_URL, defaultCodexBridgeStateDir } from './platforms/weixin/config.js';
import { WeixinPlatformPlugin } from './platforms/weixin/plugin.js';
import { WeixinIlinkClient, qrLogin } from './platforms/weixin/client.js';
import { createCodexBridgeRuntime } from './runtime/bootstrap.js';
import { createFileJsonRepositories } from './store/file_json/create_file_json_repositories.js';
import { loadCodexProfilesFromEnv } from './providers/codex/config.js';
import { CodexProviderPlugin } from './providers/codex/plugin.js';
import { WeixinBridgeRuntime } from './runtime/weixin_bridge_runtime.js';

async function main(argv = process.argv.slice(2)) {
  const [group, command, ...args] = argv;
  if (group === 'weixin' && command === 'login') {
    return runWeixinLogin(args);
  }
  if (group === 'weixin' && command === 'serve') {
    return runWeixinServe(args);
  }
  printUsage();
  process.exitCode = 1;
}

async function runWeixinLogin(args) {
  const options = parseWeixinLoginArgs(args);
  const stateDir = path.resolve(options.stateDir ?? defaultCodexBridgeStateDir());
  const accountsDir = path.join(stateDir, 'weixin', 'accounts');
  const accountStore = new WeixinAccountStore({ rootDir: accountsDir });
  const client = new WeixinIlinkClient({
    baseUrl: options.baseUrl ?? WEIXIN_DEFAULT_BASE_URL,
  });
  let qrFilePath = null;

  const credentials = await qrLogin({
    client,
    accountStore,
    botType: options.botType,
    timeoutSeconds: options.timeoutSeconds,
    onQrCode: async ({ qrcode, qrcodeImageContent }) => {
      const output = await materializeQrArtifact({
        stateDir,
        qrcode,
        qrcodeImageContent,
      });
      qrFilePath = output.filePath ?? null;
      process.stdout.write(`二维码已生成\n`);
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
      process.stdout.write(`请用微信扫描上面的二维码。\n`);
    },
    onStatus: async ({ status }) => {
      process.stdout.write(`status: ${status}\n`);
    },
  });

  if (!credentials) {
    process.stderr.write(`扫码登录超时，未拿到凭据。\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`登录成功\n`);
  process.stdout.write(`account_id: ${credentials.account_id}\n`);
  process.stdout.write(`user_id: ${credentials.user_id || ''}\n`);
  process.stdout.write(`base_url: ${credentials.base_url}\n`);
  process.stdout.write(`saved_account_file: ${path.join(accountsDir, `${credentials.account_id}.json`)}\n`);
  if (qrFilePath) {
    process.stdout.write(`qr_file: ${qrFilePath}\n`);
  }
}

async function runWeixinServe(args) {
  const options = parseWeixinServeArgs(args);
  const stateDir = path.resolve(options.stateDir ?? defaultCodexBridgeStateDir());
  const defaultCwd = path.resolve(options.cwd ?? process.env.CODEXBRIDGE_DEFAULT_CWD ?? process.cwd());
  const accountsDir = path.join(stateDir, 'weixin', 'accounts');
  const accountStore = new WeixinAccountStore({ rootDir: accountsDir });
  const serveLock = await acquireServeLock(path.join(stateDir, 'runtime', 'weixin-serve.lock'));
  const repositories = createFileJsonRepositories(path.join(stateDir, 'runtime'));
  const codexProfiles = loadCodexProfilesFromEnv();
  const runtime = createCodexBridgeRuntime({
    platformPlugins: [
      new WeixinPlatformPlugin({ accountStore }),
    ],
    providerPlugins: [
      new CodexProviderPlugin(),
    ],
    providerProfiles: codexProfiles.profiles,
    defaultProviderProfileId: codexProfiles.defaultProviderProfileId,
    defaultCwd,
    repositories,
    restartBridge: async () => {
      await queueWeixinBridgeRestart();
    },
  });
  const platformPlugin = runtime.registry.getPlatform('weixin');
  const bridgeRuntime = new WeixinBridgeRuntime({
    platformPlugin,
    bridgeCoordinator: runtime.services.bridgeCoordinator,
    onError: async (error) => {
      process.stderr.write(`[weixin] ${formatError(error)}\n`);
    },
  });

  process.stdout.write(`启动 WeChat bridge\n`);
  process.stdout.write(`state_dir: ${stateDir}\n`);
  process.stdout.write(`default_provider_profile: ${runtime.config.defaultProviderProfileId}\n`);
  process.stdout.write(`serve_lock: ${serveLock.lockPath}\n`);
  process.stdout.write(`default_cwd: ${runtime.config.defaultCwd ?? '(none)'}\n`);

  let stopped = false;
  process.once('exit', () => {
    serveLock.releaseSync();
  });
  const stop = async (signal) => {
    if (stopped) {
      return;
    }
    stopped = true;
    process.stdout.write(`收到 ${signal}，正在停止 WeChat bridge...\n`);
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
    await bridgeRuntime.start();
  } finally {
    await serveLock.release();
  }
}

function parseWeixinLoginArgs(args) {
  const options = {
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

function parseWeixinServeArgs(args) {
  const options = {
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

async function materializeQrArtifact({ stateDir, qrcode, qrcodeImageContent }) {
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

function mimeToExtension(contentType) {
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

function sanitizeFileSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/gu, '-').slice(0, 120) || 'weixin-qr';
}

function truncate(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

async function acquireServeLock(lockPath) {
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });
  try {
    return await createServeLock(lockPath);
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
  }

  const existing = readServeLock(lockPath);
  if (existing?.pid && isProcessAlive(existing.pid)) {
    throw new Error(
      `WeChat bridge is already running for ${lockPath} (pid ${existing.pid}). Stop the existing process before starting another.`,
    );
  }

  await fsp.rm(lockPath, { force: true });
  return createServeLock(lockPath);
}

async function createServeLock(lockPath) {
  const handle = await fsp.open(lockPath, 'wx');
  const payload = {
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

function readServeLock(lockPath) {
  if (!fs.existsSync(lockPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
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

async function queueWeixinBridgeRestart() {
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

function printUsage() {
  process.stdout.write([
    'Usage:',
    '  node src/cli.js weixin login [--base-url URL] [--state-dir DIR] [--bot-type N] [--timeout-sec N]',
    '  node src/cli.js weixin serve [--state-dir DIR] [--cwd DIR]',
  ].join('\n'));
}

function formatError(error) {
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
  main,
  materializeQrArtifact,
  parseWeixinLoginArgs,
  parseWeixinServeArgs,
};
