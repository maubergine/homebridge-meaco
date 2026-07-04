import type { TuyaValue } from '../tuya/types.js';

export class StateCache {
  state: Record<string, TuyaValue> = {};
  lastSuccess = 0;
  consecutiveFailures = 0;

  private readonly preOptimistic = new Map<string, TuyaValue | undefined>();

  constructor(private readonly threshold: number) {}

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
    if (!this.preOptimistic.has(code)) {
      this.preOptimistic.set(code, this.state[code]);
    }
    this.state[code] = value;
  }

  revertOptimistic(code: string): void {
    if (!this.preOptimistic.has(code)) return;
    const prior = this.preOptimistic.get(code);
    if (prior === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- code is a runtime datapoint key
      delete this.state[code];
    } else {
      this.state[code] = prior;
    }
    this.preOptimistic.delete(code);
  }
}
