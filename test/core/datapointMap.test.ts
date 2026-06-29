import { describe, it, expect } from 'vitest';

import { DatapointMap } from '../../src/core/datapointMap.js';
import type { CapabilityProfile } from '../../src/core/capabilityProfile.js';

const MOCK_PROFILE: CapabilityProfile = {
  hasPower: true,
  hasCool: true,
  hasHeat: false,
  hasDry: true,
  hasFanOnly: true,
  hasSwing: true,
  hasSleep: true,
  fanSpeedLevels: ['low', 'mid', 'high', 'auto'],
  tempRange: { min: 16, max: 31, step: 0.5, scale: 1 },
  rawFunctions: new Map([
    ['switch', { code: 'switch', desc: '', name: '', type: 'Boolean', values: '{}' }],
    ['mode', { code: 'mode', desc: '', name: '', type: 'Enum', values: '{"range":["cold","wet","wind"]}' }],
    ['temp_set', { code: 'temp_set', desc: '', name: '', type: 'Integer', values: '{"min":160,"max":310,"scale":1,"step":5}' }],
    ['temp_current', { code: 'temp_current', desc: '', name: '', type: 'Integer', values: '{"min":0,"max":500,"scale":1,"step":1}' }],
    ['windspeed', { code: 'windspeed', desc: '', name: '', type: 'Enum', values: '{"range":["low","mid","high","auto"]}' }],
    ['swing', { code: 'swing', desc: '', name: '', type: 'Boolean', values: '{}' }],
    ['sleep', { code: 'sleep', desc: '', name: '', type: 'Boolean', values: '{}' }],
  ]),
};

describe('DatapointMap', () => {
  it('resolves canonical names to Tuya codes', () => {
    const map = new DatapointMap(MOCK_PROFILE);
    expect(map.resolve('power')).toBe('switch');
    expect(map.resolve('mode')).toBe('mode');
    expect(map.resolve('setpoint')).toBe('temp_set');
    expect(map.resolve('currentTemp')).toBe('temp_current');
    expect(map.resolve('fanSpeed')).toBe('windspeed');
    expect(map.resolve('swing')).toBe('swing');
    expect(map.resolve('sleep')).toBe('sleep');
  });

  it('returns undefined for a canonical name not in the spec', () => {
    const map = new DatapointMap(MOCK_PROFILE);
    expect(map.resolve('heat' as never)).toBeUndefined();
  });

  it('encodes setpoint: celsius value → integer × 10^scale', () => {
    const map = new DatapointMap(MOCK_PROFILE);
    const { code, value } = map.encodeSetpoint(22.5, 'celsius');
    expect(code).toBe('temp_set');
    expect(value).toBe(225); // 22.5 * 10
  });

  it('decodes setpoint: integer → celsius', () => {
    const map = new DatapointMap(MOCK_PROFILE);
    expect(map.decodeSetpoint(225)).toBeCloseTo(22.5);
  });

  it('decodes current temperature respecting scale', () => {
    const map = new DatapointMap(MOCK_PROFILE);
    expect(map.decodeCurrentTemp(220)).toBeCloseTo(22.0);
  });

  it('encodes fan speed: HomeKit 0-100 → nearest Tuya level', () => {
    const map = new DatapointMap(MOCK_PROFILE);
    expect(map.encodeFanSpeed(0)).toBe('low');
    expect(map.encodeFanSpeed(33)).toBe('low');
    expect(map.encodeFanSpeed(50)).toBe('mid');
    expect(map.encodeFanSpeed(75)).toBe('high');
    expect(map.encodeFanSpeed(100)).toBe('auto');
  });

  it('decodes fan speed: Tuya level → HomeKit 0-100', () => {
    const map = new DatapointMap(MOCK_PROFILE);
    expect(map.decodeFanSpeed('low')).toBe(0);
    expect(map.decodeFanSpeed('mid')).toBe(33);
    expect(map.decodeFanSpeed('high')).toBe(66);
    expect(map.decodeFanSpeed('auto')).toBe(100);
    expect(map.decodeFanSpeed('unknown')).toBe(0);
  });

  it('encodes swing boolean', () => {
    const map = new DatapointMap(MOCK_PROFILE);
    expect(map.encodeSwing(true)).toEqual({ code: 'swing', value: true });
    expect(map.encodeSwing(false)).toEqual({ code: 'swing', value: false });
  });

  it('falls back to alias when primary code absent', () => {
    const profileWithShake: CapabilityProfile = {
      ...MOCK_PROFILE,
      rawFunctions: new Map([
        ...MOCK_PROFILE.rawFunctions,
        ['shake', { code: 'shake', desc: '', name: '', type: 'Boolean', values: '{}' }],
      ]),
    };
    // Remove 'swing', keep 'shake'
    profileWithShake.rawFunctions.delete('swing');
    const map = new DatapointMap(profileWithShake);
    expect(map.resolve('swing')).toBe('shake');
  });
});
