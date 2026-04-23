import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  extractCodexTokenIdentity,
  readCodexAccountIdentity,
  readCodexAuthState,
  resolveCodexAuthPath,
  writeCodexAuthFile,
} from './auth_state.js';
import {
  EncryptedFileCodexCredentialStore,
  SecretToolCodexCredentialStore,
  type CodexCredentialStore,
  type CodexCredentialStoreKind,
  type CodexStoredCredentials,
} from './credential_store.js';
import {
  refreshOpenAITokens,
} from './oauth_device.js';
import { CodexAppClient, createNoopLogger } from './app_client.js';

export { readCodexAccountIdentity, resolveCodexAuthPath } from './auth_state.js';

export interface CodexAccountSummary {
  id: string;
  index: number;
  label: string;
  email: string | null;
  name: string | null;
  accountId: string | null;
  plan: string | null;
  planType: string | null;
  credentialStore: CodexCredentialStoreKind;
  addedAt: number;
  lastUsedAt: number | null;
  isActive: boolean;
}

export interface CodexPendingLoginSummary {
  id: string;
  requestedByScope: string | null;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  createdAt: number;
  expiresAt: number;
  intervalSeconds: number;
  nextPollAt: number;
}

export interface CodexAccountListResult {
  accounts: CodexAccountSummary[];
  activeAccountId: string | null;
  pendingLogin: CodexPendingLoginSummary | null;
}

export interface CodexCompletedPendingLoginResult {
  status: 'completed';
  account: CodexAccountSummary;
  authPath: string;
}

export interface CodexPendingPendingLoginResult {
  status: 'pending';
  pendingLogin: CodexPendingLoginSummary;
  retryAfterMs: number;
}

export interface CodexExpiredPendingLoginResult {
  status: 'expired';
}

export interface CodexFailedPendingLoginResult {
  status: 'failed';
  error: string;
  oauthError: string | null;
  retryable: boolean;
  pendingLogin: CodexPendingLoginSummary | null;
}

export type CodexPendingLoginRefreshResult =
  | CodexCompletedPendingLoginResult
  | CodexPendingPendingLoginResult
  | CodexExpiredPendingLoginResult
  | CodexFailedPendingLoginResult;

interface PersistedAccountPool {
  version: number;
  activeAccountId: string | null;
  pendingLogin: PersistedPendingLogin | null;
  accounts: PersistedAccount[];
}

interface PersistedAccount {
  id: string;
  label: string;
  email: string | null;
  name: string | null;
  accountId: string | null;
  plan: string | null;
  credentialStore: CodexCredentialStoreKind;
  addedAt: number;
  lastUsedAt: number | null;
}

interface PersistedPendingLogin {
  id: string;
  requestedByScope: string | null;
  loginId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  createdAt: number;
  expiresAt: number;
  intervalSeconds: number;
  nextPollAt: number;
  authFingerprint: string | null;
}

interface CodexLoginRpcClientLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  request(method: string, params: any, options?: { timeoutMs?: number }): Promise<any>;
  isConnected?(): boolean;
}

interface PendingLoginSession {
  loginId: string;
  client: CodexLoginRpcClientLike;
}

export class CodexAccountManager {
  rootDir: string;

  poolPath: string;

  authPath: string;

  env: NodeJS.ProcessEnv;

  fetchImpl: typeof fetch;

  now: () => number;

  randomUUIDImpl: () => string;

  codexCliBin: string;

  stores: Record<CodexCredentialStoreKind, CodexCredentialStore>;

  loginClientFactory: () => CodexLoginRpcClientLike;

  pendingLoginSession: PendingLoginSession | null;

