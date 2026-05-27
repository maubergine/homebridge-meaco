import type { CapabilityProfile, TempRange } from '../core/capabilityProfile.js';
import type { TuyaFunctionSpec, TuyaSpecResponse } from './types.js';

const SAFE_TEMP_RANGE: TempRange = { min: 16, max: 31, step: 1, scale: 0 };

function parseTempRange(values: string): TempRange {
  try {
    const v = JSON.parse(values) as Record<string, number>;
    const scale = v['scale'] ?? 0;
    const divisor = Math.pow(10, scale);
    return {
      min: (v['min'] ?? 160) / divisor,
      max: (v['max'] ?? 310) / divisor,
      step: (v['step'] ?? 1) / divisor,
      scale,
    };
  } catch {
    return SAFE_TEMP_RANGE;
  }
}

function parseEnumRange(values: string): string[] {
  try {
    const v = JSON.parse(values) as { range?: string[] };
    return v.range ?? [];
  } catch {
    return [];
  }
}

export function parseSpecification(spec: TuyaSpecResponse): CapabilityProfile {
  const allSpecs = new Map<string, TuyaFunctionSpec>();
  for (const f of [...spec.result.functions, ...spec.result.status]) {
    if (!allSpecs.has(f.code)) allSpecs.set(f.code, f);
  }

  const rawFunctions = new Map<string, TuyaFunctionSpec>(allSpecs);

  const modeSpec = allSpecs.get('mode');
  const modeRange = modeSpec ? parseEnumRange(modeSpec.values) : [];

  const fanSpec = allSpecs.get('windspeed') ?? allSpecs.get('fan_speed');
  const fanSpeedLevels = fanSpec ? parseEnumRange(fanSpec.values) : [];

  const setpointSpec = allSpecs.get('temp_set') ?? allSpecs.get('set_temp');
  const tempRange = setpointSpec ? parseTempRange(setpointSpec.values) : SAFE_TEMP_RANGE;

  const currentTempSpec = allSpecs.get('temp_current') ?? allSpecs.get('temp_indoor');
  const currentTempRange = currentTempSpec ? parseTempRange(currentTempSpec.values) : undefined;

  return {
    hasPower: allSpecs.has('switch') || allSpecs.has('switch_1') || allSpecs.has('power'),
    hasCool: modeRange.includes('cold'),
    hasHeat: modeRange.includes('hot'),
    hasDry: modeRange.includes('wet'),
    hasFanOnly: modeRange.includes('wind'),
    hasAuto: modeRange.includes('auto'),
    hasSwing: allSpecs.has('swing') || allSpecs.has('shake'),
    hasSleep: allSpecs.has('sleep') || allSpecs.has('sleep_mode'),
    fanSpeedLevels,
    tempRange,
    currentTempRange,
    rawFunctions,
  };
}
