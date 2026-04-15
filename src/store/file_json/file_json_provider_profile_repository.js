import { JsonFileStore } from './json_file_store.js';

export class FileJsonProviderProfileRepository {
  constructor(filePath) {
    this.store = new JsonFileStore(filePath, []);
  }

  save(profile) {
    const records = this.list();
    const next = upsertBy(records, profile, (record) => record.id === profile.id);
    this.store.write(next);
    return profile;
  }

  get(id) {
    return this.list().find((record) => record.id === id) ?? null;
  }

  list() {
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
