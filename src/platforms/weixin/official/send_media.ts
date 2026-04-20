import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getMimeFromFilename } from './media/mime.js';
import {
  isWeixinSendResponseError,
  sendFileMessageWeixin,
  sendImageMessageWeixin,
  sendMessageWeixin,
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
}): Promise<{
  messageId: string;
  captionMessageId?: string | null;
  captionError?: string | null;
  captionErrorCode?: number | null;
}> {
  const materialized = await materializeMediaInput(params.filePath, params.opts.fetchImpl);
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
      const mediaResult = await sendVideoMessageWeixin({
        to: params.to,
        text: '',
        uploaded,
        opts: params.opts,
      });
      return attachCaptionResult(mediaResult, params);
    }

    if (mime.startsWith('image/')) {
      return sendWeixinImageFile({
        filePath: materialized.filePath,
        to: params.to,
        text: params.text,
        opts: params.opts,
        uploadOpts,
        cdnBaseUrl: params.cdnBaseUrl,
      });
    }

    const fileName = path.basename(materialized.filePath);
    const uploaded = await uploadFileAttachmentToWeixin({
      filePath: materialized.filePath,
      fileName,
      toUserId: params.to,
      opts: uploadOpts,
      cdnBaseUrl: params.cdnBaseUrl,
    });
    const mediaResult = await sendFileMessageWeixin({
      to: params.to,
      text: '',
      fileName,
      uploaded,
      opts: params.opts,
    });
    return attachCaptionResult(mediaResult, params);
  } finally {
    await materialized.cleanup?.();
  }
}

async function sendWeixinImageFile(params: {
  filePath: string;
  to: string;
  text: string;
  opts: WeixinOfficialApiOptions & { contextToken?: string | null };
  uploadOpts: WeixinOfficialApiOptions;
  cdnBaseUrl: string;
}): Promise<{
  messageId: string;
  captionMessageId?: string | null;
  captionError?: string | null;
  captionErrorCode?: number | null;
}> {
  const uploaded = await uploadFileToWeixin({
    filePath: params.filePath,
    toUserId: params.to,
    opts: params.uploadOpts,
    cdnBaseUrl: params.cdnBaseUrl,
  });
  try {
    const mediaResult = await sendImageMessageWeixin({
      to: params.to,
      text: '',
      uploaded,
      opts: params.opts,
    });
    return attachCaptionResult(mediaResult, params);
  } catch (rawSendError) {
    if (!shouldRetryWithJpegFallback(rawSendError)) {
      throw rawSendError;
    }
    const fallbackImage = await prepareImageFallbackForWeixin(params.filePath);
    if (!fallbackImage) {
      throw rawSendError;
    }
    try {
      const fallbackUploaded = await uploadFileToWeixin({
        filePath: fallbackImage.filePath,
        toUserId: params.to,
        opts: params.uploadOpts,
        cdnBaseUrl: params.cdnBaseUrl,
      });
      const mediaResult = await sendImageMessageWeixin({
        to: params.to,
        text: '',
        uploaded: fallbackUploaded,
        opts: params.opts,
      });
      return attachCaptionResult(mediaResult, params);
    } catch (fallbackError) {
      throw buildImageFallbackError(rawSendError, fallbackError);
    } finally {
      await fallbackImage.cleanup?.();
    }
  }
}

async function prepareImageFallbackForWeixin(filePath: string): Promise<{
  filePath: string;
  cleanup?: (() => Promise<void>) | null;
} | null> {
  const mime = getMimeFromFilename(filePath);
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    return null;
  }
  const transcoded = await transcodeStillImageJpeg(filePath);
  if (!transcoded) {
    return null;
  }
  return transcoded;
}

async function materializeMediaInput(
  filePath: string,
  fetchImpl?: WeixinOfficialApiOptions['fetchImpl'],
): Promise<{
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
  const downloadedPath = await downloadRemoteImageToTemp(normalized, tempDir, fetchImpl);
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

function buildImageFallbackError(rawSendError: unknown, fallbackError: unknown): Error {
  const rawMessage = rawSendError instanceof Error ? rawSendError.message : String(rawSendError);
  const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
  return new Error(`raw image send failed: ${rawMessage}; jpeg fallback failed: ${fallbackMessage}`);
}

async function attachCaptionResult(
  mediaResult: { messageId: string },
  params: {
    to: string;
    text: string;
    opts: WeixinOfficialApiOptions & { contextToken?: string | null };
  },
): Promise<{
  messageId: string;
  captionMessageId?: string | null;
  captionError?: string | null;
  captionErrorCode?: number | null;
}> {
  const caption = String(params.text ?? '').trim();
  if (!caption) {
    return {
      messageId: mediaResult.messageId,
      captionMessageId: null,
      captionError: null,
      captionErrorCode: null,
    };
  }
  try {
    const captionResult = await sendMessageWeixin({
      to: params.to,
      text: caption,
      opts: params.opts,
    });
    return {
      messageId: mediaResult.messageId,
      captionMessageId: captionResult.messageId,
      captionError: null,
      captionErrorCode: null,
    };
  } catch (error) {
    return {
      messageId: mediaResult.messageId,
      captionMessageId: null,
      captionError: error instanceof Error ? error.message : String(error),
      captionErrorCode: isWeixinSendResponseError(error) ? error.code : null,
    };
  }
}

function shouldRetryWithJpegFallback(error: unknown): boolean {
  if (!isWeixinSendResponseError(error)) {
    return false;
  }
  return error.label === 'sendMediaItems' && Number.isFinite(error.code) && error.code > 0;
}
