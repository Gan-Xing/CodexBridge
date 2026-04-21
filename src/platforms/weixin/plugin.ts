import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WeixinAccountStore } from './account_store.js';
import {
  createWeixinOfficialTransport,
  type WeixinOfficialTransport,
} from './official/transport.js';
import {
  MessageItemType,
  type MessageItem,
  type WeixinMessage,
} from './official/types.js';
import {
  findAccountIdsByContextToken,
  getContextToken as getStoredContextToken,
  restoreContextTokens as restoreStoredContextTokens,
  setContextToken as setStoredContextToken,
} from './official/context_tokens.js';
import {
  assertSessionActive,
  getRemainingPauseMs,
  isSessionPaused,
  pauseSession,
  SESSION_EXPIRED_ERRCODE,
} from './official/session_guard.js';
import { WeixinConfigManager } from './official/config_cache.js';
import { downloadMediaFromItem } from './official/media/media_download.js';
import { getExtensionFromMime, getMimeFromFilename } from './official/media/mime.js';
import { buildTextMessageReq } from './official/send.js';
import { isWeixinSendResponseError } from './official/send.js';
import { loadWeixinConfig, validateWeixinConfig, type WeixinConfig } from './config.js';
import { formatWeixinText, splitWeixinText } from './formatting.js';
import { writeSequencedDebugLog } from '../../core/sequenced_stderr.js';
import { createI18n, type Translator } from '../../i18n/index.js';
import type {
  InboundAttachment,
  InboundTextEvent,
  PlatformDeliveryRequest,
  PlatformMediaDeliveryResult,
  PlatformStatusInfo,
  PlatformPluginContract,
} from '../../types/platform.js';

const TYPING_START = 1;
const TYPING_STOP = 2;

interface WeixinScope {
  chatType: 'group' | 'dm';
  externalScopeId: string;
}

interface WeixinInboundPayload extends WeixinMessage {
  room_id?: string;
  chat_room_id?: string;
  msg_type?: number;
}

interface WeixinInboundMetadata extends Record<string, unknown> {
  weixin: {
    senderId: string;
    roomId: string | null;
    chatType: 'group' | 'dm';
    messageId: string | null;
    contextTokenPresent: boolean;
    attachmentCount: number;
    attachmentErrors?: string[];
  };
}

interface WeixinNormalizedEvent extends InboundTextEvent {
  metadata: WeixinInboundMetadata;
}

interface WeixinTextDelivery extends PlatformDeliveryRequest {
  kind: 'weixin.sendmessage';
  payload: {
    msg: {
      from_user_id: string;
      to_user_id: string;
      client_id: string;
      message_type: number;
      message_state: number;
      item_list: Array<{ type: number; text_item: { text: string } }>;
      context_token?: string;
    };
  };
}

interface WeixinTypingDelivery extends PlatformDeliveryRequest {
  kind: 'weixin.sendtyping';
  payload: {
    ilink_user_id: string;
    typing_ticket: string;
    status: number;
  };
}

interface WeixinPlatformPluginOptions {
  config?: WeixinConfig;
  accountStore?: WeixinAccountStore;
  chunkIntervalMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  nowFn?: () => number;
  locale?: string | null;
}

export class WeixinPlatformPlugin implements Pick<PlatformPluginContract, 'id' | 'displayName' | 'start' | 'stop' | 'normalizeInboundEvent' | 'buildTextDeliveries' | 'sendText' | 'sendTyping' | 'sendMedia'> {
  constructor({
    config,
    accountStore,
    chunkIntervalMs = 3000,
    sleepImpl = sleep,
    nowFn = Date.now,
    locale = null,
  }: WeixinPlatformPluginOptions = {}) {
    this.i18n = createI18n(locale);
    this.id = 'weixin';
    this.displayName = 'WeChat';
    this.accountStore = accountStore ?? new WeixinAccountStore();
    this.config = config ?? loadWeixinConfig({
      accountStore: this.accountStore,
    });
    this.running = false;
    this.typingTickets = new Map();
    this.configManager = null;
    this.client = null;
    this.chunkIntervalMs = chunkIntervalMs;
    this.sleepImpl = sleepImpl;
    this.nowFn = nowFn;
    this.messageSendQueue = Promise.resolve();
    this.nextMessageSendAt = 0;
  }

