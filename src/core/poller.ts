export class Poller {
  private handle: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private stopped = false;
  private onTick: (() => Promise<void>) | null = null;
  private intervalMs = 0;

  start(intervalSec: number, onTick: () => Promise<void>): void {
    this.stopped = false;
    this.onTick = onTick;
    this.intervalMs = intervalSec * 1000;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.handle !== null) {
      clearTimeout(this.handle);
      this.handle = null;
    }
  }

  async triggerNow(): Promise<void> {
    if (this.inFlight || this.onTick === null) return;
    await this.tick();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.handle = setTimeout(() => {
      void this.tick().then(() => {
        this.schedule();
      });
    }, this.intervalMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.inFlight || this.onTick === null) return;
    this.inFlight = true;
    try {
      await this.onTick();
    } finally {
      this.inFlight = false;
    }
  }
}
