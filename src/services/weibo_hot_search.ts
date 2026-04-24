export interface WeiboHotSearchItem {
  position: number;
  title: string;
  label: string | null;
  category: string | null;
  hotValue: number | null;
}

export interface WeiboHotSearchSnapshot {
  fetchedAt: number;
  items: WeiboHotSearchItem[];
}

export interface WeiboHotSearchServiceLike {
  getTop(params?: { limit?: number }): Promise<WeiboHotSearchSnapshot>;
}

interface WeiboHotSearchServiceOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const WEIBO_HOT_SEARCH_URL = 'https://weibo.com/ajax/side/hotSearch';

export class WeiboHotSearchService implements WeiboHotSearchServiceLike {
  fetchImpl: typeof fetch;

  now: () => number;

  constructor({
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
  }: WeiboHotSearchServiceOptions = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('Weibo hot search requires a fetch implementation.');
    }
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async getTop({ limit = 10 }: { limit?: number } = {}): Promise<WeiboHotSearchSnapshot> {
    const normalizedLimit = Math.max(1, Math.min(20, Number(limit) || 10));
    const response = await this.fetchImpl(WEIBO_HOT_SEARCH_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://weibo.com/',
      },
    });
    if (!response.ok) {
      throw new Error(`Weibo hot search request failed with HTTP ${response.status}`);
    }
    const payload: any = await response.json();
    const realtime = Array.isArray(payload?.data?.realtime) ? payload.data.realtime : [];
    const items = realtime
      .filter((entry) => !entry?.is_ad)
      .map((entry, index) => normalizeWeiboHotSearchItem(entry, index))
      .filter(Boolean)
      .slice(0, normalizedLimit);
    if (items.length === 0) {
      throw new Error('Weibo hot search returned no usable items.');
    }
    return {
      fetchedAt: this.now(),
      items,
    };
  }
}

function normalizeWeiboHotSearchItem(entry: any, index: number): WeiboHotSearchItem | null {
  const title = String(entry?.note ?? entry?.word ?? '').trim();
  if (!title) {
    return null;
  }
  const realpos = Number(entry?.realpos);
  const hotValue = Number(entry?.num);
  const label = String(entry?.small_icon_desc ?? entry?.icon_desc ?? entry?.label_name ?? '').trim();
  const category = String(entry?.flag_desc ?? '').trim();
  return {
    position: Number.isInteger(realpos) && realpos > 0 ? realpos : index + 1,
    title,
    label: label || null,
    category: category || null,
    hotValue: Number.isFinite(hotValue) && hotValue > 0 ? hotValue : null,
  };
}
