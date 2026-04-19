import fs from 'node:fs';
import path from 'node:path';

const contextTokenStore = new Map<string, string>();

function contextTokenKey(accountId: string, userId: string): string {
  return `${accountId}:${userId}`;
}

function resolveContextTokenFilePath(accountsDir: string, accountId: string): string {
  return path.join(accountsDir, `${accountId}.context-tokens.json`);
}

function persistContextTokens(accountsDir: string, accountId: string): void {
  const prefix = `${accountId}:`;
  const tokens: Record<string, string> = {};
  for (const [key, value] of contextTokenStore) {
    if (key.startsWith(prefix)) {
      tokens[key.slice(prefix.length)] = value;
    }
  }
  const filePath = resolveContextTokenFilePath(accountsDir, accountId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(tokens, null, 2), 'utf8');
}

export function restoreContextTokens(accountsDir: string, accountId: string): void {
  const filePath = resolveContextTokenFilePath(accountsDir, accountId);
  if (!fs.existsSync(filePath)) {
    return;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const tokens = JSON.parse(raw) as Record<string, string>;
    for (const [userId, token] of Object.entries(tokens)) {
      if (typeof token === 'string' && token) {
        contextTokenStore.set(contextTokenKey(accountId, userId), token);
      }
    }
  } catch {
    // Keep startup tolerant: a broken token cache should not stop the bridge.
  }
}

export function clearContextTokensForAccount(accountsDir: string, accountId: string): void {
  const prefix = `${accountId}:`;
  for (const key of [...contextTokenStore.keys()]) {
    if (key.startsWith(prefix)) {
      contextTokenStore.delete(key);
    }
  }
  const filePath = resolveContextTokenFilePath(accountsDir, accountId);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // best effort
  }
}

export function setContextToken(
  accountsDir: string,
  accountId: string,
  userId: string,
  token: string,
): void {
  contextTokenStore.set(contextTokenKey(accountId, userId), token);
  persistContextTokens(accountsDir, accountId);
}

export function getContextToken(
  accountsDir: string,
  accountId: string,
  userId: string,
): string | null {
  const key = contextTokenKey(accountId, userId);
  const direct = contextTokenStore.get(key);
  if (typeof direct === 'string' && direct) {
    return direct;
  }

  restoreContextTokens(accountsDir, accountId);
  const restored = contextTokenStore.get(key);
  return typeof restored === 'string' && restored ? restored : null;
}

export function findAccountIdsByContextToken(
  accountsDir: string,
  accountIds: string[],
  userId: string,
): string[] {
  return accountIds.filter((accountId) => Boolean(getContextToken(accountsDir, accountId, userId)));
}

export function _resetContextTokenStoreForTest(): void {
  contextTokenStore.clear();
}
