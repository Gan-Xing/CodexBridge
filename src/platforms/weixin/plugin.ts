import crypto from 'node:crypto';
import { WeixinAccountStore } from './account_store.js';
import { WeixinIlinkClient } from './client.js';
import { loadWeixinConfig, validateWeixinConfig, type WeixinConfig } from './config.js';
import { formatWeixinText, splitWeixinText } from './formatting.js';
import type { InboundTextEvent, PlatformDeliveryRequest, PlatformPluginContract } from '../../types/platform.js';

const MESSAGE_TYPE_BOT = 2;
const MESSAGE_STATE_FINISH = 2;
const TEXT_ITEM = 1;
const VOICE_ITEM = 3;
const TYPING_START = 1;
const TYPING_STOP = 2;

interface WeixinMessageItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
}

interface WeixinInboundPayload {
  from_user_id?: string;
  to_user_id?: string;
  room_id?: string;
  chat_room_id?: string;
  msg_type?: number;
  message_id?: string;
  context_token?: string;
  item_list?: WeixinMessageItem[];
}

interface WeixinScope {
  chatType: 'group' | 'dm';
  externalScopeId: string;
}

interface WeixinInboundMetadata extends Record<string, unknown> {
  weixin: {
    senderId: string;
    roomId: string | null;
    chatType: 'group' | 'dm';
    messageId: string | null;
    contextTokenPresent: boolean;
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
}

export class WeixinPlatformPlugin implements Pick<PlatformPluginContract, 'id' | 'displayName' | 'start' | 'stop' | 'normalizeInboundEvent' | 'buildTextDeliveries'> {
  constructor({
    config,
    accountStore,
    chunkIntervalMs = 3000,
    sleepImpl = sleep,
    nowFn = Date.now,
  }: WeixinPlatformPluginOptions = {}) {
    this.id = 'weixin';
    this.displayName = 'WeChat';
    this.accountStore = accountStore ?? new WeixinAccountStore();
    this.config = config ?? loadWeixinConfig({
      accountStore: this.accountStore,
    });
    this.running = false;
    this.typingTickets = new Map();
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
  client: WeixinIlinkClient | null;
  chunkIntervalMs: number;
  sleepImpl: (ms: number) => Promise<void>;
  nowFn: () => number;
  messageSendQueue: Promise<void>;
  nextMessageSendAt: number;

  async start() {
    if (this.running && this.client) {
      return;
    }
    const errors = validateWeixinConfig(this.config);
    if (errors.length > 0) {
      throw new Error(`WeixinPlatformPlugin.start configuration error: ${errors.join('; ')}`);
    }
    this.client = new WeixinIlinkClient({
      baseUrl: this.config.baseUrl,
      token: this.config.token,
    });
    this.running = true;
  }

  async stop() {
    this.running = false;
    this.client = null;
  }

  normalizeInboundEvent(payload: WeixinInboundPayload): WeixinNormalizedEvent | null {
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
    if (!text) {
      debugWeixin('drop_message', {
        reason: 'no_text',
        scopeId: scope.externalScopeId,
        chatType: scope.chatType,
        messageId: stringValue(payload.message_id),
        itemTypes: Array.isArray(payload.item_list) ? payload.item_list.map((item) => Number(item?.type)) : [],
      });
      return null;
    }
    const contextToken = stringValue(payload.context_token);
    if (contextToken) {
      this.accountStore.setContextToken(this.config.accountId, senderId, contextToken);
    }
    debugWeixin('accept_message', {
      scopeId: scope.externalScopeId,
      chatType: scope.chatType,
      messageId: stringValue(payload.message_id),
      text,
    });
    return {
      platform: this.id,
      externalScopeId: scope.externalScopeId,
      text,
      metadata: {
        weixin: {
          senderId,
          roomId: scope.chatType === 'group' ? scope.externalScopeId : null,
          chatType: scope.chatType,
          messageId: stringValue(payload.message_id),
          contextTokenPresent: Boolean(contextToken),
        },
      },
    };
  }

  buildTextDeliveries({ externalScopeId, content }: { externalScopeId: string; content: string }): WeixinTextDelivery[] {
    const contextToken = this.accountStore.getContextToken(this.config.accountId, externalScopeId);
    return splitWeixinText(formatWeixinText(content), this.config.maxMessageLength).map((text) => ({
      kind: 'weixin.sendmessage',
      payload: {
        msg: {
          from_user_id: '',
          to_user_id: externalScopeId,
          client_id: `codexbridge-weixin-${crypto.randomUUID()}`,
          message_type: MESSAGE_TYPE_BOT,
          message_state: MESSAGE_STATE_FINISH,
          item_list: [{
            type: TEXT_ITEM,
            text_item: { text },
          }],
          ...(contextToken ? { context_token: contextToken } : {}),
        },
      },
    }));
  }

  loadSyncCursor() {
    return this.accountStore.loadSyncCursor(this.config.accountId);
  }

  async pollOnce({ syncCursor: requestedSyncCursor = null }: { syncCursor?: string | null } = {}) {
    if (!this.client) {
      throw new Error('WeixinPlatformPlugin.pollOnce requires start() first');
    }
    const syncCursor = stringValue(requestedSyncCursor) ?? this.loadSyncCursor();
    debugWeixin('poll_start', {
      accountId: this.config.accountId,
      baseUrl: this.config.baseUrl,
      syncCursorLength: typeof syncCursor === 'string' ? syncCursor.length : 0,
      syncCursorPreview: previewCursor(syncCursor),
    });
    const response = await this.client.getUpdates({ syncCursor });
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
      const event = this.normalizeInboundEvent(message);
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

  async sendText({ externalScopeId, content }: { externalScopeId: string; content: string }) {
    if (!this.client) {
      return {
        success: false,
        deliveredCount: 0,
        deliveredText: '',
        failedIndex: 0,
        failedText: String(content ?? '').trim(),
        error: 'WeixinPlatformPlugin.sendText requires start() first',
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
        assertSuccessfulSendResult(result, externalScopeId, delivery.payload.msg.client_id);
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
      error: lastError instanceof Error ? lastError.message : String(lastError ?? 'Unknown Weixin send failure'),
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
      throw new Error('WeixinPlatformPlugin.ensureTypingTicket requires start() first');
    }
    if (this.typingTickets.has(externalScopeId)) {
      return this.typingTickets.get(externalScopeId);
    }
    const contextToken = this.accountStore.getContextToken(this.config.accountId, externalScopeId);
    const response = await this.client.getConfig({
      userId: externalScopeId,
      contextToken,
    });
    const typingTicket = stringValue((response as Record<string, unknown>)?.typing_ticket);
    if (typingTicket) {
      this.recordTypingTicket(externalScopeId, typingTicket);
    }
    return typingTicket;
  }

  async sendTyping({ externalScopeId, status = 'start' as 'start' | 'stop' }: { externalScopeId: string; status?: 'start' | 'stop' }) {
    if (!this.client) {
      throw new Error('WeixinPlatformPlugin.sendTyping requires start() first');
    }
    const delivery = this.buildTypingDelivery({ externalScopeId, status });
    if (!delivery) {
      return null;
    }
    return this.client.sendTyping({
      toUserId: delivery.payload.ilink_user_id,
      typingTicket: delivery.payload.typing_ticket,
      status: delivery.payload.status,
    });
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
}

function debugWeixin(event: string, payload: unknown) {
  if (process.env.CODEXBRIDGE_DEBUG_WEIXIN !== '1') {
    return;
  }
  const line = `[weixin-debug] ${event} ${JSON.stringify(payload)}\n`;
  process.stderr.write(line);
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

export function extractText(itemList: WeixinMessageItem[]) {
  for (const item of itemList) {
    if (Number(item?.type) === TEXT_ITEM) {
      return stringValue(item?.text_item?.text) ?? '';
    }
  }
  for (const item of itemList) {
    if (Number(item?.type) === VOICE_ITEM) {
      return stringValue(item?.voice_item?.text) ?? '';
    }
  }
  return '';
}

function assertSuccessfulSendResult(result: { ret?: number }, externalScopeId: string, clientId: string) {
  const ret = Number(result?.ret ?? 0);
  if (ret === 0) {
    return;
  }
  throw new Error(`Weixin sendmessage failed for ${externalScopeId} (${clientId}): ret=${ret}`);
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
  if (!senderId && !toUserId && !roomId && !contextToken && !text) {
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
  ].join('|');
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
