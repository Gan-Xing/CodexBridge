import type { PluginAlias } from '../../types/core.js';
import type { PluginAliasRepository } from '../../types/repository.js';

export class InMemoryPluginAliasRepository implements PluginAliasRepository {
  constructor() {
    this.records = new Map();
  }

  records: Map<string, PluginAlias>;

  save(alias: PluginAlias): PluginAlias {
    this.records.set(buildAliasKey(alias.platform, alias.externalScopeId, alias.providerProfileId, alias.alias), alias);
    return alias;
  }

  getByAlias(platform: string, externalScopeId: string, providerProfileId: string, alias: string): PluginAlias | null {
    return this.records.get(buildAliasKey(platform, externalScopeId, providerProfileId, alias)) ?? null;
  }

  delete(platform: string, externalScopeId: string, providerProfileId: string, alias: string): void {
    this.records.delete(buildAliasKey(platform, externalScopeId, providerProfileId, alias));
  }

  listByScope(platform: string, externalScopeId: string, providerProfileId: string): PluginAlias[] {
    return [...this.records.values()].filter((record) =>
      record.platform === platform
      && record.externalScopeId === externalScopeId
      && record.providerProfileId === providerProfileId,
    );
  }
}

function buildAliasKey(platform: string, externalScopeId: string, providerProfileId: string, alias: string) {
  return `${platform}:${externalScopeId}:${providerProfileId}:${alias}`;
}
