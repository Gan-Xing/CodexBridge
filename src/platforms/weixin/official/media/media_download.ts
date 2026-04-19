import { downloadAndDecryptBuffer, downloadPlainCdnBuffer } from '../cdn/pic_decrypt.js';
import { getMimeFromFilename } from './mime.js';
import { silkToWav } from './silk_transcode.js';
import type { WeixinMessage } from '../types.js';
import { MessageItemType } from '../types.js';

const WEIXIN_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

export type WeixinInboundMediaOpts = {
  decryptedPicPath?: string;
  decryptedVoicePath?: string;
  voiceMediaType?: string;
  decryptedFilePath?: string;
  fileMediaType?: string;
  decryptedVideoPath?: string;
};

type SaveMediaFn = (
  buffer: Buffer,
  contentType?: string,
  subdir?: string,
  maxBytes?: number,
  originalFilename?: string,
) => Promise<{ path: string }>;

export async function downloadMediaFromItem(
  item: WeixinMessage['item_list'] extends (infer T)[] | undefined ? T : never,
  deps: {
    cdnBaseUrl: string;
    saveMedia: SaveMediaFn;
    label: string;
  },
): Promise<WeixinInboundMediaOpts> {
  const result: WeixinInboundMediaOpts = {};

  if (item.type === MessageItemType.IMAGE) {
    const img = item.image_item;
    if (!img?.media?.encrypt_query_param && !img?.media?.full_url) {
      return result;
    }
    const aesKeyBase64 = img.aeskey
      ? Buffer.from(img.aeskey, 'hex').toString('base64')
      : img.media?.aes_key;
    const buf = aesKeyBase64
      ? await downloadAndDecryptBuffer(
        img.media?.encrypt_query_param ?? '',
        aesKeyBase64,
        deps.cdnBaseUrl,
        `${deps.label} image`,
        img.media?.full_url,
      )
      : await downloadPlainCdnBuffer(
        img.media?.encrypt_query_param ?? '',
        deps.cdnBaseUrl,
        `${deps.label} image-plain`,
        img.media?.full_url,
      );
    const saved = await deps.saveMedia(buf, undefined, 'inbound', WEIXIN_MEDIA_MAX_BYTES);
    result.decryptedPicPath = saved.path;
    return result;
  }

  if (item.type === MessageItemType.VOICE) {
    const voice = item.voice_item;
    if ((!voice?.media?.encrypt_query_param && !voice?.media?.full_url) || !voice?.media?.aes_key) {
      return result;
    }
    const silkBuf = await downloadAndDecryptBuffer(
      voice.media.encrypt_query_param ?? '',
      voice.media.aes_key,
      deps.cdnBaseUrl,
      `${deps.label} voice`,
      voice.media.full_url,
    );
    const wavBuf = await silkToWav(silkBuf);
    if (wavBuf) {
      const saved = await deps.saveMedia(wavBuf, 'audio/wav', 'inbound', WEIXIN_MEDIA_MAX_BYTES);
      result.decryptedVoicePath = saved.path;
      result.voiceMediaType = 'audio/wav';
      return result;
    }
    const saved = await deps.saveMedia(silkBuf, 'audio/silk', 'inbound', WEIXIN_MEDIA_MAX_BYTES);
    result.decryptedVoicePath = saved.path;
    result.voiceMediaType = 'audio/silk';
    return result;
  }

  if (item.type === MessageItemType.FILE) {
    const fileItem = item.file_item;
    if ((!fileItem?.media?.encrypt_query_param && !fileItem?.media?.full_url) || !fileItem?.media?.aes_key) {
      return result;
    }
    const buf = await downloadAndDecryptBuffer(
      fileItem.media.encrypt_query_param ?? '',
      fileItem.media.aes_key,
      deps.cdnBaseUrl,
      `${deps.label} file`,
      fileItem.media.full_url,
    );
    const mime = getMimeFromFilename(fileItem.file_name ?? 'file.bin');
    const saved = await deps.saveMedia(
      buf,
      mime,
      'inbound',
      WEIXIN_MEDIA_MAX_BYTES,
      fileItem.file_name ?? undefined,
    );
    result.decryptedFilePath = saved.path;
    result.fileMediaType = mime;
    return result;
  }

  if (item.type === MessageItemType.VIDEO) {
    const videoItem = item.video_item;
    if ((!videoItem?.media?.encrypt_query_param && !videoItem?.media?.full_url) || !videoItem?.media?.aes_key) {
      return result;
    }
    const buf = await downloadAndDecryptBuffer(
      videoItem.media.encrypt_query_param ?? '',
      videoItem.media.aes_key,
      deps.cdnBaseUrl,
      `${deps.label} video`,
      videoItem.media.full_url,
    );
    const saved = await deps.saveMedia(buf, 'video/mp4', 'inbound', WEIXIN_MEDIA_MAX_BYTES);
    result.decryptedVideoPath = saved.path;
    return result;
  }

  return result;
}
