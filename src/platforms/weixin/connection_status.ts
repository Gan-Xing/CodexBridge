import fs from 'node:fs';
import path from 'node:path';

export type WeixinConnectionState = 'connected' | 'reauthorization_required' | 'stopped';

export interface WeixinConnectionStatus {
  accountId: string | null;
  state: WeixinConnectionState;
  updatedAt: string;
  errorCode: number | null;
}

export function weixinConnectionStatusFile(stateDir: string) {
  return path.join(stateDir, 'runtime', 'weixin-connection-status.json');
}

export function writeWeixinConnectionStatus({
  stateDir,
  accountId,
  state,
  errorCode = null,
}: Omit<WeixinConnectionStatus, 'updatedAt'> & { stateDir: string }) {
  const status: WeixinConnectionStatus = {
    accountId: accountId ? String(accountId) : null,
    state,
    updatedAt: new Date().toISOString(),
    errorCode,
  };
  const filePath = weixinConnectionStatusFile(stateDir);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  } catch {}
  return status;
}

export function readWeixinConnectionStatus(stateDir: string): WeixinConnectionStatus | null {
  const filePath = weixinConnectionStatusFile(stateDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<WeixinConnectionStatus>;
    const state = parsed.state;
    if (state !== 'connected' && state !== 'reauthorization_required' && state !== 'stopped') {
      return null;
    }
    return {
      accountId: typeof parsed.accountId === 'string' && parsed.accountId ? parsed.accountId : null,
      state,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      errorCode: typeof parsed.errorCode === 'number' ? parsed.errorCode : null,
    };
  } catch {
    return null;
  }
}
