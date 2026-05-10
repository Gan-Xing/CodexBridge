import fs from 'node:fs';
import path from 'node:path';
import { CodexAppClient, createStderrLogger, type CodexTurnInput } from './codex_app_client.js';
import { readCodexAccountIdentity } from './auth_state.js';
import type {
  ProviderApprovalRequest,
  ProviderModelInfo,
  ProviderPluginContract,
  ProviderProfile,
  ProviderThreadListResult,
  ProviderThreadSummary,
  ProviderThreadStartResult,
  ProviderTurnAttachment,
  ProviderTurnEvent,
  ProviderTurnProgress,
  ProviderTurnResult,
  ProviderTurnSession,
  ProviderTurnSessionSettings,
} from './provider.js';

export interface DefaultCodexProviderProfileConfig extends Record<string, unknown> {
  cliBin: string;
  launchCommand?: string | null;
  autolaunch?: boolean;
  codexCliArgs?: string[];
  modelCatalog?: unknown[];
  modelCatalogMode?: 'merge' | 'overlay-only';
  defaultModel?: string | null;
}

export type DefaultCodexProviderProfile = ProviderProfile & {
  config: DefaultCodexProviderProfileConfig;
};

export interface ProviderProfileRepositoryLike {
  get(id: string): ProviderProfile | null | undefined;
  list(): ProviderProfile[];
}

export interface ProviderRegistryLike {
  getProvider<T extends ProviderPluginContract>(providerKind: string): T;
}

export interface DefaultCodexNativeProviderBootstrap {
  providerProfiles: ProviderProfileRepositoryLike;
  providerRegistry: ProviderRegistryLike;
  defaultProviderProfileId: string;
}

interface DefaultCodexProviderPluginOptions {
  clientFactory?: (profile: DefaultCodexProviderProfile) => CodexAppClient;
}

const DEFAULT_PROVIDER_PROFILE_ID = 'openai-default';
const DEFAULT_PROVIDER_KIND = 'openai-native';
const DEFAULT_PROVIDER_DISPLAY_NAME = 'Codex OpenAI';

const DEFAULT_NATIVE_API_DEVELOPER_INSTRUCTIONS = [
  'codex-native-api runtime constraints:',
  '- This turn is running through a localhost API facade over the logged-in Codex runtime.',
  '- codex-native-api owns request and continuation lifecycle for this API session.',
  '- Do not assume any chat-platform wrapper, slash-command UX, or external delivery layer exists.',
].join('\n');

