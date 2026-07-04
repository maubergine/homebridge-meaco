import { describe, it, expect, beforeEach } from 'vitest';

import { StateCache } from '../../src/core/stateCache.js';

describe('StateCache', () => {
  let cache: StateCache;

  beforeEach(() => {
    cache = new StateCache(3);
  });

  it('starts responding with empty state', () => {
    expect(cache.isResponding()).toBe(true);
    expect(cache.state).toEqual({});
  });

  it('merges values on success', () => {
    cache.recordSuccess({ switch: true, mode: 'cold', temp_current: 220 });
    expect(cache.state).toEqual({ switch: true, mode: 'cold', temp_current: 220 });
    expect(cache.consecutiveFailures).toBe(0);
    expect(cache.isResponding()).toBe(true);
  });

  it('increments failure counter on recordFailure', () => {
    cache.recordFailure();
    expect(cache.consecutiveFailures).toBe(1);
    expect(cache.isResponding()).toBe(true);
  });

  it('becomes unresponsive after threshold failures', () => {
    cache.recordFailure();
    cache.recordFailure();
    expect(cache.isResponding()).toBe(true);
    cache.recordFailure(); // 3rd failure crosses threshold
    expect(cache.isResponding()).toBe(false);
  });

  it('recovers after one success', () => {
    cache.recordFailure();
    cache.recordFailure();
    cache.recordFailure();
    expect(cache.isResponding()).toBe(false);
    cache.recordSuccess({ switch: true });
    expect(cache.isResponding()).toBe(true);
    expect(cache.consecutiveFailures).toBe(0);
  });

  it('optimistically sets a single value', () => {
    cache.recordSuccess({ switch: true, mode: 'cold' });
    cache.optimisticSet('mode', 'wind');
    expect(cache.state['mode']).toBe('wind');
  });

  it('reverts optimistic value to previous', () => {
    cache.recordSuccess({ switch: true, mode: 'cold' });
    cache.optimisticSet('mode', 'wind');
    cache.revertOptimistic('mode');
    expect(cache.state['mode']).toBe('cold');
  });

  it('revert is no-op if no prior value exists', () => {
    cache.optimisticSet('mode', 'wind');
    cache.revertOptimistic('mode');
    expect(cache.state['mode']).toBeUndefined();
  });
});
