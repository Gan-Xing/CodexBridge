import {
  CodexNativeApiServer,
  type CodexNativeApiServerOptions,
} from './native_api_server.js';
import { resolveCodexAuthPath } from './auth_state.js';
import {
  createDefaultCodexNativeProviderBootstrap,
  type ProviderProfileRepositoryLike,
  type ProviderRegistryLike,
} from './default_provider.js';
import { CodexNativeRuntime } from './native_runtime.js';
import type {
  ProviderPluginContract,
  ProviderProfile,
} from './provider.js';

export interface CodexNativeApiServiceOptions {
  runtime?: CodexNativeRuntime;
  providerProfiles?: ProviderProfileRepositoryLike;
  providerRegistry?: ProviderRegistryLike;
  defaultProviderProfileId?: string | null;
  providerProfileId?: string | null;
  authPath?: string | null;
  env?: NodeJS.ProcessEnv;
  host?: CodexNativeApiServerOptions['host'];
  port?: CodexNativeApiServerOptions['port'];
  authToken?: CodexNativeApiServerOptions['authToken'];
  defaultModel?: CodexNativeApiServerOptions['defaultModel'];
  defaultCwd?: CodexNativeApiServerOptions['defaultCwd'];
  defaultLocale?: CodexNativeApiServerOptions['defaultLocale'];
  requestTitlePrefix?: CodexNativeApiServerOptions['requestTitlePrefix'];
  maxBodyBytes?: CodexNativeApiServerOptions['maxBodyBytes'];
  continuationRegistry?: CodexNativeApiServerOptions['continuationRegistry'];
  continuationTtlMs?: CodexNativeApiServerOptions['continuationTtlMs'];
  now?: CodexNativeApiServerOptions['now'];
  createResponseId?: CodexNativeApiServerOptions['createResponseId'];
}

export interface CodexNativeApiServiceBinding {
  providerProfileId: string;
  providerKind: string;
  providerDisplayName: string;
  authPath: string | null;
}

export class CodexNativeApiService {
  private readonly providerProfiles: ProviderProfileRepositoryLike;

  private readonly providerRegistry: ProviderRegistryLike;

  private readonly defaultProviderProfileId: string | null;

  private readonly requestedProviderProfileId: string | null;

  private readonly authPath: string | null;

  private readonly env: NodeJS.ProcessEnv;

  private readonly server: CodexNativeApiServer;

  constructor({
    runtime = new CodexNativeRuntime(),
    providerProfiles,
    providerRegistry,
    defaultProviderProfileId = null,
    providerProfileId = null,
    authPath = null,
    env = process.env,
    host,
    port,
    authToken,
    defaultModel,
    defaultCwd,
    defaultLocale,
    requestTitlePrefix,
    maxBodyBytes,
    continuationRegistry,
    continuationTtlMs,
    now,
    createResponseId,
  }: CodexNativeApiServiceOptions) {
    const bootstrap = createDefaultCodexNativeProviderBootstrap(env);
    this.providerProfiles = providerProfiles ?? bootstrap.providerProfiles;
    this.providerRegistry = providerRegistry ?? bootstrap.providerRegistry;
    this.defaultProviderProfileId = normalizeString(defaultProviderProfileId)
      || normalizeString(bootstrap.defaultProviderProfileId)
      || null;
    this.requestedProviderProfileId = normalizeString(providerProfileId) || null;
    this.authPath = normalizeString(authPath) || null;
    this.env = env;
    this.server = new CodexNativeApiServer({
      runtime,
      resolveRuntimeContext: () => {
        const providerProfile = this.resolveProviderProfile();
        return {
          providerProfile,
          providerPlugin: this.resolveProviderPlugin(providerProfile.providerKind),
          authPathOrOptions: this.authPath
            ? { authPath: this.authPath, env: this.env }
            : { env: this.env },
        };
      },
      host,
      port,
      authToken,
      defaultModel,
      defaultCwd,
      defaultLocale,
      requestTitlePrefix,
      maxBodyBytes,
      continuationRegistry,
      continuationTtlMs,
      now,
      createResponseId,
    });
  }

  get baseUrl(): string {
    return this.server.baseUrl;
  }

  describeBinding(): CodexNativeApiServiceBinding {
    const providerProfile = this.resolveProviderProfile();
    return {
      providerProfileId: providerProfile.id,
      providerKind: providerProfile.providerKind,
      providerDisplayName: providerProfile.displayName,
      authPath: this.authPath ?? resolveCodexAuthPath(this.env),
    };
  }

  async start(): Promise<CodexNativeApiServiceBinding> {
    const binding = this.describeBinding();
    if (!this.resolveProviderPlugin(binding.providerKind)) {
      throw new Error(`Codex native API provider plugin is unavailable for kind: ${binding.providerKind}`);
    }
    await this.server.start();
    return binding;
  }

  async stop(): Promise<void> {
    await this.server.stop();
  }

  private resolveProviderProfile(): ProviderProfile {
    const availableProfiles = this.providerProfiles.list();
    if (availableProfiles.length === 0) {
      throw new Error('Codex native API service cannot start without any configured provider profiles.');
    }
    const selectedProfileId = this.requestedProviderProfileId
      ?? this.defaultProviderProfileId
      ?? availableProfiles[0]?.id
      ?? null;
    if (!selectedProfileId) {
      throw new Error('Codex native API service could not determine a provider profile.');
    }
    const providerProfile = this.providerProfiles.get(selectedProfileId);
    if (!providerProfile) {
      throw new Error(`Unknown Codex native API provider profile: ${selectedProfileId}`);
    }
    return providerProfile;
  }

  private resolveProviderPlugin(providerKind: string): ProviderPluginContract | null {
    try {
      return this.providerRegistry.getProvider(providerKind);
    } catch {
      return null;
    }
  }
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