function joinDeveloperInstructions(...blocks: Array<string | null | undefined>): string {
  return blocks
    .map((block) => normalizeOptionalString(block))
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export class InMemoryProviderProfileRepository implements ProviderProfileRepositoryLike {
  constructor(private readonly profiles: ProviderProfile[]) {}

  get(id: string): ProviderProfile | null {
    return this.profiles.find((profile) => profile.id === id) ?? null;
  }

  list(): ProviderProfile[] {
    return [...this.profiles];
  }
}

export class SingleProviderRegistry implements ProviderRegistryLike {
  constructor(private readonly providerPlugin: ProviderPluginContract) {}

  getProvider<T extends ProviderPluginContract>(providerKind: string): T {
    if (providerKind !== this.providerPlugin.kind) {
      throw new Error(`Unknown provider kind: ${providerKind}`);
    }
    return this.providerPlugin as T;
  }
}

export class DefaultCodexNativeProviderPlugin implements ProviderPluginContract {
  kind = DEFAULT_PROVIDER_KIND;

  displayName = DEFAULT_PROVIDER_DISPLAY_NAME;

  private readonly clientFactory: (profile: DefaultCodexProviderProfile) => CodexAppClient;

  private readonly clients = new Map<string, CodexAppClient>();

  constructor({
    clientFactory = (profile) => new CodexAppClient({
      codexCliBin: profile.config.cliBin,
      codexCliArgs: profile.config.codexCliArgs ?? [],
      launchCommand: profile.config.launchCommand ?? null,
      autolaunch: profile.config.autolaunch ?? false,
      modelCatalog: Array.isArray(profile.config.modelCatalog) ? profile.config.modelCatalog as any[] : [],
      modelCatalogMode: profile.config.modelCatalogMode ?? 'merge',
      logger: createStderrLogger(),
    }),
  }: DefaultCodexProviderPluginOptions = {}) {
    this.clientFactory = clientFactory;
  }

  async startThread({
    providerProfile,
    cwd = null,
    title = null,
    ephemeral = null,
  }: {
    providerProfile: ProviderProfile;
    cwd?: string | null;
    title?: string | null;
    ephemeral?: boolean | null;
    metadata?: Record<string, unknown>;
  }): Promise<ProviderThreadStartResult> {
    const client = await this.ensureClient(providerProfile);
    const modelInfo = await this.resolveModelInfo(providerProfile, client, null);
    return client.startThread({
      cwd,
      title,
      model: modelInfo?.model ?? null,
      ephemeral,
    });
  }

  async readThread({
    providerProfile,
    threadId,
    includeTurns = false,
  }: {
    providerProfile: ProviderProfile;
    threadId: string;
    includeTurns?: boolean;
  }): Promise<ProviderThreadSummary | null> {
    const client = await this.ensureClient(providerProfile);
    return client.readThread(threadId, includeTurns);
  }

  async listThreads({
    providerProfile,
    limit = 20,
    cursor = null,
    searchTerm = null,
    archived = false,
  }: {
    providerProfile: ProviderProfile;
    limit?: number;
    cursor?: string | null;
    searchTerm?: string | null;
    archived?: boolean | null;
  }): Promise<ProviderThreadListResult> {
    const client = await this.ensureClient(providerProfile);
    return client.listThreads({ limit, cursor, searchTerm, archived: Boolean(archived) });
  }

  async startTurn({
    providerProfile,
    bridgeSession,
    sessionSettings,
    event,
    inputText,
    developerInstructions = null,
    onProgress = null,
    onTurnStarted = null,
    onApprovalRequest = null,
  }: {
    providerProfile: ProviderProfile;
    bridgeSession: ProviderTurnSession;
    sessionSettings: ProviderTurnSessionSettings | null;
    event: ProviderTurnEvent;
    inputText: string;
    developerInstructions?: string | null;
    onProgress?: ((progress: ProviderTurnProgress) => Promise<void> | void) | null;
    onTurnStarted?: ((meta: Record<string, unknown>) => Promise<void> | void) | null;
    onApprovalRequest?: ((request: ProviderApprovalRequest) => Promise<void> | void) | null;
  }): Promise<ProviderTurnResult> {
    const client = await this.ensureClient(providerProfile);
    const modelInfo = await this.resolveModelInfo(
      providerProfile,
      client,
      sessionSettings?.model ?? null,
    );
    const turnInput = buildCodexTurnInput(event, inputText);
    return client.startTurn({
      threadId: bridgeSession.codexThreadId,
      inputText: turnInput[0]?.type === 'text' ? turnInput[0].text : inputText,
      input: turnInput,
      cwd: bridgeSession.cwd ?? event.cwd ?? null,
      model: modelInfo?.model ?? null,
      effort: normalizeOptionalString(sessionSettings?.reasoningEffort ?? null),
      serviceTier: normalizeCodexServiceTier(sessionSettings?.serviceTier ?? null),
      personality: normalizeCodexPersonality(sessionSettings?.personality ?? null),
      approvalPolicy: sessionSettings?.approvalPolicy ?? 'on-request',
      sandboxMode: sessionSettings?.sandboxMode ?? 'workspace-write',
      collaborationMode: normalizeCodexCollaborationMode(sessionSettings?.collaborationMode ?? null),
      developerInstructions: joinDeveloperInstructions(
        DEFAULT_NATIVE_API_DEVELOPER_INSTRUCTIONS,
        developerInstructions,
      ),
      onProgress,
      onTurnStarted,
      onApprovalRequest,
    });
  }

  async reconnectProfile({
    providerProfile,
  }: {
    providerProfile: ProviderProfile;
  }): Promise<Record<string, unknown>> {
    const previousClient = this.clients.get(providerProfile.id) ?? null;
    if (previousClient) {
      this.clients.delete(providerProfile.id);
      await previousClient.stop();
    }
    const client = this.clientFactory(providerProfile as DefaultCodexProviderProfile);
    this.clients.set(providerProfile.id, client);
    await client.start();
    return {
      connected: client.isConnected(),
      accountIdentity: readCodexAccountIdentity(),
    };
  }

  async listModels({
    providerProfile,
  }: {
    providerProfile: ProviderProfile;
  }): Promise<ProviderModelInfo[]> {
    const client = await this.ensureClient(providerProfile);
    return client.listModels();
  }

  async stop(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map((client) => client.stop()));
  }

  private async ensureClient(providerProfile: ProviderProfile): Promise<CodexAppClient> {
    let client = this.clients.get(providerProfile.id) ?? null;
    if (!client) {
      client = this.clientFactory(providerProfile as DefaultCodexProviderProfile);
      this.clients.set(providerProfile.id, client);
    }
    await client.start();
    return client;
  }

  private async resolveModelInfo(
    providerProfile: ProviderProfile,
    client: CodexAppClient,
    requestedModel: string | null,
  ): Promise<ProviderModelInfo | null> {
    if (requestedModel) {
      return {
        id: requestedModel,
        model: requestedModel,
        displayName: requestedModel,
        description: '',
        isDefault: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
      };
    }
    const config = providerProfile.config as DefaultCodexProviderProfileConfig;
    if (config.defaultModel) {
      return {
        id: config.defaultModel,
        model: config.defaultModel,
        displayName: config.defaultModel,
        description: '',
        isDefault: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
      };
    }
    const models = await client.listModels();
    return models.find((model) => model.isDefault) ?? models[0] ?? null;
  }
}

