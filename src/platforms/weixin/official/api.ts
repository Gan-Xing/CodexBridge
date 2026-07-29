import { createI18n } from '../../../i18n/index.js';
import dns from 'node:dns/promises';
import https from 'node:https';
import type {
  BaseInfo,
  GetConfigReq,
  GetConfigResp,
  GetUploadUrlReq,
  GetUploadUrlResp,
  GetUpdatesReq,
  GetUpdatesResp,
  NotifyStartResp,
  NotifyStopResp,
  SendMessageReq,
  SendMessageResp,
  SendTypingReq,
  SendTypingResp,
  WeixinQrCodeResponse,
  WeixinQrStatusResponse,
} from './types.js';

const ILINK_APP_ID = 'bot';
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;
const DEFAULT_CHANNEL_VERSION = '2.2.0';

interface WeixinFetchResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export type WeixinOfficialFetch = (
  input: string,
  init?: Record<string, unknown>,
) => Promise<WeixinFetchResponse>;

export interface WeixinOfficialApiOptions {
  baseUrl: string;
  token?: string | null;
  timeoutMs?: number;
  fetchImpl?: WeixinOfficialFetch;
  locale?: string | null;
}

interface RawRequestOptions {
  method: 'GET' | 'POST';
  endpoint: string;
  body?: string;
  timeoutMs: number;
  authorized?: boolean;
  headers?: Record<string, string>;
  fetchImpl?: WeixinOfficialFetch;
  locale?: string | null;
}

export function buildBaseInfo(channelVersion = DEFAULT_CHANNEL_VERSION): BaseInfo {
  return { channel_version: channelVersion };
}

export async function getUpdates(
  params: GetUpdatesReq & WeixinOfficialApiOptions,
): Promise<GetUpdatesResp> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    return await postJson<GetUpdatesResp>({
      ...params,
      endpoint: 'ilink/bot/getupdates',
      payload: {
        get_updates_buf: params.get_updates_buf ?? '',
      },
      timeoutMs,
    });
  } catch (error) {
    if (isAbortError(error)) {
      return {
        ret: 0,
        msgs: [],
        get_updates_buf: params.get_updates_buf ?? '',
      };
    }
    throw error;
  }
}

export async function getUploadUrl(
  params: GetUploadUrlReq & WeixinOfficialApiOptions,
): Promise<GetUploadUrlResp> {
  return postJson<GetUploadUrlResp>({
    ...params,
    endpoint: 'ilink/bot/getuploadurl',
    payload: {
      filekey: params.filekey,
      media_type: params.media_type,
      to_user_id: params.to_user_id,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      thumb_rawsize: params.thumb_rawsize,
      thumb_rawfilemd5: params.thumb_rawfilemd5,
      thumb_filesize: params.thumb_filesize,
      no_need_thumb: params.no_need_thumb,
      aeskey: params.aeskey,
    },
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
  });
}

export async function sendMessage(
  params: SendMessageReq & WeixinOfficialApiOptions,
): Promise<SendMessageResp> {
  return postJson<SendMessageResp>({
    ...params,
    endpoint: 'ilink/bot/sendmessage',
    payload: {
      msg: params.msg ?? {},
    },
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
  });
}

export async function sendTyping(
  params: SendTypingReq & WeixinOfficialApiOptions,
): Promise<SendTypingResp> {
  return postJson<SendTypingResp>({
    ...params,
    endpoint: 'ilink/bot/sendtyping',
    payload: {
      ilink_user_id: params.ilink_user_id,
      typing_ticket: params.typing_ticket,
      status: params.status,
    },
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
  });
}

export async function notifyStart(
  params: WeixinOfficialApiOptions,
): Promise<NotifyStartResp> {
  return postJson<NotifyStartResp>({
    ...params,
    endpoint: 'ilink/bot/msg/notifystart',
    payload: {},
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
  });
}

export async function notifyStop(
  params: WeixinOfficialApiOptions,
): Promise<NotifyStopResp> {
  return postJson<NotifyStopResp>({
    ...params,
    endpoint: 'ilink/bot/msg/notifystop',
    payload: {},
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
  });
}

export async function getConfig(
  params: GetConfigReq & WeixinOfficialApiOptions,
): Promise<GetConfigResp> {
  return postJson<GetConfigResp>({
    ...params,
    endpoint: 'ilink/bot/getconfig',
    payload: {
      ilink_user_id: params.ilink_user_id,
      ...(params.context_token ? { context_token: params.context_token } : {}),
    },
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
  });
}