  id: string;
  displayName: string;
  accountStore: WeixinAccountStore;
  config: WeixinConfig;
  running: boolean;
  typingTickets: Map<string, string>;
  configManager: WeixinConfigManager | null;
  client: WeixinOfficialTransport | null;
  chunkIntervalMs: number;
  sleepImpl: (ms: number) => Promise<void>;
  nowFn: () => number;
  i18n: Translator;
  messageSendQueue: Promise<void>;
  nextMessageSendAt: number;

  async start() {
    if (this.running && this.client) {
      return;
    }
    const errors = validateWeixinConfig(this.config, this.i18n.locale);
    if (errors.length > 0) {
      throw new Error(this.i18n.t('platform.weixin.plugin.startConfigError', { errors: errors.join('; ') }));
    }
    this.client = createWeixinOfficialTransport({
      baseUrl: this.config.baseUrl,
      token: this.config.token,
      locale: this.i18n.locale,
    });
    this.configManager = this.createConfigManager();
    restoreStoredContextTokens(this.config.accountsDir, this.config.accountId);
    this.running = true;
  }

  async stop() {
    this.running = false;
    this.configManager?.clear();
    this.configManager = null;
    this.client = null;
  }

  async normalizeInboundEvent(payload: WeixinInboundPayload): Promise<WeixinNormalizedEvent | null> {
    const senderId = stringValue(payload.from_user_id);
    if (!senderId || senderId === this.config.accountId) {
      debugWeixin('drop_message', {
        reason: !senderId ? 'missing_sender' : 'self_message',
        messageId: stringValue(payload.message_id),
      });
      return null;
    }
    const scope = resolveWeixinScope(payload, this.config.accountId);
    if (!this.isScopeAllowed(scope)) {
      debugWeixin('drop_message', {
        reason: 'scope_not_allowed',
        scopeId: scope.externalScopeId,
        chatType: scope.chatType,
        messageId: stringValue(payload.message_id),
      });
      return null;
    }
    const text = extractText(payload.item_list ?? []);
    const { attachments, errors: attachmentErrors } = await this.downloadInboundAttachments(payload);
    if (!text && attachments.length === 0 && attachmentErrors.length === 0) {
      debugWeixin('drop_message', {
        reason: 'no_supported_content',
        scopeId: scope.externalScopeId,
        chatType: scope.chatType,
        messageId: stringValue(payload.message_id),
        itemTypes: Array.isArray(payload.item_list) ? payload.item_list.map((item) => Number(item?.type)) : [],
      });
      return null;
    }
    const contextToken = stringValue(payload.context_token);
    if (contextToken) {
      setStoredContextToken(this.config.accountsDir, this.config.accountId, senderId, contextToken);
      if (scope.externalScopeId !== senderId) {
        setStoredContextToken(this.config.accountsDir, this.config.accountId, scope.externalScopeId, contextToken);
      }
    }
    debugWeixin('accept_message', {
      scopeId: scope.externalScopeId,
      chatType: scope.chatType,
      messageId: stringValue(payload.message_id),
      text,
      attachmentCount: attachments.length,
      attachmentErrors,
    });
    return {
      platform: this.id,
      externalScopeId: scope.externalScopeId,
      text,
      attachments,
      metadata: {
        weixin: {
          senderId,
          roomId: scope.chatType === 'group' ? scope.externalScopeId : null,
          chatType: scope.chatType,
          messageId: stringValue(payload.message_id),
          contextTokenPresent: Boolean(contextToken),
          attachmentCount: attachments.length,
          attachmentErrors,
        },
      },
    };
  }

  buildTextDeliveries({ externalScopeId, content }: { externalScopeId: string; content: string }): WeixinTextDelivery[] {
    const contextToken = getStoredContextToken(this.config.accountsDir, this.config.accountId, externalScopeId);
    return splitWeixinText(formatWeixinText(content), this.config.maxMessageLength).map((text) => ({
      kind: 'weixin.sendmessage',
      payload: buildTextMessageReq({
        to: externalScopeId,
        text,
        contextToken,
        clientId: `codexbridge-weixin-${crypto.randomUUID()}`,
      }) as WeixinTextDelivery['payload'],
    }));
  }

