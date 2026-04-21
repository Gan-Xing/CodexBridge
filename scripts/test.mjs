import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const distTestDir = path.join(process.cwd(), 'dist', 'test');
fs.rmSync(distTestDir, { recursive: true, force: true });

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...process.argv.slice(2)], {
  stdio: 'inherit',
});

if (typeof result.status === 'number') {
  process.exit(result.status);
}

process.exit(1);
