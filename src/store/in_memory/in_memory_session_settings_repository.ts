import type { SessionSettings } from '../../types/core.js';
import type { SessionSettingsRepository } from '../../types/repository.js';

export class InMemorySessionSettingsRepository implements SessionSettingsRepository {
  constructor() {
    this.records = new Map();
  }

  records: Map<string, SessionSettings>;

  save(settings: SessionSettings): SessionSettings {
    this.records.set(settings.bridgeSessionId, settings);
    return settings;
  }

  get(bridgeSessionId: string): SessionSettings | null {
    return this.records.get(bridgeSessionId) ?? null;
  }

  getByBridgeSessionId(bridgeSessionId: string): SessionSettings | null {
    return this.get(bridgeSessionId);
  }
}
