import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getUploadUrl, type WeixinOfficialApiOptions, type WeixinOfficialFetch } from '../api.js';
import { UploadMediaType } from '../types.js';
import { aesEcbPaddedSize } from './aes_ecb.js';
import { uploadBufferToCdn } from './cdn_upload.js';
import { getExtensionFromContentTypeOrUrl } from '../media/mime.js';
import { createVideoThumbnailJpeg, probeMediaInfo } from '../media/thumbnail.js';

export type UploadedThumbInfo = {
  downloadEncryptedQueryParam: string;
  fileSize: number;
  fileSizeCiphertext: number;
  width: number | null;
  height: number | null;
};

export type UploadedFileInfo = {
  filekey: string;
  downloadEncryptedQueryParam: string;
  // Keep the generated AES-128 key as a 32-char hex string. When sending a
  // media message downstream, Weixin expects the hex string itself to be
  // base64-encoded on the wire (matching openclaw-weixin), not the raw 16-byte
  // key buffer base64.
  aeskey: string;
  fileSize: number;
  fileSizeCiphertext: number;
  fileMd5: string;
  durationMs: number | null;
  thumb: UploadedThumbInfo | null;
};

export async function downloadRemoteImageToTemp(
  url: string,
  destDir: string,
  fetchImpl?: WeixinOfficialFetch,
): Promise<string> {
  const effectiveFetch = fetchImpl ?? (globalThis.fetch as WeixinOfficialFetch | undefined);
  if (typeof effectiveFetch !== 'function') {
    throw new Error(`remote media download missing fetch implementation: ${url}`);
  }
  const res = await effectiveFetch(url);
  if (!res.ok) {
    const statusText = typeof res.statusText === 'string' ? res.statusText : '';
    throw new Error(`remote media download failed: ${res.status} ${statusText} url=${url}`.trim());
  }
  if (typeof res.arrayBuffer !== 'function') {
    throw new Error(`remote media download missing arrayBuffer() response support: ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(destDir, { recursive: true });
  const contentType = typeof res.headers?.get === 'function' ? res.headers.get('content-type') : null;
  const ext = getExtensionFromContentTypeOrUrl(contentType, url);
  const name = `weixin-remote-${crypto.randomUUID()}${ext}`;
  const filePath = path.join(destDir, name);
  await fs.writeFile(filePath, buf);
  return filePath;
}

async function uploadMediaToCdn(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinOfficialApiOptions;
  cdnBaseUrl: string;
  mediaType: (typeof UploadMediaType)[keyof typeof UploadMediaType];
  label: string;
}): Promise<UploadedFileInfo> {
  const plaintext = await fs.readFile(params.filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex');
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString('hex');
  const aeskey = crypto.randomBytes(16);
  const mediaInfo = await probeMediaInfo(params.filePath);
  const thumbSource = await resolveThumbSource({
    filePath: params.filePath,
    mediaType: params.mediaType,
    mainPlaintext: plaintext,
  });

  const uploadUrlResp = await getUploadUrl({
    baseUrl: params.opts.baseUrl,
    token: params.opts.token,
    timeoutMs: params.opts.timeoutMs,
    fetchImpl: params.opts.fetchImpl,
    locale: params.opts.locale,
    filekey,
    media_type: params.mediaType,
    to_user_id: params.toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    thumb_rawsize: thumbSource?.rawsize,
    thumb_rawfilemd5: thumbSource?.rawfilemd5,
    thumb_filesize: thumbSource?.filesize,
    no_need_thumb: !thumbSource,
    aeskey: aeskey.toString('hex'),
  });

  const { downloadParam } = await uploadBufferToCdn({
    buf: plaintext,
    uploadFullUrl: uploadUrlResp.upload_full_url || undefined,
    uploadParam: uploadUrlResp.upload_param ?? undefined,
    filekey,
    cdnBaseUrl: params.cdnBaseUrl,
    aeskey,
    label: `${params.label}[orig filekey=${filekey}]`,
    fetchImpl: params.opts.fetchImpl as typeof globalThis.fetch | undefined,
  });

  try {
    const thumb = thumbSource
      ? await uploadThumbToCdn({
        thumbSource,
        uploadParam: uploadUrlResp.thumb_upload_param ?? undefined,
        filekey,
        cdnBaseUrl: params.cdnBaseUrl,
        aeskey,
        label: `${params.label}[thumb filekey=${filekey}]`,
        fetchImpl: params.opts.fetchImpl as typeof globalThis.fetch | undefined,
      })
      : null;

    return {
      filekey,
      downloadEncryptedQueryParam: downloadParam,
      aeskey: aeskey.toString('hex'),
      fileSize: rawsize,
      fileSizeCiphertext: filesize,
      fileMd5: rawfilemd5,
      durationMs: mediaInfo?.durationMs ?? null,
      thumb,
    };
  } finally {
    await thumbSource?.cleanup?.();
  }
}

export async function uploadFileToWeixin(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinOfficialApiOptions;
  cdnBaseUrl: string;
}): Promise<UploadedFileInfo> {
  return uploadMediaToCdn({
    ...params,
    mediaType: UploadMediaType.IMAGE,
    label: 'uploadFileToWeixin',
  });
}

export async function uploadVideoToWeixin(params: {
  filePath: string;
  toUserId: string;
  opts: WeixinOfficialApiOptions;
  cdnBaseUrl: string;
}): Promise<UploadedFileInfo> {
  return uploadMediaToCdn({
    ...params,
    mediaType: UploadMediaType.VIDEO,
    label: 'uploadVideoToWeixin',
  });
}

export async function uploadFileAttachmentToWeixin(params: {
  filePath: string;
  fileName: string;
  toUserId: string;
  opts: WeixinOfficialApiOptions;
  cdnBaseUrl: string;
}): Promise<UploadedFileInfo> {
  return uploadMediaToCdn({
    ...params,
    mediaType: UploadMediaType.FILE,
    label: 'uploadFileAttachmentToWeixin',
  });
}

interface ThumbSource {
  plaintext: Buffer;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  width: number | null;
  height: number | null;
  cleanup?: (() => Promise<void>) | null;
}

async function resolveThumbSource(params: {
  filePath: string;
  mediaType: (typeof UploadMediaType)[keyof typeof UploadMediaType];
  mainPlaintext: Buffer;
}): Promise<ThumbSource | null> {
  if (params.mediaType === UploadMediaType.IMAGE) {
    return null;
  }

  if (params.mediaType !== UploadMediaType.VIDEO) {
    return null;
  }

  const generated = await createVideoThumbnailJpeg(params.filePath);
  if (!generated) {
    return null;
  }
  try {
    const thumbPlaintext = await fs.readFile(generated.filePath);
    const thumbInfo = await probeMediaInfo(generated.filePath);
    return buildThumbSource({
      plaintext: thumbPlaintext,
      width: thumbInfo?.width ?? null,
      height: thumbInfo?.height ?? null,
      cleanup: generated.cleanup,
    });
  } catch (error) {
    await generated.cleanup().catch(() => {});
    throw error;
  }
}

function buildThumbSource(params: {
  plaintext: Buffer;
  width: number | null;
  height: number | null;
  cleanup?: (() => Promise<void>) | null;
}): ThumbSource {
  const rawsize = params.plaintext.length;
  return {
    plaintext: params.plaintext,
    rawsize,
    rawfilemd5: crypto.createHash('md5').update(params.plaintext).digest('hex'),
    filesize: aesEcbPaddedSize(rawsize),
    width: params.width,
    height: params.height,
    cleanup: params.cleanup ?? null,
  };
}

async function uploadThumbToCdn(params: {
  thumbSource: ThumbSource;
  uploadParam?: string;
  filekey: string;
  cdnBaseUrl: string;
  aeskey: Buffer;
  label: string;
  fetchImpl?: typeof globalThis.fetch;
}): Promise<UploadedThumbInfo> {
  if (!params.uploadParam) {
    throw new Error(`${params.label}: thumbnail upload URL missing (need thumb_upload_param)`);
  }
  const { downloadParam } = await uploadBufferToCdn({
    buf: params.thumbSource.plaintext,
    uploadParam: params.uploadParam,
    filekey: params.filekey,
    cdnBaseUrl: params.cdnBaseUrl,
    aeskey: params.aeskey,
    label: params.label,
    fetchImpl: params.fetchImpl,
  });
  return {
    downloadEncryptedQueryParam: downloadParam,
    fileSize: params.thumbSource.rawsize,
    fileSizeCiphertext: params.thumbSource.filesize,
    width: params.thumbSource.width,
    height: params.thumbSource.height,
  };
}
