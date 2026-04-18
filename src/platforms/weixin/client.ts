import type { WeixinAccountStore } from './account_store.js';
import { createI18n, type Translator } from '../../i18n/index.js';

const ILINK_APP_ID = 'bot';
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

interface WeixinRequestOptions {
  method: string;
  body?: string;
  timeoutMs: number;
  headers?: Record<string, string>;
  authorized?: boolean;
}

interface WeixinFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

type FetchImpl = (input: string, init?: Record<string, unknown>) => Promise<WeixinFetchResponse>;

interface WeixinIlinkClientOptions {
  baseUrl: string;
  token?: string | null;
  fetchImpl?: FetchImpl;
  locale?: string | null;
}

interface WeixinQrCodeResponse {
  qrcode?: string;
  qrcode_img_content?: string;
}

interface WeixinQrStatusResponse {
  status?: string;
  redirect_host?: string;
  ilink_bot_id?: string;
  bot_token?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

interface WeixinGetUpdatesResponse {
  ret?: number;
  msgs?: unknown[];
  get_updates_buf?: string;
}

interface WeixinLooseResponse {
  [key: string]: unknown;
}

export class WeixinIlinkClient {
  constructor({
    baseUrl,
    token = null,
    fetchImpl = globalThis.fetch,
    locale = null,
  }: WeixinIlinkClientOptions) {
    this.i18n = createI18n(locale);
    if (typeof fetchImpl !== 'function') {
      throw new Error(this.i18n.t('platform.weixin.client.missingFetchImplementation'));
    }
    this.baseUrl = String(baseUrl).replace(/\/+$/u, '');
    this.token = token;
    this.fetch = fetchImpl;
  }

  baseUrl: string;
  token: string | null;
  fetch: FetchImpl;
  i18n: Translator;

  async getUpdates({ syncCursor = '', timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS }: { syncCursor?: string; timeoutMs?: number } = {}): Promise<WeixinGetUpdatesResponse> {
    try {
      return await this.post<WeixinGetUpdatesResponse>('ilink/bot/getupdates', {
        get_updates_buf: syncCursor,
      }, { timeoutMs });
    } catch (error) {
      if (isAbortError(error)) {
        return {
          ret: 0,
          msgs: [],
          get_updates_buf: syncCursor,
        };
      }
      throw error;
    }
  }

  async sendMessage({ toUserId, text, contextToken = null, clientId }: {
    toUserId: string;
    text: string;
    contextToken?: string | null;
    clientId: string;
  }) {
    return this.post<{ ret?: number }>('ilink/bot/sendmessage', {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: clientId,
        message_type: 2,
        message_state: 2,
        item_list: text ? [{
          type: 1,
          text_item: { text },
        }] : [],
        ...(contextToken ? { context_token: contextToken } : {}),
      },
    });
  }

  async sendTyping({ toUserId, typingTicket, status }: {
    toUserId: string;
    typingTicket: string;
    status: number;
  }) {
    return this.post<{ ret?: number }>('ilink/bot/sendtyping', {
      ilink_user_id: toUserId,
      typing_ticket: typingTicket,
      status,
    });
  }

  async getConfig({ userId, contextToken = null }: { userId: string; contextToken?: string | null }): Promise<{ typing_ticket?: string }> {
    return this.post<{ typing_ticket?: string }>('ilink/bot/getconfig', {
      ilink_user_id: userId,
      ...(contextToken ? { context_token: contextToken } : {}),
    }, { timeoutMs: 10_000 });
  }

  async getBotQr({ botType = '3' }: { botType?: string } = {}): Promise<WeixinQrCodeResponse> {
    return this.get<WeixinQrCodeResponse>(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, {
      timeoutMs: 35_000,
      authorized: false,
    });
  }