export function createDefaultCodexNativeProviderBootstrap(
  env: NodeJS.ProcessEnv = process.env,
  {
    platform = process.platform,
    cwd = process.cwd(),
  }: {
    platform?: NodeJS.Platform;
    cwd?: string;
  } = {},
): DefaultCodexNativeProviderBootstrap {
  const profile = loadDefaultCodexNativeProviderProfile(env, { platform, cwd });
  const providerPlugin = new DefaultCodexNativeProviderPlugin();
  return {
    providerProfiles: new InMemoryProviderProfileRepository([profile]),
    providerRegistry: new SingleProviderRegistry(providerPlugin),
    defaultProviderProfileId: profile.id,
  };
}

export function loadDefaultCodexNativeProviderProfile(
  env: NodeJS.ProcessEnv = process.env,
  {
    platform = process.platform,
    cwd = process.cwd(),
  }: {
    platform?: NodeJS.Platform;
    cwd?: string;
  } = {},
): DefaultCodexProviderProfile {
  const codexCliBin = resolveConfiguredCommand(normalizeOptionalString(env.CODEX_REAL_BIN), {
    platform,
    env,
    cwd,
  }) ?? resolveCommand('codex', {
    platform,
    env,
    cwd,
  }) ?? 'codex';
  const now = Date.now();
  return {
    id: DEFAULT_PROVIDER_PROFILE_ID,
    providerKind: DEFAULT_PROVIDER_KIND,
    displayName: DEFAULT_PROVIDER_DISPLAY_NAME,
    config: {
      cliBin: codexCliBin,
      launchCommand: normalizeOptionalString(env.CODEX_APP_LAUNCH_CMD),
      autolaunch: parseBoolean(env.CODEX_APP_AUTOLAUNCH, false),
      codexCliArgs: parseCommandArgs(env.CODEX_CLI_ARGS),
      modelCatalog: [],
      modelCatalogMode: 'merge',
      defaultModel: normalizeOptionalString(env.CODEX_DEFAULT_MODEL),
    },
    createdAt: now,
    updatedAt: now,
  };
}

function buildCodexTurnInput(event: ProviderTurnEvent, inputText: string): CodexTurnInput[] {
  const attachments = Array.isArray(event.attachments) ? event.attachments : [];
  const normalizedInputText = String(inputText ?? '').trim();
  if (attachments.length === 0) {
    return [{
      type: 'text',
      text: normalizedInputText,
      text_elements: [],
    }];
  }

  const textPrompt = buildAttachmentPrompt(normalizedInputText, attachments);
  const input: CodexTurnInput[] = [{
    type: 'text',
    text: textPrompt,
    text_elements: [],
  }];
  for (const attachment of attachments) {
    if (attachment.kind !== 'image') {
      continue;
    }
    input.push({
      type: 'localImage',
      path: attachment.localPath,
    });
  }
  return input;
}

