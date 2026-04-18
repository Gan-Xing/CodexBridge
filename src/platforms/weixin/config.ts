import os from 'node:os';
import path from 'node:path';
import { createI18n } from '../../i18n/index.js';
import { WeixinAccountStore, type SavedWeixinAccount } from './account_store.js';

type PolicyValue = 'open' | 'allowlist' | 'disabled' | 'pairing';

export interface WeixinConfig {
  enabled: boolean;
  accountId: string | null;
  token: string | null;
  baseUrl: string;
  cdnBaseUrl: string;
  dmPolicy: PolicyValue;
  groupPolicy: Exclude<PolicyValue, 'pairing'>;
  allowFrom: string[];
  groupAllowFrom: string[];
  stateDir: string;
  accountsDir: string;
  maxMessageLength: number;
}

export const WEIXIN_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const WEIXIN_DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const WEIXIN_DEFAULT_DM_POLICY: PolicyValue = 'open';
export const WEIXIN_DEFAULT_GROUP_POLICY: Exclude<PolicyValue, 'pairing'> = 'disabled';
export const WEIXIN_DEFAULT_MAX_MESSAGE_LENGTH = 4000;

const DM_POLICIES = new Set<PolicyValue>(['open', 'allowlist', 'disabled', 'pairing']);
const GROUP_POLICIES = new Set<Exclude<PolicyValue, 'pairing'>>(['open', 'allowlist', 'disabled']);

export function loadWeixinConfig({
  env = process.env,
  stateDir = defaultCodexBridgeStateDir(),
  accountStore = new WeixinAccountStore({
    rootDir: path.join(stateDir, 'weixin', 'accounts'),
  }),
}: {
  env?: NodeJS.ProcessEnv | Record<string, unknown>;
  stateDir?: string;
  accountStore?: WeixinAccountStore;
} = {}): WeixinConfig {
  let accountId = normalizeString(env.WEIXIN_ACCOUNT_ID);
  if (!accountId) {
    const accountIds = accountStore.listAccounts();
    if (accountIds.length === 1) {
      [accountId] = accountIds;
    }
  }

  const savedAccount: SavedWeixinAccount | null = accountId ? accountStore.loadAccount(accountId) : null;
  const token = normalizeString(env.WEIXIN_TOKEN) ?? normalizeString(savedAccount?.token);
  const baseUrl = normalizeUrl(
    normalizeString(env.WEIXIN_BASE_URL)
      ?? normalizeString(savedAccount?.base_url)
      ?? WEIXIN_DEFAULT_BASE_URL,
  );

  return {
    enabled: Boolean(accountId && token),
    accountId,
    token,
    baseUrl,
    cdnBaseUrl: normalizeUrl(
      normalizeString(env.WEIXIN_CDN_BASE_URL) ?? WEIXIN_DEFAULT_CDN_BASE_URL,
    ),
    dmPolicy: normalizePolicy(
      normalizeString(env.WEIXIN_DM_POLICY),
      WEIXIN_DEFAULT_DM_POLICY,
      DM_POLICIES,
    ),
    groupPolicy: normalizePolicy(
      normalizeString(env.WEIXIN_GROUP_POLICY),
      WEIXIN_DEFAULT_GROUP_POLICY,
      GROUP_POLICIES,
    ),
    allowFrom: parseCsvList(env.WEIXIN_ALLOWED_USERS),
    groupAllowFrom: parseCsvList(env.WEIXIN_GROUP_ALLOWED_USERS),
    stateDir,
    accountsDir: accountStore.rootDir,
    maxMessageLength: parsePositiveInteger(env.WEIXIN_MAX_MESSAGE_LENGTH) ?? WEIXIN_DEFAULT_MAX_MESSAGE_LENGTH,
  };
}

export function validateWeixinConfig(config: WeixinConfig, locale: unknown = null) {
  const i18n = createI18n(locale);
  const errors: string[] = [];
  if (!config.accountId) {
    errors.push(i18n.t('platform.weixin.config.accountIdRequired'));
  }
  if (!config.token) {
    errors.push(i18n.t('platform.weixin.config.tokenRequired'));
  }
  if (!config.baseUrl) {
    errors.push(i18n.t('platform.weixin.config.baseUrlRequired'));
  }
  if (!config.cdnBaseUrl) {
    errors.push(i18n.t('platform.weixin.config.cdnBaseUrlRequired'));
  }
  return errors;
}

export function defaultCodexBridgeStateDir() {
  return path.join(os.homedir(), '.codexbridge');
}

function normalizeString(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function normalizeUrl(value: string) {
  return value.replace(/\/+$/u, '');
}

function normalizePolicy<T extends string>(rawValue: unknown, fallback: T, allowedValues: Set<string>): T {
  const normalized = normalizeString(rawValue)?.toLowerCase();
  if (!normalized || !allowedValues.has(normalized)) {
    return fallback;
  }
  return normalized as T;
}

function parseCsvList(rawValue: unknown): string[] {
  if (Array.isArray(rawValue)) {
    return rawValue.map((value) => String(value).trim()).filter(Boolean);
  }
  if (typeof rawValue !== 'string') {
    return [];
  }
  return rawValue.split(',').map((value) => value.trim()).filter(Boolean);
}

function parsePositiveInteger(rawValue: unknown) {
  const normalized = Number.parseInt(String(rawValue ?? ''), 10);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}
