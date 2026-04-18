import { NotFoundError } from '../core/errors.js';

interface PlatformPluginLike {
  id: string;
}

interface ProviderPluginLike {
  kind: string;
}

export class PluginRegistry {
  private readonly platforms: Map<string, PlatformPluginLike>;

  private readonly providers: Map<string, ProviderPluginLike>;

  constructor() {
    this.platforms = new Map();
    this.providers = new Map();
  }

  registerPlatform(plugin: PlatformPluginLike): void {
    this.platforms.set(plugin.id, plugin);
  }

  registerProvider(plugin: ProviderPluginLike): void {
    this.providers.set(plugin.kind, plugin);
  }

  getPlatform<T extends PlatformPluginLike>(platformId: string): T {
    const plugin = this.platforms.get(platformId);
    if (!plugin) {
      throw new NotFoundError(`Unknown platform plugin: ${platformId}`);
    }
    return plugin as T;
  }

  getProvider<T extends ProviderPluginLike>(providerKind: string): T {
    const plugin = this.providers.get(providerKind);
    if (!plugin) {
      throw new NotFoundError(`Unknown provider plugin: ${providerKind}`);
    }
    return plugin as T;
  }

  listPlatforms<T extends PlatformPluginLike>(): T[] {
    return [...this.platforms.values()] as T[];
  }

  listProviders<T extends ProviderPluginLike>(): T[] {
    return [...this.providers.values()] as T[];
  }
}

