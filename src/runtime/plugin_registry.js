import { NotFoundError } from '../core/errors.js';

export class PluginRegistry {
  constructor() {
    this.platforms = new Map();
    this.providers = new Map();
  }

  registerPlatform(plugin) {
    this.platforms.set(plugin.id, plugin);
  }

  registerProvider(plugin) {
    this.providers.set(plugin.kind, plugin);
  }

  getPlatform(platformId) {
    const plugin = this.platforms.get(platformId);
    if (!plugin) {
      throw new NotFoundError(`Unknown platform plugin: ${platformId}`);
    }
    return plugin;
  }

  getProvider(providerKind) {
    const plugin = this.providers.get(providerKind);
    if (!plugin) {
      throw new NotFoundError(`Unknown provider plugin: ${providerKind}`);
    }
    return plugin;
  }

  listPlatforms() {
    return [...this.platforms.values()];
  }

  listProviders() {
    return [...this.providers.values()];
  }
}