  constructor({
    rootDir = defaultCodexAccountRoot(),
    env = process.env,
    authPath = null,
    fetchImpl = fetch,
    now = () => Date.now(),
    randomUUIDImpl = randomUUID,
    codexCliBin = 'codex',
    loginClientFactory = null,
    platform = process.platform,
    commandRunner = spawnSync,
  }: {
    rootDir?: string;
    env?: NodeJS.ProcessEnv;
    authPath?: string | null;
    fetchImpl?: typeof fetch;
    now?: () => number;
    randomUUIDImpl?: () => string;
    codexCliBin?: string;
    loginClientFactory?: (() => CodexLoginRpcClientLike) | null;
    platform?: NodeJS.Platform;
    commandRunner?: typeof spawnSync;
  } = {}) {
    this.rootDir = path.resolve(rootDir);
    this.poolPath = path.join(this.rootDir, 'accounts.json');
    this.env = env;
    this.authPath = path.resolve(authPath ?? resolveCodexAuthPath(env));
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.randomUUIDImpl = randomUUIDImpl;
    this.codexCliBin = codexCliBin;
    this.stores = {
      'secret-tool': new SecretToolCodexCredentialStore({
        platform,
        commandRunner,
      }),
      'encrypted-file': new EncryptedFileCodexCredentialStore({
        rootDir: path.join(this.rootDir, 'secrets'),
        env,
      }),
    };
    this.loginClientFactory = loginClientFactory ?? (() => new CodexAppClient({
      codexCliBin: this.codexCliBin,
      logger: createNoopLogger(),
    }));
    this.pendingLoginSession = null;
  }

  async getPendingLogin(): Promise<CodexPendingLoginSummary | null> {
    const pool = await this.readPool();
    return summarizePendingLogin(pool.pendingLogin, this.now());
  }

  async startDeviceLogin({
    requestedByScope = null,
  }: {
    requestedByScope?: string | null;
  } = {}): Promise<CodexPendingLoginSummary> {
    const now = this.now();
    const pool = await this.readPool();
    const existingPending = summarizePendingLogin(pool.pendingLogin, now);
    if (existingPending && this.hasLivePendingLoginSession(pool.pendingLogin)) {
      return existingPending;
    }
    if (pool.pendingLogin) {
      await this.stopPendingLoginSession();
      pool.pendingLogin = null;
      await this.writePool(pool);
    }
    const client = this.loginClientFactory();
    try {
      await client.start();
      const flow = await client.request('account/login/start', {
        type: 'chatgptDeviceCode',
      }, { timeoutMs: 20_000 });
      const loginId = normalizeString(flow?.loginId);
      const verificationUrl = normalizeString(flow?.verificationUrl);
      const userCode = normalizeString(flow?.userCode);
      if (!loginId || !verificationUrl || !userCode) {
        throw new Error('Codex login start returned incomplete device-code data');
      }
      pool.pendingLogin = {
        id: this.randomUUIDImpl(),
        requestedByScope: normalizeString(requestedByScope),
        loginId,
        userCode,
        verificationUri: verificationUrl,
        verificationUriComplete: verificationUrl,
        createdAt: now,
        expiresAt: now + 15 * 60_000,
        intervalSeconds: 5,
        nextPollAt: now + 5_000,
        authFingerprint: this.readHostAuthFingerprint(),
      };
      await this.writePool(pool);
      this.pendingLoginSession = {
        loginId,
        client,
      };
      return summarizePendingLogin(pool.pendingLogin, now) as CodexPendingLoginSummary;
    } catch (error) {
      await client.stop().catch(() => {});
      throw error;
    }
  }

