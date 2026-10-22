import type { TuyaChoice } from '../accessories/airConditionerAccessory.js';
import type { TuyaDeviceModelResponse, TuyaSpecResponse } from '../tuya/types.js';
import {
  deriveModeDefaults,
  parseFanSpeedFromModel,
  parseModeRangeFromModel,
  parseSpecification,
} from '../tuya/specParser.js';

import { applyOverrides } from './capabilityProfile.js';
import type { CapabilityOverrides, CapabilityProfile } from './capabilityProfile.js';
import { DatapointMap } from './datapointMap.js';

/**
 * Builds a device's capability profile from its specification, filling gaps from its thing
 * model (Meaco units often list fan speeds only there), then applies any user overrides.
 * Also returns the device's mode range, from the model when there is one.
 */
export function buildProfile(
  spec: TuyaSpecResponse,
  model: TuyaDeviceModelResponse | null,
  overrides?: CapabilityOverrides,
): { profile: CapabilityProfile; modeRange: string[] } {
  const detected = parseSpecification(spec);
  if (model && detected.fanSpeedLevels.length === 0) {
    const modelFanSpeed = parseFanSpeedFromModel(model.result.model);
    if (modelFanSpeed) {
      detected.fanSpeedLevels = modelFanSpeed.levels;
      detected.rawFunctions.set(modelFanSpeed.code, {
        code: modelFanSpeed.code, desc: '', name: 'Fan Speed', type: 'Enum',
        values: JSON.stringify({ range: modelFanSpeed.levels }),
      });
    }
  }
  const profile = applyOverrides(detected, overrides);
  const modeRange = model
    ? parseModeRangeFromModel(model.result.model)
    : [...(profile.hasHeat ? ['Heat'] : []), ...(profile.hasCool ? ['Cool'] : []),
       ...(profile.hasDry ? ['Dyr'] : []), ...(profile.hasFanOnly ? ['Fan'] : [])];
  return { profile, modeRange };
}

/** Per-device settings a device gets when its config entry doesn't set them. */
export interface DeviceDefaults {
  display_type: 'heater_cooler' | 'thermostat' | 'fan_only';
  temperature_unit: 'celsius' | 'fahrenheit' | 'auto';
  expose_child_lock: boolean;
  expose_swing_control: boolean;
  expose_sleep_mode_switch: boolean;
  expose_fan_speed: boolean;
  expose_dry_mode_switch: boolean;
  expose_fan_only_mode_switch: boolean;
  mode_mappings: { heat: TuyaChoice; cool: TuyaChoice; auto: TuyaChoice };
}

/**
 * The settings a device gets when its config entry doesn't set them. It shows as a
 * heater/cooler, in the unit's own temperature unit. Each control defaults
 * on only if the unit has the datapoint behind it. Swing is the exception: it has always
 * defaulted off (as in config.schema.json), so it stays off unless chosen.
 */
export function deriveDeviceDefaults(profile: CapabilityProfile, modeRange: string[]): DeviceDefaults {
  const map = new DatapointMap(profile);
  const modes = deriveModeDefaults(modeRange);
  return {
    display_type: 'heater_cooler',
    temperature_unit: 'auto',
    expose_child_lock: map.resolve('lock') !== undefined,
    expose_swing_control: false,
    expose_sleep_mode_switch: profile.hasSleep,
    expose_fan_speed: map.resolve('fanSpeed') !== undefined,
    expose_dry_mode_switch: modes.expose_dry_mode_switch,
    expose_fan_only_mode_switch: modes.expose_fan_only_mode_switch,
    mode_mappings: modes.mode_mappings,
  };
}
