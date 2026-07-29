import {
  getBotQr,
  getConfig,
  getQrStatus,
  getUpdates,
  notifyStart,
  notifyStop,
  sendMessage,
  sendTyping,
  type WeixinOfficialFetch,
} from './api.js';
import { DEFAULT_ILINK_BOT_TYPE } from './login.js';
import { sendWeixinMediaFile } from './send_media.js';
import type {
  GetConfigResp,
  GetUpdatesResp,
  NotifyStartResp,
  NotifyStopResp,
  SendMessageResp,
  SendTypingResp,
  WeixinQrCodeResponse,
  WeixinQrStatusResponse,
} from './types.js';

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_GLOBAL_FETCH = globalThis.fetch as WeixinOfficialFetch | undefined;

export interface WeixinOfficialTransport {
  baseUrl: string;
  token: string | null;
  fetch: WeixinOfficialFetch | undefined;
  locale: string | null;
  getUpdates(params?: { syncCursor?: string; timeoutMs?: number }): Promise<GetUpdatesResp>;
  notifyStart(): Promise<NotifyStartResp>;
  notifyStop(): Promise<NotifyStopResp>;
  sendMessage(params: {
    toUserId: string;
    text: string;
    contextToken?: string | null;
    clientId: string;
    timeoutMs?: number;
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
  }): Promise<{
    messageId: string;
    captionMessageId?: string | null;
    captionError?: string | null;
    captionErrorCode?: number | null;
  }>;
}

export function createWeixinOfficialTransport({
  baseUrl,
  token = null,
  fetchImpl,
  locale = null,
}: {
  baseUrl: string;
  token?: string | null;
  fetchImpl?: WeixinOfficialFetch;
  locale?: string | null;
}): WeixinOfficialTransport {
  const normalizedBaseUrl = String(baseUrl).replace(/\/+$/u, '');
  const effectiveFetchImpl = fetchImpl
    ?? (globalThis.fetch !== DEFAULT_GLOBAL_FETCH
      ? globalThis.fetch as WeixinOfficialFetch | undefined
      : undefined);

  return {
    baseUrl: normalizedBaseUrl,
    token,
    fetch: effectiveFetchImpl,
    locale,
    async getUpdates({ syncCursor = '', timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS } = {}) {
      return getUpdates({
        baseUrl: normalizedBaseUrl,
        token,
        fetchImpl: effectiveFetchImpl,
        locale,
        timeoutMs,
        get_updates_buf: syncCursor,
      });
    },
    async notifyStart() {
      return notifyStart({
        baseUrl: normalizedBaseUrl,
        token,
        fetchImpl: effectiveFetchImpl,
        locale,
      });
    },
    async notifyStop() {
      return notifyStop({
        baseUrl: normalizedBaseUrl,
        token,
        fetchImpl: effectiveFetchImpl,
        locale,
      });
    },
    async sendMessage({ toUserId, text, contextToken = null, clientId, timeoutMs }) {
      return sendMessage({
        baseUrl: normalizedBaseUrl,
        token,
        fetchImpl: effectiveFetchImpl,
        locale,
        timeoutMs,
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
        fetchImpl: effectiveFetchImpl,
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
        fetchImpl: effectiveFetchImpl,
        locale,
        ilink_user_id: userId,
        ...(contextToken ? { context_token: contextToken } : {}),
      });
    },
    async getBotQr({ botType = DEFAULT_ILINK_BOT_TYPE } = {}) {
      return getBotQr({
        baseUrl: normalizedBaseUrl,
        fetchImpl: effectiveFetchImpl,
        locale,
        botType,
      });
    },
    async getQrStatus({ qrcode, baseUrlOverride = null }) {
      return getQrStatus({
        baseUrl: baseUrlOverride ? String(baseUrlOverride).replace(/\/+$/u, '') : normalizedBaseUrl,
        fetchImpl: effectiveFetchImpl,
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
          fetchImpl: effectiveFetchImpl,
          locale,
          contextToken,
        },
      });
    },
  };
}
