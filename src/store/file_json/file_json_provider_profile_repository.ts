import { JsonFileStore } from './json_file_store.js';
import type { ProviderProfile } from '../../types/provider.js';
import type { ProviderProfileRepository } from '../../types/repository.js';

export class FileJsonProviderProfileRepository implements ProviderProfileRepository {
  constructor(filePath: string) {
    this.store = new JsonFileStore(filePath, []);
  }

  store: JsonFileStore<ProviderProfile[]>;

  save(profile: ProviderProfile): ProviderProfile {
    const records = this.list();
    const next = upsertBy(records, profile, (record) => record.id === profile.id);
    this.store.write(next);
    return profile;
  }

  get(id: string): ProviderProfile | null {
    return this.list().find((record) => record.id === id) ?? null;
  }

  list(): ProviderProfile[] {
    return this.store.read();
  }

  getById(id: string): ProviderProfile | null {
    return this.get(id);
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
