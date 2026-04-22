export const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OPENAI_OAUTH_SCOPE = 'openid profile email offline_access';
export const OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const OPENAI_OAUTH_DEVICE_CODE_URL = 'https://auth.openai.com/oauth/device/code';

export interface OpenAIDeviceLoginStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresIn: number;
  interval: number;
}

export interface OpenAITokenBundle {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  expiresAt: number | null;
  tokenType: string | null;
  scope: string | null;
}

export type OpenAIDeviceLoginRefreshResult =
  | { status: 'pending'; intervalSeconds: number }
  | { status: 'slow_down'; intervalSeconds: number }
  | { status: 'completed'; tokens: OpenAITokenBundle }
  | { status: 'expired'; error: string }
  | { status: 'failed'; error: string; oauthError?: string | null; retryable?: boolean };

export async function startOpenAIDeviceLogin({
  fetchImpl = fetch,
}: {
  fetchImpl?: typeof fetch;
} = {}): Promise<OpenAIDeviceLoginStart> {
  const response = await fetchImpl(OPENAI_OAUTH_DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: OPENAI_OAUTH_CLIENT_ID,
      scope: OPENAI_OAUTH_SCOPE,
    }),
  });
  if (!response.ok) {
    throw await buildOAuthError(response, 'Device login request failed');
  }
  const raw = await response.json() as Record<string, unknown>;
  const deviceCode = normalizeString(raw?.device_code);
  const userCode = normalizeString(raw?.user_code);
  const verificationUri = normalizeString(raw?.verification_uri);
  const verificationUriComplete = normalizeString(raw?.verification_uri_complete);
  const expiresIn = normalizePositiveInteger(raw?.expires_in);
  const interval = normalizePositiveInteger(raw?.interval) ?? 5;
  if (!deviceCode || !userCode || !verificationUri || !expiresIn) {
    throw new Error('OpenAI device login response is missing required fields');
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresIn,
    interval,
  };
}

export async function refreshOpenAIDeviceLogin({
  deviceCode,
  fetchImpl = fetch,
  now = Date.now(),
}: {
  deviceCode: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<OpenAIDeviceLoginRefreshResult> {
  try {
    const response = await fetchImpl(OPENAI_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: OPENAI_OAUTH_CLIENT_ID,
      }),
    });
    if (!response.ok) {
      const error = await readOAuthErrorResponse(response);
      if (error.oauthError === 'authorization_pending') {
        return {
          status: 'pending',
          intervalSeconds: error.intervalSeconds ?? 5,
        };
      }
      if (error.oauthError === 'slow_down') {
        return {
          status: 'slow_down',
          intervalSeconds: error.intervalSeconds ?? 10,
        };
      }
      if (error.oauthError === 'expired_token') {
        return {
          status: 'expired',
          error: error.message,
        };
      }
      if (error.oauthError === 'access_denied') {
        return {
          status: 'failed',
          error: error.message,
          oauthError: error.oauthError,
          retryable: false,
        };
      }
      return {
        status: 'failed',
        error: error.message,
        oauthError: error.oauthError,
        retryable: error.oauthError === 'authorization_pending' || response.status >= 500,
      };
    }
    const tokens = normalizeTokenBundle(await response.json(), now);
    if (!tokens) {
      return {
        status: 'failed',
        error: 'OpenAI device login token response is missing required fields',
        retryable: false,
      };
    }
    return {
      status: 'completed',
      tokens,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
  }
}

export async function refreshOpenAITokens({
  refreshToken,
  fetchImpl = fetch,
  now = Date.now(),
}: {
  refreshToken: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<OpenAITokenBundle> {
  const response = await fetchImpl(OPENAI_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OPENAI_OAUTH_CLIENT_ID,
    }),
  });
  if (!response.ok) {
    throw await buildOAuthError(response, 'OpenAI token refresh failed');
  }
  const tokens = normalizeTokenBundle(await response.json(), now, refreshToken);
  if (!tokens) {
    throw new Error('OpenAI token refresh response is missing required fields');
  }
  return tokens;
}

function normalizeTokenBundle(
  raw: any,
  now: number,
  fallbackRefreshToken: string | null = null,
): OpenAITokenBundle | null {
  const accessToken = normalizeString(raw?.access_token);
  const refreshToken = normalizeString(raw?.refresh_token) ?? fallbackRefreshToken;
  const expiresIn = normalizePositiveInteger(raw?.expires_in);
  if (!accessToken || !refreshToken) {
    return null;
  }
  return {
    accessToken,
    refreshToken,
    idToken: normalizeString(raw?.id_token),
    expiresAt: expiresIn ? now + expiresIn * 1000 : null,
    tokenType: normalizeString(raw?.token_type),
    scope: normalizeString(raw?.scope),
  };
}

async function buildOAuthError(response: Response, prefix: string): Promise<Error> {
  const details = await readOAuthErrorResponse(response);
  return new Error(`${prefix}: ${details.message}`);
}

async function readOAuthErrorResponse(response: Response): Promise<{
  message: string;
  oauthError: string | null;
  intervalSeconds: number | null;
}> {
  let body = '';
  try {
    body = await response.text();
  } catch {
    body = '';
  }
  const normalizedBody = body.trim();
  if (!normalizedBody) {
    return {
      message: `HTTP ${response.status} ${response.statusText}`.trim(),
      oauthError: null,
      intervalSeconds: null,
    };
  }
  try {
    const parsed = JSON.parse(normalizedBody) as Record<string, unknown>;
    const oauthError = normalizeString(parsed?.error);
    const description = normalizeString(parsed?.error_description);
    const intervalSeconds = normalizePositiveInteger(parsed?.interval);
    return {
      message: description ?? oauthError ?? `HTTP ${response.status} ${response.statusText}`.trim(),
      oauthError,
      intervalSeconds,
    };
  } catch {
    return {
      message: truncate(normalizedBody),
      oauthError: null,
      intervalSeconds: null,
    };
  }
}

function truncate(value: string, maxLength = 240): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

function normalizeString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function normalizePositiveInteger(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
