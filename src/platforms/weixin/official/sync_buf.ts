import fs from 'node:fs';
import path from 'node:path';

export function getSyncBufFilePath(accountsDir: string, accountId: string): string {
  return path.join(accountsDir, `${accountId}.sync.json`);
}

export function loadGetUpdatesBuf(filePath: string): string | undefined {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw) as { get_updates_buf?: string };
    if (typeof data.get_updates_buf === 'string') {
      return data.get_updates_buf;
    }
  } catch {
    // file missing or invalid; keep compatibility with tolerant official behavior
  }
  return undefined;
}

export function saveGetUpdatesBuf(filePath: string, getUpdatesBuf: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ get_updates_buf: getUpdatesBuf }, null, 2), 'utf8');
}
