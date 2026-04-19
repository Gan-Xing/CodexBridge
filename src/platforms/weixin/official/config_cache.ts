import { SESSION_EXPIRED_ERRCODE } from './session_guard.js';

export interface CachedConfig {
  typingTicket: string;
}

const CONFIG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CONFIG_CACHE_INITIAL_RETRY_MS = 2_000;
const CONFIG_CACHE_MAX_RETRY_MS = 60 * 60 * 1000;

interface ConfigCacheEntry {
  config: CachedConfig;
  everSucceeded: boolean;
  nextFetchAt: number;
  retryDelayMs: number;
}

interface WeixinConfigManagerOptions {
  fetchConfig: (params: { userId: string; contextToken?: string | null }) => Promise<unknown>;
  nowFn?: () => number;
  randomFn?: () => number;
  onSessionExpired?: () => void;
  log?: (message: string) => void;
}

export class WeixinConfigManager {
  private cache = new Map<string, ConfigCacheEntry>();
  private fetchConfig: WeixinConfigManagerOptions['fetchConfig'];
  private nowFn: () => number;
  private randomFn: () => number;
  private onSessionExpired?: () => void;
  private log: (message: string) => void;

  constructor({
    fetchConfig,
    nowFn = Date.now,
    randomFn = Math.random,
    onSessionExpired,
    log = () => {},
  }: WeixinConfigManagerOptions) {
    this.fetchConfig = fetchConfig;
    this.nowFn = nowFn;
    this.randomFn = randomFn;
    this.onSessionExpired = onSessionExpired;
    this.log = log;
  }

  async getForUser(userId: string, contextToken?: string | null): Promise<CachedConfig> {
    const now = this.nowFn();
    const entry = this.cache.get(userId);
    const shouldFetch = !entry || now >= entry.nextFetchAt;

    if (shouldFetch) {
      let fetchOk = false;
      try {
        const resp = await this.fetchConfig({ userId, contextToken });
        if (isSessionExpiredResponse(resp)) {
          this.onSessionExpired?.();
          throw new Error(`session expired (errcode ${SESSION_EXPIRED_ERRCODE})`);
        }
        const typingTicket = stringValue((resp as Record<string, unknown> | null)?.typing_ticket) ?? '';
        this.cache.set(userId, {
          config: { typingTicket },
          everSucceeded: true,
          nextFetchAt: now + this.randomFn() * CONFIG_CACHE_TTL_MS,
          retryDelayMs: CONFIG_CACHE_INITIAL_RETRY_MS,
        });
        this.log(`[weixin] config ${entry?.everSucceeded ? 'refreshed' : 'cached'} for ${userId}`);
        fetchOk = true;
      } catch (error) {
        this.log(`[weixin] getConfig failed for ${userId} (ignored): ${error instanceof Error ? error.message : String(error)}`);
      }

      if (!fetchOk) {
        const prevDelay = entry?.retryDelayMs ?? CONFIG_CACHE_INITIAL_RETRY_MS;
        const nextDelay = Math.min(prevDelay * 2, CONFIG_CACHE_MAX_RETRY_MS);
        if (entry) {
          entry.nextFetchAt = now + nextDelay;
          entry.retryDelayMs = nextDelay;
        } else {
          this.cache.set(userId, {
            config: { typingTicket: '' },
            everSucceeded: false,
            nextFetchAt: now + CONFIG_CACHE_INITIAL_RETRY_MS,
            retryDelayMs: CONFIG_CACHE_INITIAL_RETRY_MS,
          });
        }
      }
    }

    return this.cache.get(userId)?.config ?? { typingTicket: '' };
  }

  clear(): void {
    this.cache.clear();
  }
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return null;
}

function isSessionExpiredResponse(response: unknown): boolean {
  const ret = Number((response as Record<string, unknown> | null)?.ret);
  const errcode = Number((response as Record<string, unknown> | null)?.errcode);
  return ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE;
}