  loadSyncCursor() {
    return this.accountStore.loadSyncCursor(this.config.accountId);
  }

  async pollOnce({ syncCursor: requestedSyncCursor = null }: { syncCursor?: string | null } = {}) {
    if (!this.client) {
      throw new Error(this.i18n.t('platform.weixin.plugin.pollOnceNotStarted'));
    }
    const remainingPauseMs = getRemainingPauseMs(this.config.accountId);
    if (remainingPauseMs > 0) {
      await this.sleepImpl(Math.min(remainingPauseMs, 5000));
      return {
        syncCursor: stringValue(requestedSyncCursor) ?? this.loadSyncCursor(),
        events: [],
        raw: {
          ret: SESSION_EXPIRED_ERRCODE,
          errcode: SESSION_EXPIRED_ERRCODE,
        },
      };
    }
    const syncCursor = stringValue(requestedSyncCursor) ?? this.loadSyncCursor();
    debugWeixin('poll_start', {
      accountId: this.config.accountId,
      baseUrl: this.config.baseUrl,
      syncCursorLength: typeof syncCursor === 'string' ? syncCursor.length : 0,
      syncCursorPreview: previewCursor(syncCursor),
    });
    const response = await this.client.getUpdates({ syncCursor });
    if (isSessionExpiredResponse(response)) {
      pauseSession(this.config.accountId);
      return {
        syncCursor,
        events: [],
        raw: response,
      };
    }
    const nextCursor = stringValue(response.get_updates_buf);
    const rawMessages = Array.isArray(response.msgs) ? response.msgs as WeixinInboundPayload[] : [];
    debugWeixin('poll_result', {
      ret: response?.ret ?? null,
      messageCount: rawMessages.length,
      nextCursorLength: typeof nextCursor === 'string' ? nextCursor.length : 0,
      nextCursorPreview: previewCursor(nextCursor),
      summaries: rawMessages.map(summarizeInboundPayload),
    });
    const events: WeixinNormalizedEvent[] = [];
    const seenInboundKeys = new Set<string>();
    for (const message of rawMessages) {
      const dedupeKey = buildInboundDedupeKey(message);
      if (dedupeKey && seenInboundKeys.has(dedupeKey)) {
        debugWeixin('drop_message', {
          reason: 'duplicate_batch_message',
          dedupeKey,
          messageId: stringValue(message.message_id),
          text: extractText(message.item_list ?? []),
        });
        continue;
      }
      const event = await this.normalizeInboundEvent(message);
      if (!event) {
        continue;
      }
      if (dedupeKey) {
        seenInboundKeys.add(dedupeKey);
      }
      const senderId = event.metadata?.weixin?.senderId;
      if (typeof senderId === 'string' && senderId) {
        try {
          await this.ensureTypingTicket(senderId);
        } catch {
          // Typing indicators are optional; message delivery should continue.
        }
      }
      events.push(event);
    }
    debugWeixin('poll_events', {
      eventCount: events.length,
      events: events.map((event) => ({
        scopeId: event.externalScopeId,
        textPreview: previewText(event.text),
        attachmentCount: Array.isArray(event.attachments) ? event.attachments.length : 0,
        senderId: event.metadata?.weixin?.senderId ?? null,
        chatType: event.metadata?.weixin?.chatType ?? null,
        messageId: event.metadata?.weixin?.messageId ?? null,
      })),
    });
    return {
      syncCursor: nextCursor ?? syncCursor,
      events,
      raw: response,
    };
  }

  async commitSyncCursor(syncCursor: string | null | undefined): Promise<string> {
    const normalized = stringValue(syncCursor) ?? '';
    this.accountStore.saveSyncCursor(this.config.accountId, normalized);
    return normalized;
  }

