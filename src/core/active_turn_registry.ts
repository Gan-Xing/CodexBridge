import { formatPlatformScopeKey } from './contracts.js';
import type { PlatformScopeRef } from '../types/core.js';

interface ActiveTurnRecord {
  scopeRef: PlatformScopeRef;
  bridgeSessionId: string | null;
  providerProfileId: string | null;
  threadId: string | null;
  turnId: string | null;
  interruptRequested: boolean;
  interruptDispatched: boolean;
  createdAt: number;
  updatedAt: number;
}

interface BeginScopeTurnOptions {
  bridgeSessionId?: string | null;
  providerProfileId?: string | null;
  threadId?: string | null;
  turnId?: string | null;
}

interface ActiveTurnRegistryOptions {
  now?: () => number;
}

export class ActiveTurnRegistry {
  private readonly now: () => number;

  private readonly scopeTurns: Map<string, ActiveTurnRecord>;

  constructor({ now = () => Date.now() }: ActiveTurnRegistryOptions = {}) {
    this.now = now;
    this.scopeTurns = new Map();
  }

  resolveScopeTurn(scopeRef: PlatformScopeRef): ActiveTurnRecord | null {
    return this.scopeTurns.get(buildScopeKey(scopeRef)) ?? null;
  }

  beginScopeTurn(scopeRef: PlatformScopeRef, initial: BeginScopeTurnOptions = {}): ActiveTurnRecord {
    const scopeKey = buildScopeKey(scopeRef);
    if (this.scopeTurns.has(scopeKey)) {
      throw new Error(`Active turn already exists for ${scopeKey}`);
    }
    const now = this.now();
    const record: ActiveTurnRecord = {
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

  updateScopeTurn(
    scopeRef: PlatformScopeRef,
    updates: Partial<ActiveTurnRecord> = {},
  ): ActiveTurnRecord | null {
    const record = this.resolveScopeTurn(scopeRef);
    if (!record) {
      return null;
    }
    Object.assign(record, updates, {
      updatedAt: this.now(),
    });
    return record;
  }

  requestInterrupt(scopeRef: PlatformScopeRef): ActiveTurnRecord | null {
    return this.updateScopeTurn(scopeRef, {
      interruptRequested: true,
    });
  }

  noteInterruptDispatched(scopeRef: PlatformScopeRef, value = true): ActiveTurnRecord | null {
    return this.updateScopeTurn(scopeRef, {
      interruptDispatched: value,
    });
  }

  endScopeTurn(scopeRef: PlatformScopeRef): ActiveTurnRecord | null {
    const scopeKey = buildScopeKey(scopeRef);
    const record = this.scopeTurns.get(scopeKey) ?? null;
    this.scopeTurns.delete(scopeKey);
    return record;
  }
}

function buildScopeKey(scopeRef: PlatformScopeRef): string {
  return formatPlatformScopeKey(scopeRef.platform, scopeRef.externalScopeId);
}
