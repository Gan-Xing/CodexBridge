import crypto from 'node:crypto';
import { WeixinAccountStore } from './account_store.js';
import { WeixinIlinkClient } from './client.js';
import { loadWeixinConfig, validateWeixinConfig } from './config.js';
import { formatWeixinText, splitWeixinText } from './formatting.js';

const MESSAGE_TYPE_BOT = 2;
const MESSAGE_STATE_FINISH = 2;
const TEXT_ITEM = 1;
const VOICE_ITEM = 3;
const TYPING_START = 1;
const TYPING_STOP = 2;

export class WeixinPlatformPlugin {
  constructor({ config, accountStore, chunkIntervalMs = 3000 } = {}) {
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
  }

  async start() {
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
    this.chunkIntervalMs = chunkIntervalMs;
  }

  normalizeInboundEvent(payload) {
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

  buildTextDeliveries({ externalScopeId, content }) {
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

  async pollOnce() {
    if (!this.client) {
      throw new Error('WeixinPlatformPlugin.pollOnce requires start() first');
    }
    const syncCursor = this.accountStore.loadSyncCursor(this.config.accountId);
    debugWeixin('poll_start', {
      accountId: this.config.accountId,
      baseUrl: this.config.baseUrl,
      syncCursorLength: typeof syncCursor === 'string' ? syncCursor.length : 0,
      syncCursorPreview: previewCursor(syncCursor),
    });
    const response = await this.client.getUpdates({ syncCursor });
    const nextCursor = stringValue(response.get_updates_buf);
    const rawMessages = Array.isArray(response.msgs) ? response.msgs : [];
    debugWeixin('poll_result', {
      ret: response?.ret ?? null,
      messageCount: rawMessages.length,
      nextCursorLength: typeof nextCursor === 'string' ? nextCursor.length : 0,
      nextCursorPreview: previewCursor(nextCursor),
      summaries: rawMessages.map(summarizeInboundPayload),
    });
    const events = [];
    for (const message of rawMessages) {
      const event = this.normalizeInboundEvent(message);
      if (!event) {
        continue;
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

  async commitSyncCursor(syncCursor) {
    const normalized = stringValue(syncCursor) ?? '';
    this.accountStore.saveSyncCursor(this.config.accountId, normalized);
    return normalized;
  }

  async sendText({ externalScopeId, content }) {
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
      if (index > 0 && this.chunkIntervalMs > 0) {
        await sleep(this.chunkIntervalMs);
      }
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

  async sendDeliveryWithRetry({ externalScopeId, delivery, maxAttempts = 4 }) {
    const chunkText = delivery.payload.msg.item_list[0].text_item.text;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      debugWeixin('send_text', {
        scopeId: externalScopeId,
        content: chunkText,
        attempt,
      });
      try {
        const result = await this.client.sendMessage({
          toUserId: delivery.payload.msg.to_user_id,
          text: chunkText,
          contextToken: delivery.payload.msg.context_token ?? null,
          clientId: delivery.payload.msg.client_id,
        });
        assertSuccessfulSendResult(result, externalScopeId, delivery.payload.msg.client_id);
        debugWeixin('send_text_result', {
          scopeId: externalScopeId,
          clientId: delivery.payload.msg.client_id,
          attempt,
          result,
        });
        return { success: true, error: '' };
      } catch (error) {
        lastError = error;
        debugWeixin('send_text_failed', {
          scopeId: externalScopeId,
          clientId: delivery.payload.msg.client_id,
          attempt,
          error: error instanceof Error ? (error.stack || error.message) : String(error),
        });
        if (attempt < maxAttempts) {
          await sleep(sendRetryDelayMs(attempt));
        }
      }
    }
    return {
      success: false,
      error: lastError instanceof Error ? lastError.message : String(lastError ?? 'Unknown Weixin send failure'),
    };
  }

  recordTypingTicket(externalScopeId, typingTicket) {
    if (!externalScopeId || !typingTicket) {
      return;
    }
    this.typingTickets.set(externalScopeId, typingTicket);
  }

  buildTypingDelivery({ externalScopeId, status = 'start' }) {
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

  async ensureTypingTicket(externalScopeId) {
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
    const typingTicket = stringValue(response.typing_ticket);
    if (typingTicket) {
      this.recordTypingTicket(externalScopeId, typingTicket);
    }
    return typingTicket;
  }

  async sendTyping({ externalScopeId, status = 'start' }) {
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

  isScopeAllowed(scope) {
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

function debugWeixin(event, payload) {
  if (process.env.CODEXBRIDGE_DEBUG_WEIXIN !== '1') {
    return;
  }
  const line = `[weixin-debug] ${event} ${JSON.stringify(payload)}\n`;
  process.stderr.write(line);
}

function summarizeInboundPayload(payload) {
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

function previewText(value, maxLength = 80) {
  const text = stringValue(value);
  if (!text) {
    return null;
  }
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function previewCursor(value, maxLength = 24) {
  const cursor = stringValue(value);
  if (!cursor) {
    return null;
  }
  return cursor.length <= maxLength ? cursor : `${cursor.slice(0, 12)}...${cursor.slice(-8)}`;
}

export function resolveWeixinScope(message, accountId) {
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

export function extractText(itemList) {
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

function assertSuccessfulSendResult(result, externalScopeId, clientId) {
  const ret = Number(result?.ret ?? 0);
  if (ret === 0) {
    return;
  }
  throw new Error(`Weixin sendmessage failed for ${externalScopeId} (${clientId}): ret=${ret}`);
}

function joinDeliveredTexts(chunks) {
  return Array.isArray(chunks) ? chunks.filter(Boolean).join('\n\n').trim() : '';
}

function sendRetryDelayMs(attempt) {
  return Math.min(8000, 1000 * (2 ** Math.max(0, attempt - 1)));
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
