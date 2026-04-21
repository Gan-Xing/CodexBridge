import { writeSequencedDebugLog } from '../../../../core/sequenced_stderr.js';
import { encryptAesEcb } from './aes_ecb.js';
import { buildCdnUploadUrl } from './cdn_url.js';

const UPLOAD_MAX_RETRIES = 3;

export async function uploadBufferToCdn(params: {
  buf: Buffer;
  uploadFullUrl?: string;
  uploadParam?: string;
  filekey: string;
  cdnBaseUrl: string;
  label: string;
  aeskey: Buffer;
  fetchImpl?: typeof globalThis.fetch;
}): Promise<{ downloadParam: string }> {
  const ciphertext = encryptAesEcb(params.buf, params.aeskey);
  const trimmedFull = params.uploadFullUrl?.trim();
  const cdnUrl = trimmedFull
    ? trimmedFull
    : params.uploadParam
      ? buildCdnUploadUrl({
        cdnBaseUrl: params.cdnBaseUrl,
        uploadParam: params.uploadParam,
        filekey: params.filekey,
      })
      : null;

  if (!cdnUrl) {
    throw new Error(`${params.label}: CDN upload URL missing (need upload_full_url or upload_param)`);
  }
  debugCdnUpload('cdn_upload_prepare', {
    label: params.label,
    filekey: params.filekey,
    plaintextSize: params.buf.length,
    ciphertextSize: ciphertext.length,
    uploadUrlMode: trimmedFull ? 'upload_full_url' : 'upload_param',
  });

  let downloadParam: string | undefined;
  let lastError: unknown;
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error(`${params.label}: fetch implementation missing for CDN upload`);
  }

  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt += 1) {
    try {
      debugCdnUpload('cdn_upload_attempt_start', {
        label: params.label,
        filekey: params.filekey,
        attempt,
        uploadUrlMode: trimmedFull ? 'upload_full_url' : 'upload_param',
      });
      const res = await fetchImpl(cdnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
      });
      debugCdnUpload('cdn_upload_attempt_response', {
        label: params.label,
        filekey: params.filekey,
        attempt,
        status: res.status,
        encryptedParamPresent: Boolean(res.headers.get('x-encrypted-param')),
      });
      if (res.status >= 400 && res.status < 500) {
        const errMsg = res.headers.get('x-error-message') ?? await res.text();
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        const errMsg = res.headers.get('x-error-message') ?? `status ${res.status}`;
        throw new Error(`CDN upload server error: ${errMsg}`);
      }
      downloadParam = res.headers.get('x-encrypted-param') ?? undefined;
      if (!downloadParam) {
        throw new Error('CDN upload response missing x-encrypted-param header');
      }
      debugCdnUpload('cdn_upload_attempt_success', {
        label: params.label,
        filekey: params.filekey,
        attempt,
      });
      break;
    } catch (error) {
      lastError = error;
      debugCdnUpload('cdn_upload_attempt_failed', {
        label: params.label,
        filekey: params.filekey,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof Error && error.message.includes('client error')) {
        throw error;
      }
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error
      ? lastError
      : new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`);
  }
  return { downloadParam };
}

function debugCdnUpload(event: string, payload: unknown) {
  writeSequencedDebugLog('weixin-debug', event, payload);
}