export async function getBotQr(
  params: WeixinOfficialApiOptions & { botType?: string },
): Promise<WeixinQrCodeResponse> {
  const botType = params.botType ?? '3';
  return getJson<WeixinQrCodeResponse>({
    ...params,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    timeoutMs: params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
    authorized: false,
  });
}

export async function getQrStatus(
  params: WeixinOfficialApiOptions & { qrcode: string },
): Promise<WeixinQrStatusResponse> {
  return getJson<WeixinQrStatusResponse>({
    ...params,
    endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`,
    timeoutMs: params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
    authorized: false,
  });
}

async function postJson<T>(params: WeixinOfficialApiOptions & {
  endpoint: string;
  payload: Record<string, unknown>;
}): Promise<T> {
  const body = JSON.stringify({
    ...params.payload,
    base_info: buildBaseInfo(),
  });
  return requestJson<T>({
    method: 'POST',
    endpoint: params.endpoint,
    body,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    fetchImpl: params.fetchImpl,
    locale: params.locale,
    authorized: true,
    headers: {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'Content-Length': String(Buffer.byteLength(body, 'utf8')),
    },
    baseUrl: params.baseUrl,
    token: params.token,
  });
}

async function getJson<T>(params: Omit<RawRequestOptions, 'method'> & {
  baseUrl: string;
  token?: string | null;
}): Promise<T> {
  return requestJson<T>({
    method: 'GET',
    endpoint: params.endpoint,
    timeoutMs: params.timeoutMs,
    fetchImpl: params.fetchImpl,
    locale: params.locale,
    authorized: params.authorized,
    headers: params.headers,
    baseUrl: params.baseUrl,
    token: params.token,
  });
}

async function requestJson<T>(params: RawRequestOptions & {
  baseUrl: string;
  token?: string | null;
}): Promise<T> {
  const fetchImpl = params.fetchImpl;
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') {
    const i18n = createI18n(params.locale);
    throw new Error(i18n.t('platform.weixin.official.missingFetchImplementation'));
  }

  if (fetchImpl) {
    return requestJsonWithFetch<T>({
      ...params,
      fetchImpl,
    });
  }
  return requestJsonWithAddressRotation<T>(params);
}

async function requestJsonWithFetch<T>(params: RawRequestOptions & {
  baseUrl: string;
  token?: string | null;
  fetchImpl: WeixinOfficialFetch;
}): Promise<T> {
  const i18n = createI18n(params.locale);
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), params.timeoutMs);
  const startTime = Date.now();
  debugWeixinHttp('request_start', {
    method: params.method,
    endpoint: params.endpoint,
    timeoutMs: params.timeoutMs,
    authorized: params.authorized ?? true,
    bodyLength: typeof params.body === 'string' ? Buffer.byteLength(params.body, 'utf8') : 0,
  });

  try {
    const response = await params.fetchImpl(joinUrl(params.baseUrl, params.endpoint), {
      method: params.method,
      body: params.body,
      signal: abortController.signal,
      headers: buildHeaders({
        token: params.token ?? null,
        authorized: params.authorized ?? true,
        extraHeaders: params.headers ?? {},
      }),
    });
    const raw = await response.text();
    debugWeixinHttp('request_end', {
      method: params.method,
      endpoint: params.endpoint,
      status: response.status,
      ok: response.ok,
      durationMs: Date.now() - startTime,
      responseLength: raw.length,
      responsePreview: previewResponse(raw),
    });
    if (!response.ok) {
      throw new Error(i18n.t('platform.weixin.official.ilinkHttpError', {
        method: params.method,
        endpoint: params.endpoint,
        status: response.status,
        response: raw.slice(0, 200),
      }));
    }
    return raw ? JSON.parse(raw) as T : {} as T;
  } catch (error) {
    debugWeixinHttp('request_error', {
      method: params.method,
      endpoint: params.endpoint,
      durationMs: Date.now() - startTime,
      error: error instanceof Error ? (error.stack || error.message) : String(error),
    });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestJsonWithAddressRotation<T>(params: RawRequestOptions & {
  baseUrl: string;
  token?: string | null;
}): Promise<T> {
  const i18n = createI18n(params.locale);
  const url = new URL(joinUrl(params.baseUrl, params.endpoint));
  const addresses = await resolveHostAddresses(url.hostname);
  const startTime = Date.now();
  const deadline = startTime + params.timeoutMs;
  let lastError: unknown = null;
  debugWeixinHttp('request_start', {
    method: params.method,
    endpoint: params.endpoint,
    timeoutMs: params.timeoutMs,
    authorized: params.authorized ?? true,
    bodyLength: typeof params.body === 'string' ? Buffer.byteLength(params.body, 'utf8') : 0,
  });

  for (const address of addresses) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    try {
      const response = await requestJsonOverHttpsAddress({
        url,
        address,
        params,
        timeoutMs: Math.min(20_000, remainingMs),
      });
      debugWeixinHttp('request_end', {
        method: params.method,
        endpoint: params.endpoint,
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        durationMs: Date.now() - startTime,
        responseLength: response.raw.length,
        responsePreview: previewResponse(response.raw),
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(i18n.t('platform.weixin.official.ilinkHttpError', {
          method: params.method,
          endpoint: params.endpoint,
          status: response.status,
          response: response.raw.slice(0, 200),
        }));
      }
      return response.raw ? JSON.parse(response.raw) as T : {} as T;
    } catch (error) {
      lastError = error;
      if (!isRetryableNetworkError(error)) {
        break;
      }
      debugWeixinHttp('request_retry', {
        method: params.method,
        endpoint: params.endpoint,
        address,
        elapsedMs: Date.now() - startTime,
        error: error instanceof Error ? (error.stack || error.message) : String(error),
      });
    }
  }

  debugWeixinHttp('request_error', {
    method: params.method,
    endpoint: params.endpoint,
    durationMs: Date.now() - startTime,
    error: lastError instanceof Error ? (lastError.stack || lastError.message) : String(lastError ?? 'unknown error'),
  });
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error(String(lastError ?? 'Weixin request failed'));
}

async function resolveHostAddresses(hostname: string): Promise<string[]> {
  try {
    const records = await dns.lookup(hostname, { all: true });
    const addresses = records
      .map((record) => record.address)
      .filter((address) => typeof address === 'string' && address.trim());
    return [...new Set(addresses)].length > 0 ? [...new Set(addresses)] : [hostname];
  } catch {
    return [hostname];
  }
}

function requestJsonOverHttpsAddress({
  url,
  address,
  params,
  timeoutMs,
}: {
  url: URL;
  address: string;
  params: RawRequestOptions & {
    baseUrl: string;
    token?: string | null;
  };
  timeoutMs: number;
}): Promise<{ status: number; raw: string }> {
  const headers = buildHeaders({
    token: params.token ?? null,
    authorized: params.authorized ?? true,
    extraHeaders: {
      ...(params.headers ?? {}),
      Host: url.hostname,
    },
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = https.request({
      protocol: 'https:',
      hostname: address,
      port: url.port ? Number(url.port) : 443,
      method: params.method,
      path: `${url.pathname}${url.search}`,
      headers,
      servername: url.hostname,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve({
          status: Number(response.statusCode ?? 0),
          raw: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      const error = new Error(`HTTPS request timed out after ${timeoutMs}ms`);
      (error as NodeJS.ErrnoException).code = 'ETIMEDOUT';
      request.destroy(error);
    }, timeoutMs);

    request.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    if (params.body) {
      request.write(params.body);
    }
    request.end();
  });
}

function isRetryableNetworkError(error: unknown): boolean {
  const code = typeof error === 'object' && error && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  return [
    'ECONNRESET',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
  ].includes(code);
}

function joinUrl(baseUrl: string, endpoint: string): string {
  const normalizedBase = String(baseUrl).replace(/\/+$/u, '');
  const normalizedEndpoint = String(endpoint).replace(/^\/+/u, '');
  return `${normalizedBase}/${normalizedEndpoint}`;
}

function buildHeaders({
  token,
  authorized,
  extraHeaders,
}: {
  token?: string | null;
  authorized: boolean;
  extraHeaders: Record<string, string>;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
    'X-WECHAT-UIN': randomWechatUin(),
    ...extraHeaders,
  };
  if (authorized && token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function randomWechatUin(): string {
  const value = Math.floor(Math.random() * 0xffffffff);
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError';
}

function previewResponse(raw: string, maxLength = 200) {
  if (!raw) {
    return null;
  }
  return raw.length <= maxLength ? raw : `${raw.slice(0, maxLength - 3)}...`;
}

function debugWeixinHttp(event: string, payload: Record<string, unknown>) {
  if (process.env.CODEXBRIDGE_DEBUG_WEIXIN !== '1') {
    return;
  }
  process.stderr.write(`[weixin-http] ${event} ${JSON.stringify(payload)}\n`);
}
