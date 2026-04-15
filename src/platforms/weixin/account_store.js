import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class WeixinAccountStore {
  constructor({ rootDir = defaultWeixinAccountsDir() } = {}) {
    this.rootDir = rootDir;
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  listAccounts() {
    const entries = fs.readdirSync(this.rootDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .filter((entry) => !entry.name.endsWith('.context-tokens.json'))
      .filter((entry) => !entry.name.endsWith('.sync.json'))
      .map((entry) => entry.name.slice(0, -'.json'.length))
      .sort();
  }

  saveAccount({ accountId, token, baseUrl, userId = '' }) {
    const payload = {
      token,
      base_url: baseUrl,
      user_id: userId,
      saved_at: new Date().toISOString(),
    };
    this.writeJson(this.accountFile(accountId), payload);
    return payload;
  }

  loadAccount(accountId) {
    return this.readJson(this.accountFile(accountId));
  }

  getContextToken(accountId, peerId) {
    const tokens = this.readJson(this.contextTokensFile(accountId)) ?? {};
    const token = tokens?.[peerId];
    return typeof token === 'string' && token ? token : null;
  }

  setContextToken(accountId, peerId, contextToken) {
    const tokens = this.readJson(this.contextTokensFile(accountId)) ?? {};
    tokens[peerId] = contextToken;
    this.writeJson(this.contextTokensFile(accountId), tokens);
  }

  loadSyncCursor(accountId) {
    const payload = this.readJson(this.syncFile(accountId));
    const cursor = payload?.get_updates_buf;
    return typeof cursor === 'string' ? cursor : '';
  }

  saveSyncCursor(accountId, syncCursor) {
    this.writeJson(this.syncFile(accountId), {
      get_updates_buf: syncCursor,
    });
  }

  accountFile(accountId) {
    return path.join(this.rootDir, `${accountId}.json`);
  }

  contextTokensFile(accountId) {
    return path.join(this.rootDir, `${accountId}.context-tokens.json`);
  }

  syncFile(accountId) {
    return path.join(this.rootDir, `${accountId}.sync.json`);
  }

  readJson(filePath) {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
}

export function defaultWeixinAccountsDir() {
  return path.join(os.homedir(), '.codexbridge', 'weixin', 'accounts');
}
