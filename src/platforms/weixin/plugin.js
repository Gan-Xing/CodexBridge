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
  constructor({ config, accountStore } = {}) {
    this.id = 'weixin';
    this.displayName = 'WeChat';
    this.accountStore = accountStore ?? new WeixinAccountStore();
    this.config = config ?? loadWeixinConfig({
      accountStore: this.accountStore,
    });
    this.running = false;
    this.typingTickets = new Map();
    this.client = null;
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
  }

  normalizeInboundEvent(payload) {
    const senderId = stringValue(payload.from_user_id);
    if (!senderId || senderId === this.config.accountId) {
      return null;
    }
    const scope = resolveWeixinScope(payload, this.config.accountId);
    if (!this.isScopeAllowed(scope)) {
      return null;
    }
    const text = extractText(payload.item_list ?? []);
    if (!text) {
      return null;
    }
    const contextToken = stringValue(payload.context_token);
    if (contextToken) {
      this.accountStore.setContextToken(this.config.accountId, senderId, contextToken);
    }
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
    const response = await this.client.getUpdates({ syncCursor });
    const nextCursor = stringValue(response.get_updates_buf);
    if (nextCursor) {
      this.accountStore.saveSyncCursor(this.config.accountId, nextCursor);
    }
    const events = [];
    for (const message of response.msgs ?? []) {
      const event = this.normalizeInboundEvent(message);
      if (!event) {
        continue;
      }
      const senderId = event.metadata?.weixin?.senderId;
      if (typeof senderId === 'string' && senderId) {
        await this.ensureTypingTicket(senderId);
      }
      events.push(event);
    }
    return {
      syncCursor: nextCursor ?? syncCursor,
      events,
      raw: response,
    };
  }

  async sendText({ externalScopeId, content }) {
    if (!this.client) {
      throw new Error('WeixinPlatformPlugin.sendText requires start() first');
    }
    const deliveries = this.buildTextDeliveries({
      externalScopeId,
      content,
    });
    const results = [];
    for (const delivery of deliveries) {
      results.push(await this.client.sendMessage({
        toUserId: delivery.payload.msg.to_user_id,
        text: delivery.payload.msg.item_list[0].text_item.text,
        contextToken: delivery.payload.msg.context_token ?? null,
        clientId: delivery.payload.msg.client_id,
      }));
    }
    return results;
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

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
