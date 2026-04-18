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
    this.nextSyncCursor = null;
    this.pendingCursorCommits = [];
    this.commitPumpPromise = null;
    this.commitBlocked = false;
  }

  async start() {
    this.running = true;
    this.nextSyncCursor = this.plugin.loadSyncCursor?.() ?? null;
    while (this.running) {
      try {
        const result = await this.plugin.pollOnce({ syncCursor: this.nextSyncCursor });
        this.nextSyncCursor = result?.syncCursor ?? this.nextSyncCursor;
        const eventCompletion = this.dispatchEvents(result?.events ?? []);
        this.enqueueCursorCommit({
          syncCursor: result?.syncCursor ?? this.nextSyncCursor,
          completion: eventCompletion,
        });
        this.ensureCommitPump();
      } catch (error) {
        await this.onError(error);
        await this.sleep(2000);
      }
    }
    await this.commitPumpPromise;
  }

  stop() {
    this.running = false;
  }

  async dispatchEvents(events) {
    const completions = [];
    for (const event of events) {
      const outcome = await this.onEvent(event);
      const completion = extractCompletionPromise(outcome);
      if (completion) {
        completions.push(completion);
      }
    }
    if (completions.length === 0) {
      return Promise.resolve();
    }
    return Promise.all(completions).then(() => {});
  }

  enqueueCursorCommit(entry) {
    this.pendingCursorCommits.push(entry);
  }

  ensureCommitPump() {
    if (this.commitPumpPromise || this.commitBlocked) {
      return;
    }
    this.commitPumpPromise = this.runCommitPump()
      .finally(() => {
        this.commitPumpPromise = null;
        if (this.pendingCursorCommits.length > 0 && !this.commitBlocked) {
          this.ensureCommitPump();
        }
      });
  }

  async runCommitPump() {
    while (this.pendingCursorCommits.length > 0) {
      const entry = this.pendingCursorCommits[0];
      try {
        await entry.completion;
        await this.plugin.commitSyncCursor?.(entry.syncCursor);
        this.pendingCursorCommits.shift();
      } catch (error) {
        this.commitBlocked = true;
        await this.onError(error);
        return;
      }
    }
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function extractCompletionPromise(outcome) {
  const completion = outcome?.completion;
  if (!completion || typeof completion.then !== 'function') {
    return null;
  }
  return completion;
}
