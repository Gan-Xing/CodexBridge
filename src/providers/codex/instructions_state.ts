import fs from 'node:fs';
import path from 'node:path';
import { resolveCodexHome } from './auth_state.js';

export interface CodexInstructionsSnapshot {
  path: string;
  content: string;
  exists: boolean;
}

export class CodexInstructionsManager {
  readonly filePath: string;

  constructor({
    filePath = null,
    env = process.env,
  }: {
    filePath?: string | null;
    env?: NodeJS.ProcessEnv;
  } = {}) {
    this.filePath = path.resolve(filePath ?? resolveCodexInstructionsPath(env));
  }

  async readInstructions(): Promise<CodexInstructionsSnapshot> {
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      return {
        path: this.filePath,
        content: raw,
        exists: true,
      };
    } catch {
      return {
        path: this.filePath,
        content: '',
        exists: false,
      };
    }
  }

  async writeInstructions(content: string): Promise<CodexInstructionsSnapshot> {
    const normalized = String(content ?? '').trim();
    if (!normalized) {
      return this.clearInstructions();
    }
    await writeTextAtomic(this.filePath, `${normalized}\n`);
    return {
      path: this.filePath,
      content: `${normalized}\n`,
      exists: true,
    };
  }

  async clearInstructions(): Promise<CodexInstructionsSnapshot> {
    try {
      await fs.promises.unlink(this.filePath);
    } catch {}
    return {
      path: this.filePath,
      content: '',
      exists: false,
    };
  }
}

export function resolveCodexInstructionsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveCodexHome(env), 'AGENTS.md');
}

async function writeTextAtomic(filePath: string, text: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.promises.mkdir(directory, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tempPath, text, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    await fs.promises.chmod(tempPath, 0o600);
  } catch {}
  await fs.promises.rename(tempPath, filePath);
  try {
    await fs.promises.chmod(filePath, 0o600);
  } catch {}
}
