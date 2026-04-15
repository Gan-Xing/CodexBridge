import { formatPlatformScopeKey } from '../../core/contracts.js';

export class InMemoryPlatformBindingRepository {
  constructor() {
    this.records = new Map();
  }

  setBinding(binding) {
    this.records.set(formatPlatformScopeKey(binding.platform, binding.externalScopeId), binding);
    return binding;
  }

  getBinding({ platform, externalScopeId }) {
    return this.records.get(formatPlatformScopeKey(platform, externalScopeId)) ?? null;
  }

  listBindingsForSession(bridgeSessionId) {
    return [...this.records.values()].filter((binding) => binding.bridgeSessionId === bridgeSessionId);
  }
}
