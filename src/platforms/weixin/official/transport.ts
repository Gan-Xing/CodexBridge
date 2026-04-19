import {
  getBotQr,
  getConfig,
  getQrStatus,
  getUpdates,
  sendMessage,
  sendTyping,
  type WeixinOfficialFetch,
} from './api.js';
import { DEFAULT_ILINK_BOT_TYPE } from './login.js';
import { sendWeixinMediaFile } from './send_media.js';
import type {
  GetConfigResp,
  GetUpdatesResp,
  SendMessageResp,
  SendTypingResp,
  WeixinQrCodeResponse,
  WeixinQrStatusResponse,
} from './types.js';

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

export interface WeixinOfficialTransport {
  baseUrl: string;
  token: string | null;
  fetch: WeixinOfficialFetch | undefined;
  locale: string | null;
  getUpdates(params?: { syncCursor?: string; timeoutMs?: number }): Promise<GetUpdatesResp>;
  sendMessage(params: {
    toUserId: string;
    text: string;
    contextToken?: string | null;
    clientId: string;
  }): Promise<SendMessageResp>;
  sendTyping(params: {
    toUserId: string;
    typingTicket: string;
    status: number;
  }): Promise<SendTypingResp>;
  getConfig(params: { userId: string; contextToken?: string | null }): Promise<GetConfigResp>;
  getBotQr(params?: { botType?: string }): Promise<WeixinQrCodeResponse>;
  getQrStatus(params: { qrcode: string; baseUrlOverride?: string | null }): Promise<WeixinQrStatusResponse>;
  sendMediaFile(params: {
    filePath: string;
    toUserId: string;
    text?: string;
    contextToken?: string | null;
    cdnBaseUrl: string;
  }): Promise<{ messageId: string }>;
}

export function createWeixinOfficialTransport({
  baseUrl,
  token = null,
  fetchImpl = globalThis.fetch as WeixinOfficialFetch | undefined,
  locale = null,
}: {
  baseUrl: string;
  token?: string | null;
  fetchImpl?: WeixinOfficialFetch;
  locale?: string | null;
}): WeixinOfficialTransport {
  const normalizedBaseUrl = String(baseUrl).replace(/\/+$/u, '');

  return {
    baseUrl: normalizedBaseUrl,
    token,
    fetch: fetchImpl,
    locale,
    async getUpdates({ syncCursor = '', timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS } = {}) {
      return getUpdates({
        baseUrl: normalizedBaseUrl,
        token,
        fetchImpl,
        locale,
        timeoutMs,
        get_updates_buf: syncCursor,
      });
    },
    async sendMessage({ toUserId, text, contextToken = null, clientId }) {
      return sendMessage({
        baseUrl: normalizedBaseUrl,
        token,
        fetchImpl,
        locale,
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: text
            ? [{
              type: 1,
              text_item: { text },
            }]
            : [],
          ...(contextToken ? { context_token: contextToken } : {}),
        },
      });
    },
    async sendTyping({ toUserId, typingTicket, status }) {
      return sendTyping({
        baseUrl: normalizedBaseUrl,
        token,
        fetchImpl,
        locale,
        ilink_user_id: toUserId,
        typing_ticket: typingTicket,
        status,
      });
    },
    async getConfig({ userId, contextToken = null }) {
      return getConfig({
        baseUrl: normalizedBaseUrl,
        token,
        fetchImpl,
        locale,
        ilink_user_id: userId,
        ...(contextToken ? { context_token: contextToken } : {}),
      });
    },
    async getBotQr({ botType = DEFAULT_ILINK_BOT_TYPE } = {}) {
      return getBotQr({
        baseUrl: normalizedBaseUrl,
        fetchImpl,
        locale,
        botType,
      });
    },
    async getQrStatus({ qrcode, baseUrlOverride = null }) {
      return getQrStatus({
        baseUrl: baseUrlOverride ? String(baseUrlOverride).replace(/\/+$/u, '') : normalizedBaseUrl,
        fetchImpl,
        locale,
        qrcode,
      });
    },
    async sendMediaFile({ filePath, toUserId, text = '', contextToken = null, cdnBaseUrl }) {
      return sendWeixinMediaFile({
        filePath,
        to: toUserId,
        text,
        cdnBaseUrl,
        opts: {
          baseUrl: normalizedBaseUrl,
          token,
          fetchImpl,
          locale,
          contextToken,
        },
      });
    },
  };
}