  /**
   * @param {{ qrcode: string, baseUrlOverride?: string | null }} [options]
   */
  async getQrStatus(options: { qrcode: string; baseUrlOverride?: string | null } = { qrcode: '' }): Promise<WeixinQrStatusResponse> {
    const { qrcode, baseUrlOverride = null } = options;
    const client = baseUrlOverride
      ? new WeixinIlinkClient({
        baseUrl: baseUrlOverride,
        token: this.token,
        fetchImpl: this.fetch,
        locale: this.i18n.locale,
      })
      : this;
    return client.get<WeixinQrStatusResponse>(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
      timeoutMs: 35_000,
      authorized: false,
    });
  }

  async post<T>(endpoint: string, payload: Record<string, unknown>, { timeoutMs = 15_000 }: { timeoutMs?: number } = {}): Promise<T> {
    const body = JSON.stringify({
      ...payload,
      base_info: {
        channel_version: '2.2.0',
      },
    });
    return this.request(endpoint, {
      method: 'POST',
      body,
      timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'AuthorizationType': 'ilink_bot_token',
        'Content-Length': String(Buffer.byteLength(body, 'utf8')),
      },
    });
  }

  async get<T>(endpoint: string, { timeoutMs = 15_000, authorized = true }: { timeoutMs?: number; authorized?: boolean } = {}): Promise<T> {
    return this.request(endpoint, {
      method: 'GET',
      timeoutMs,
      authorized,
    });
  }

  async request<T>(endpoint: string, {
    method,
    body,
    timeoutMs,
    headers = {},
    authorized = true,
  }: WeixinRequestOptions): Promise<T> {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    const startTime = Date.now();
    debugWeixinHttp('request_start', {
      method,
      endpoint,
      timeoutMs,
      authorized,
      bodyLength: typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : 0,
      getUpdatesCursorPreview: endpoint === 'ilink/bot/getupdates'
        ? previewGetUpdatesCursor(body)
        : null,
    });
    try {
      const response = await this.fetch(`${this.baseUrl}/${endpoint}`, {
        method,
        body,
        signal: abortController.signal,
        headers: this.buildHeaders({
          extraHeaders: headers,
          authorized,
        }),
      });
      const raw = await response.text();
      debugWeixinHttp('request_end', {
        method,
        endpoint,
        status: response.status,
        ok: response.ok,
        durationMs: Date.now() - startTime,
        responseLength: raw.length,
        responsePreview: previewResponse(raw),
      });
      if (!response.ok) {
        throw new Error(this.i18n.t('platform.weixin.client.ilinkHttpError', {
          method,
          endpoint,
          status: response.status,
          response: raw.slice(0, 200),
        }));
      }
      return raw ? JSON.parse(raw) as T : {} as T;
    } catch (error) {
      debugWeixinHttp('request_error', {
        method,
        endpoint,
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? (error.stack || error.message) : String(error),
      });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  buildHeaders({ extraHeaders = {}, authorized = true }: { extraHeaders?: Record<string, string>; authorized?: boolean } = {}) {
    const headers: Record<string, string> = {
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
      'X-WECHAT-UIN': randomWechatUin(),
      ...extraHeaders,
    };
    if (authorized && this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    return headers;
  }
}

function randomWechatUin(): string {
  const value = Math.floor(Math.random() * 0xffffffff);
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError';
}

function debugWeixinHttp(event: string, payload: Record<string, unknown>) {
  if (process.env.CODEXBRIDGE_DEBUG_WEIXIN !== '1') {
    return;
  }
  const line = `[weixin-http] ${event} ${JSON.stringify(payload)}\n`;
  process.stderr.write(line);
}

function previewGetUpdatesCursor(body: string | undefined) {
  if (typeof body !== 'string' || !body) {
    return null;
  }
  try {
    const parsed = JSON.parse(body);
    const cursor = typeof parsed?.get_updates_buf === 'string' ? parsed.get_updates_buf : '';
    if (!cursor) {
      return null;
    }
    return cursor.length <= 24 ? cursor : `${cursor.slice(0, 12)}...${cursor.slice(-8)}`;
  } catch {
    return null;
  }
}

function previewResponse(raw: string, maxLength = 200) {
  if (typeof raw !== 'string' || !raw) {
    return null;
  }
  return raw.length <= maxLength ? raw : `${raw.slice(0, maxLength - 3)}...`;
}

interface QrLoginOptions {
  client: WeixinIlinkClient;
  accountStore: Pick<WeixinAccountStore, 'saveAccount'>;
  locale?: string | null;
  botType?: string;
  timeoutSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
  onQrCode?: ((params: { qrcode: string; qrcodeImageContent: string; raw: WeixinQrCodeResponse }) => Promise<void> | void) | null;
  onStatus?: ((params: { status: string; qrcode: string; raw: WeixinQrStatusResponse }) => Promise<void> | void) | null;
}

interface QrLoginCredentials {
  account_id: string;
  token: string;
  base_url: string;
  user_id: string;
}

export async function qrLogin(options: QrLoginOptions | undefined = undefined): Promise<QrLoginCredentials | null> {
  const {
    client,
    accountStore,
    locale = null,
    botType = '3',
    timeoutSeconds = 480,
    sleep = defaultSleep,
    onQrCode = null,
    onStatus = null,
  } = options ?? {};
  const i18n = createI18n(locale);
  if (!client) {
    throw new Error(i18n.t('platform.weixin.client.qrLoginRequiresClient'));
  }
  if (!accountStore) {
    throw new Error(i18n.t('platform.weixin.client.qrLoginRequiresAccountStore'));
  }

  let qrResponse = await client.getBotQr({ botType }) as WeixinQrCodeResponse;
  let qrcode = String(qrResponse.qrcode ?? '');
  if (!qrcode) {
    return null;
  }
  if (typeof onQrCode === 'function') {
    await onQrCode({
      qrcode,
      qrcodeImageContent: String(qrResponse.qrcode_img_content ?? ''),
      raw: qrResponse,
    });
  }

  const deadline = Date.now() + (timeoutSeconds * 1000);
  let currentBaseUrl = client.baseUrl;
  let lastStatus: string | null = null;

  while (Date.now() < deadline) {
    const statusResponse = await client.getQrStatus({
      qrcode,
      baseUrlOverride: currentBaseUrl,
    }) as WeixinQrStatusResponse;
    const status = String(statusResponse.status ?? 'wait');
    if (status !== lastStatus) {
      lastStatus = status;
      if (typeof onStatus === 'function') {
        await onStatus({
          status,
          qrcode,
          raw: statusResponse,
        });
      }
    }
    if (status === 'scaned_but_redirect') {
      const redirectHost = String(statusResponse.redirect_host ?? '').trim();
      if (redirectHost) {
        currentBaseUrl = `https://${redirectHost}`;
      }
    } else if (status === 'expired') {
      qrResponse = await client.getBotQr({ botType }) as WeixinQrCodeResponse;
      qrcode = String(qrResponse.qrcode ?? '');
      currentBaseUrl = client.baseUrl;
      if (typeof onQrCode === 'function') {
        await onQrCode({
          qrcode,
          qrcodeImageContent: String(qrResponse.qrcode_img_content ?? ''),
          raw: qrResponse,
        });
      }
    } else if (status === 'confirmed') {
      const credentials: QrLoginCredentials = {
        account_id: String(statusResponse.ilink_bot_id ?? ''),
        token: String(statusResponse.bot_token ?? ''),
        base_url: String(statusResponse.baseurl ?? client.baseUrl),
        user_id: String(statusResponse.ilink_user_id ?? ''),
      };
      if (!credentials.account_id || !credentials.token) {
        return null;
      }
      accountStore.saveAccount({
        accountId: credentials.account_id,
        token: credentials.token,
        baseUrl: credentials.base_url,
        userId: credentials.user_id,
      });
      return credentials;
    }
    await sleep(1000);
  }

  return null;
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
