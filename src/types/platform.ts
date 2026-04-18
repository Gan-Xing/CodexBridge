import type { PlatformScopeRef } from './core.js';

export interface InboundTextEvent extends PlatformScopeRef {
  text: string;
  cwd?: string | null;
  locale?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PlatformDeliveryRequest {
  kind: string;
  payload: Record<string, unknown>;
}

export interface TypingDeliveryRequest {
  externalScopeId: string;
  action: 'start' | 'stop';
}

export interface PlatformPluginContract {
  id: string;
  displayName: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  normalizeInboundEvent(payload: Record<string, unknown>): InboundTextEvent | null;
  buildTextDeliveries(params: {
    externalScopeId: string;
    content: string;
  }): PlatformDeliveryRequest[];
}

