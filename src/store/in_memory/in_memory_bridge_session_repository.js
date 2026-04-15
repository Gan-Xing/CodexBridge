export class InMemoryBridgeSessionRepository {
  constructor() {
    this.records = new Map();
  }

  save(session) {
    this.records.set(session.id, session);
    return session;
  }

  get(id) {
    return this.records.get(id) ?? null;
  }

  getByProviderThread(providerProfileId, codexThreadId) {
    return this.list().find((session) =>
      session.providerProfileId === providerProfileId && session.codexThreadId === codexThreadId,
    ) ?? null;
  }

  listByProviderProfileId(providerProfileId) {
    return this.list().filter((session) => session.providerProfileId === providerProfileId);
  }

  list() {
    return [...this.records.values()];
  }
}
