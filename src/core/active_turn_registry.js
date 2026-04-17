import { formatPlatformScopeKey } from './contracts.js';

export class ActiveTurnRegistry {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.scopeTurns = new Map();
  }

  resolveScopeTurn(scopeRef) {
    return this.scopeTurns.get(buildScopeKey(scopeRef)) ?? null;
  }

  beginScopeTurn(scopeRef, initial = {}) {
    const scopeKey = buildScopeKey(scopeRef);
    if (this.scopeTurns.has(scopeKey)) {
      throw new Error(`Active turn already exists for ${scopeKey}`);
    }
    const now = this.now();
    const record = {
      scopeRef: {
        platform: scopeRef.platform,
        externalScopeId: scopeRef.externalScopeId,
      },
      bridgeSessionId: initial.bridgeSessionId ?? null,
      providerProfileId: initial.providerProfileId ?? null,
      threadId: initial.threadId ?? null,
      turnId: initial.turnId ?? null,
      interruptRequested: false,
      interruptDispatched: false,
      createdAt: now,
      updatedAt: now,
    };
    this.scopeTurns.set(scopeKey, record);
    return record;
  }

  updateScopeTurn(scopeRef, updates = {}) {
    const record = this.resolveScopeTurn(scopeRef);
    if (!record) {
      return null;
    }
    Object.assign(record, updates, {
      updatedAt: this.now(),
    });
    return record;
  }

  requestInterrupt(scopeRef) {
    return this.updateScopeTurn(scopeRef, {
      interruptRequested: true,
    });
  }

  noteInterruptDispatched(scopeRef, value = true) {
    return this.updateScopeTurn(scopeRef, {
      interruptDispatched: value,
    });
  }

  endScopeTurn(scopeRef) {
    const scopeKey = buildScopeKey(scopeRef);
    const record = this.scopeTurns.get(scopeKey) ?? null;
    this.scopeTurns.delete(scopeKey);
    return record;
  }
}

function buildScopeKey(scopeRef) {
  return formatPlatformScopeKey(scopeRef.platform, scopeRef.externalScopeId);
}
