import type { API, Logger, PlatformAccessory } from 'homebridge';

import type { CapabilityProfile } from '../core/capabilityProfile.js';
import type { DatapointMap } from '../core/datapointMap.js';
import { Poller } from '../core/poller.js';
import { StateCache } from '../core/stateCache.js';
import { BaseAccessory } from './baseAccessory.js';

export type TuyaChoice = 'Heat' | 'Cool' | 'Auto' | 'Fan' | 'none';

export interface DeviceConfig {
  tuya_device_id: string;
  display_name: string;
  manufacturer: string;
  model: string;
  serial_number: string;
  display_type: 'heater_cooler' | 'thermostat' | 'fan_only';
  temperature_unit: 'celsius' | 'fahrenheit';
  expose_child_lock: boolean;
  expose_swing_control: boolean;
  expose_sleep_mode_switch: boolean;
  expose_fan_speed: boolean;
  expose_dry_mode_switch: boolean;
  expose_fan_only_mode_switch: boolean;
  polling_interval_seconds: number;
  unresponsive_after_failures: number;
  mode_mappings: {
    heat: TuyaChoice;
    cool: TuyaChoice;
    auto: TuyaChoice;
  };
}

type PostCommandFn = (deviceId: string, code: string, value: boolean | number | string) => Promise<void>;
type HAP = API['hap'];

const HK_ACTIVE_ACTIVE      = 1;
const HK_HEATER_COOLER_AUTO = 0;
const HK_HEATER_COOLER_HEAT = 1;
const HK_HEATER_COOLER_COOL = 2;

const TUYA_WIRE: Record<Exclude<TuyaChoice, 'none'>, string> = {
  Heat: 'Heat',
  Cool: 'Cool',
  Auto: 'Auto',
  Fan:  'Fan',
};

export class AirConditionerAccessory extends BaseAccessory {
  protected readonly profile: CapabilityProfile;
  private readonly map: DatapointMap;
  protected readonly poller: Poller;
  private readonly postCommand: PostCommandFn;
  private readonly config: DeviceConfig;
  private readonly hap: HAP;
  private previousNonSpecialMode: string | null = null;

  constructor(
    log: Logger,
    accessory: PlatformAccessory,
    stateCache: StateCache,
    map: DatapointMap,
    profile: CapabilityProfile,
    poller: Poller,
    postCommand: PostCommandFn,
    config: DeviceConfig,
    hap: HAP,
  ) {
    super(log, accessory, stateCache);
    this.profile = profile;
    this.map = map;
    this.poller = poller;
    this.postCommand = postCommand;
    this.config = config;
    this.hap = hap;

    this.setupHeaterCoolerService();
    this.setupSleepSwitch();
    this.setupDrySwitch();
    this.setupFanSwitch();
  }

  // ── Mode resolution ─────────────────────────────────────────────────────────

  private resolvedModes(): { heat: string | null; cool: string | null; auto: string | null } {
    const m = this.config.mode_mappings;
    return {
      heat: m.heat === 'none' ? null : TUYA_WIRE[m.heat],
      cool: m.cool === 'none' ? null : TUYA_WIRE[m.cool],
      auto: m.auto === 'none' ? null : TUYA_WIRE[m.auto],
    };
  }

  // ── HomeKit service wiring ──────────────────────────────────────────────────

  private setupSleepSwitch(): void {
    const { Service, Characteristic } = this.hap;
    if (!this.profile.hasSleep || !this.config.expose_sleep_mode_switch) {
      this.removeService(Service.Switch, 'sleep');
      return;
    }
    const dpCode = this.map.resolve('sleep') ?? 'sleep';
    const svc = this.getOrAddService(Service.Switch, 'sleep');
    this.getOrAddService(Service.HeaterCooler).addLinkedService(svc);
    svc.getCharacteristic(Characteristic.Name)?.setValue('Sleep Mode');
    svc.getCharacteristic(Characteristic.On)
      .onGet(() => !!this.stateCache.state[dpCode])
      .onSet(async (value) => {
        const on = value as boolean;
        this.stateCache.optimisticSet(dpCode, on);
        try {
          await this.postCommand(this.config.tuya_device_id, dpCode, on);
        } catch (err) {
          this.stateCache.revertOptimistic(dpCode);
          throw err;
        }
      });
  }

