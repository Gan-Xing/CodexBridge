#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRootDir = path.resolve(path.dirname(scriptPath), '..', '..');
const args = parseArgs(process.argv.slice(2));
const rootDir = path.resolve(args.rootDir ?? defaultRootDir);
const homeDir = args.homeDir ? path.resolve(args.homeDir) : null;
const stateDir = path.resolve(args.stateDir ?? process.env.CODEXBRIDGE_STATE_DIR ?? path.join(os.homedir(), '.codexbridge'));
const envFile = path.resolve(args.envFile ?? defaultServiceEnvFile());
const stdoutLog = args.stdoutLog ? path.resolve(args.stdoutLog) : null;
const stderrLog = args.stderrLog ? path.resolve(args.stderrLog) : null;
const restartMs = Math.max(0, Number.parseFloat(args.restartSec ?? process.env.CODEXBRIDGE_SERVICE_RESTART_SEC ?? '2') * 1000);
const serveCwd = args.cwd ? path.resolve(args.cwd) : null;
const once = Boolean(args.once);

let child = null;
let stopping = false;

await loadEnvFile(envFile);
if (homeDir) {
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.CODEX_HOME ||= path.join(homeDir, '.codex');
  if (process.platform === 'win32') {
    process.env.APPDATA ||= path.join(homeDir, 'AppData', 'Roaming');
    process.env.LOCALAPPDATA ||= path.join(homeDir, 'AppData', 'Local');
  }
}
process.env.CODEXBRIDGE_STATE_DIR ||= stateDir;

await fsp.mkdir(path.join(stateDir, 'logs'), { recursive: true }).catch(() => {});
if (stdoutLog) {
  await fsp.mkdir(path.dirname(stdoutLog), { recursive: true });
}
if (stderrLog) {
  await fsp.mkdir(path.dirname(stderrLog), { recursive: true });
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

do {
  const code = await runServe();
  if (stopping || once) {
    process.exitCode = typeof code === 'number' ? code : 0;
    break;
  }
  await sleep(restartMs);
} while (!stopping);

async function runServe() {
  const cliPath = path.join(rootDir, 'src', 'cli.ts');
  const serveArgs = [
    '--import',
    'tsx',
    cliPath,
    'weixin',
    'serve',
    '--state-dir',
    stateDir,
  ];
  if (serveCwd) {
    serveArgs.push('--cwd', serveCwd);
  }

  writeLine('stdout', `[codexbridge-service] starting: ${process.execPath} ${serveArgs.join(' ')}`);
  writeLine('stdout', `[codexbridge-service] env HOME=${process.env.HOME ?? ''}`);
  writeLine('stdout', `[codexbridge-service] env USERPROFILE=${process.env.USERPROFILE ?? ''}`);
  writeLine('stdout', `[codexbridge-service] env CODEX_HOME=${process.env.CODEX_HOME ?? ''}`);
  writeLine('stdout', `[codexbridge-service] env CODEX_REAL_BIN=${process.env.CODEX_REAL_BIN ?? ''}`);
  child = spawn(process.execPath, serveArgs, {
    cwd: rootDir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout.on('data', (chunk) => writeChunk('stdout', chunk));
  child.stderr.on('data', (chunk) => writeChunk('stderr', chunk));

  return new Promise((resolve) => {
    child.once('error', (error) => {
      writeLine('stderr', `[codexbridge-service] child spawn failed: ${error.stack || error.message}`);
      resolve(1);
    });
    child.once('exit', (code, signal) => {
      writeLine('stderr', `[codexbridge-service] child exited code=${code ?? ''} signal=${signal ?? ''}`);
      child = null;
      resolve(code);
    });
  });
}

function stop(signal) {
  if (stopping) {
    return;
  }
  stopping = true;
  writeLine('stderr', `[codexbridge-service] stopping on ${signal}`);
  if (child && !child.killed) {
    child.kill(signal);
  }
}

async function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const content = await fsp.readFile(filePath, 'utf8');
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
    let value = line.slice(index + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      continue;
    }
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function writeChunk(streamName, chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  if (streamName === 'stderr') {
    process.stderr.write(text);
  } else {
    process.stdout.write(text);
  }
  const logPath = streamName === 'stderr' ? stderrLog : stdoutLog;
  if (logPath) {
    fs.appendFile(logPath, text, () => {});
  }
}

function writeLine(streamName, line) {
  writeChunk(streamName, `${new Date().toISOString()} ${line}\n`);
}

function defaultServiceEnvFile() {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'codexbridge', 'weixin.service.env');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'codexbridge', 'weixin.service.env');
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--once') {
      parsed.once = true;
      continue;
    }
    if (arg.startsWith('--') && next && !next.startsWith('--')) {
      parsed[toCamel(arg.slice(2))] = next;
      index += 1;
    }
  }
  return parsed;
}

function toCamel(value) {
  return value.replace(/-([a-z])/gu, (_, char) => char.toUpperCase());
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
