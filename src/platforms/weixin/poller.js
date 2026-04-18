export class WeixinPoller {
  constructor({
    plugin,
    onEvent = async () => {},
    onError = async () => {},
    sleep = defaultSleep,
  }) {
    this.plugin = plugin;
    this.onEvent = onEvent;
    this.onError = onError;
    this.sleep = sleep;
    this.running = false;
  }

  async start() {
    this.running = true;
    while (this.running) {
      try {
        const result = await this.plugin.pollOnce();
        for (const event of result.events) {
          await this.onEvent(event);
        }
        await this.plugin.commitSyncCursor?.(result.syncCursor);
      } catch (error) {
        await this.onError(error);
        await this.sleep(2000);
      }
    }
  }

  stop() {
    this.running = false;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
