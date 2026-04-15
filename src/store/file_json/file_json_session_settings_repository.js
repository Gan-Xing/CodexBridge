import { JsonFileStore } from './json_file_store.js';

export class FileJsonSessionSettingsRepository {
  constructor(filePath) {
    this.store = new JsonFileStore(filePath, []);
  }

  save(settings) {
    const records = this.listAll();
    const next = upsertBy(records, settings, (record) => record.bridgeSessionId === settings.bridgeSessionId);
    this.store.write(next);
    return settings;
  }

  get(bridgeSessionId) {
    return this.listAll().find((record) => record.bridgeSessionId === bridgeSessionId) ?? null;
  }

  listAll() {
    return this.store.read();
  }
}

function upsertBy(records, value, matcher) {
  const next = [...records];
  const index = next.findIndex(matcher);
  if (index >= 0) {
    next[index] = value;
    return next;
  }
  next.push(value);
  return next;
}
