export class InMemorySessionSettingsRepository {
  constructor() {
    this.records = new Map();
  }

  save(settings) {
    this.records.set(settings.bridgeSessionId, settings);
    return settings;
  }

  get(bridgeSessionId) {
    return this.records.get(bridgeSessionId) ?? null;
  }
}
