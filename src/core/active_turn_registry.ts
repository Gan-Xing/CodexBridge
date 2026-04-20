import { formatPlatformScopeKey } from './contracts.js';
import { createI18n, type Translator } from '../i18n/index.js';
import type { PlatformScopeRef, TurnArtifactDeliveryState } from '../types/core.js';
import type { ProviderApprovalRequest } from '../types/provider.js';

interface ActiveTurnRecord {
  scopeRef: PlatformScopeRef;
  bridgeSessionId: string | null;
  providerProfileId: string | null;
  threadId: string | null;
  turnId: string | null;
  interruptRequested: boolean;
  interruptDispatched: boolean;
  pendingApprovals: ProviderApprovalRequest[];
  artifactDelivery: TurnArtifactDeliveryState | null;
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
  locale?: string | null;
}

export class ActiveTurnRegistry {
  private readonly now: () => number;

  private readonly scopeTurns: Map<string, ActiveTurnRecord>;

  private readonly i18n: Translator;

  constructor({ now = () => Date.now(), locale = null }: ActiveTurnRegistryOptions = {}) {
    this.now = now;
    this.scopeTurns = new Map();
    this.i18n = createI18n(locale);
  }

  resolveScopeTurn(scopeRef: PlatformScopeRef): ActiveTurnRecord | null {
    return this.scopeTurns.get(buildScopeKey(scopeRef)) ?? null;
  }

  beginScopeTurn(scopeRef: PlatformScopeRef, initial: BeginScopeTurnOptions = {}): ActiveTurnRecord {
    const scopeKey = buildScopeKey(scopeRef);
    if (this.scopeTurns.has(scopeKey)) {
      throw new Error(this.i18n.t('service.activeTurn.alreadyExists', { scope: scopeKey }));
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
      pendingApprovals: [],
      artifactDelivery: null,
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

  addPendingApproval(scopeRef: PlatformScopeRef, request: ProviderApprovalRequest): ActiveTurnRecord | null {
    const record = this.resolveScopeTurn(scopeRef);
    if (!record) {
      return null;
    }
    const next = record.pendingApprovals.filter((entry) => entry.requestId !== request.requestId);
    next.push(request);
    return this.updateScopeTurn(scopeRef, {
      pendingApprovals: next,
    });
  }

  clearPendingApproval(scopeRef: PlatformScopeRef, requestId: string): ActiveTurnRecord | null {
    const record = this.resolveScopeTurn(scopeRef);
    if (!record) {
      return null;
    }
    return this.updateScopeTurn(scopeRef, {
      pendingApprovals: record.pendingApprovals.filter((entry) => entry.requestId !== requestId),
    });
  }

  clearPendingApprovals(scopeRef: PlatformScopeRef): ActiveTurnRecord | null {
    return this.updateScopeTurn(scopeRef, {
      pendingApprovals: [],
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