  async downloadInboundAttachments(payload: WeixinInboundPayload): Promise<{
    attachments: InboundAttachment[];
    errors: string[];
  }> {
    const itemList = Array.isArray(payload.item_list) ? payload.item_list : [];
    const attachments: InboundAttachment[] = [];
    const errors: string[] = [];
    for (const item of itemList) {
      if (!isMediaItem(item)) {
        continue;
      }
      try {
        const media = await downloadMediaFromItem(item, {
          cdnBaseUrl: this.config.cdnBaseUrl,
          saveMedia: async (buffer, contentType, subdir, maxBytes, originalFilename) =>
            this.saveInboundMedia(buffer, contentType, subdir, maxBytes, originalFilename),
          label: `weixin message ${stringValue(payload.message_id) ?? crypto.randomUUID()}`,
        });
        attachments.push(...convertDownloadedMediaToAttachments(item, media));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return { attachments, errors };
  }

  async saveInboundMedia(
    buffer: Buffer,
    contentType: string | undefined,
    subdir = 'inbound',
    maxBytes = 100 * 1024 * 1024,
    originalFilename?: string,
  ): Promise<{ path: string }> {
    if (buffer.length > maxBytes) {
      throw new Error(`inbound media exceeds max size: ${buffer.length} > ${maxBytes}`);
    }
    const dir = path.join(
      path.dirname(this.config.accountsDir),
      subdir,
      String(this.config.accountId ?? 'unknown-account'),
    );
    await fs.mkdir(dir, { recursive: true });
    const originalBase = typeof originalFilename === 'string' ? path.basename(originalFilename).trim() : '';
    const originalExt = originalBase ? path.extname(originalBase) : '';
    const fallbackExt = contentType ? getExtensionFromMime(contentType) : '.bin';
    const extension = originalExt || fallbackExt || '.bin';
    const originalStem = originalBase ? originalBase.slice(0, originalBase.length - originalExt.length) : 'media';
    const stem = sanitizeFilenameStem(originalStem);
    const filePath = path.join(dir, `${stem}-${crypto.randomUUID()}${extension}`);
    await fs.writeFile(filePath, buffer);
    return { path: filePath };
  }

  async sendText({ externalScopeId, content }: { externalScopeId: string; content: string }) {
    if (!this.client) {
      return {
        success: false,
        deliveredCount: 0,
        deliveredText: '',
        failedIndex: 0,
        failedText: String(content ?? '').trim(),
        error: this.i18n.t('platform.weixin.plugin.sendTextNotStarted'),
      };
    }
    try {
      assertSessionActive(this.config.accountId);
    } catch (error) {
      return {
        success: false,
        deliveredCount: 0,
        deliveredText: '',
        failedIndex: 0,
        failedText: String(content ?? '').trim(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const deliveries = this.buildTextDeliveries({
      externalScopeId,
      content,
    });
    const deliveredTexts = [];
    for (let index = 0; index < deliveries.length; index += 1) {
      const delivery = deliveries[index];
      const chunkText = delivery.payload.msg.item_list[0].text_item.text;
      const outcome = await this.sendDeliveryWithRetry({
        externalScopeId,
        delivery,
      });
      if (!outcome.success) {
        return {
          success: false,
          deliveredCount: deliveredTexts.length,
          deliveredText: joinDeliveredTexts(deliveredTexts),
          failedIndex: index,
          failedText: chunkText,
          error: outcome.error,
        };
      }
      deliveredTexts.push(chunkText);
    }
    return {
      success: true,
      deliveredCount: deliveredTexts.length,
      deliveredText: joinDeliveredTexts(deliveredTexts),
      failedIndex: null,
      failedText: '',
      error: '',
    };
  }

  async sendDeliveryWithRetry({ externalScopeId, delivery, maxAttempts = 4 }: {
    externalScopeId: string;
    delivery: WeixinTextDelivery;
    maxAttempts?: number;
  }) {
    const chunkText = delivery.payload.msg.item_list[0].text_item.text;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      debugWeixin('send_text', {
        scopeId: externalScopeId,
        content: chunkText,
        attempt,
      });
      try {
        const result = await this.runWithMessageSendGate(async () => this.client?.sendMessage({
          toUserId: delivery.payload.msg.to_user_id,
          text: chunkText,
          contextToken: delivery.payload.msg.context_token ?? null,
          clientId: delivery.payload.msg.client_id,
        }) ?? { ret: -1 });
        debugWeixin('send_text_result', {
          scopeId: externalScopeId,
          clientId: delivery.payload.msg.client_id,
          attempt,
          result,
        });
        if (isSessionExpiredResponse(result)) {
          pauseSession(this.config.accountId);
          return {
            success: false,
            error: `session expired (errcode ${SESSION_EXPIRED_ERRCODE})`,
          };
        }
        assertSuccessfulSendResult(
          result,
          this.i18n.t('platform.weixin.plugin.sendFailure', {
            externalScopeId,
            clientId: delivery.payload.msg.client_id,
          }),
        );
        return { success: true, error: '' };
      } catch (error) {
        lastError = error;
        debugWeixin('send_text_failed', {
          scopeId: externalScopeId,
          clientId: delivery.payload.msg.client_id,
          attempt,
          error: error instanceof Error ? (error.stack || error.message) : String(error),
        });
      }
    }
    return {
      success: false,
      error: lastError instanceof Error
        ? lastError.message
        : this.i18n.t('runtime.error.unknownDeliveryFailure'),
    };
  }

  recordTypingTicket(externalScopeId: string, typingTicket: string | null | undefined): void {
    if (!externalScopeId || !typingTicket) {
      return;
    }
    this.typingTickets.set(externalScopeId, typingTicket);
  }

  buildTypingDelivery({ externalScopeId, status = 'start' }: { externalScopeId: string; status?: 'start' | 'stop' }): WeixinTypingDelivery | null {
    const typingTicket = this.typingTickets.get(externalScopeId);
    if (!typingTicket) {
      return null;
    }
    return {
      kind: 'weixin.sendtyping',
      payload: {
        ilink_user_id: externalScopeId,
        typing_ticket: typingTicket,
        status: status === 'stop' ? TYPING_STOP : TYPING_START,
      },
    };
  }

  async ensureTypingTicket(externalScopeId: string) {
    if (!this.client) {
      throw new Error(this.i18n.t('platform.weixin.plugin.typingTicketNotStarted'));
    }
    assertSessionActive(this.config.accountId);
    if (this.typingTickets.has(externalScopeId)) {
      return this.typingTickets.get(externalScopeId);
    }
    const contextToken = getStoredContextToken(this.config.accountsDir, this.config.accountId, externalScopeId);
    const typingTicket = (await this.getConfigManager().getForUser(externalScopeId, contextToken)).typingTicket;
    if (typingTicket) {
      this.recordTypingTicket(externalScopeId, typingTicket);
    }
    return typingTicket;
  }

  async sendTyping({ externalScopeId, status = 'start' as 'start' | 'stop' }: { externalScopeId: string; status?: 'start' | 'stop' }): Promise<void> {
    if (!this.client) {
      throw new Error(this.i18n.t('platform.weixin.plugin.sendTypingNotStarted'));
    }
    assertSessionActive(this.config.accountId);
    const delivery = this.buildTypingDelivery({ externalScopeId, status });
    if (!delivery) {
      return;
    }
    const response = await this.client.sendTyping({
      toUserId: delivery.payload.ilink_user_id,
      typingTicket: delivery.payload.typing_ticket,
      status: delivery.payload.status,
    });
    if (isSessionExpiredResponse(response)) {
      pauseSession(this.config.accountId);
    }
  }

  async sendMedia({
    externalScopeId,
    filePath,
    caption = null,
  }: {
    externalScopeId: string;
    filePath: string;
    caption?: string | null;
  }): Promise<PlatformMediaDeliveryResult> {
    if (!this.client) {
      return {
        success: false,
        messageId: null,
        sentPath: String(filePath ?? ''),
        sentCaption: String(caption ?? '').trim(),
        error: this.i18n.t('platform.weixin.plugin.sendTextNotStarted'),
      };
    }
    try {
      assertSessionActive(this.config.accountId);
    } catch (error) {
      return {
        success: false,
        messageId: null,
        sentPath: String(filePath ?? ''),
        sentCaption: String(caption ?? '').trim(),
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const normalizedPath = String(filePath ?? '').trim();
    const normalizedCaption = String(caption ?? '').trim();
    const contextToken = getStoredContextToken(this.config.accountsDir, this.config.accountId, externalScopeId);
    if (!contextToken) {
      return {
        success: false,
        messageId: null,
        sentPath: normalizedPath,
        sentCaption: normalizedCaption,
        error: this.i18n.t('platform.weixin.plugin.contextTokenMissing', { externalScopeId }),
      };
    }

    debugWeixin('send_media', {
      scopeId: externalScopeId,
      filePath: normalizedPath,
      caption: normalizedCaption,
      attempt: 1,
    });
    try {
      const result = await this.runWithMessageSendGate(async () => this.client?.sendMediaFile({
        filePath: normalizedPath,
        toUserId: externalScopeId,
        text: normalizedCaption,
        contextToken,
        cdnBaseUrl: this.config.cdnBaseUrl,
      }) ?? { messageId: null });
      const messageId = typeof result?.messageId === 'string' ? result.messageId.trim() : '';
      if (!messageId) {
        throw new Error('sendMediaFile returned no messageId');
      }
      const captionError = typeof (result as { captionError?: unknown } | null)?.captionError === 'string'
        ? (result as { captionError: string }).captionError
        : '';
      const captionErrorCode = typeof (result as { captionErrorCode?: unknown } | null)?.captionErrorCode === 'number'
        ? (result as { captionErrorCode: number }).captionErrorCode
        : null;
      if (captionErrorCode === SESSION_EXPIRED_ERRCODE
        || (captionError && captionError.includes(String(SESSION_EXPIRED_ERRCODE)))) {
        pauseSession(this.config.accountId);
      }
      if (captionError) {
        debugWeixin('send_media_caption_failed', {
          scopeId: externalScopeId,
          filePath: normalizedPath,
          messageId,
          error: captionError,
        });
      }
      debugWeixin('send_media_result', {
        scopeId: externalScopeId,
        filePath: normalizedPath,
        messageId,
        sentCaption: captionError ? '' : normalizedCaption,
        captionError: captionError || null,
      });
      return {
        success: true,
        messageId,
        sentPath: normalizedPath,
        sentCaption: captionError ? '' : normalizedCaption,
        error: captionError,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugWeixin('send_media_failed', {
        scopeId: externalScopeId,
        filePath: normalizedPath,
        attempt: 1,
        error: message,
      });
      if ((isWeixinSendResponseError(error) && error.code === SESSION_EXPIRED_ERRCODE)
        || message.includes(String(SESSION_EXPIRED_ERRCODE))) {
        pauseSession(this.config.accountId);
      }
      return {
        success: false,
        messageId: null,
        sentPath: normalizedPath,
        sentCaption: normalizedCaption,
        error: message || this.i18n.t('runtime.error.unknownDeliveryFailure'),
      };
    }
  }

  getStatus({ externalScopeId = null }: { externalScopeId?: string | null } = {}): PlatformStatusInfo {
    const remainingPauseMs = getRemainingPauseMs(this.config.accountId);
    const normalizedScopeId = typeof externalScopeId === 'string' ? externalScopeId.trim() : '';
    const matchedAccountIds = normalizedScopeId
      ? findAccountIdsByContextToken(this.config.accountsDir, this.accountStore.listAccounts(), normalizedScopeId)
      : [];
    return {
      data: {
        accountId: this.config.accountId,
        running: this.running,
        sessionPaused: isSessionPaused(this.config.accountId),
        remainingPauseMs,
        remainingPauseMinutes: remainingPauseMs > 0 ? Math.ceil(remainingPauseMs / 60_000) : 0,
        hasContextToken: normalizedScopeId
          ? Boolean(getStoredContextToken(this.config.accountsDir, this.config.accountId, normalizedScopeId))
          : false,
        contextTokenMatchedAccountIds: matchedAccountIds,
      },
    };
  }

  async runWithMessageSendGate<T>(task: () => Promise<T>): Promise<T> {
    let releaseCurrent: (() => void) | null = null;
    const previous = this.messageSendQueue;
    this.messageSendQueue = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    await previous.catch(() => {});
    try {
      const waitMs = Math.max(0, this.nextMessageSendAt - this.nowFn());
      if (waitMs > 0) {
        await this.sleepImpl(waitMs);
      }
      const result = await task();
      this.nextMessageSendAt = this.nowFn() + Math.max(0, this.chunkIntervalMs);
      return result;
    } finally {
      releaseCurrent?.();
    }
  }

  isScopeAllowed(scope: WeixinScope) {
    if (scope.chatType === 'group') {
      if (this.config.groupPolicy === 'disabled') {
        return false;
      }
      if (this.config.groupPolicy === 'allowlist') {
        return this.config.groupAllowFrom.includes(scope.externalScopeId);
      }
      return true;
    }
    if (this.config.dmPolicy === 'disabled') {
      return false;
    }
    if (this.config.dmPolicy === 'allowlist') {
      return this.config.allowFrom.includes(scope.externalScopeId);
    }
    return true;
  }

  createConfigManager() {
    return new WeixinConfigManager({
      fetchConfig: async ({ userId, contextToken }) => this.client?.getConfig({
        userId,
        contextToken,
      }) ?? { ret: -1 },
      nowFn: this.nowFn,
      onSessionExpired: () => pauseSession(this.config.accountId),
      log: (message) => debugWeixin('config_cache', { message }),
    });
  }

  getConfigManager() {
    if (!this.configManager) {
      this.configManager = this.createConfigManager();
    }
    return this.configManager;
  }
}

function debugWeixin(event: string, payload: unknown) {
  writeSequencedDebugLog('weixin-debug', event, payload);
}

function summarizeInboundPayload(payload: WeixinInboundPayload) {
  const itemList = Array.isArray(payload?.item_list) ? payload.item_list : [];
  return {
    messageId: stringValue(payload?.message_id),
    msgType: payload?.msg_type ?? null,
    fromUserId: stringValue(payload?.from_user_id),
    toUserId: stringValue(payload?.to_user_id),
    roomId: stringValue(payload?.room_id) ?? stringValue(payload?.chat_room_id),
    contextTokenPresent: Boolean(stringValue(payload?.context_token)),
    itemTypes: itemList.map((item) => Number(item?.type)),
    textPreview: previewText(extractText(itemList)),
  };
}

function isSessionExpiredResponse(response: unknown): boolean {
  const ret = Number((response as Record<string, unknown> | null)?.ret);
  const errcode = Number((response as Record<string, unknown> | null)?.errcode);
  return ret === SESSION_EXPIRED_ERRCODE || errcode === SESSION_EXPIRED_ERRCODE;
}

function previewText(value: unknown, maxLength = 80) {
  const text = stringValue(value);
  if (!text) {
    return null;
  }
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function previewCursor(value: unknown, maxLength = 24) {
  const cursor = stringValue(value);
  if (!cursor) {
    return null;
  }
  return cursor.length <= maxLength ? cursor : `${cursor.slice(0, 12)}...${cursor.slice(-8)}`;
}

export function resolveWeixinScope(message: WeixinInboundPayload, accountId: string | null): WeixinScope {
  const roomId = stringValue(message.room_id) ?? stringValue(message.chat_room_id);
  const toUserId = stringValue(message.to_user_id);
  const isGroup = Boolean(roomId)
    || Boolean(toUserId && accountId && toUserId !== accountId && Number(message.msg_type) === 1);
  if (isGroup) {
    return {
      chatType: 'group',
      externalScopeId: roomId ?? toUserId ?? stringValue(message.from_user_id) ?? '',
    };
  }
  return {
    chatType: 'dm',
    externalScopeId: stringValue(message.from_user_id) ?? '',
  };
}

export function extractText(itemList: MessageItem[]) {
  for (const item of itemList) {
    if (Number(item?.type) === MessageItemType.TEXT) {
      return stringValue(item?.text_item?.text) ?? '';
    }
  }
  for (const item of itemList) {
    if (Number(item?.type) === MessageItemType.VOICE) {
      return stringValue(item?.voice_item?.text) ?? '';
    }
  }
  return '';
}

function isMediaItem(item: MessageItem) {
  return Number(item?.type) === MessageItemType.IMAGE
    || Number(item?.type) === MessageItemType.VOICE
    || Number(item?.type) === MessageItemType.FILE
    || Number(item?.type) === MessageItemType.VIDEO;
}

function convertDownloadedMediaToAttachments(item: MessageItem, media: {
  decryptedPicPath?: string;
  decryptedVoicePath?: string;
  voiceMediaType?: string;
  decryptedFilePath?: string;
  fileMediaType?: string;
  decryptedVideoPath?: string;
}): InboundAttachment[] {
  const attachments: InboundAttachment[] = [];
  if (media.decryptedPicPath) {
    attachments.push({
      kind: 'image',
      localPath: media.decryptedPicPath,
      fileName: path.basename(media.decryptedPicPath),
      mimeType: inferMimeFromPath(media.decryptedPicPath),
    });
  }
  if (media.decryptedVoicePath) {
    attachments.push({
      kind: 'voice',
      localPath: media.decryptedVoicePath,
      fileName: path.basename(media.decryptedVoicePath),
      mimeType: media.voiceMediaType ?? null,
      transcriptText: stringValue(item?.voice_item?.text),
      durationSeconds: typeof item?.voice_item?.playtime === 'number'
        ? item.voice_item.playtime
        : null,
    });
  }
  if (media.decryptedFilePath) {
    attachments.push({
      kind: 'file',
      localPath: media.decryptedFilePath,
      mimeType: media.fileMediaType ?? null,
      fileName: stringValue(item?.file_item?.file_name) ?? path.basename(media.decryptedFilePath),
    });
  }
  if (media.decryptedVideoPath) {
    attachments.push({
      kind: 'video',
      localPath: media.decryptedVideoPath,
      fileName: path.basename(media.decryptedVideoPath),
      mimeType: inferMimeFromPath(media.decryptedVideoPath),
      durationSeconds: typeof item?.video_item?.play_length === 'number'
        ? item.video_item.play_length
        : null,
    });
  }
  return attachments;
}

function sanitizeFilenameStem(value: string) {
  const normalized = String(value ?? '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '')
    .trim();
  return normalized || 'media';
}

function inferMimeFromPath(filePath: string): string | null {
  const base = path.basename(filePath);
  return base ? getMimeFromFilename(base) : null;
}

function assertSuccessfulSendResult(result: { ret?: number }, messageTemplate: string, ) {
  const ret = Number(result?.ret ?? 0);
  if (ret === 0) {
    return;
  }
  throw new Error(`${messageTemplate}: ${ret}`);
}

function joinDeliveredTexts(chunks: string[]) {
  return Array.isArray(chunks) ? chunks.filter(Boolean).join('\n\n').trim() : '';
}

function stringValue(value: unknown) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
}

function buildInboundDedupeKey(payload: WeixinInboundPayload) {
  const messageId = stringValue(payload?.message_id);
  if (messageId) {
    return `message:${messageId}`;
  }
  const senderId = stringValue(payload?.from_user_id) ?? '';
  const toUserId = stringValue(payload?.to_user_id) ?? '';
  const roomId = stringValue(payload?.room_id) ?? stringValue(payload?.chat_room_id) ?? '';
  const contextToken = stringValue(payload?.context_token) ?? '';
  const text = extractText(Array.isArray(payload?.item_list) ? payload.item_list : []);
  const itemFingerprints = Array.isArray(payload?.item_list)
    ? payload.item_list.map(buildInboundItemFingerprint).filter(Boolean).join('||')
    : '';
  if (!senderId && !toUserId && !roomId && !contextToken && !text && !itemFingerprints) {
    return null;
  }
  return [
    'fallback',
    senderId,
    toUserId,
    roomId,
    contextToken,
    String(Number(payload?.msg_type ?? 0)),
    text,
    itemFingerprints,
  ].join('|');
}

function buildInboundItemFingerprint(item: MessageItem): string {
  const type = Number(item?.type ?? 0);
  switch (type) {
    case MessageItemType.TEXT:
      return `text:${stringValue(item?.text_item?.text) ?? ''}`;
    case MessageItemType.IMAGE:
      return `image:${stringValue(item?.image_item?.media?.full_url)
        ?? stringValue(item?.image_item?.media?.encrypt_query_param)
        ?? stringValue(item?.image_item?.url)
        ?? ''}`;
    case MessageItemType.VOICE:
      return `voice:${stringValue(item?.voice_item?.media?.full_url)
        ?? stringValue(item?.voice_item?.media?.encrypt_query_param)
        ?? ''}:${stringValue(item?.voice_item?.text) ?? ''}`;
    case MessageItemType.FILE:
      return `file:${stringValue(item?.file_item?.file_name) ?? ''}:${
        stringValue(item?.file_item?.media?.full_url)
          ?? stringValue(item?.file_item?.media?.encrypt_query_param)
          ?? ''
      }`;
    case MessageItemType.VIDEO:
      return `video:${stringValue(item?.video_item?.media?.full_url)
        ?? stringValue(item?.video_item?.media?.encrypt_query_param)
        ?? ''}`;
    default:
      return `type:${type}`;
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
