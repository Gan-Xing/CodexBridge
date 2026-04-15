import os from 'node:os';
import path from 'node:path';
import { WeixinAccountStore } from './account_store.js';

export const WEIXIN_DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const WEIXIN_DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
export const WEIXIN_DEFAULT_DM_POLICY = 'open';
export const WEIXIN_DEFAULT_GROUP_POLICY = 'disabled';
export const WEIXIN_DEFAULT_MAX_MESSAGE_LENGTH = 4000;

const DM_POLICIES = new Set(['open', 'allowlist', 'disabled', 'pairing']);
const GROUP_POLICIES = new Set(['open', 'allowlist', 'disabled']);

export function loadWeixinConfig({
  env = process.env,
  stateDir = defaultCodexBridgeStateDir(),
  accountStore = new WeixinAccountStore({
    rootDir: path.join(stateDir, 'weixin', 'accounts'),
  }),
} = {}) {
  let accountId = normalizeString(env.WEIXIN_ACCOUNT_ID);
  if (!accountId) {
    const accountIds = accountStore.listAccounts();
    if (accountIds.length === 1) {
      [accountId] = accountIds;
    }
  }

  const savedAccount = accountId ? accountStore.loadAccount(accountId) : null;
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

export function validateWeixinConfig(config) {
  const errors = [];
  if (!config.accountId) {
    errors.push('WEIXIN_ACCOUNT_ID is required');
  }
  if (!config.token) {
    errors.push('WEIXIN_TOKEN is required or must be restorable from the saved account file');
  }
  if (!config.baseUrl) {
    errors.push('WEIXIN_BASE_URL is required');
  }
  if (!config.cdnBaseUrl) {
    errors.push('WEIXIN_CDN_BASE_URL is required');
  }
  return errors;
}

export function defaultCodexBridgeStateDir() {
  return path.join(os.homedir(), '.codexbridge');
}

function normalizeString(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function normalizeUrl(value) {
  return value.replace(/\/+$/u, '');
}

function normalizePolicy(rawValue, fallback, allowedValues) {
  const normalized = normalizeString(rawValue)?.toLowerCase();
  if (!normalized || !allowedValues.has(normalized)) {
    return fallback;
  }
  return normalized;
}

function parseCsvList(rawValue) {
  if (Array.isArray(rawValue)) {
    return rawValue.map((value) => String(value).trim()).filter(Boolean);
  }
  if (typeof rawValue !== 'string') {
    return [];
  }
  return rawValue.split(',').map((value) => value.trim()).filter(Boolean);
}

function parsePositiveInteger(rawValue) {
  const normalized = Number.parseInt(String(rawValue ?? ''), 10);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}
