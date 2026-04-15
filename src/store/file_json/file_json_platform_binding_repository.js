import { formatPlatformScopeKey } from '../../core/contracts.js';
import { JsonFileStore } from './json_file_store.js';

export class FileJsonPlatformBindingRepository {
  constructor(filePath) {
    this.store = new JsonFileStore(filePath, []);
  }

  setBinding(binding) {
    const records = this.listAll();
    const scopeKey = formatPlatformScopeKey(binding.platform, binding.externalScopeId);
    const next = upsertBy(records, binding, (record) =>
      formatPlatformScopeKey(record.platform, record.externalScopeId) === scopeKey,
    );
    this.store.write(next);
    return binding;
  }

  getBinding({ platform, externalScopeId }) {
    const scopeKey = formatPlatformScopeKey(platform, externalScopeId);
    return this.listAll().find((record) =>
      formatPlatformScopeKey(record.platform, record.externalScopeId) === scopeKey,
    ) ?? null;
  }

  listBindingsForSession(bridgeSessionId) {
    return this.listAll().filter((record) => record.bridgeSessionId === bridgeSessionId);
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
