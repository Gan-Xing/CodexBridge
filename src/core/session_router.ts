import { NotFoundError } from './errors.js';
import type { BridgeSession, PlatformScopeRef } from '../types/core.js';
import type { PlatformBinding } from '../types/repository.js';
import { createI18n, type Translator } from '../i18n/index.js';

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
  locale?: string | null;
}

export class SessionRouter {
  private readonly platformBindings: PlatformBindingsLike;

  private readonly bridgeSessions: BridgeSessionsLike;

  private readonly i18n: Translator;

  constructor({ platformBindings, bridgeSessions, locale = null }: SessionRouterOptions) {
    this.platformBindings = platformBindings;
    this.bridgeSessions = bridgeSessions;
    this.i18n = createI18n(locale);
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
      throw new NotFoundError(this.i18n.t('service.noBridgeSessionBound', {
        scope: `${scopeRef.platform}:${scopeRef.externalScopeId}`,
      }));
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
