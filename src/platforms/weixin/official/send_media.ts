import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getMimeFromFilename } from './media/mime.js';
import {
  sendFileMessageWeixin,
  sendImageMessageWeixin,
  sendVideoMessageWeixin,
} from './send.js';
import {
  downloadRemoteImageToTemp,
  uploadFileAttachmentToWeixin,
  uploadFileToWeixin,
  uploadVideoToWeixin,
} from './cdn/upload.js';
import type { WeixinOfficialApiOptions } from './api.js';
import { transcodeStillImageJpeg } from './media/thumbnail.js';

export async function sendWeixinMediaFile(params: {
  filePath: string;
  to: string;
  text: string;
  opts: WeixinOfficialApiOptions & { contextToken?: string | null };
  cdnBaseUrl: string;
}): Promise<{ messageId: string }> {
  const materialized = await materializeMediaInput(params.filePath);
  const uploadOpts: WeixinOfficialApiOptions = {
    baseUrl: params.opts.baseUrl,
    token: params.opts.token,
    timeoutMs: params.opts.timeoutMs,
    fetchImpl: params.opts.fetchImpl,
    locale: params.opts.locale,
  };
  const mime = getMimeFromFilename(materialized.filePath);

  try {
    if (mime.startsWith('video/')) {
      const uploaded = await uploadVideoToWeixin({
        filePath: materialized.filePath,
        toUserId: params.to,
        opts: uploadOpts,
        cdnBaseUrl: params.cdnBaseUrl,
      });
      return sendVideoMessageWeixin({
        to: params.to,
        text: params.text,
        uploaded,
        opts: params.opts,
      });
    }

    if (mime.startsWith('image/')) {
      const preparedImage = await prepareImageForWeixin(materialized.filePath);
      const uploaded = await uploadFileToWeixin({
        filePath: preparedImage.filePath,
        toUserId: params.to,
        opts: uploadOpts,
        cdnBaseUrl: params.cdnBaseUrl,
      });
      try {
        return sendImageMessageWeixin({
          to: params.to,
          text: params.text,
          uploaded,
          opts: params.opts,
        });
      } finally {
        await preparedImage.cleanup?.();
      }
    }

    const fileName = path.basename(materialized.filePath);
    const uploaded = await uploadFileAttachmentToWeixin({
      filePath: materialized.filePath,
      fileName,
      toUserId: params.to,
      opts: uploadOpts,
      cdnBaseUrl: params.cdnBaseUrl,
    });
    return sendFileMessageWeixin({
      to: params.to,
      text: params.text,
      fileName,
      uploaded,
      opts: params.opts,
    });
  } finally {
    await materialized.cleanup?.();
  }
}

async function prepareImageForWeixin(filePath: string): Promise<{
  filePath: string;
  cleanup?: (() => Promise<void>) | null;
}> {
  const mime = getMimeFromFilename(filePath);
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    return {
      filePath,
      cleanup: null,
    };
  }
  const transcoded = await transcodeStillImageJpeg(filePath);
  if (!transcoded) {
    return {
      filePath,
      cleanup: null,
    };
  }
  return transcoded;
}

async function materializeMediaInput(filePath: string): Promise<{
  filePath: string;
  cleanup?: (() => Promise<void>) | null;
}> {
  const normalized = String(filePath ?? '').trim();
  if (!isRemoteHttpUrl(normalized)) {
    return {
      filePath: normalized,
      cleanup: null,
    };
  }
  const tempDir = path.join(os.tmpdir(), 'codexbridge-weixin-remote-media');
  const downloadedPath = await downloadRemoteImageToTemp(normalized, tempDir);
  const mime = getMimeFromFilename(downloadedPath);
  if (!mime.startsWith('image/')) {
    await fs.unlink(downloadedPath).catch(() => {});
    throw new Error(`remote media URL is not a supported image: ${normalized}`);
  }
  return {
    filePath: downloadedPath,
    cleanup: async () => {
      await fs.unlink(downloadedPath).catch(() => {});
    },
  };
}

function isRemoteHttpUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}
