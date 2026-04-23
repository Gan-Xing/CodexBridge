import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CodexAuthIdentity {
  email: string | null;
  name: string | null;
  authMode: string | null;
  accountId: string | null;
  plan: string | null;
  authPath: string;
}

export interface CodexTokenIdentity {
  email: string | null;
  name: string | null;
  authMode: string | null;
  accountId: string | null;
  plan: string | null;
  accessTokenExpiresAt: number | null;
  idTokenExpiresAt: number | null;
}

export interface CodexAuthTokens {
  accessToken: string | null;
  idToken: string | null;
  refreshToken: string | null;
  accountId: string | null;
  lastRefresh: string | null;
}

export interface CodexAuthState {
  authPath: string;
  raw: Record<string, unknown>;
  tokens: CodexAuthTokens;
  identity: CodexAuthIdentity | null;
}

export interface WriteCodexAuthOptions {
  accessToken: string;
  refreshToken: string;
  idToken?: string | null;
  accountId?: string | null;
  email?: string | null;
  authMode?: string | null;
  now?: number;
  authPath?: string;
}

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = normalizeString(env.CODEX_HOME);
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), '.codex');
}

export function resolveCodexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveCodexHome(env), 'auth.json');
}

export function readCodexAuthState(
  authPathOrOptions: string | { authPath?: string; env?: NodeJS.ProcessEnv } = {},
): CodexAuthState | null {
  const authPath = resolveRequestedAuthPath(authPathOrOptions);
  const raw = readJsonObject(authPath);
  if (!raw) {
    return null;
  }
  const tokens = readCodexAuthTokens(raw);
  const tokenIdentity = extractCodexTokenIdentity({
    accessToken: tokens.accessToken,
    idToken: tokens.idToken,
    accountId: tokens.accountId,
    authMode: firstString(raw.auth_mode),
  });
  const identity = buildCodexAuthIdentity(raw, tokenIdentity, authPath);
  return {
    authPath,
    raw,
    tokens,
    identity,
  };
}

export function readCodexAccountIdentity(
  authPathOrOptions: string | { authPath?: string; env?: NodeJS.ProcessEnv } = {},
): CodexAuthIdentity | null {
  return readCodexAuthState(authPathOrOptions)?.identity ?? null;
}

export function extractCodexTokenIdentity({
  accessToken = null,
  idToken = null,
  accountId = null,
  authMode = null,
}: {
  accessToken?: string | null;
  idToken?: string | null;
  accountId?: string | null;
  authMode?: string | null;
}): CodexTokenIdentity {
  const idPayload = decodeJwtPayload(idToken);
  const accessPayload = decodeJwtPayload(accessToken);
  const idAuthClaims = getAuthClaims(idPayload);
  const accessAuthClaims = getAuthClaims(accessPayload);
  return {
    email: firstString(
      idPayload?.email,
      accessPayload?.email,
      idAuthClaims?.email,
      accessAuthClaims?.email,
    ),
    name: firstString(
      idPayload?.name,
      accessPayload?.name,
      idAuthClaims?.name,
      accessAuthClaims?.name,
    ),
    authMode: firstString(
      authMode,
      idPayload?.auth_provider,
      accessPayload?.auth_provider,
      idAuthClaims?.auth_provider,
      accessAuthClaims?.auth_provider,
    ),
    accountId: firstString(
      idAuthClaims?.chatgpt_account_id,
      idAuthClaims?.account_id,
      idPayload?.chatgpt_account_id,
      idPayload?.account_id,
      idPayload?.accountId,
      accessAuthClaims?.chatgpt_account_id,
      accessAuthClaims?.account_id,
      accessPayload?.chatgpt_account_id,
      accessPayload?.account_id,
      accessPayload?.accountId,
      accountId,
    ),
    plan: firstString(
      idAuthClaims?.chatgpt_plan_type,
      idAuthClaims?.plan_type,
      idPayload?.chatgpt_plan_type,
      idPayload?.plan,
      accessAuthClaims?.chatgpt_plan_type,
      accessAuthClaims?.plan_type,
      accessPayload?.chatgpt_plan_type,
      accessPayload?.plan,
    ),
    accessTokenExpiresAt: readJwtExpiryMs(accessPayload),
    idTokenExpiresAt: readJwtExpiryMs(idPayload),
  };
}

