import type { PlatformPluginContract } from '../../types/platform.js';
import { createI18n, type Translator } from '../../i18n/index.js';

export class TelegramPlatformPlugin implements Pick<PlatformPluginContract, 'id' | 'displayName' | 'start' | 'stop'> {
  constructor({ locale = null }: { locale?: string | null } = {}) {
    this.i18n = createI18n(locale);
    this.id = 'telegram';
    this.displayName = 'Telegram';
  }

  id: string;
  displayName: string;
  i18n: Translator;

  async start() {
    throw new Error(this.i18n.t('platform.telegram.plugin.startNotImplemented'));
  }

  async stop() {
    throw new Error(this.i18n.t('platform.telegram.plugin.stopNotImplemented'));
  }
}
