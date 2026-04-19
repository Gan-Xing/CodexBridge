import { decryptAesEcb } from './aes_ecb.js';
import { buildCdnDownloadUrl, ENABLE_CDN_URL_FALLBACK } from './cdn_url.js';

async function fetchCdnBytes(url: string, label: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`${label}: CDN download ${res.status} ${res.statusText} body=${body}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function parseAesKey(aesKeyBase64: string, label: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(`${label}: invalid aes_key payload`);
}

export async function downloadAndDecryptBuffer(
  encryptedQueryParam: string,
  aesKeyBase64: string,
  cdnBaseUrl: string,
  label: string,
  fullUrl?: string,
): Promise<Buffer> {
  const key = parseAesKey(aesKeyBase64, label);
  const url = fullUrl
    ? fullUrl
    : ENABLE_CDN_URL_FALLBACK
      ? buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl)
      : null;
  if (!url) {
    throw new Error(`${label}: fullUrl is required (CDN URL fallback is disabled)`);
  }
  const encrypted = await fetchCdnBytes(url, label);
  return decryptAesEcb(encrypted, key);
}

export async function downloadPlainCdnBuffer(
  encryptedQueryParam: string,
  cdnBaseUrl: string,
  label: string,
  fullUrl?: string,
): Promise<Buffer> {
  const url = fullUrl
    ? fullUrl
    : ENABLE_CDN_URL_FALLBACK
      ? buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl)
      : null;
  if (!url) {
    throw new Error(`${label}: fullUrl is required (CDN URL fallback is disabled)`);
  }
  return fetchCdnBytes(url, label);
}
