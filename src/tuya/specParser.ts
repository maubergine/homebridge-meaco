import type { CapabilityProfile, TempRange } from '../core/capabilityProfile.js';

import type { TuyaFunctionSpec, TuyaSpecResponse } from './types.js';

type TuyaChoice = 'Cool' | 'Dry' | 'Fan' | 'Heat' | 'None';

export interface ModeDefaults {
  mode_mappings: { heat: TuyaChoice; cool: TuyaChoice; auto: TuyaChoice };
  expose_dry_mode_switch: boolean;
  expose_fan_only_mode_switch: boolean;
}

const SAFE_TEMP_RANGE: TempRange = { min: 16, max: 31, step: 1, scale: 0 };

function parseTempRange(values: string): TempRange {
  try {
    const v = JSON.parse(values) as Record<string, number | undefined>;
    const scale = v.scale ?? 0;
    const divisor = Math.pow(10, scale);
    return {
      min: (v.min ?? 160) / divisor,
      max: (v.max ?? 310) / divisor,
      step: (v.step ?? 1) / divisor,
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

interface ModelProperty { code: string; typeSpec?: { type?: string; range?: string[] } }

function parseModelProperties(modelJson: string): ModelProperty[] {
  try {
    const parsed = JSON.parse(modelJson) as {
      services?: { properties?: ModelProperty[] }[];
    };
    return (parsed.services ?? []).flatMap(s => s.properties ?? []);
  } catch {
    return [];
  }
}

export function parseModeRangeFromModel(modelJson: string): string[] {
  const prop = parseModelProperties(modelJson).find(p => p.code === 'mode');
  return prop?.typeSpec?.range ?? [];
}

export function parseFanSpeedFromModel(modelJson: string): { code: string; levels: string[] } | null {
  const prop = parseModelProperties(modelJson).find(p => p.code === 'fan_speed_enum');
  if (!prop?.typeSpec?.range?.length) return null;
  return { code: prop.code, levels: prop.typeSpec.range };
}

export function deriveModeDefaults(modeRange: string[]): ModeDefaults {
  return {
    mode_mappings: {
      heat: modeRange.includes('Heat') ? 'Heat' : 'None',
      cool: modeRange.includes('Cool') ? 'Cool' : 'None',
      // 'Auto' is not a Meaco mode option; the HomeKit Auto state defaults to hidden.
      auto: 'None',
    },
    expose_dry_mode_switch: modeRange.includes('Dyr'),
    expose_fan_only_mode_switch: modeRange.includes('Fan'),
  };
}

export function parseSpecification(spec: TuyaSpecResponse): CapabilityProfile {
  const allSpecs = new Map<string, TuyaFunctionSpec>();
  for (const f of [...spec.result.functions, ...spec.result.status]) {
    if (!allSpecs.has(f.code)) allSpecs.set(f.code, f);
  }

  const rawFunctions = new Map<string, TuyaFunctionSpec>(allSpecs);

  const modeSpec = allSpecs.get('mode');
  const modeRange = modeSpec ? parseEnumRange(modeSpec.values) : [];

  const fanSpec = allSpecs.get('fan_speed_enum') ?? allSpecs.get('windspeed') ?? allSpecs.get('fan_speed');
  const fanSpeedLevels = fanSpec ? parseEnumRange(fanSpec.values) : [];

  const setpointSpec = allSpecs.get('temp_set') ?? allSpecs.get('set_temp');
  const tempRange = setpointSpec ? parseTempRange(setpointSpec.values) : SAFE_TEMP_RANGE;

  const currentTempSpec = allSpecs.get('temp_current') ?? allSpecs.get('temp_indoor');
  const currentTempRange = currentTempSpec ? parseTempRange(currentTempSpec.values) : undefined;

  // Cooling-only devices (category kt, no mode DP) don't expose a mode selector
  // but are inherently cooling devices — infer hasCool so the accessory is operable.
  const inferredCool = spec.result.category === 'kt' && modeRange.length === 0;

  return {
    hasPower: allSpecs.has('switch') || allSpecs.has('switch_1') || allSpecs.has('power'),
    hasCool: modeRange.includes('cold') || modeRange.includes('Cool') || inferredCool,
    hasHeat: modeRange.includes('hot') || modeRange.includes('Heat'),
    hasDry: modeRange.includes('wet') || modeRange.includes('Dyr'),
    hasFanOnly: modeRange.includes('wind') || modeRange.includes('Fan'),
    hasSwing: allSpecs.has('swing') || allSpecs.has('shake'),
    hasSleep: allSpecs.has('sleep') || allSpecs.has('sleep_mode') || allSpecs.has('Sleep'),
    fanSpeedLevels,
    tempRange,
    currentTempRange,
    rawFunctions,
  };
}
