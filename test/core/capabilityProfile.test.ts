import { describe, it, expect } from 'vitest';

import { applyOverrides } from '../../src/core/capabilityProfile.js';
import type { CapabilityProfile } from '../../src/core/capabilityProfile.js';

const BASE: CapabilityProfile = {
  hasPower: true,
  hasCool: true,
  hasHeat: false,
  hasDry: false,
  hasFanOnly: false,
  hasSwing: false,
  hasSleep: false,
  fanSpeedLevels: ['low', 'high'],
  tempRange: { min: 16, max: 31, step: 1, scale: 0 },
  rawFunctions: new Map(),
};

describe('applyOverrides', () => {
  it('returns the original profile unchanged when no overrides are given', () => {
    expect(applyOverrides(BASE, undefined)).toBe(BASE);
  });

  it('does not mutate the input profile', () => {
    const result = applyOverrides(BASE, { has_heat: true });
    expect(result).not.toBe(BASE);
    expect(BASE.hasHeat).toBe(false);
  });

  it('applies every boolean capability override', () => {
    const result = applyOverrides(BASE, {
      has_heat: true,
      has_dry: true,
      has_swing: true,
      has_sleep: true,
      has_fan_only: true,
    });
    expect(result.hasHeat).toBe(true);
    expect(result.hasDry).toBe(true);
    expect(result.hasSwing).toBe(true);
    expect(result.hasSleep).toBe(true);
    expect(result.hasFanOnly).toBe(true);
  });

  it('overrides fan speed levels and temperature bounds', () => {
    const result = applyOverrides(BASE, {
      fan_speed_levels: ['auto', 'low', 'mid', 'high'],
      temp_min: 18,
      temp_max: 28,
    });
    expect(result.fanSpeedLevels).toEqual(['auto', 'low', 'mid', 'high']);
    expect(result.tempRange.min).toBe(18);
    expect(result.tempRange.max).toBe(28);
    expect(result.tempRange.step).toBe(BASE.tempRange.step);
  });

  it('respects explicit false values', () => {
    const result = applyOverrides({ ...BASE, hasCool: true }, { has_swing: false });
    expect(result.hasSwing).toBe(false);
  });
});
