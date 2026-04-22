import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

export type CodexCredentialStoreKind = 'secret-tool' | 'encrypted-file';

export interface CodexStoredCredentials {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  accountId: string | null;
  expiresAt: number | null;
  tokenType: string | null;
  scope: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CodexCredentialStore {
  kind: CodexCredentialStoreKind;
  isAvailable(): Promise<boolean>;
  load(accountId: string): Promise<CodexStoredCredentials | null>;
  save(accountId: string, credentials: CodexStoredCredentials, label?: string | null): Promise<void>;
  remove(accountId: string): Promise<boolean>;
}

type CommandRunner = typeof spawnSync;

const SECRET_TOOL_SERVICE = 'codexbridge-codex-account';
const SECRET_TOOL_UNAVAILABLE_MARKERS = [
  'no such file or directory',
  'cannot autolaunch d-bus',
  'org.freedesktop.secrets',
  'service unavailable',
  'connection refused',
  'timed out',
  'not supported',
];

export class SecretToolCodexCredentialStore implements CodexCredentialStore {
  kind: CodexCredentialStoreKind;

  platform: NodeJS.Platform;

  commandRunner: CommandRunner;

  command: string;

  availabilityCache: boolean | null;

  constructor({
    platform = process.platform,
    commandRunner = spawnSync,
    command = 'secret-tool',
  }: {
    platform?: NodeJS.Platform;
    commandRunner?: CommandRunner;
    command?: string;
  } = {}) {
    this.kind = 'secret-tool';
    this.platform = platform;
    this.commandRunner = commandRunner;
    this.command = command;
    this.availabilityCache = null;
  }

  async isAvailable(): Promise<boolean> {
    if (this.platform !== 'linux') {
      return false;
    }
    if (this.availabilityCache !== null) {
      return this.availabilityCache;
    }
    const probe = this.runCommand(['lookup', 'service', SECRET_TOOL_SERVICE, 'account_id', '__codexbridge_probe__']);
    this.availabilityCache = probe.ok || !probe.unavailable;
    return this.availabilityCache;
  }

  async load(accountId: string): Promise<CodexStoredCredentials | null> {
    const result = this.runCommand(['lookup', 'service', SECRET_TOOL_SERVICE, 'account_id', accountId]);
    if (!result.ok) {
      if (result.unavailable) {
        throw new Error(result.message || 'secret-tool is unavailable');
      }
      return null;
    }
    const text = result.stdout.trim();
    if (!text) {
      return null;
    }
    return parseStoredCredentials(text, `secret-tool account ${accountId}`);
  }

  async save(accountId: string, credentials: CodexStoredCredentials, label: string | null = null): Promise<void> {
    const args = ['store'];
    const normalizedLabel = normalizeString(label);
    if (normalizedLabel) {
      args.push(`--label=${normalizedLabel}`);
    }
    args.push('service', SECRET_TOOL_SERVICE, 'account_id', accountId);
    const result = this.runCommand(args, JSON.stringify(credentials));
    if (!result.ok) {
      throw new Error(result.message || `Failed to store credentials for ${accountId} with secret-tool`);
    }
  }

  async remove(accountId: string): Promise<boolean> {
    const result = this.runCommand(['clear', 'service', SECRET_TOOL_SERVICE, 'account_id', accountId]);
    return result.ok;
  }

  runCommand(args: string[], input?: string): {
    ok: boolean;
    stdout: string;
    stderr: string;
    unavailable: boolean;
    message: string;
  } {
    const result = this.commandRunner(this.command, args, {
      encoding: 'utf8',
      input,
      timeout: 2500,
      maxBuffer: 1024 * 1024,
    }) as SpawnSyncReturns<string>;
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    const nodeError = result.error as NodeJS.ErrnoException | undefined;
    const errorMessage = nodeError?.message ?? stderr.trim();
    const unavailable = hasUnavailableMarker(errorMessage) || nodeError?.code === 'ENOENT';
    const ok = result.status === 0;
    return {
      ok,
      stdout,
      stderr,
      unavailable,
      message: errorMessage,
    };
  }
}

export class EncryptedFileCodexCredentialStore implements CodexCredentialStore {
  kind: CodexCredentialStoreKind;

  rootDir: string;

  env: NodeJS.ProcessEnv;

  randomBytesImpl: typeof randomBytes;

  machineIdPaths: string[];

