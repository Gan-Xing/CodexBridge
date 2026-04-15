export class TelegramPlatformPlugin {
  constructor() {
    this.id = 'telegram';
    this.displayName = 'Telegram';
  }

  async start() {
    throw new Error('TelegramPlatformPlugin.start is not implemented yet');
  }

  async stop() {
    throw new Error('TelegramPlatformPlugin.stop is not implemented yet');
  }
}
