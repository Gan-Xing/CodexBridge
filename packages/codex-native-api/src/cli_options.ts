export interface ServeCliOptions {
  host: string | null;
  port: number | null;
  authPath: string | null;
  authToken: string | null;
  cwd: string | null;
  providerProfileId: string | null;
  defaultModel: string | null;
  publicBind: boolean;
}

export function parseServeCliArgs(args: string[]): ServeCliOptions {
  const options: ServeCliOptions = {
    host: null,
    port: null,
    authPath: null,
    authToken: null,
    cwd: null,
    providerProfileId: null,
    defaultModel: null,
    publicBind: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if ((arg === '--host' || arg === '-h') && next) {
      options.host = next;
      index += 1;
      continue;
    }
    if (arg === '--public') {
      options.publicBind = true;
      continue;
    }
    if ((arg === '--port' || arg === '-p') && next) {
      options.port = parsePort(next);
      index += 1;
      continue;
    }
    if (arg === '--auth-path' && next) {
      options.authPath = next;
      index += 1;
      continue;
    }
    if (arg === '--auth-token' && next) {
      options.authToken = next;
      index += 1;
      continue;
    }
    if (arg === '--cwd' && next) {
      options.cwd = next;
      index += 1;
      continue;
    }
    if (arg === '--provider-profile' && next) {
      options.providerProfileId = next;
      index += 1;
      continue;
    }
    if (arg === '--default-model' && next) {
      options.defaultModel = next;
      index += 1;
      continue;
    }
  }

  return options;
}

export function parsePort(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseOptionalSeconds(value: string | null | undefined): number | null {
  const parsed = Number.parseFloat(String(value ?? '').trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function parseOptionalBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

export function normalizeServeHost(options: Pick<ServeCliOptions, 'host' | 'publicBind'>): string | null {
  return options.host ?? (options.publicBind ? '0.0.0.0' : null);
}

export function isLoopbackHost(value: string | null): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '' || normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}
