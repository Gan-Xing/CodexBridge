import { JsonFileStore } from './json_file_store.js';
import type { SessionSettings } from '../../types/core.js';
import type { SessionSettingsRepository } from '../../types/repository.js';

export class FileJsonSessionSettingsRepository implements SessionSettingsRepository {
  constructor(filePath: string) {
    this.store = new JsonFileStore(filePath, []);
  }

  store: JsonFileStore<SessionSettings[]>;

  save(settings: SessionSettings): SessionSettings {
    const records = this.listAll();
    const next = upsertBy(records, settings, (record) => record.bridgeSessionId === settings.bridgeSessionId);
    this.store.write(next);
    return settings;
  }

  get(bridgeSessionId: string): SessionSettings | null {
    return this.listAll().find((record) => record.bridgeSessionId === bridgeSessionId) ?? null;
  }

  listAll(): SessionSettings[] {
    return this.store.read();
  }

  getByBridgeSessionId(bridgeSessionId: string): SessionSettings | null {
    return this.get(bridgeSessionId);
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
