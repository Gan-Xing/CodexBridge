import fs from 'node:fs';
import path from 'node:path';

export interface CodexGoalSnapshot {
  path: string;
  goal: string;
  exists: boolean;
}

export class CodexGoalManager {
  readonly filePath: string;

  constructor({
    filePath = null,
  }: {
    filePath?: string | null;
  } = {}) {
    this.filePath = path.resolve(filePath ?? path.join('.codexbridge', 'runtime', 'codex-goal.txt'));
  }

  async readGoal(): Promise<CodexGoalSnapshot> {
    try {
      const raw = await fs.promises.readFile(this.filePath, 'utf8');
      const goal = normalizeGoalText(raw);
      return {
        path: this.filePath,
        goal,
        exists: Boolean(goal),
      };
    } catch {
      return {
        path: this.filePath,
        goal: '',
        exists: false,
      };
    }
  }

  async writeGoal(goal: string): Promise<CodexGoalSnapshot> {
    const normalized = normalizeGoalText(goal);
    if (!normalized) {
      return this.clearGoal();
    }
    await writeTextAtomic(this.filePath, `${normalized}\n`);
    return {
      path: this.filePath,
      goal: normalized,
      exists: true,
    };
  }

  async clearGoal(): Promise<CodexGoalSnapshot> {
    try {
      await fs.promises.unlink(this.filePath);
    } catch {}
    return {
      path: this.filePath,
      goal: '',
      exists: false,
    };
  }
}

function normalizeGoalText(value: unknown): string {
  return String(value ?? '').trim();
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
