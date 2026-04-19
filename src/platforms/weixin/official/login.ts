import { createI18n } from '../../../i18n/index.js';
import { getBotQr, getQrStatus, type WeixinOfficialFetch } from './api.js';
import type { WeixinQrCodeResponse, WeixinQrStatusResponse } from './types.js';
import { clearContextTokensForAccount } from './context_tokens.js';
import type { WeixinAccountStore } from '../account_store.js';

export const DEFAULT_ILINK_BOT_TYPE = '3';
export const FIXED_QR_BASE_URL = 'https://ilinkai.weixin.qq.com';

interface OfficialQrLoginOptions {
  accountStore: Pick<WeixinAccountStore, 'saveAccount'>;
  accountsDir?: string | null;
  fetchImpl?: WeixinOfficialFetch;
  locale?: string | null;
  botType?: string;
  timeoutSeconds?: number;
  sleep?: (ms: number) => Promise<void>;
  onQrCode?: ((params: { qrcode: string; qrcodeImageContent: string; raw: WeixinQrCodeResponse }) => Promise<void> | void) | null;
  onStatus?: ((params: { status: string; qrcode: string; raw: WeixinQrStatusResponse }) => Promise<void> | void) | null;
}

export interface OfficialQrLoginCredentials {
  account_id: string;
  token: string;
  base_url: string;
  user_id: string;
}

export async function officialQrLogin(
  options: OfficialQrLoginOptions,
): Promise<OfficialQrLoginCredentials | null> {
  const {
    accountStore,
    accountsDir = null,
    fetchImpl,
    locale = null,
    botType = DEFAULT_ILINK_BOT_TYPE,
    timeoutSeconds = 480,
    sleep = defaultSleep,
    onQrCode = null,
    onStatus = null,
  } = options;

  const i18n = createI18n(locale);
  if (!accountStore) {
    throw new Error(i18n.t('platform.weixin.official.qrLoginRequiresAccountStore'));
  }

  let qrResponse = await getBotQr({
    baseUrl: FIXED_QR_BASE_URL,
    fetchImpl,
    locale,
    botType,
  });
  let qrcode = String(qrResponse.qrcode ?? '');
  if (!qrcode) {
    return null;
  }

  if (typeof onQrCode === 'function') {
    await onQrCode({
      qrcode,
      qrcodeImageContent: String(qrResponse.qrcode_img_content ?? ''),
      raw: qrResponse,
    });
  }

  const deadline = Date.now() + (timeoutSeconds * 1000);
  let currentBaseUrl = FIXED_QR_BASE_URL;
  let lastStatus: string | null = null;

  while (Date.now() < deadline) {
    let statusResponse: WeixinQrStatusResponse;
    try {
      statusResponse = await getQrStatus({
        baseUrl: currentBaseUrl,
        fetchImpl,
        locale,
        qrcode,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        await sleep(1000);
        continue;
      }
      throw error;
    }

    const status = String(statusResponse.status ?? 'wait');
    if (status !== lastStatus) {
      lastStatus = status;
      if (typeof onStatus === 'function') {
        await onStatus({ status, qrcode, raw: statusResponse });
      }
    }

    if (status === 'scaned_but_redirect') {
      const redirectHost = String(statusResponse.redirect_host ?? '').trim();
      if (redirectHost) {
        currentBaseUrl = `https://${redirectHost}`;
      }
      await sleep(1000);
      continue;
    }

    if (status === 'expired') {
      qrResponse = await getBotQr({
        baseUrl: FIXED_QR_BASE_URL,
        fetchImpl,
        locale,
        botType,
      });
      qrcode = String(qrResponse.qrcode ?? '');
      currentBaseUrl = FIXED_QR_BASE_URL;
      if (typeof onQrCode === 'function') {
        await onQrCode({
          qrcode,
          qrcodeImageContent: String(qrResponse.qrcode_img_content ?? ''),
          raw: qrResponse,
        });
      }
      await sleep(1000);
      continue;
    }

    if (status === 'confirmed') {
      const credentials: OfficialQrLoginCredentials = {
        account_id: String(statusResponse.ilink_bot_id ?? ''),
        token: String(statusResponse.bot_token ?? ''),
        base_url: String(statusResponse.baseurl ?? FIXED_QR_BASE_URL),
        user_id: String(statusResponse.ilink_user_id ?? ''),
      };
      if (!credentials.account_id || !credentials.token) {
        return null;
      }
      if (accountsDir) {
        clearContextTokensForAccount(accountsDir, credentials.account_id);
      }
      accountStore.saveAccount({
        accountId: credentials.account_id,
        token: credentials.token,
        baseUrl: credentials.base_url,
        userId: credentials.user_id,
      });
      return credentials;
    }

    await sleep(1000);
  }

  return null;
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
