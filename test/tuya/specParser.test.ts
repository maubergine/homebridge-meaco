import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSpecification, parseModeRangeFromModel, parseFanSpeedFromModel, deriveModeDefaults } from '../../src/tuya/specParser.js';
import type { TuyaSpecResponse } from '../../src/tuya/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): TuyaSpecResponse {
  const raw = readFileSync(
    join(__dirname, '../fixtures/specifications', name),
    'utf-8',
  );
  return JSON.parse(raw) as TuyaSpecResponse;
}

describe('parseSpecification', () => {
  it('parses the synthetic MeacoCool MC fixture', () => {
    const spec = loadFixture('meacocool-mc-synthetic.json');
    const profile = parseSpecification(spec);

    expect(profile.hasPower).toBe(true);
    expect(profile.hasCool).toBe(true);
    expect(profile.hasHeat).toBe(false);
    expect(profile.hasDry).toBe(true);
    expect(profile.hasFanOnly).toBe(true);
    expect(profile.hasSwing).toBe(true);
    expect(profile.hasSleep).toBe(true);
    expect(profile.fanSpeedLevels).toEqual(['low', 'high']);
    expect(profile.tempRange).toEqual({ min: 16, max: 31, step: 0.5, scale: 1 });
    expect(profile.rawFunctions.has('switch')).toBe(true);
  });

  it('applies scale=1 correctly — integer values /10^scale', () => {
    const spec = loadFixture('meacocool-mc-synthetic.json');
    const profile = parseSpecification(spec);
    // scale=1 means stored value / 10 = real value, so 160/10=16, 310/10=31, step=5/10=0.5
    expect(profile.tempRange.min).toBe(16);
    expect(profile.tempRange.max).toBe(31);
    expect(profile.tempRange.step).toBeCloseTo(0.5);
  });

  it('falls back to safe defaults when temp_set values JSON is malformed', () => {
    const spec = loadFixture('meacocool-mc-synthetic.json');
    // corrupt temp_set values
    spec.result.functions = spec.result.functions.map((f) =>
      f.code === 'temp_set' ? { ...f, values: 'NOT_JSON' } : f,
    );
    const profile = parseSpecification(spec);
    expect(profile.tempRange).toEqual({ min: 16, max: 31, step: 1, scale: 0 });
  });

  it('handles missing switch gracefully — hasPower=false', () => {
    const spec = loadFixture('meacocool-mc-synthetic.json');
    spec.result.functions = spec.result.functions.filter((f) => f.code !== 'switch');
    spec.result.status = spec.result.status.filter((f) => f.code !== 'switch');
    const profile = parseSpecification(spec);
    expect(profile.hasPower).toBe(false);
  });

  it('sets currentTempRange when temp_current is present in status', () => {
    const spec = loadFixture('meacocool-mc-synthetic.json');
    const profile = parseSpecification(spec);
    expect(profile.currentTempRange).toBeDefined();
    expect(profile.currentTempRange?.min).toBe(0);
    expect(profile.currentTempRange?.max).toBe(50);
  });
});

describe('parseModeRangeFromModel', () => {
  const MODEL_JSON = JSON.stringify({
    modelId: 'test',
    services: [{
      properties: [
        { code: 'switch', typeSpec: { type: 'bool' } },
        { code: 'mode', typeSpec: { type: 'enum', range: ['Cool', 'Dyr', 'Fan', 'Heat'] } },
      ],
    }],
  });

  it('extracts mode range from model JSON', () => {
    expect(parseModeRangeFromModel(MODEL_JSON)).toEqual(['Cool', 'Dyr', 'Fan', 'Heat']);
  });

  it('returns empty array for malformed JSON', () => {
    expect(parseModeRangeFromModel('NOT_JSON')).toEqual([]);
  });

  it('returns empty array when no mode property exists', () => {
    const noMode = JSON.stringify({ services: [{ properties: [{ code: 'switch', typeSpec: {} }] }] });
    expect(parseModeRangeFromModel(noMode)).toEqual([]);
  });
});

describe('parseFanSpeedFromModel', () => {
  const MODEL_WITH_FAN = JSON.stringify({
    services: [{
      properties: [
        { code: 'mode', typeSpec: { type: 'enum', range: ['Cool', 'Fan'] } },
        { code: 'fan_speed_enum', typeSpec: { type: 'enum', range: ['Low', 'High'] } },
      ],
    }],
  });

  it('extracts fan speed levels from model JSON', () => {
    expect(parseFanSpeedFromModel(MODEL_WITH_FAN)).toEqual({ code: 'fan_speed_enum', levels: ['Low', 'High'] });
  });

  it('returns null when no fan_speed_enum property exists', () => {
    const noFan = JSON.stringify({ services: [{ properties: [{ code: 'mode', typeSpec: { range: ['Cool'] } }] }] });
    expect(parseFanSpeedFromModel(noFan)).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseFanSpeedFromModel('NOT_JSON')).toBeNull();
  });
});

describe('deriveModeDefaults', () => {
  it('maps Cool and Heat, exposes dry and fan switches for the example device', () => {
    const defaults = deriveModeDefaults(['Cool', 'Dyr', 'Fan', 'Heat']);
    expect(defaults.mode_mappings).toEqual({ heat: 'Heat', cool: 'Cool', auto: 'none' });
    expect(defaults.expose_dry_mode_switch).toBe(true);
    expect(defaults.expose_fan_only_mode_switch).toBe(true);
  });

  it('maps Auto when present in range', () => {
    const defaults = deriveModeDefaults(['Cool', 'Auto']);
    expect(defaults.mode_mappings.auto).toBe('Auto');
    expect(defaults.expose_dry_mode_switch).toBe(false);
  });

  it('returns all none for empty range', () => {
    const defaults = deriveModeDefaults([]);
    expect(defaults.mode_mappings).toEqual({ heat: 'none', cool: 'none', auto: 'none' });
    expect(defaults.expose_dry_mode_switch).toBe(false);
    expect(defaults.expose_fan_only_mode_switch).toBe(false);
  });
});

describe('parseSpecification — MC10000RPRO (cooling-only, no mode DP)', () => {
  it('infers hasCool=true for kt category with no mode DP', () => {
    const spec = loadFixture('meacocool-mc10000rpro.json');
    const profile = parseSpecification(spec);

    expect(profile.hasPower).toBe(true);
    expect(profile.hasCool).toBe(true);
    expect(profile.hasHeat).toBe(false);
    expect(profile.hasDry).toBe(false);
    expect(profile.hasFanOnly).toBe(false);
    expect(profile.hasSwing).toBe(true);
    expect(profile.hasSleep).toBe(false);
    expect(profile.fanSpeedLevels).toEqual([]);
    expect(profile.tempRange).toEqual({ min: 16, max: 32, step: 1, scale: 0 });
    expect(profile.currentTempRange).toEqual({ min: 0, max: 99, step: 1, scale: 0 });
  });

  it('does not infer hasCool for non-kt category with no mode DP', () => {
    const spec = loadFixture('meacocool-mc10000rpro.json');
    spec.result.category = 'other';
    const profile = parseSpecification(spec);
    expect(profile.hasCool).toBe(false);
  });
});
