import { JsonFileStore } from './json_file_store.js';
import type { PluginAlias } from '../../types/core.js';
import type { PluginAliasRepository } from '../../types/repository.js';

export class FileJsonPluginAliasRepository implements PluginAliasRepository {
  constructor(filePath: string) {
    this.store = new JsonFileStore(filePath, []);
  }

  store: JsonFileStore<PluginAlias[]>;

  save(alias: PluginAlias): PluginAlias {
    const records = this.listAll();
    const next = upsertBy(records, alias, (record) =>
      record.platform === alias.platform
      && record.externalScopeId === alias.externalScopeId
      && record.providerProfileId === alias.providerProfileId
      && record.alias === alias.alias,
    );
    this.store.write(next);
    return alias;
  }

  getByAlias(platform: string, externalScopeId: string, providerProfileId: string, alias: string): PluginAlias | null {
    return this.listAll().find((record) =>
      record.platform === platform
      && record.externalScopeId === externalScopeId
      && record.providerProfileId === providerProfileId
      && record.alias === alias,
    ) ?? null;
  }

  delete(platform: string, externalScopeId: string, providerProfileId: string, alias: string): void {
    this.store.write(this.listAll().filter((record) =>
      record.platform !== platform
      || record.externalScopeId !== externalScopeId
      || record.providerProfileId !== providerProfileId
      || record.alias !== alias,
    ));
  }

  listByScope(platform: string, externalScopeId: string, providerProfileId: string): PluginAlias[] {
    return this.listAll().filter((record) =>
      record.platform === platform
      && record.externalScopeId === externalScopeId
      && record.providerProfileId === providerProfileId,
    );
  }

  listAll(): PluginAlias[] {
    return this.store.read();
  }
}

function upsertBy<T>(records: T[], value: T, matcher: (record: T) => boolean) {
  const next = [...records];
  const index = next.findIndex(matcher);
  if (index >= 0) {
    next[index] = value;
    return next;
  }
  next.push(value);
  return next;
}