  async refreshPendingLogin(): Promise<CodexPendingLoginRefreshResult | null> {
    const now = this.now();
    const pool = await this.readPool();
    const pending = pool.pendingLogin;
    if (!pending) {
      return null;
    }
    if (isPendingExpired(pending, now)) {
      pool.pendingLogin = null;
      await this.writePool(pool);
      await this.stopPendingLoginSession();
      return { status: 'expired' };
    }
    const currentFingerprint = this.readHostAuthFingerprint();
    if (currentFingerprint && currentFingerprint !== pending.authFingerprint) {
      pool.pendingLogin = null;
      await this.writePool(pool);
      await this.stopPendingLoginSession();
      const syncedPool = await this.synchronizePoolWithHostAuth(pool);
      const accountIndex = syncedPool.accounts.findIndex((account) => account.id === syncedPool.activeAccountId);
      const activeAccount = accountIndex >= 0 ? summarizeAccount(
        syncedPool.accounts[accountIndex] as PersistedAccount,
        accountIndex,
        syncedPool.activeAccountId,
      ) : null;
      if (!activeAccount) {
        return {
          status: 'failed',
          error: 'Codex login completed, but the active account could not be imported',
          oauthError: null,
          retryable: false,
          pendingLogin: null,
        };
      }
      return {
        status: 'completed',
        account: activeAccount,
        authPath: this.authPath,
      };
    }
    if (!this.hasLivePendingLoginSession(pending)) {
      pool.pendingLogin = null;
      await this.writePool(pool);
      await this.stopPendingLoginSession();
      return { status: 'expired' };
    }
    return {
      status: 'pending',
      pendingLogin: summarizePendingLogin(pending, now) as CodexPendingLoginSummary,
      retryAfterMs: Math.max(0, pending.nextPollAt - now),
    };
  }

  async cancelPendingLogin(): Promise<boolean> {
    const pool = await this.readPool();
    const hadPending = Boolean(pool.pendingLogin);
    if (hadPending) {
      const session = this.pendingLoginSession;
      if (pool.pendingLogin?.loginId && session?.loginId === pool.pendingLogin.loginId) {
        await session.client.request('account/login/cancel', {
          loginId: pool.pendingLogin.loginId,
        }, { timeoutMs: 20_000 }).catch(() => null);
      } else if (pool.pendingLogin?.loginId) {
        await this.runLoginRpc('account/login/cancel', {
          loginId: pool.pendingLogin.loginId,
        }).catch(() => null);
      }
      pool.pendingLogin = null;
      await this.writePool(pool);
      await this.stopPendingLoginSession();
    }
    return hadPending;
  }

  async listAccounts(): Promise<CodexAccountListResult> {
    const pool = await this.readPoolWithHostAuth();
    const accounts = pool.accounts.map((account, index) => summarizeAccount(account, index, pool.activeAccountId));
    return {
      accounts,
      activeAccountId: pool.activeAccountId,
      pendingLogin: summarizePendingLogin(pool.pendingLogin, this.now()),
    };
  }

  async switchAccountByIndex(index: number): Promise<{
    account: CodexAccountSummary;
    authPath: string;
    refreshed: boolean;
  }> {
    const normalizedIndex = Number.parseInt(String(index), 10);
    if (!Number.isFinite(normalizedIndex) || normalizedIndex < 1) {
      throw new Error('Account index must be a positive integer');
    }
    const now = this.now();
    const pool = await this.readPoolWithHostAuth();
    const previousPool = clonePool(pool);
    const account = pool.accounts[normalizedIndex - 1];
    if (!account) {
      throw new Error(`Account ${normalizedIndex} does not exist`);
    }
    const loaded = await this.loadCredentialsForAccount(account);
    const fresh = await this.ensureFreshCredentials(account, loaded);
    Object.assign(account, fresh.account);
    account.lastUsedAt = now;
    pool.activeAccountId = account.id;
    await this.writePool(pool);
    let authPath: string;
    try {
      authPath = await this.syncActiveAuth(account, fresh.credentials);
    } catch (error) {
      await this.writePool(previousPool).catch(() => {});
      throw error;
    }
    return {
      account: summarizeAccount(account, normalizedIndex - 1, pool.activeAccountId),
      authPath,
      refreshed: fresh.refreshed,
    };
  }

