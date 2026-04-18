import { formatPlatformScopeKey } from '../../core/contracts.js';
import { JsonFileStore } from './json_file_store.js';
import type { PlatformBinding } from '../../types/repository.js';
import type { PlatformBindingRepository } from '../../types/repository.js';

export class FileJsonPlatformBindingRepository implements PlatformBindingRepository {
  constructor(filePath: string) {
    this.store = new JsonFileStore(filePath, []);
  }

  store: JsonFileStore<PlatformBinding[]>;

  setBinding(binding: PlatformBinding): PlatformBinding {
    const records = this.listAll();
    const scopeKey = formatPlatformScopeKey(binding.platform, binding.externalScopeId);
    const next = upsertBy(records, binding, (record) =>
      formatPlatformScopeKey(record.platform, record.externalScopeId) === scopeKey,
    );
    this.store.write(next);
    return binding;
  }

  getBinding({ platform, externalScopeId }: { platform: string; externalScopeId: string }): PlatformBinding | null {
    const scopeKey = formatPlatformScopeKey(platform, externalScopeId);
    return this.listAll().find((record) =>
      formatPlatformScopeKey(record.platform, record.externalScopeId) === scopeKey,
    ) ?? null;
  }

  listBindingsForSession(bridgeSessionId: string): PlatformBinding[] {
    return this.listAll().filter((record) => record.bridgeSessionId === bridgeSessionId);
  }

  listAll(): PlatformBinding[] {
    return this.store.read();
  }

  getByScope(platform: string, externalScopeId: string): PlatformBinding | null {
    return this.getBinding({ platform, externalScopeId });
  }

  save(binding: PlatformBinding): PlatformBinding {
    return this.setBinding(binding);
  }

  list(): PlatformBinding[] {
    return this.listAll();
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
