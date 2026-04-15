import { WeixinPoller } from '../platforms/weixin/poller.js';

export class WeixinBridgeRuntime {
  constructor({
    platformPlugin,
    bridgeCoordinator,
    onError = async () => {},
  }) {
    this.platformPlugin = platformPlugin;
    this.bridgeCoordinator = bridgeCoordinator;
    this.onError = onError;
    this.poller = null;
  }

  async start() {
    await this.platformPlugin.start();
    this.poller = new WeixinPoller({
      plugin: this.platformPlugin,
      onEvent: async (event) => {
        await this.handleInboundEvent(event);
      },
      onError: async (error) => {
        await this.onError(error);
      },
    });
    return this.poller.start();
  }

  async stop() {
    this.poller?.stop();
    this.poller = null;
    await this.platformPlugin.stop();
  }

  async runOnce() {
    const result = await this.platformPlugin.pollOnce();
    for (const event of result.events) {
      await this.handleInboundEvent(event);
    }
    return result;
  }

  async handleInboundEvent(event) {
    const response = await this.bridgeCoordinator.handleInboundEvent(event);
    if (response?.type !== 'message') {
      return response;
    }
    const content = response.messages
      .map((message) => message.text)
      .filter(Boolean)
      .join('\n\n')
      .trim();
    if (content) {
      await this.platformPlugin.sendText({
        externalScopeId: event.externalScopeId,
        content,
      });
    }
    return response;
  }
}