  constructor({
    rootDir,
    env = process.env,
    randomBytesImpl = randomBytes,
    machineIdPaths = ['/etc/machine-id', '/var/lib/dbus/machine-id'],
  }: {
    rootDir: string;
    env?: NodeJS.ProcessEnv;
    randomBytesImpl?: typeof randomBytes;
    machineIdPaths?: string[];
  }) {
    this.kind = 'encrypted-file';
    this.rootDir = path.resolve(rootDir);
    this.env = env;
    this.randomBytesImpl = randomBytesImpl;
    this.machineIdPaths = machineIdPaths;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async load(accountId: string): Promise<CodexStoredCredentials | null> {
    const filePath = this.resolveCredentialPath(accountId);
    try {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      const envelope = JSON.parse(raw);
      if (!isRecord(envelope)) {
        return null;
      }
      const key = await this.deriveKey(await this.readOrCreateSalt());
      const decrypted = decryptEnvelope(envelope, key);
      return parseStoredCredentials(decrypted, filePath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError?.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async save(accountId: string, credentials: CodexStoredCredentials): Promise<void> {
    await fs.promises.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const salt = await this.readOrCreateSalt();
    const key = await this.deriveKey(salt);
    const payload = JSON.stringify(credentials);
    const filePath = this.resolveCredentialPath(accountId);
    const envelope = encryptPayload(payload, key, this.randomBytesImpl);
    await writeTextAtomic(filePath, `${JSON.stringify(envelope, null, 2)}\n`);
  }

  async remove(accountId: string): Promise<boolean> {
    const filePath = this.resolveCredentialPath(accountId);
    try {
      await fs.promises.rm(filePath, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  async readOrCreateSalt(): Promise<Buffer> {
    const saltPath = path.join(this.rootDir, 'vault.salt');
    try {
      return await fs.promises.readFile(saltPath);
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError?.code !== 'ENOENT') {
        throw error;
      }
    }
    await fs.promises.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const salt = this.randomBytesImpl(16);
    await fs.promises.writeFile(saltPath, salt, { mode: 0o600 });
    try {
      await fs.promises.chmod(saltPath, 0o600);
    } catch {}
    return salt;
  }

  async deriveKey(salt: Buffer): Promise<Buffer> {
    const configuredSecret = normalizeString(this.env.CODEXBRIDGE_ACCOUNT_SECRET);
    const machineId = this.readMachineId();
    const fingerprint = [
      configuredSecret,
      machineId,
      os.hostname(),
      os.userInfo().username,
      os.homedir(),
      'codexbridge-codex-auth-v1',
    ].filter(Boolean).join('|');
    return scryptSync(fingerprint, salt, 32);
  }

  readMachineId(): string {
    for (const candidate of this.machineIdPaths) {
      try {
        const value = fs.readFileSync(candidate, 'utf8').trim();
        if (value) {
          return value;
        }
      } catch {}
    }
    return '';
  }

  resolveCredentialPath(accountId: string): string {
    return path.join(this.rootDir, `${Buffer.from(accountId).toString('hex')}.json.enc`);
  }
}

function encryptPayload(
  payload: string,
  key: Buffer,
  randomBytesImpl: typeof randomBytes,
): Record<string, unknown> {
  const iv = randomBytesImpl(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptEnvelope(envelope: Record<string, unknown>, key: Buffer): string {
  const iv = decodeBase64Field(envelope.iv, 'iv');
  const tag = decodeBase64Field(envelope.tag, 'tag');
  const ciphertext = decodeBase64Field(envelope.ciphertext, 'ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

function decodeBase64Field(value: unknown, fieldName: string): Buffer {
  const normalized = normalizeString(value);
  if (!normalized) {
    throw new Error(`Credential envelope is missing ${fieldName}`);
  }
  return Buffer.from(normalized, 'base64');
}

function parseStoredCredentials(raw: string, source: string): CodexStoredCredentials {
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`Stored credentials in ${source} are invalid`);
  }
  const accessToken = normalizeString(parsed.accessToken);
  const refreshToken = normalizeString(parsed.refreshToken);
  if (!accessToken || !refreshToken) {
    throw new Error(`Stored credentials in ${source} are missing accessToken/refreshToken`);
  }
  return {
    accessToken,
    refreshToken,
    idToken: normalizeString(parsed.idToken),
    accountId: normalizeString(parsed.accountId),
    expiresAt: normalizeFiniteNumber(parsed.expiresAt),
    tokenType: normalizeString(parsed.tokenType),
    scope: normalizeString(parsed.scope),
    createdAt: normalizeFiniteNumber(parsed.createdAt) ?? Date.now(),
    updatedAt: normalizeFiniteNumber(parsed.updatedAt) ?? Date.now(),
  };
}

async function writeTextAtomic(filePath: string, text: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tempPath, text, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.promises.chmod(tempPath, 0o600);
  } catch {}
  await fs.promises.rename(tempPath, filePath);
  try {
    await fs.promises.chmod(filePath, 0o600);
  } catch {}
}

function normalizeString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function normalizeFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function hasUnavailableMarker(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return SECRET_TOOL_UNAVAILABLE_MARKERS.some((marker) => normalized.includes(marker));
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
