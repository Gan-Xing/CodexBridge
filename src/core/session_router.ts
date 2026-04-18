import { NotFoundError } from './errors.js';
import type { BridgeSession, PlatformScopeRef } from '../types/core.js';
import type { PlatformBinding } from '../types/repository.js';

interface PlatformBindingsLike {
  getBinding(scopeRef: PlatformScopeRef): PlatformBinding | null;
  setBinding(binding: PlatformBinding): void;
  listBindingsForSession(bridgeSessionId: string): PlatformBinding[];
}

interface BridgeSessionsLike {
  get(bridgeSessionId: string): BridgeSession | null;
}

interface SessionRouterOptions {
  platformBindings: PlatformBindingsLike;
  bridgeSessions: BridgeSessionsLike;
}

export class SessionRouter {
  private readonly platformBindings: PlatformBindingsLike;

  private readonly bridgeSessions: BridgeSessionsLike;

  constructor({ platformBindings, bridgeSessions }: SessionRouterOptions) {
    this.platformBindings = platformBindings;
    this.bridgeSessions = bridgeSessions;
  }

  resolveBoundSession(scopeRef: PlatformScopeRef): BridgeSession | null {
    const binding = this.platformBindings.getBinding(scopeRef);
    if (!binding) {
      return null;
    }
    return this.bridgeSessions.get(binding.bridgeSessionId);
  }

  requireBoundSession(scopeRef: PlatformScopeRef): BridgeSession {
    const session = this.resolveBoundSession(scopeRef);
    if (!session) {
      throw new NotFoundError(`No bridge session is bound to ${scopeRef.platform}:${scopeRef.externalScopeId}`);
    }
    return session;
  }

  bindScope(scopeRef: PlatformScopeRef, bridgeSessionId: string, now = Date.now()): void {
    this.platformBindings.setBinding({
      platform: scopeRef.platform,
      externalScopeId: scopeRef.externalScopeId,
      bridgeSessionId,
      updatedAt: now,
    });
  }

  listBindingsForSession(bridgeSessionId: string): PlatformBinding[] {
    return this.platformBindings.listBindingsForSession(bridgeSessionId);
  }
}