  private setupDrySwitch(): void {
    const { Service, Characteristic } = this.hap;
    if (!this.config.expose_dry_mode_switch) {
      this.removeService(Service.Switch, 'dry');
      return;
    }
    const svc = this.getOrAddService(Service.Switch, 'dry');
    svc.getCharacteristic(Characteristic.Name)?.setValue('Dry Mode');
    svc.getCharacteristic(Characteristic.On)
      .onGet(() => this.stateCache.state['mode'] === 'Dyr')
      .onSet(async (value) => { await this.testSetDryMode(value as boolean); });
  }

  private setupFanSwitch(): void {
    const { Service, Characteristic } = this.hap;
    if (!this.config.expose_fan_only_mode_switch) {
      this.removeService(Service.Switch, 'fan');
      return;
    }
    const svc = this.getOrAddService(Service.Switch, 'fan');
    svc.getCharacteristic(Characteristic.Name)?.setValue('Fan Only');
    svc.getCharacteristic(Characteristic.On)
      .onGet(() => this.stateCache.state['mode'] === 'Fan')
      .onSet(async (value) => { await this.testSetFanMode(value as boolean); });
  }

  private setupHeaterCoolerService(): void {
    const { Service, Characteristic } = this.hap;
    const svc = this.getOrAddService(Service.HeaterCooler);

    // Active (power on/off)
    svc.getCharacteristic(Characteristic.Active)
      .onGet(() => (this.stateCache.state['switch'] ? HK_ACTIVE_ACTIVE : 0))
      .onSet(async (value) => { await this.testSetActive(value as number); });

    // CurrentHeaterCoolerState — derived from switch + mode
    svc.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .onGet(() => this.getCurrentHeaterCoolerState());

    // TargetHeaterCoolerState — driven entirely by mode_mappings; 'none' excludes a state
    const resolvedModes = this.resolvedModes();
    const validTargetStates: number[] = [];
    if (resolvedModes.auto !== null) validTargetStates.push(HK_HEATER_COOLER_AUTO);
    if (resolvedModes.heat !== null) validTargetStates.push(HK_HEATER_COOLER_HEAT);
    if (resolvedModes.cool !== null) validTargetStates.push(HK_HEATER_COOLER_COOL);

    svc.getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .setProps({ validValues: validTargetStates })
      .onGet(() => this.getTargetHeaterCoolerState())
      .onSet(async (value) => { await this.testSetTargetState(value as number); });

    // CurrentTemperature
    if (this.map.resolve('currentTemp')) {
      const cr = this.profile.currentTempRange;
      svc.getCharacteristic(Characteristic.CurrentTemperature)
        .setProps({ minValue: cr?.min ?? 0, maxValue: cr?.max ?? 100, minStep: cr?.step ?? 0.1 })
        .onGet(() => {
          const raw = this.stateCache.state[this.map.resolve('currentTemp') ?? 'temp_current'] as number | undefined;
          return raw !== undefined ? this.map.decodeCurrentTemp(raw) : 20;
        });
    }

    // CoolingThresholdTemperature
    if (this.profile.hasCool) {
      const { min, max, step } = this.profile.tempRange;
      svc.getCharacteristic(Characteristic.CoolingThresholdTemperature)
        .setProps({ minValue: min, maxValue: max, minStep: step })
        .onGet(() => {
          const raw = this.stateCache.state[this.map.resolve('setpoint') ?? 'temp_set'] as number | undefined;
          return raw !== undefined ? this.map.decodeSetpoint(raw) : min;
        })
        .onSet(async (value) => { await this.testSetCoolingThreshold(value as number); });
    }

    // HeatingThresholdTemperature (shares the same DP as cooling setpoint)
    if (this.profile.hasHeat) {
      const { min, max, step } = this.profile.tempRange;
      svc.getCharacteristic(Characteristic.HeatingThresholdTemperature)
        .setProps({ minValue: min, maxValue: max, minStep: step })
        .onGet(() => {
          const raw = this.stateCache.state[this.map.resolve('setpoint') ?? 'temp_set'] as number | undefined;
          return raw !== undefined ? this.map.decodeSetpoint(raw) : min;
        })
        .onSet(async (value) => { await this.testSetCoolingThreshold(value as number); });
    }

    // SwingMode
    if (this.profile.hasSwing && this.config.expose_swing_control) {
      svc.getCharacteristic(Characteristic.SwingMode)
        .onGet(() => (this.stateCache.state['swing'] ? 1 : 0))
        .onSet(async (value) => {
          const on = (value as number) === 1;
          this.stateCache.optimisticSet('swing', on);
          try {
            const encoded = this.map.encodeSwing(on);
            await this.postCommand(this.config.tuya_device_id, encoded.code, encoded.value);
          } catch (err) {
            this.stateCache.revertOptimistic('swing');
            throw err;
          }
        });
    }

    // LockPhysicalControls (child lock)
    if (this.config.expose_child_lock) {
      svc.getCharacteristic(Characteristic.LockPhysicalControls)
        .onGet(() => (this.stateCache.state['lock'] ? 1 : 0))
        .onSet(async (value) => {
          const locked = (value as number) === 1;
          this.stateCache.optimisticSet('lock', locked);
          try {
            await this.postCommand(this.config.tuya_device_id, 'lock', locked);
          } catch (err) {
            this.stateCache.revertOptimistic('lock');
            throw err;
          }
        });
    }

    const fanSpeedCode = this.map.resolve('fanSpeed');
    if (this.config.expose_fan_speed && fanSpeedCode !== undefined) {
      svc.getCharacteristic(Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
        .onGet(() => {
          const level = this.stateCache.state[fanSpeedCode] as string | undefined;
          return level !== undefined ? this.map.decodeFanSpeed(level) : 0;
        })
        .onSet(async (value) => {
          const speed = this.map.encodeFanSpeed(value as number);
          this.stateCache.optimisticSet(fanSpeedCode, speed);
          try {
            await this.postCommand(this.config.tuya_device_id, fanSpeedCode, speed);
          } catch (err) {
            this.stateCache.revertOptimistic(fanSpeedCode);
            throw err;
          }
        });
    }
  }

  private getCurrentHeaterCoolerState(): number {
    const { Characteristic } = this.hap;
    if (!this.stateCache.state['switch']) return Characteristic.CurrentHeaterCoolerState.INACTIVE;
    const mode = this.stateCache.state['mode'] as string | undefined;
    const modes = this.resolvedModes();
    if (mode && mode === modes.heat) return Characteristic.CurrentHeaterCoolerState.HEATING;
    if (mode && mode === modes.cool) return Characteristic.CurrentHeaterCoolerState.COOLING;
    return Characteristic.CurrentHeaterCoolerState.IDLE;
  }

  private getTargetHeaterCoolerState(): number {
    const mode = this.stateCache.state['mode'] as string | undefined;
    const modes = this.resolvedModes();
    if (mode && mode === modes.heat) return HK_HEATER_COOLER_HEAT;
    if (mode && mode === modes.auto) return HK_HEATER_COOLER_AUTO;
    return HK_HEATER_COOLER_COOL;
  }

  // ── Command implementations (also called directly by tests) ────────────────

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
    const modes = this.resolvedModes();
    const mode = hkState === HK_HEATER_COOLER_HEAT ? modes.heat
      : hkState === HK_HEATER_COOLER_AUTO ? modes.auto
      : modes.cool;
    if (!mode) return;
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
      this.previousNonSpecialMode = (this.stateCache.state['mode'] as string | undefined) ?? null;
      this.stateCache.optimisticSet('mode', 'Dyr');
      this.stateCache.optimisticSet('switch', true);
      try {
        await this.postCommand(this.config.tuya_device_id, 'mode', 'Dyr');
        await this.postCommand(this.config.tuya_device_id, 'switch', true);
      } catch (err) {
        this.stateCache.revertOptimistic('mode');
        this.stateCache.revertOptimistic('switch');
        throw err;
      }
    } else {
      const restoreMode = this.previousNonSpecialMode ?? (this.resolvedModes().cool ?? 'Cool');
      this.stateCache.optimisticSet('mode', restoreMode);
      try {
        await this.postCommand(this.config.tuya_device_id, 'mode', restoreMode);
      } catch (err) {
        this.stateCache.revertOptimistic('mode');
        throw err;
      }
    }
  }

  async testSetFanMode(on: boolean): Promise<void> {
    if (on) {
      this.previousNonSpecialMode = (this.stateCache.state['mode'] as string | undefined) ?? null;
      this.stateCache.optimisticSet('mode', 'Fan');
      this.stateCache.optimisticSet('switch', true);
      try {
        await this.postCommand(this.config.tuya_device_id, 'mode', 'Fan');
        await this.postCommand(this.config.tuya_device_id, 'switch', true);
      } catch (err) {
        this.stateCache.revertOptimistic('mode');
        this.stateCache.revertOptimistic('switch');
        throw err;
      }
    } else {
      const restoreMode = this.previousNonSpecialMode ?? (this.resolvedModes().cool ?? 'Cool');
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
