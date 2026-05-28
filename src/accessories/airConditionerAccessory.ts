import type { Logger, PlatformAccessory } from 'homebridge';

import type { CapabilityProfile } from '../core/capabilityProfile.js';
import type { DatapointMap } from '../core/datapointMap.js';
import { Poller } from '../core/poller.js';
import { StateCache } from '../core/stateCache.js';
import { BaseAccessory } from './baseAccessory.js';

export interface DeviceConfig {
  tuya_device_id: string;
  display_name: string;
  display_type: 'heater_cooler' | 'thermostat' | 'fan_only';
  temperature_unit: 'celsius' | 'fahrenheit';
  expose_dry_mode_switch: boolean;
  expose_fan_only_mode_switch: boolean;
  expose_swing_control: boolean;
  expose_sleep_mode_switch: boolean;
  polling_interval_seconds: number;
  unresponsive_after_failures: number;
}

type PostCommandFn = (deviceId: string, code: string, value: boolean | number | string) => Promise<void>;

const HK_ACTIVE_ACTIVE = 1;
const HK_HEATER_COOLER_COOL = 2;
const HK_HEATER_COOLER_HEAT = 1;

export class AirConditionerAccessory extends BaseAccessory {
  protected readonly profile: CapabilityProfile;
  private readonly map: DatapointMap;
  protected readonly poller: Poller;
  private readonly postCommand: PostCommandFn;
  private readonly config: DeviceConfig;
  private previousNonDryMode: string | null = null;

  constructor(
    log: Logger,
    accessory: PlatformAccessory,
    stateCache: StateCache,
    map: DatapointMap,
    profile: CapabilityProfile,
    poller: Poller,
    postCommand: PostCommandFn,
    config: DeviceConfig,
  ) {
    super(log, accessory, stateCache);
    this.profile = profile;
    this.map = map;
    this.poller = poller;
    this.postCommand = postCommand;
    this.config = config;
  }

  async testSetActive(value: number): Promise<void> {
    const on = value === HK_ACTIVE_ACTIVE;
    this.stateCache.optimisticSet('switch', on);
    try {
      await this.postCommand(this.config.tuya_device_id, 'switch', on);
    } catch (err) {
      this.stateCache.revertOptimistic('switch');
      throw err;
    }
  }

  async testSetTargetState(hkState: number): Promise<void> {
    const mode = hkState === HK_HEATER_COOLER_COOL ? 'cold'
      : hkState === HK_HEATER_COOLER_HEAT ? 'hot'
      : 'auto';
    this.stateCache.optimisticSet('mode', mode);
    try {
      await this.postCommand(this.config.tuya_device_id, 'mode', mode);
    } catch (err) {
      this.stateCache.revertOptimistic('mode');
      throw err;
    }
  }

  async testSetCoolingThreshold(celsius: number): Promise<void> {
    const { code, value } = this.map.encodeSetpoint(celsius, this.config.temperature_unit);
    this.stateCache.optimisticSet(code, value);
    try {
      await this.postCommand(this.config.tuya_device_id, code, value);
    } catch (err) {
      this.stateCache.revertOptimistic(code);
      throw err;
    }
  }

  async testSetDryMode(on: boolean): Promise<void> {
    if (on) {
      this.previousNonDryMode = (this.stateCache.state['mode'] as string | undefined) ?? null;
      this.stateCache.optimisticSet('mode', 'wet');
      this.stateCache.optimisticSet('switch', true);
      try {
        await this.postCommand(this.config.tuya_device_id, 'mode', 'wet');
        await this.postCommand(this.config.tuya_device_id, 'switch', true);
      } catch (err) {
        this.stateCache.revertOptimistic('mode');
        this.stateCache.revertOptimistic('switch');
        throw err;
      }
    } else {
      const restoreMode = this.previousNonDryMode ?? 'cold';
      this.stateCache.optimisticSet('mode', restoreMode);
      try {
        await this.postCommand(this.config.tuya_device_id, 'mode', restoreMode);
      } catch (err) {
        this.stateCache.revertOptimistic('mode');
        throw err;
      }
    }
  }
}
