const ILINK_APP_ID = 'bot';
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (2 << 8) | 0;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

export class WeixinIlinkClient {
  constructor({
    baseUrl,
    token = null,
    fetchImpl = globalThis.fetch,
  }) {
    if (typeof fetchImpl !== 'function') {
      throw new Error('WeixinIlinkClient requires a fetch implementation');
    }
    this.baseUrl = String(baseUrl).replace(/\/+$/u, '');
    this.token = token;
    this.fetch = fetchImpl;
  }

  async getUpdates({ syncCursor = '', timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS } = {}) {
    try {
      return await this.post('ilink/bot/getupdates', {
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

  async sendMessage({ toUserId, text, contextToken = null, clientId }) {
    return this.post('ilink/bot/sendmessage', {
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

  async sendTyping({ toUserId, typingTicket, status }) {
    return this.post('ilink/bot/sendtyping', {
      ilink_user_id: toUserId,
      typing_ticket: typingTicket,
      status,
    });
  }

  async getConfig({ userId, contextToken = null }) {
    return this.post('ilink/bot/getconfig', {
      ilink_user_id: userId,
      ...(contextToken ? { context_token: contextToken } : {}),
    }, { timeoutMs: 10_000 });
  }

  async getBotQr({ botType = '3' } = {}) {
    return this.get(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, {
      timeoutMs: 35_000,
      authorized: false,
    });
  }

  async getQrStatus({ qrcode, baseUrlOverride = null } = {}) {
    const client = baseUrlOverride
      ? new WeixinIlinkClient({
        baseUrl: baseUrlOverride,
        token: this.token,
        fetchImpl: this.fetch,
      })
      : this;
    return client.get(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, {
      timeoutMs: 35_000,
      authorized: false,
    });
  }

  async post(endpoint, payload, { timeoutMs = 15_000 } = {}) {
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

  async get(endpoint, { timeoutMs = 15_000, authorized = true } = {}) {
    return this.request(endpoint, {
      method: 'GET',
      timeoutMs,
      authorized,
    });
  }

  async request(endpoint, {
    method,
    body,
    timeoutMs,
    headers = {},
    authorized = true,
  }) {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
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
      if (!response.ok) {
        throw new Error(`iLink ${method} ${endpoint} HTTP ${response.status}: ${raw.slice(0, 200)}`);
      }
      return raw ? JSON.parse(raw) : {};
    } finally {
      clearTimeout(timer);
    }
  }

  buildHeaders({ extraHeaders = {}, authorized = true } = {}) {
    const headers = {
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

function randomWechatUin() {
  const value = Math.floor(Math.random() * 0xffffffff);
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function isAbortError(error) {
  return error instanceof Error && error.name === 'AbortError';
}

export async function qrLogin({
  client,
  accountStore,
  botType = '3',
  timeoutSeconds = 480,
  sleep = defaultSleep,
  onQrCode = null,
  onStatus = null,
} = {}) {
  if (!client) {
    throw new Error('qrLogin requires a WeixinIlinkClient instance');
  }
  if (!accountStore) {
    throw new Error('qrLogin requires a WeixinAccountStore');
  }

  let qrResponse = await client.getBotQr({ botType });
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
  let lastStatus = null;

  while (Date.now() < deadline) {
    const statusResponse = await client.getQrStatus({
      qrcode,
      baseUrlOverride: currentBaseUrl,
    });
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
      qrResponse = await client.getBotQr({ botType });
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
      const credentials = {
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

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
