import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const distTestDir = path.join(process.cwd(), 'dist', 'test');
fs.rmSync(distTestDir, { recursive: true, force: true });

const LIVE_AGENT_TEST_ENV_FLAG = 'CODEXBRIDGE_TEST_ALLOW_LIVE_AGENT';
const isolatedEnv = { ...process.env };

if (isolatedEnv[LIVE_AGENT_TEST_ENV_FLAG] !== '1') {
  for (const key of [
    'CODEXBRIDGE_AGENT_API_KEY',
    'CODEXBRIDGE_AGENT_BASE_URL',
    'CODEXBRIDGE_AGENT_API',
    'CODEXBRIDGE_AGENT_MODEL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_API_BASE_URL',
    'OPENAI_MODEL',
    'MINIMAX_API_KEY',
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

const testArgs =
  process.argv.length > 2 ? process.argv.slice(2) : collectTestFiles(path.join(process.cwd(), 'test'));

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...testArgs], {
  env: isolatedEnv,
  stdio: 'inherit',
});

if (typeof result.status === 'number') {
  process.exit(result.status);
}

process.exit(1);