function buildAttachmentPrompt(userText: string, attachments: readonly ProviderTurnAttachment[]): string {
  const normalizedText = String(userText ?? '').trim();
  const lines: string[] = [];
  if (normalizedText) {
    lines.push(normalizedText, '');
  } else {
    lines.push('User sent attachments without additional text.', '');
  }
  lines.push('Attachments:');
  attachments.forEach((attachment, index) => {
    lines.push(`${index + 1}. ${describeAttachment(attachment)}`);
    lines.push(`   path: ${attachment.localPath}`);
    if (attachment.fileName) {
      lines.push(`   filename: ${attachment.fileName}`);
    }
    if (attachment.mimeType) {
      lines.push(`   mime: ${attachment.mimeType}`);
    }
    if (typeof attachment.durationSeconds === 'number' && Number.isFinite(attachment.durationSeconds)) {
      lines.push(`   duration_seconds: ${attachment.durationSeconds}`);
    }
    if (attachment.transcriptText) {
      lines.push(`   transcript_hint: ${attachment.transcriptText}`);
    }
    if (attachment.kind === 'image') {
      lines.push('   attached_as: localImage');
    }
  });
  lines.push('', 'Use the local file paths above when you inspect these attachments.');
  return lines.join('\n');
}

function describeAttachment(attachment: ProviderTurnAttachment): string {
  switch (attachment.kind) {
    case 'image':
      return 'image';
    case 'voice':
      return 'voice message';
    case 'file':
      return 'file';
    case 'video':
      return 'video';
    default:
      return 'attachment';
  }
}

function normalizeOptionalString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return String(value).trim() !== 'false' && String(value).trim() !== '0';
}

function parseCommandArgs(value: unknown): string[] {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return [];
  }
  return normalized.split(/\s+/u).filter(Boolean);
}

function normalizeCodexPersonality(value: unknown): 'friendly' | 'pragmatic' | 'none' | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'friendly' || normalized === 'pragmatic' || normalized === 'none') {
    return normalized;
  }
  return null;
}

function normalizeCodexServiceTier(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ?? null;
}

function normalizeCodexCollaborationMode(value: string | null | undefined): 'default' | 'plan' {
  return normalizeOptionalString(value) === 'plan' ? 'plan' : 'default';
}

function resolveConfiguredCommand(
  configuredCommand: string | null,
  options: {
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    cwd: string;
  },
): string | null {
  const normalized = normalizeOptionalString(configuredCommand);
  if (!normalized) {
    return null;
  }
  return resolveExplicitCommandPath(normalized, options);
}

function resolveCommand(
  command: string,
  {
    platform = process.platform,
    env = process.env,
    cwd = process.cwd(),
  }: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  } = {},
): string | null {
  const normalizedCommand = normalizeOptionalString(command);
  if (!normalizedCommand) {
    return null;
  }
  const explicit = resolveExplicitCommandPath(normalizedCommand, {
    platform,
    env,
    cwd,
  });
  if (explicit) {
    return explicit;
  }
  if (hasPathSeparator(normalizedCommand)) {
    return null;
  }
  const pathEntries = splitPathEntries(env.PATH ?? '');
  const suffixes = resolveCommandSuffixes(platform, env, normalizedCommand);
  for (const entry of pathEntries) {
    for (const suffix of suffixes) {
      const candidate = path.join(entry, `${normalizedCommand}${suffix}`);
      if (isCommandFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function resolveExplicitCommandPath(
  command: string,
  {
    platform,
    env,
    cwd,
  }: {
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    cwd: string;
  },
): string | null {
  const expandedHome = command.startsWith('~')
    ? path.join(env.HOME ?? '', command.slice(1))
    : command;
  const resolved = path.isAbsolute(expandedHome)
    ? expandedHome
    : path.resolve(cwd, expandedHome);
  if (isCommandFile(resolved)) {
    return resolved;
  }
  if (platform === 'win32' && !path.extname(resolved)) {
    for (const extension of resolveWindowsExecutableExtensions(env)) {
      const candidate = `${resolved}${extension}`;
      if (isCommandFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function splitPathEntries(pathValue: string): string[] {
  return pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveCommandSuffixes(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  command: string,
): string[] {
  if (platform !== 'win32') {
    return [''];
  }
  if (path.extname(command)) {
    return [''];
  }
  return resolveWindowsExecutableExtensions(env);
}

function resolveWindowsExecutableExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = normalizeOptionalString(env.PATHEXT)
    ?? '.COM;.EXE;.BAT;.CMD';
  return raw
    .split(';')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function hasPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

function isCommandFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}
