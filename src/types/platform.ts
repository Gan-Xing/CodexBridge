import type { PlatformScopeRef } from './core.js';

export type InboundAttachmentKind = 'image' | 'voice' | 'file' | 'video';

export interface InboundAttachment {
  kind: InboundAttachmentKind;
  localPath: string;
  fileName?: string | null;
  mimeType?: string | null;
  transcriptText?: string | null;
  durationSeconds?: number | null;
}

export interface InboundTextEvent extends PlatformScopeRef {
  text: string;
  attachments?: InboundAttachment[];
  cwd?: string | null;
  locale?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PlatformDeliveryRequest {
  kind: string;
  payload: Record<string, unknown>;
}

export interface PlatformTextDeliveryResult {
  success: boolean;
  deliveredCount: number;
  deliveredText: string;
  failedIndex: number | null;
  failedText: string;
  error: string;
}

export interface PlatformMediaDeliveryResult {
  success: boolean;
  messageId: string | null;
  sentPath: string;
  sentCaption: string;
  error: string;
}

export interface PlatformStatusInfo {
  data?: Record<string, unknown> | null;
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
  normalizeInboundEvent(payload: Record<string, unknown>): InboundTextEvent | null | Promise<InboundTextEvent | null>;
  buildTextDeliveries(params: {
    externalScopeId: string;
    content: string;
  }): PlatformDeliveryRequest[];
  sendText?(params: {
    externalScopeId: string;
    content: string;
  }): Promise<PlatformTextDeliveryResult | null | undefined>;
  sendTyping?(params: {
    externalScopeId: string;
    status: 'start' | 'stop';
  }): Promise<void> | void;
  sendMedia?(params: {
    externalScopeId: string;
    filePath: string;
    caption?: string | null;
  }): Promise<PlatformMediaDeliveryResult | null | undefined>;
  getStatus?(params: {
    externalScopeId?: string | null;
  }): Promise<PlatformStatusInfo | null | undefined> | PlatformStatusInfo | null | undefined;
}
