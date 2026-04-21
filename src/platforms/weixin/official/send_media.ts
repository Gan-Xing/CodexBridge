import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeSequencedDebugLog } from '../../../core/sequenced_stderr.js';
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
import { normalizeStillImageForWeixin, transcodeStillImageJpeg } from './media/thumbnail.js';

const MAX_WEIXIN_IMAGE_BYTES = 200 * 1024;
const TARGET_WEIXIN_IMAGE_BYTES = 190 * 1024;

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
  debugWeixinMedia('send_media_file_start', {
    filePath: params.filePath,
    toUserId: params.to,
    textPreview: truncateDebugText(params.text, 160),
  });
  const materialized = await materializeMediaInput(params.filePath, params.opts.fetchImpl);
  const uploadOpts: WeixinOfficialApiOptions = {
    baseUrl: params.opts.baseUrl,
    token: params.opts.token,
    timeoutMs: params.opts.timeoutMs,
    fetchImpl: params.opts.fetchImpl,
    locale: params.opts.locale,
  };
  const mime = getMimeFromFilename(materialized.filePath);
  debugWeixinMedia('send_media_file_materialized', {
    originalPath: params.filePath,
    materializedPath: materialized.filePath,
    mime,
  });

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
      debugWeixinMedia('send_media_file_video_sent', {
        toUserId: params.to,
        filePath: materialized.filePath,
        messageId: mediaResult.messageId,
      });
      return attachCaptionResult(mediaResult, params);
    }

    if (mime.startsWith('image/')) {
      return await sendWeixinImageFile({
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
    debugWeixinMedia('send_media_file_file_sent', {
      toUserId: params.to,
      filePath: materialized.filePath,
      fileName,
      messageId: mediaResult.messageId,
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
  debugWeixinMedia('send_media_image_begin', {
    toUserId: params.to,
    filePath: params.filePath,
    captionPreview: truncateDebugText(params.text, 120),
  });
  const uploadInput = await prepareImageUploadInputForWeixin(params.filePath);
  try {
    debugWeixinMedia('send_media_upload_input', {
      toUserId: params.to,
      originalPath: uploadInput.originalPath,
      uploadPath: uploadInput.filePath,
      originalSizeBytes: uploadInput.originalSizeBytes,
      uploadSizeBytes: uploadInput.uploadSizeBytes,
      transcodedToJpeg: uploadInput.transcodedToJpeg,
      normalized: uploadInput.normalized,
    });
    const uploaded = await uploadFileToWeixin({
      filePath: uploadInput.filePath,
      toUserId: params.to,
      opts: params.uploadOpts,
      cdnBaseUrl: params.cdnBaseUrl,
    });
    debugWeixinMedia('send_media_image_uploaded', {
      toUserId: params.to,
      uploadPath: uploadInput.filePath,
      filekey: uploaded.filekey,
      fileSize: uploaded.fileSize,
      fileSizeCiphertext: uploaded.fileSizeCiphertext,
      durationMs: uploaded.durationMs,
      hasThumb: Boolean(uploaded.thumb),
    });
    const mediaResult = await sendImageMessageWeixin({
      to: params.to,
      text: '',
      uploaded,
      opts: params.opts,
    });
    debugWeixinMedia('send_media_image_sent', {
      toUserId: params.to,
      uploadPath: uploadInput.filePath,
      messageId: mediaResult.messageId,
    });
    return attachCaptionResult(mediaResult, params);
  } finally {
    await uploadInput.cleanup?.();
  }
}

async function prepareImageUploadInputForWeixin(filePath: string): Promise<{
  originalPath: string;
  filePath: string;
  originalSizeBytes: number;
  uploadSizeBytes: number;
  transcodedToJpeg: boolean;
  normalized: boolean;
  cleanup?: (() => Promise<void>) | null;
}> {
  debugWeixinMedia('prepare_image_upload_input_start', {
    filePath,
  });
  const originalStat = await fs.stat(filePath);
  const transcoded = await transcodeStillImageJpeg(filePath);
  if (!transcoded) {
    throw new Error(`failed to transcode image to JPEG for Weixin upload: ${filePath}`);
  }
  try {
    const transcodedStat = await fs.stat(transcoded.filePath);
    debugWeixinMedia('prepare_image_upload_transcoded', {
      originalPath: filePath,
      transcodedPath: transcoded.filePath,
      originalSizeBytes: originalStat.size,
      transcodedSizeBytes: transcodedStat.size,
    });
    if (transcodedStat.size <= MAX_WEIXIN_IMAGE_BYTES) {
      return {
        originalPath: filePath,
        filePath: transcoded.filePath,
        originalSizeBytes: originalStat.size,
        uploadSizeBytes: transcodedStat.size,
        transcodedToJpeg: true,
        normalized: false,
        cleanup: transcoded.cleanup,
      };
    }

    const normalized = await normalizeStillImageForWeixin(transcoded.filePath, {
      maxBytes: MAX_WEIXIN_IMAGE_BYTES,
      targetBytes: TARGET_WEIXIN_IMAGE_BYTES,
    });
    if (!normalized) {
      throw new Error(`failed to normalize image for Weixin upload: ${filePath}`);
    }
    const normalizedStat = await fs.stat(normalized.filePath);
    debugWeixinMedia('prepare_image_upload_normalized', {
      originalPath: filePath,
      transcodedPath: transcoded.filePath,
      normalizedPath: normalized.filePath,
      normalizedSizeBytes: normalizedStat.size,
      targetBytes: TARGET_WEIXIN_IMAGE_BYTES,
      maxBytes: MAX_WEIXIN_IMAGE_BYTES,
    });
    return {
      originalPath: filePath,
      filePath: normalized.filePath,
      originalSizeBytes: originalStat.size,
      uploadSizeBytes: normalizedStat.size,
      transcodedToJpeg: true,
      normalized: true,
      cleanup: async () => {
        await normalized.cleanup?.();
        await transcoded.cleanup?.();
      },
    };
  } catch (error) {
    await transcoded.cleanup?.();
    throw error;
  }
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
    debugWeixinMedia('materialize_media_input_local', {
      filePath: normalized,
    });
    return {
      filePath: normalized,
      cleanup: null,
    };
  }
  debugWeixinMedia('materialize_media_input_remote_start', {
    url: normalized,
  });
  const tempDir = path.join(os.tmpdir(), 'codexbridge-weixin-remote-media');
  const downloadedPath = await downloadRemoteImageToTemp(normalized, tempDir, fetchImpl);
  const mime = getMimeFromFilename(downloadedPath);
  if (!mime.startsWith('image/')) {
    await fs.unlink(downloadedPath).catch(() => {});
    throw new Error(`remote media URL is not a supported image: ${normalized}`);
  }
  debugWeixinMedia('materialize_media_input_remote_done', {
    url: normalized,
    downloadedPath,
    mime,
  });
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

function debugWeixinMedia(event: string, payload: unknown) {
  writeSequencedDebugLog('weixin-debug', event, payload);
}

function truncateDebugText(value: unknown, limit = 240): string {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (!text) {
    return '';
  }
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
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
