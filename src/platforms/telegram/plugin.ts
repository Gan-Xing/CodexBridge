import type {
  InboundTextEvent,
  PlatformDeliveryRequest,
  PlatformPluginContract,
  PlatformTextDeliveryResult,
} from '../../types/platform.js';

interface TelegramTransportLike {
  start?(): Promise<void> | void;
  stop?(): Promise<void> | void;
  sendMessage?(params: {
    chatId: string;
    text: string;
    messageThreadId?: number | null;
  }): Promise<{
    ok?: boolean;
    result?: {
      message_id?: number | string | null;
    } | null;
    description?: string | null;
    error?: string | null;
  } | null | undefined> | {
    ok?: boolean;
    result?: {
      message_id?: number | string | null;
    } | null;
    description?: string | null;
    error?: string | null;
  } | null | undefined;
  sendChatAction?(params: {
    chatId: string;
    action: 'typing';
    messageThreadId?: number | null;
  }): Promise<void> | void;
}

interface TelegramPlatformPluginOptions {
  client?: TelegramTransportLike | null;
}

interface TelegramNormalizedMessage {
  externalScopeId: string;
  text: string;
  locale: string | null;
  metadata: Record<string, unknown>;
}

export class TelegramPlatformPlugin implements PlatformPluginContract {
  constructor({ client = null }: TelegramPlatformPluginOptions = {}) {
    this.id = 'telegram';
    this.displayName = 'Telegram';
    this.client = client;
  }

  id: string;
  displayName: string;
  client: TelegramTransportLike | null;

  async start(): Promise<void> {
    await this.client?.start?.();
  }

  async stop(): Promise<void> {
    await this.client?.stop?.();
  }

  normalizeInboundEvent(payload: Record<string, unknown>): InboundTextEvent | null {
    const normalized = normalizeTelegramMessage(payload);
    if (!normalized) {
      return null;
    }
    return {
      platform: 'telegram',
      externalScopeId: normalized.externalScopeId,
      text: normalized.text,
      attachments: [],
      locale: normalized.locale,
      metadata: normalized.metadata,
    };
  }

  buildTextDeliveries({
    externalScopeId,
    content,
  }: {
    externalScopeId: string;
    content: string;
  }): PlatformDeliveryRequest[] {
    const { chatId, messageThreadId } = parseTelegramScopeId(externalScopeId);
    return splitTelegramText(content).map((text) => ({
      kind: 'telegram.sendMessage',
      payload: {
        chat_id: chatId,
        text,
        ...(messageThreadId !== null ? { message_thread_id: messageThreadId } : {}),
      },
    }));
  }

  async sendText({
    externalScopeId,
    content,
  }: {
    externalScopeId: string;
    content: string;
  }): Promise<PlatformTextDeliveryResult> {
    const deliveries = this.buildTextDeliveries({ externalScopeId, content });
    const deliveredTexts: string[] = [];
    for (let index = 0; index < deliveries.length; index += 1) {
      const delivery = deliveries[index];
      const payload = delivery?.payload ?? {};
      const text = typeof payload.text === 'string' ? payload.text : '';
      if (!this.client?.sendMessage) {
        deliveredTexts.push(text);
        continue;
      }
      try {
        const result = await this.client.sendMessage({
          chatId: String(payload.chat_id ?? ''),
          text,
          messageThreadId: typeof payload.message_thread_id === 'number'
            ? payload.message_thread_id
            : null,
        });
        if (result && result.ok === false) {
          return {
            success: false,
            deliveredCount: deliveredTexts.length,
            deliveredText: deliveredTexts.join('\n\n'),
            failedIndex: index,
            failedText: text,
            error: String(result.description ?? result.error ?? 'telegram send failed'),
          };
        }
        deliveredTexts.push(text);
      } catch (error) {
        return {
          success: false,
          deliveredCount: deliveredTexts.length,
          deliveredText: deliveredTexts.join('\n\n'),
          failedIndex: index,
          failedText: text,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return {
      success: true,
      deliveredCount: deliveredTexts.length,
      deliveredText: deliveredTexts.join('\n\n'),
      failedIndex: null,
      failedText: '',
      error: '',
    };
  }

  async sendTyping({
    externalScopeId,
    status,
  }: {
    externalScopeId: string;
    status: 'start' | 'stop';
  }): Promise<void> {
    if (status !== 'start' || !this.client?.sendChatAction) {
      return;
    }
    const { chatId, messageThreadId } = parseTelegramScopeId(externalScopeId);
    await this.client.sendChatAction({
      chatId,
      action: 'typing',
      messageThreadId,
    });
  }
}

function normalizeTelegramMessage(payload: Record<string, unknown>): TelegramNormalizedMessage | null {
  const container = getFirstObject(
    payload.message,
    payload.edited_message,
    payload.channel_post,
    payload.edited_channel_post,
  );
  if (!container) {
    return null;
  }
  const chat = getObject(container.chat);
  if (!chat) {
    return null;
  }
  const chatId = normalizeScalarId(chat.id);
  if (!chatId) {
    return null;
  }
  const text = normalizeText(container.text) ?? normalizeText(container.caption);
  if (!text) {
    return null;
  }
  const messageThreadId = normalizeInteger(container.message_thread_id);
  const from = getObject(container.from);
  const username = normalizeText(from?.username);
  const firstName = normalizeText(from?.first_name);
  const lastName = normalizeText(from?.last_name);
  const locale = normalizeText(from?.language_code);
  return {
    externalScopeId: formatTelegramScopeId(chatId, messageThreadId),
    text,
    locale,
    metadata: {
      telegram: {
        chatId,
        chatType: normalizeText(chat.type),
        messageId: normalizeScalarId(container.message_id),
        messageThreadId,
        userId: normalizeScalarId(from?.id),
        username,
        displayName: [firstName, lastName].filter(Boolean).join(' ').trim() || username || null,
      },
    },
  };
}

function parseTelegramScopeId(externalScopeId: string): {
  chatId: string;
  messageThreadId: number | null;
} {
  const normalized = String(externalScopeId ?? '').trim();
  const separatorIndex = normalized.indexOf('::');
  if (separatorIndex < 0) {
    return {
      chatId: normalized,
      messageThreadId: null,
    };
  }
  const chatId = normalized.slice(0, separatorIndex).trim();
  const suffix = normalized.slice(separatorIndex + 2).trim();
  return {
    chatId,
    messageThreadId: normalizeInteger(suffix),
  };
}

function formatTelegramScopeId(chatId: string, messageThreadId: number | null): string {
  return messageThreadId === null ? chatId : `${chatId}::${messageThreadId}`;
}

function splitTelegramText(content: string): string[] {
  const normalized = String(content ?? '').trim();
  if (!normalized) {
    return [''];
  }
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > 4096) {
    let boundary = remaining.lastIndexOf('\n', 4096);
    if (boundary < 1024) {
      boundary = 4096;
    }
    chunks.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks.filter((chunk) => chunk.length > 0);
}

function getFirstObject(...values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    const objectValue = getObject(value);
    if (objectValue) {
      return objectValue;
    }
  }
  return null;
}

function getObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeText(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function normalizeScalarId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function normalizeInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/u.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}