  async finalizeCompletedLogin(
    pool: PersistedAccountPool,
    pending: PersistedPendingLogin,
    tokens: {
      accessToken: string;
      refreshToken: string;
      idToken: string | null;
      expiresAt: number | null;
      tokenType: string | null;
      scope: string | null;
    },
  ): Promise<{
    account: CodexAccountSummary;
    authPath: string;
  }> {
    const now = this.now();
    const previousPool = clonePool(pool);
    const identity = extractCodexTokenIdentity({
      accessToken: tokens.accessToken,
      idToken: tokens.idToken,
    });
    const existing = findMatchingAccount(pool.accounts, identity.accountId, identity.email);
    const account = existing ?? {
      id: this.randomUUIDImpl(),
      label: '',
      email: null,
      name: null,
      accountId: null,
      plan: null,
      credentialStore: 'encrypted-file' as CodexCredentialStoreKind,
      addedAt: now,
      lastUsedAt: null,
    };
    const label = normalizeString(account.label)
      ?? normalizeString(identity.email)
      ?? normalizeString(identity.name)
      ?? normalizeString(identity.accountId)
      ?? `OpenAI account ${pool.accounts.length + (existing ? 0 : 1)}`;
    account.label = label;
    account.email = normalizeString(identity.email) ?? account.email;
    account.name = normalizeString(identity.name) ?? account.name;
    account.accountId = normalizeString(identity.accountId) ?? account.accountId;
    account.plan = normalizeString(identity.plan) ?? account.plan;
    account.lastUsedAt = now;
    const credentials: CodexStoredCredentials = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: normalizeString(tokens.idToken),
      accountId: normalizeString(identity.accountId) ?? normalizeString(account.accountId),
      expiresAt: tokens.expiresAt,
      tokenType: normalizeString(tokens.tokenType),
      scope: normalizeString(tokens.scope),
      createdAt: existing ? now : now,
      updatedAt: now,
    };
    account.credentialStore = await this.saveCredentials(account, credentials);
    if (!existing) {
      pool.accounts.push(account);
    }
    pool.activeAccountId = account.id;
    pool.pendingLogin = null;
    await this.writePool(pool);
    let authPath: string;
    try {
      authPath = await this.syncActiveAuth(account, credentials);
    } catch (error) {
      await this.writePool(previousPool).catch(() => {});
      if (!existing) {
        await this.getStore(account.credentialStore).remove(account.id).catch(() => false);
      }
      throw error;
    }
    const index = pool.accounts.findIndex((candidate) => candidate.id === account.id);
    return {
      account: summarizeAccount(account, index, pool.activeAccountId),
      authPath,
    };
  }

  async ensureFreshCredentials(
    account: PersistedAccount,
    credentials: CodexStoredCredentials,
  ): Promise<{
    account: PersistedAccount;
    credentials: CodexStoredCredentials;
    refreshed: boolean;
  }> {
    const now = this.now();
    const shouldRefresh = credentialsNeedRefresh(credentials, now);
    if (!shouldRefresh) {
      return {
        account,
        credentials,
        refreshed: false,
      };
    }
    const refreshed = await refreshOpenAITokens({
      refreshToken: credentials.refreshToken,
      fetchImpl: this.fetchImpl,
      now,
    });
    const identity = extractCodexTokenIdentity({
      accessToken: refreshed.accessToken,
      idToken: refreshed.idToken ?? credentials.idToken,
      accountId: refreshed.idToken ? null : credentials.accountId,
    });
    const nextAccount = {
      ...account,
      email: normalizeString(identity.email) ?? account.email,
      name: normalizeString(identity.name) ?? account.name,
      accountId: normalizeString(identity.accountId) ?? account.accountId,
      plan: normalizeString(identity.plan) ?? account.plan,
    };
    const nextCredentials: CodexStoredCredentials = {
      ...credentials,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      idToken: normalizeString(refreshed.idToken) ?? credentials.idToken,
      accountId: normalizeString(identity.accountId) ?? account.accountId,
      expiresAt: refreshed.expiresAt,
      tokenType: refreshed.tokenType,
      scope: refreshed.scope,
      updatedAt: now,
    };
    nextAccount.credentialStore = await this.saveCredentials(nextAccount, nextCredentials);
    return {
      account: nextAccount,
      credentials: nextCredentials,
      refreshed: true,
    };
  }

  async loadCredentialsForAccount(account: PersistedAccount): Promise<CodexStoredCredentials> {
    const store = this.getStore(account.credentialStore);
    const credentials = await store.load(account.id);
    if (!credentials) {
      throw new Error(`Stored credentials for account ${account.label} are unavailable`);
    }
    return credentials;
  }

  async saveCredentials(account: PersistedAccount, credentials: CodexStoredCredentials): Promise<CodexCredentialStoreKind> {
    const primaryStore = account.credentialStore === 'secret-tool'
      ? this.getStore('secret-tool')
      : await this.selectPreferredStore();
    const label = `CodexBridge ${account.label}`;
    try {
      await primaryStore.save(account.id, credentials, label);
      return primaryStore.kind;
    } catch (error) {
      if (primaryStore.kind !== 'secret-tool') {
        throw error;
      }
      const fallbackStore = this.getStore('encrypted-file');
      await fallbackStore.save(account.id, credentials, label);
      return fallbackStore.kind;
    }
  }

  async selectPreferredStore(): Promise<CodexCredentialStore> {
    const secretToolStore = this.getStore('secret-tool');
    if (await secretToolStore.isAvailable()) {
      return secretToolStore;
    }
    return this.getStore('encrypted-file');
  }

  getStore(kind: CodexCredentialStoreKind): CodexCredentialStore {
    return this.stores[kind];
  }

  async syncActiveAuth(account: PersistedAccount, credentials: CodexStoredCredentials): Promise<string> {
    return writeCodexAuthFile({
      authPath: this.authPath,
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      idToken: credentials.idToken,
      accountId: normalizeString(account.accountId) ?? credentials.accountId,
      email: normalizeString(account.email),
      authMode: 'chatgpt',
      now: this.now(),
    });
  }

  async readPool(): Promise<PersistedAccountPool> {
    try {
      const raw = JSON.parse(await fs.promises.readFile(this.poolPath, 'utf8'));
      return normalizePool(raw);
    } catch {
      return createEmptyPool();
    }
  }

  async readPoolWithHostAuth(): Promise<PersistedAccountPool> {
    const pool = await this.readPool();
    return this.synchronizePoolWithHostAuth(pool);
  }

  async writePool(pool: PersistedAccountPool): Promise<void> {
    await fs.promises.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const tempPath = `${this.poolPath}.tmp-${process.pid}-${Date.now()}`;
    await fs.promises.writeFile(tempPath, `${JSON.stringify(pool, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      await fs.promises.chmod(tempPath, 0o600);
    } catch {}
    await fs.promises.rename(tempPath, this.poolPath);
    try {
      await fs.promises.chmod(this.poolPath, 0o600);
    } catch {}
  }

  async synchronizePoolWithHostAuth(pool: PersistedAccountPool): Promise<PersistedAccountPool> {
    const authState = readCodexAuthState({
      authPath: this.authPath,
      env: this.env,
    });
    const accessToken = normalizeString(authState?.tokens.accessToken);
    const refreshToken = normalizeString(authState?.tokens.refreshToken);
    const identity = authState?.identity ?? null;
    if (!accessToken || !refreshToken || !identity) {
      return pool;
    }
    const consolidation = consolidateAccountsForHostIdentity(pool, identity);
    if (consolidation.changed) {
      pool = consolidation.pool;
    }
    const existing = findMatchingAccount(pool.accounts, identity.accountId, identity.email);
    const now = this.now();
    const observedAt = parseOptionalDateMs(authState?.tokens.lastRefresh) ?? now;
    const account = existing ?? {
      id: this.randomUUIDImpl(),
      label: '',
      email: null,
      name: null,
      accountId: null,
      plan: null,
      credentialStore: 'encrypted-file' as CodexCredentialStoreKind,
      addedAt: observedAt,
      lastUsedAt: null,
    };
    let changed = consolidation.changed;
    const nextLabel = normalizeString(account.label)
      ?? normalizeString(identity.email)
      ?? normalizeString(identity.name)
      ?? normalizeString(identity.accountId)
      ?? `OpenAI account ${pool.accounts.length + (existing ? 0 : 1)}`;
    if (account.label !== nextLabel) {
      account.label = nextLabel;
      changed = true;
    }
    const nextEmail = normalizeString(identity.email) ?? account.email;
    const nextName = normalizeString(identity.name) ?? account.name;
    const nextAccountId = normalizeString(identity.accountId) ?? account.accountId;
    const nextPlan = normalizeString(identity.plan) ?? account.plan;
    if (account.email !== nextEmail) {
      account.email = nextEmail;
      changed = true;
    }
    if (account.name !== nextName) {
      account.name = nextName;
      changed = true;
    }
    if (account.accountId !== nextAccountId) {
      account.accountId = nextAccountId;
      changed = true;
    }
    if (account.plan !== nextPlan) {
      account.plan = nextPlan;
      changed = true;
    }
    if (!account.lastUsedAt || account.lastUsedAt < observedAt) {
      account.lastUsedAt = observedAt;
      changed = true;
    }
    const credentials: CodexStoredCredentials = {
      accessToken,
      refreshToken,
      idToken: normalizeString(authState?.tokens.idToken),
      accountId: normalizeString(identity.accountId),
      expiresAt: extractCodexTokenIdentity({
        accessToken,
        idToken: normalizeString(authState?.tokens.idToken),
        accountId: normalizeString(identity.accountId),
      }).accessTokenExpiresAt,
      tokenType: null,
      scope: null,
      createdAt: existing?.addedAt ?? observedAt,
      updatedAt: observedAt,
    };
    const credentialStore = await this.saveCredentials(account, credentials);
    if (account.credentialStore !== credentialStore) {
      account.credentialStore = credentialStore;
      changed = true;
    }
    if (!existing) {
      pool.accounts.push(account);
      changed = true;
    }
    if (pool.activeAccountId !== account.id) {
      pool.activeAccountId = account.id;
      changed = true;
    }
    if (changed) {
      await this.writePool(pool);
    }
    return pool;
  }

  readHostAuthFingerprint(): string | null {
    const authState = readCodexAuthState({
      authPath: this.authPath,
      env: this.env,
    });
    if (!authState) {
      return null;
    }
    const payload = JSON.stringify({
      accountId: authState.identity?.accountId ?? null,
      email: authState.identity?.email ?? null,
      lastRefresh: authState.tokens.lastRefresh ?? null,
      accessToken: authState.tokens.accessToken ?? null,
      refreshToken: authState.tokens.refreshToken ?? null,
      idToken: authState.tokens.idToken ?? null,
    });
    return createHash('sha256').update(payload).digest('hex');
  }

  async runLoginRpc(method: string, params: Record<string, unknown>): Promise<any> {
    const client = this.loginClientFactory();
    try {
      await client.start();
      return await client.request(method, params, { timeoutMs: 20_000 });
    } finally {
      await client.stop().catch(() => {});
    }
  }

  hasLivePendingLoginSession(pending: PersistedPendingLogin | null): boolean {
    if (!pending?.loginId) {
      return false;
    }
    const session = this.pendingLoginSession;
    if (!session || session.loginId !== pending.loginId) {
      return false;
    }
    if (typeof session.client.isConnected === 'function') {
      return session.client.isConnected();
    }
    return true;
  }

  async stopPendingLoginSession(): Promise<void> {
    const session = this.pendingLoginSession;
    this.pendingLoginSession = null;
    if (!session) {
      return;
    }
    await session.client.stop().catch(() => {});
  }
}

function defaultCodexAccountRoot(): string {
  return path.join(os.homedir(), '.codexbridge', 'codex', 'accounts');
}

function createEmptyPool(): PersistedAccountPool {
  return {
    version: 1,
    activeAccountId: null,
    pendingLogin: null,
    accounts: [],
  };
}

function clonePool(pool: PersistedAccountPool): PersistedAccountPool {
  return JSON.parse(JSON.stringify(pool)) as PersistedAccountPool;
}

function normalizePool(value: unknown): PersistedAccountPool {
  const raw = isRecord(value) ? value : {};
  const accountsRaw = Array.isArray(raw.accounts) ? raw.accounts : [];
  return {
    version: 1,
    activeAccountId: normalizeString(raw.activeAccountId),
    pendingLogin: normalizePendingLogin(raw.pendingLogin),
    accounts: accountsRaw
      .map(normalizePersistedAccount)
      .filter(Boolean) as PersistedAccount[],
  };
}

function normalizePersistedAccount(value: unknown): PersistedAccount | null {
  const raw = isRecord(value) ? value : null;
  const id = normalizeString(raw?.id);
  const label = normalizeString(raw?.label);
  const credentialStore = normalizeCredentialStore(raw?.credentialStore);
  const addedAt = normalizeFiniteNumber(raw?.addedAt);
  if (!id || !label || !credentialStore || !addedAt) {
    return null;
  }
  return {
    id,
    label,
    email: normalizeString(raw?.email),
    name: normalizeString(raw?.name),
    accountId: normalizeString(raw?.accountId),
    plan: normalizeString(raw?.plan),
    credentialStore,
    addedAt,
    lastUsedAt: normalizeFiniteNumber(raw?.lastUsedAt),
  };
}

function normalizePendingLogin(value: unknown): PersistedPendingLogin | null {
  const raw = isRecord(value) ? value : null;
  const id = normalizeString(raw?.id);
  const loginId = normalizeString(raw?.loginId);
  const userCode = normalizeString(raw?.userCode);
  const verificationUri = normalizeString(raw?.verificationUri);
  const createdAt = normalizeFiniteNumber(raw?.createdAt);
  const expiresAt = normalizeFiniteNumber(raw?.expiresAt);
  const intervalSeconds = normalizeFiniteNumber(raw?.intervalSeconds);
  const nextPollAt = normalizeFiniteNumber(raw?.nextPollAt);
  if (!id || !loginId || !userCode || !verificationUri || !createdAt || !expiresAt || !intervalSeconds || !nextPollAt) {
    return null;
  }
  return {
    id,
    requestedByScope: normalizeString(raw?.requestedByScope),
    loginId,
    userCode,
    verificationUri,
    verificationUriComplete: normalizeString(raw?.verificationUriComplete),
    createdAt,
    expiresAt,
    intervalSeconds,
    nextPollAt,
    authFingerprint: normalizeString(raw?.authFingerprint),
  };
}

function summarizeAccount(
  account: PersistedAccount,
  index: number,
  activeAccountId: string | null,
): CodexAccountSummary {
  return {
    id: account.id,
    index: index + 1,
    label: account.label,
    email: account.email,
    name: account.name,
    accountId: account.accountId,
    plan: account.plan,
    planType: account.plan,
    credentialStore: account.credentialStore,
    addedAt: account.addedAt,
    lastUsedAt: account.lastUsedAt,
    isActive: account.id === activeAccountId,
  };
}

function summarizePendingLogin(
  pending: PersistedPendingLogin | null,
  now: number,
): CodexPendingLoginSummary | null {
  if (!pending || isPendingExpired(pending, now)) {
    return null;
  }
  return {
    id: pending.id,
    requestedByScope: pending.requestedByScope,
    userCode: pending.userCode,
    verificationUri: pending.verificationUri,
    verificationUriComplete: pending.verificationUriComplete,
    createdAt: pending.createdAt,
    expiresAt: pending.expiresAt,
    intervalSeconds: pending.intervalSeconds,
    nextPollAt: pending.nextPollAt,
  };
}

function isPendingExpired(pending: PersistedPendingLogin, now: number): boolean {
  return pending.expiresAt <= now;
}

function findMatchingAccount(
  accounts: PersistedAccount[],
  accountId: string | null,
  email: string | null,
): PersistedAccount | null {
  const normalizedAccountId = normalizeString(accountId);
  if (normalizedAccountId) {
    const byAccountId = accounts.find((account) => normalizeString(account.accountId) === normalizedAccountId);
    if (byAccountId) {
      return byAccountId;
    }
  }
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail) {
    return accounts.find((account) => normalizeEmail(account.email) === normalizedEmail) ?? null;
  }
  return null;
}

function consolidateAccountsForHostIdentity(
  pool: PersistedAccountPool,
  identity: { email: string | null; accountId: string | null },
): {
  pool: PersistedAccountPool;
  changed: boolean;
} {
  const normalizedEmail = normalizeEmail(identity.email);
  if (!normalizedEmail) {
    return { pool, changed: false };
  }
  const sameEmail = pool.accounts.filter((account) => normalizeEmail(account.email) === normalizedEmail);
  if (sameEmail.length <= 1) {
    return { pool, changed: false };
  }
  const normalizedAccountId = normalizeString(identity.accountId);
  const matchedByAccountId = normalizedAccountId
    ? sameEmail.find((account) => normalizeString(account.accountId) === normalizedAccountId) ?? null
    : null;
  const matchedByActive = sameEmail.find((account) => account.id === pool.activeAccountId) ?? null;
  const fallback = [...sameEmail].sort(compareAccountsForRetention)[0] ?? null;
  const primary = matchedByAccountId ?? matchedByActive ?? fallback;
  if (!primary) {
    return { pool, changed: false };
  }
  const duplicates = sameEmail.filter((account) => account.id !== primary.id);
  if (duplicates.length === 0) {
    return { pool, changed: false };
  }
  for (const duplicate of duplicates) {
    primary.label = normalizeString(primary.label)
      ?? normalizeString(duplicate.label)
      ?? primary.label;
    primary.email = normalizeString(primary.email)
      ?? normalizeString(duplicate.email)
      ?? primary.email;
    primary.name = normalizeString(primary.name)
      ?? normalizeString(duplicate.name)
      ?? primary.name;
    primary.accountId = normalizeString(primary.accountId)
      ?? normalizeString(duplicate.accountId)
      ?? primary.accountId;
    primary.plan = normalizeString(primary.plan)
      ?? normalizeString(duplicate.plan)
      ?? primary.plan;
    primary.addedAt = Math.min(primary.addedAt, duplicate.addedAt);
    primary.lastUsedAt = Math.max(primary.lastUsedAt ?? 0, duplicate.lastUsedAt ?? 0) || null;
  }
  const duplicateIds = new Set(duplicates.map((account) => account.id));
  pool.accounts = pool.accounts.filter((account) => !duplicateIds.has(account.id));
  if (pool.activeAccountId && (pool.activeAccountId === primary.id || duplicateIds.has(pool.activeAccountId))) {
    pool.activeAccountId = primary.id;
  }
  return {
    pool,
    changed: true,
  };
}

function compareAccountsForRetention(left: PersistedAccount, right: PersistedAccount): number {
  const leftLastUsed = left.lastUsedAt ?? 0;
  const rightLastUsed = right.lastUsedAt ?? 0;
  if (leftLastUsed !== rightLastUsed) {
    return rightLastUsed - leftLastUsed;
  }
  if (left.addedAt !== right.addedAt) {
    return right.addedAt - left.addedAt;
  }
  return left.id.localeCompare(right.id);
}

function credentialsNeedRefresh(credentials: CodexStoredCredentials, now: number): boolean {
  const derivedIdentity = extractCodexTokenIdentity({
    accessToken: credentials.accessToken,
    idToken: credentials.idToken,
  });
  const knownExpiry = credentials.expiresAt ?? derivedIdentity.accessTokenExpiresAt;
  return typeof knownExpiry === 'number' && Number.isFinite(knownExpiry) && knownExpiry <= now + 60_000;
}

function normalizeCredentialStore(value: unknown): CodexCredentialStoreKind | null {
  if (value === 'secret-tool' || value === 'encrypted-file') {
    return value;
  }
  return null;
}

function normalizeString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function normalizeFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeEmail(value: unknown): string | null {
  const normalized = normalizeString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function parseOptionalDateMs(value: unknown): number | null {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
