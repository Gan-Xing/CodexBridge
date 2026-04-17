export class InMemoryThreadMetadataRepository {
  constructor() {
    this.records = new Map();
  }

  save(metadata) {
    this.records.set(buildMetadataKey(metadata.providerProfileId, metadata.threadId), metadata);
    return metadata;
  }

  get(providerProfileId, threadId) {
    return this.records.get(buildMetadataKey(providerProfileId, threadId)) ?? null;
  }

  listByProviderProfileId(providerProfileId) {
    return [...this.records.values()].filter((record) => record.providerProfileId === providerProfileId);
  }
}

function buildMetadataKey(providerProfileId, threadId) {
  return `${providerProfileId}:${threadId}`;
}
