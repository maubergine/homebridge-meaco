import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSpecification } from '../../src/tuya/specParser.js';
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
    expect(profile.hasAuto).toBe(true);
    expect(profile.hasSwing).toBe(true);
    expect(profile.hasSleep).toBe(true);
    expect(profile.fanSpeedLevels).toEqual(['low', 'mid', 'high', 'auto']);
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
