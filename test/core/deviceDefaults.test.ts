import { describe, it, expect } from 'vitest';

import { buildProfile, deriveDeviceDefaults } from '../../src/core/deviceDefaults.js';
import type { TuyaDeviceModelResponse, TuyaFunctionSpec, TuyaSpecResponse } from '../../src/tuya/types.js';

const fn = (code: string, type: TuyaFunctionSpec['type'] = 'Boolean', values: object = {}): TuyaFunctionSpec =>
  ({ code, desc: '', name: code, type, values: JSON.stringify(values) });

const spec = (...functions: TuyaFunctionSpec[]): TuyaSpecResponse =>
  ({ success: true, t: 0, result: { category: 'kt', functions, status: functions } });

const model = (modes: string[], fanSpeeds: string[] = []): TuyaDeviceModelResponse => ({
  success: true,
  t: 0,
  result: {
    model: JSON.stringify({ services: [{ properties: [
      { code: 'mode', typeSpec: { type: 'enum', range: modes } },
      ...(fanSpeeds.length ? [{ code: 'fan_speed_enum', typeSpec: { type: 'enum', range: fanSpeeds } }] : []),
    ] }] }),
  },
});

const defaultsFor = (...args: Parameters<typeof buildProfile>) => {
  const { profile, modeRange } = buildProfile(...args);
  return deriveDeviceDefaults(profile, modeRange);
};

describe('deriveDeviceDefaults', () => {
  it('turns off controls whose datapoint the unit lacks', () => {
    const d = defaultsFor(spec(fn('switch')), null);
    expect(d).toMatchObject({
      expose_child_lock: false, expose_sleep_mode_switch: false, expose_fan_speed: false, expose_swing_control: false,
    });
  });

  it('turns on controls the unit has, except swing', () => {
    const d = defaultsFor(spec(fn('switch'), fn('child_lock'), fn('sleep'), fn('swing'), fn('windspeed', 'Enum', { range: ['low', 'high'] })), null);
    expect(d).toMatchObject({
      expose_child_lock: true, expose_sleep_mode_switch: true, expose_fan_speed: true, expose_swing_control: false,
    });
  });

  it('takes fan speeds and modes from the thing model when the spec lacks them', () => {
    const d = defaultsFor(spec(fn('switch')), model(['Cool', 'Dyr', 'Fan', 'Heat'], ['Low', 'High']));
    expect(d.expose_fan_speed).toBe(true);
    expect(d.expose_dry_mode_switch).toBe(true);
    expect(d.expose_fan_only_mode_switch).toBe(true);
    expect(d.mode_mappings).toEqual({ heat: 'Heat', cool: 'Cool', auto: 'None' });
  });

  it('falls back to the spec\'s modes without a thing model', () => {
    const d = defaultsFor(spec(fn('switch'), fn('mode', 'Enum', { range: ['Cool', 'Heat'] })), null);
    expect(d.mode_mappings).toEqual({ heat: 'Heat', cool: 'Cool', auto: 'None' });
    expect(d.expose_dry_mode_switch).toBe(false);
  });

  it('applies capability overrides before deciding', () => {
    const d = defaultsFor(spec(fn('switch'), fn('sleep')), null, { has_sleep: false });
    expect(d.expose_sleep_mode_switch).toBe(false);
  });
});