export async function writeCodexAuthFile({
  accessToken,
  refreshToken,
  idToken = null,
  accountId = null,
  email = null,
  authMode = 'chatgpt',
  now = Date.now(),
  authPath = resolveCodexAuthPath(),
}: WriteCodexAuthOptions): Promise<string> {
  const existing = readJsonObject(authPath) ?? {};
  const existingTokens = isRecord(existing.tokens) ? existing.tokens : {};
  const normalizedAccountId = firstString(
    accountId,
    existingTokens.account_id,
    existing.account_id,
  );
  const normalizedEmail = firstString(email, existing.email);
  const next = {
    ...existing,
    auth_mode: firstString(authMode, existing.auth_mode) ?? 'chatgpt',
    account_id: normalizedAccountId,
    email: normalizedEmail,
    OPENAI_API_KEY: Object.prototype.hasOwnProperty.call(existing, 'OPENAI_API_KEY')
      ? existing.OPENAI_API_KEY
      : null,
    last_refresh: new Date(now).toISOString(),
    tokens: {
      ...existingTokens,
      id_token: firstString(idToken, accessToken),
      access_token: accessToken,
      refresh_token: refreshToken,
      account_id: normalizedAccountId,
    },
  };
  await writeJsonAtomic(authPath, next);
  return authPath;
}

export function decodeJwtPayload(token: string | null | undefined): Record<string, any> | null {
  if (!token) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) {
    return null;
  }
  try {
    const normalized = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(parts[1].length / 4) * 4, '=');
    const parsed = JSON.parse(Buffer.from(normalized, 'base64').toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function buildCodexAuthIdentity(
  raw: Record<string, unknown>,
  tokenIdentity: CodexTokenIdentity,
  authPath: string,
): CodexAuthIdentity | null {
  const email = firstString(raw.email, tokenIdentity.email);
  const name = firstString(raw.name, tokenIdentity.name);
  const authMode = firstString(raw.auth_mode, tokenIdentity.authMode);
  const accountId = firstString(tokenIdentity.accountId, raw.account_id);
  const plan = firstString(raw.plan, tokenIdentity.plan);
  if (!email && !name && !authMode && !accountId && !plan) {
    return null;
  }
  return {
    email,
    name,
    authMode,
    accountId,
    plan,
    authPath,
  };
}

function readCodexAuthTokens(raw: Record<string, unknown>): CodexAuthTokens {
  const tokenObject = isRecord(raw.tokens) ? raw.tokens : {};
  return {
    accessToken: firstString(tokenObject.access_token),
    idToken: firstString(tokenObject.id_token),
    refreshToken: firstString(tokenObject.refresh_token),
    accountId: firstString(tokenObject.account_id, raw.account_id),
    lastRefresh: firstString(raw.last_refresh),
  };
}

function readJwtExpiryMs(payload: Record<string, any> | null): number | null {
  const rawExp = payload?.exp;
  return typeof rawExp === 'number' && Number.isFinite(rawExp) ? rawExp * 1000 : null;
}

function getAuthClaims(payload: Record<string, any> | null): Record<string, any> | null {
  const raw = payload?.['https://api.openai.com/auth'];
  return isRecord(raw) ? raw : null;
}

function resolveRequestedAuthPath(
  authPathOrOptions: string | { authPath?: string; env?: NodeJS.ProcessEnv },
): string {
  if (typeof authPathOrOptions === 'string') {
    return path.resolve(authPathOrOptions);
  }
  const explicitPath = normalizeString(authPathOrOptions?.authPath);
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  return resolveCodexAuthPath(authPathOrOptions?.env);
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return isRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(filePath: string, value: Record<string, unknown>): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.promises.mkdir(directory, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
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

function normalizeString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
