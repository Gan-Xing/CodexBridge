import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const distTestDir = path.join(process.cwd(), 'dist', 'test');
fs.rmSync(distTestDir, { recursive: true, force: true });

const AGENT_COMMAND_ENV_FLAG = 'CODEXBRIDGE_ENABLE_AGENT_COMMAND';
const LIVE_AGENT_TEST_ENV_FLAG = 'CODEXBRIDGE_TEST_ALLOW_LIVE_AGENT';
const LIVE_OPENAI_COMPATIBLE_TEST_ENV_FLAG = 'CODEXBRIDGE_TEST_LIVE_OPENAI_COMPATIBLE';
loadOptionalEnvFile(process.env.CODEXBRIDGE_TEST_ENV_FILE);
const isolatedEnv = { ...process.env };
isolatedEnv[AGENT_COMMAND_ENV_FLAG] ??= '1';
const allowLiveAgent = isolatedEnv[LIVE_AGENT_TEST_ENV_FLAG] === '1';
const allowLiveOpenAICompatible = isolatedEnv[LIVE_OPENAI_COMPATIBLE_TEST_ENV_FLAG] === '1';

if (!allowLiveAgent && !allowLiveOpenAICompatible) {
  for (const key of [
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_API_BASE_URL',
    'OPENAI_MODEL',
    'MINIMAX_API_KEY',
    'MINIMAX_BASE_URL',
    'MINIMAX_MODEL',
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_BASE_URL',
    'DEEPSEEK_MODEL',
    'DEEPSEEK_DEFAULT_MODEL',
    'QWEN_API_KEY',
    'QWEN_BASE_URL',
    'QWEN_MODEL',
    'DASHSCOPE_API_KEY',
    'DASHSCOPE_BASE_URL',
    'DASHSCOPE_MODEL',
    'OPENROUTER_API_KEY',
    'OPENROUTER_BASE_URL',
    'OPENROUTER_MODEL',
  ]) {
    delete isolatedEnv[key];
  }
}

function collectTestFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTestFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

const directCliArgs = process.argv.slice(2);
const importedEntryArgs =
  directCliArgs.length === 0
    && process.argv.length === 2
    && typeof process.argv[1] === 'string'
    && process.argv[1].includes('.test.')
    ? [process.argv[1]]
    : [];

const testArgs =
  directCliArgs.length > 0
    ? directCliArgs
    : importedEntryArgs.length > 0
      ? importedEntryArgs
      : collectTestFiles(path.join(process.cwd(), 'test'));

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...testArgs], {
  env: isolatedEnv,
  stdio: 'inherit',
});

if (typeof result.status === 'number') {
  process.exit(result.status);
}

process.exit(1);

function loadOptionalEnvFile(filePath) {
  if (!filePath) {
    return;
  }
  const resolvedPath = path.resolve(String(filePath));
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`CODEXBRIDGE_TEST_ENV_FILE does not exist: ${resolvedPath}`);
  }
  const content = fs.readFileSync(resolvedPath, 'utf8');
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
    process.env[key] = value;
  }
}
