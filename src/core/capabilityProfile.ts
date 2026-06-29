import type { TuyaFunctionSpec } from '../tuya/types.js';

export interface TempRange {
  min: number;
  max: number;
  step: number;
  scale: number;
}

export interface CapabilityProfile {
  hasPower: boolean;
  hasCool: boolean;
  hasHeat: boolean;
  hasDry: boolean;
  hasFanOnly: boolean;
  hasSwing: boolean;
  hasSleep: boolean;
  fanSpeedLevels: string[];
  tempRange: TempRange;
  currentTempRange?: TempRange;
  rawFunctions: Map<string, TuyaFunctionSpec>;
}

export interface CapabilityOverrides {
  has_heat?: boolean;
  has_dry?: boolean;
  has_swing?: boolean;
  has_sleep?: boolean;
  has_fan_only?: boolean;
  fan_speed_levels?: string[];
  temp_min?: number;
  temp_max?: number;
}

export function applyOverrides(
  profile: CapabilityProfile,
  overrides: CapabilityOverrides | undefined,
): CapabilityProfile {
  if (!overrides) return profile;
  const result = { ...profile };
  if (overrides.has_heat !== undefined) result.hasHeat = overrides.has_heat;
  if (overrides.has_dry !== undefined) result.hasDry = overrides.has_dry;
  if (overrides.has_swing !== undefined) result.hasSwing = overrides.has_swing;
  if (overrides.has_sleep !== undefined) result.hasSleep = overrides.has_sleep;
  if (overrides.has_fan_only !== undefined) result.hasFanOnly = overrides.has_fan_only;
if (overrides.fan_speed_levels !== undefined) result.fanSpeedLevels = overrides.fan_speed_levels;
  if (overrides.temp_min !== undefined) result.tempRange = { ...result.tempRange, min: overrides.temp_min };
  if (overrides.temp_max !== undefined) result.tempRange = { ...result.tempRange, max: overrides.temp_max };
  return result;
}
