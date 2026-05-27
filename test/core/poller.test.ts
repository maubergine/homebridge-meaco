import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { Poller } from '../../src/core/poller.js';

describe('Poller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onTick on each interval', async () => {
    const onTick = vi.fn().mockResolvedValue(undefined);
    const poller = new Poller();
    poller.start(10, onTick);

    await vi.advanceTimersByTimeAsync(10_000);
    poller.stop();

    expect(onTick.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('does not overlap ticks when onTick is slow', async () => {
    let running = false;
    let overlaps = 0;
    const onTick = vi.fn().mockImplementation(async () => {
      if (running) overlaps++;
      running = true;
      await Promise.resolve();
      running = false;
    });

    const poller = new Poller();
    poller.start(1, onTick);
    await vi.advanceTimersByTimeAsync(5_000);
    poller.stop();

    expect(overlaps).toBe(0);
  });

  it('stop() prevents further ticks', async () => {
    const onTick = vi.fn().mockResolvedValue(undefined);
    const poller = new Poller();
    poller.start(10, onTick);
    poller.stop();
    const countAfterStop = onTick.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onTick.mock.calls.length).toBe(countAfterStop);
  });

  it('triggerNow() calls onTick immediately', async () => {
    const onTick = vi.fn().mockResolvedValue(undefined);
    const poller = new Poller();
    poller.start(60, onTick);
    await poller.triggerNow();
    expect(onTick).toHaveBeenCalled();
    poller.stop();
  });

  it('triggerNow() is no-op when a tick is already in flight', async () => {
    let resolve!: () => void;
    const onTick = vi.fn().mockImplementation(
      () => new Promise<void>((r) => { resolve = r; }),
    );
    const poller = new Poller();
    poller.start(60, onTick);
    const p1 = poller.triggerNow();
    const p2 = poller.triggerNow(); // should not call onTick again
    resolve();
    await Promise.all([p1, p2]);
    expect(onTick).toHaveBeenCalledTimes(1);
    poller.stop();
  });
});
