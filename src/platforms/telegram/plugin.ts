import type { PlatformPluginContract } from '../../types/platform.js';

export class TelegramPlatformPlugin implements Pick<PlatformPluginContract, 'id' | 'displayName' | 'start' | 'stop'> {
  constructor() {
    this.id = 'telegram';
    this.displayName = 'Telegram';
  }

  id: string;
  displayName: string;

  async start() {
    throw new Error('TelegramPlatformPlugin.start is not implemented yet');
  }

  async stop() {
    throw new Error('TelegramPlatformPlugin.stop is not implemented yet');
  }
}
