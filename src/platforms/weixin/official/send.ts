import crypto from 'node:crypto';
import { sendMessage as sendMessageApi, type WeixinOfficialApiOptions } from './api.js';
import type { MessageItem, SendMessageReq } from './types.js';
import { MessageItemType, MessageState, MessageType } from './types.js';
import type { UploadedFileInfo } from './cdn/upload.js';

const MESSAGE_TYPE_BOT = 2;
const MESSAGE_STATE_FINISH = 2;
const TEXT_ITEM = 1;

export function buildTextMessageReq(params: {
  to: string;
  text: string;
  contextToken?: string | null;
  clientId: string;
}): SendMessageReq {
  const { to, text, contextToken, clientId } = params;
  return {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: clientId,
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      item_list: [{
        type: TEXT_ITEM,
        text_item: { text },
      }],
      context_token: contextToken ?? undefined,
    },
  };
}

export function generateClientId(): string {
  return `codexbridge-weixin-${crypto.randomUUID()}`;
}

function assertSuccessfulSendResponse(result: unknown, label: string): void {
  const ret = Number((result as Record<string, unknown> | null)?.ret ?? 0);
  const errcode = Number((result as Record<string, unknown> | null)?.errcode ?? 0);
  const code = errcode || ret;
  if (code === 0) {
    return;
  }
  throw new Error(`${label}: ${code}`);
}

export async function sendMessageWeixin(params: {
  to: string;
  text: string;
  opts: WeixinOfficialApiOptions & { contextToken?: string | null };
}): Promise<{ messageId: string }> {
  const { to, text, opts } = params;
  const clientId = generateClientId();
  const result = await sendMessageApi({
    baseUrl: opts.baseUrl,
    token: opts.token,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
    locale: opts.locale,
    ...buildTextMessageReq({
      to,
      text,
      contextToken: opts.contextToken ?? null,
      clientId,
    }),
  });
  assertSuccessfulSendResponse(result, 'sendMessageWeixin');
  return { messageId: clientId };
}

async function sendMediaItems(params: {
  to: string;
  text: string;
  mediaItem: MessageItem;
  opts: WeixinOfficialApiOptions & { contextToken?: string | null };
}): Promise<{ messageId: string }> {
  const items: MessageItem[] = [];
  if (params.text) {
    items.push({ type: MessageItemType.TEXT, text_item: { text: params.text } });
  }
  items.push(params.mediaItem);

  let lastClientId = '';
  for (const item of items) {
    lastClientId = generateClientId();
    const result = await sendMessageApi({
      baseUrl: params.opts.baseUrl,
      token: params.opts.token,
      timeoutMs: params.opts.timeoutMs,
      fetchImpl: params.opts.fetchImpl,
      locale: params.opts.locale,
      msg: {
        from_user_id: '',
        to_user_id: params.to,
        client_id: lastClientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [item],
        context_token: params.opts.contextToken ?? undefined,
      },
    });
    assertSuccessfulSendResponse(result, 'sendMediaItems');
  }

  return { messageId: lastClientId };
}

export async function sendImageMessageWeixin(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinOfficialApiOptions & { contextToken?: string | null };
}): Promise<{ messageId: string }> {
  return sendMediaItems({
    to: params.to,
    text: params.text,
    opts: params.opts,
    mediaItem: {
      type: MessageItemType.IMAGE,
      image_item: {
        media: {
          encrypt_query_param: params.uploaded.downloadEncryptedQueryParam,
          aes_key: encodeWeixinMediaAesKey(params.uploaded.aeskey),
          encrypt_type: 1,
        },
        mid_size: params.uploaded.fileSizeCiphertext,
      },
    },
  });
}

export async function sendVideoMessageWeixin(params: {
  to: string;
  text: string;
  uploaded: UploadedFileInfo;
  opts: WeixinOfficialApiOptions & { contextToken?: string | null };
}): Promise<{ messageId: string }> {
  return sendMediaItems({
    to: params.to,
    text: params.text,
    opts: params.opts,
    mediaItem: {
      type: MessageItemType.VIDEO,
      video_item: {
        media: {
          encrypt_query_param: params.uploaded.downloadEncryptedQueryParam,
          aes_key: encodeWeixinMediaAesKey(params.uploaded.aeskey),
          encrypt_type: 1,
        },
        video_size: params.uploaded.fileSizeCiphertext,
        play_length: params.uploaded.durationMs ?? undefined,
        video_md5: params.uploaded.fileMd5,
        thumb_media: params.uploaded.thumb
          ? {
            encrypt_query_param: params.uploaded.thumb.downloadEncryptedQueryParam,
            aes_key: encodeWeixinMediaAesKey(params.uploaded.aeskey),
            encrypt_type: 1,
          }
          : undefined,
        thumb_size: params.uploaded.thumb?.fileSizeCiphertext,
        thumb_height: params.uploaded.thumb?.height ?? undefined,
        thumb_width: params.uploaded.thumb?.width ?? undefined,
      },
    },
  });
}

export async function sendFileMessageWeixin(params: {
  to: string;
  text: string;
  fileName: string;
  uploaded: UploadedFileInfo;
  opts: WeixinOfficialApiOptions & { contextToken?: string | null };
}): Promise<{ messageId: string }> {
  return sendMediaItems({
    to: params.to,
    text: params.text,
    opts: params.opts,
    mediaItem: {
      type: MessageItemType.FILE,
      file_item: {
        media: {
          encrypt_query_param: params.uploaded.downloadEncryptedQueryParam,
          aes_key: encodeWeixinMediaAesKey(params.uploaded.aeskey),
          encrypt_type: 1,
        },
        file_name: params.fileName,
        md5: params.uploaded.fileMd5,
        len: String(params.uploaded.fileSize),
      },
    },
  });
}

function encodeWeixinMediaAesKey(aesKeyHex: string): string {
  // openclaw-weixin / official ilink clients base64-encode the hex string
  // itself on the wire. We keep the same encoding so the WeChat client can
  // decrypt uploaded media correctly.
  return Buffer.from(aesKeyHex).toString('base64');
}
