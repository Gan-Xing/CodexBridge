import { NotFoundError } from './errors.js';

export class SessionRouter {
  constructor({ platformBindings, bridgeSessions }) {
    this.platformBindings = platformBindings;
    this.bridgeSessions = bridgeSessions;
  }

  resolveBoundSession(scopeRef) {
    const binding = this.platformBindings.getBinding(scopeRef);
    if (!binding) {
      return null;
    }
    return this.bridgeSessions.get(binding.bridgeSessionId);
  }

  requireBoundSession(scopeRef) {
    const session = this.resolveBoundSession(scopeRef);
    if (!session) {
      throw new NotFoundError(`No bridge session is bound to ${scopeRef.platform}:${scopeRef.externalScopeId}`);
    }
    return session;
  }

  bindScope(scopeRef, bridgeSessionId, now = Date.now()) {
    this.platformBindings.setBinding({
      platform: scopeRef.platform,
      externalScopeId: scopeRef.externalScopeId,
      bridgeSessionId,
      updatedAt: now,
    });
  }

  listBindingsForSession(bridgeSessionId) {
    return this.platformBindings.listBindingsForSession(bridgeSessionId);
  }
}
