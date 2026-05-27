import type { TuyaValue } from '../tuya/types.js';

export class StateCache {
  state: Record<string, TuyaValue> = {};
  lastSuccess = 0;
  consecutiveFailures = 0;

  private readonly threshold: number;
  private readonly preOptimistic = new Map<string, TuyaValue | undefined>();

  constructor(unresponsiveAfterFailures: number) {
    this.threshold = unresponsiveAfterFailures;
  }

  isResponding(): boolean {
    return this.consecutiveFailures < this.threshold;
  }

  recordSuccess(values: Record<string, TuyaValue>): void {
    this.state = { ...this.state, ...values };
    this.lastSuccess = Date.now();
    this.consecutiveFailures = 0;
    this.preOptimistic.clear();
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
  }

  optimisticSet(code: string, value: TuyaValue): void {
    this.preOptimistic.set(code, this.state[code]);
    this.state[code] = value;
  }

  revertOptimistic(code: string): void {
    if (!this.preOptimistic.has(code)) return;
    const prior = this.preOptimistic.get(code);
    if (prior === undefined) {
      delete this.state[code];
    } else {
      this.state[code] = prior;
    }
    this.preOptimistic.delete(code);
  }
}
