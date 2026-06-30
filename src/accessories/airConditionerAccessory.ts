import type { API, Characteristic, CharacteristicValue, Logger, PlatformAccessory } from 'homebridge';

import type { CapabilityProfile } from '../core/capabilityProfile.js';
import type { DatapointMap } from '../core/datapointMap.js';
import { Poller } from '../core/poller.js';
import { StateCache } from '../core/stateCache.js';
import type { TuyaStatusItem, TuyaValue } from '../tuya/types.js';

import { BaseAccessory } from './baseAccessory.js';

export type TuyaChoice = 'Cool' | 'Dry' | 'Fan' | 'Heat' | 'None';

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
type FetchStatusFn = () => Promise<TuyaStatusItem[]>;
type HAP = API['hap'];
type Char = Characteristic;

const HK_ACTIVE_ACTIVE      = 1;
const HK_HEATER_COOLER_AUTO = 0;
const HK_HEATER_COOLER_HEAT = 1;
const HK_HEATER_COOLER_COOL = 2;

// Many Tuya operations have interacting side effects (e.g. selecting Fan mode also
// powers the unit on, and changing mode toggles the dry/fan switches). After any
// command we re-read the full device state and push it to every characteristic. A
// short settle delay lets the cloud reflect those side effects before we read back.
const REFRESH_SETTLE_MS = 1200;

// Maps a configured Meaco choice to the value sent to the Tuya `mode` datapoint.
// Most choices pass through transparently; 'Dry' is sent as Tuya's 'Dyr'.
const TUYA_WIRE: Record<Exclude<TuyaChoice, 'None'>, string> = {
  Cool: 'Cool',
  Dry:  'Dyr',
  Fan:  'Fan',
  Heat: 'Heat',
};

export class AirConditionerAccessory extends BaseAccessory {
  protected readonly profile: CapabilityProfile;
  private readonly map: DatapointMap;
  protected readonly poller: Poller;
  private readonly postCommand: PostCommandFn;
  private readonly fetchStatus: FetchStatusFn;
  private readonly config: DeviceConfig;
  private readonly hap: HAP;
  private previousNonSpecialMode: string | null = null;

  // Pushes the current cached state to every bound characteristic.
  private readonly refreshers: (() => void)[] = [];
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    log: Logger,
    accessory: PlatformAccessory,
    stateCache: StateCache,
    map: DatapointMap,
    profile: CapabilityProfile,
    poller: Poller,
    postCommand: PostCommandFn,
    fetchStatus: FetchStatusFn,
    config: DeviceConfig,
    hap: HAP,
  ) {
    super(log, accessory, stateCache);
    this.profile = profile;
    this.map = map;
    this.poller = poller;
    this.postCommand = postCommand;
    this.fetchStatus = fetchStatus;
    this.config = config;
    this.hap = hap;

    this.setupHeaterCoolerService();
    this.setupSleepSwitch();
    this.setupDrySwitch();
    this.setupFanSwitch();
  }

  // ── State refresh ───────────────────────────────────────────────────────────

  /**
   * Registers a get handler and remembers it so the same value can be pushed to
   * HomeKit during a state refresh (rather than only being pulled on demand).
   */
  private bindGet(char: Char, getFn: () => CharacteristicValue): Char {
    char.onGet(getFn);
    this.refreshers.push(() => { char.updateValue(getFn()); });
    return char;
  }

  /**
   * Registers a set handler that, after the command resolves, schedules a refresh
   * of the whole device so interacting side effects surface on every service.
   */
  private bindSet(char: Char, setFn: (value: unknown) => Promise<void>): void {
    char.onSet(async (value) => {
      await setFn(value);
      this.scheduleRefresh();
    });
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.poller.triggerNow();
    }, REFRESH_SETTLE_MS);
  }

  /** Fetches the full device status, updates the cache, and pushes to HomeKit. */
  async pollOnce(): Promise<void> {
    try {
      const status = await this.fetchStatus();
      const statusMap: Record<string, TuyaValue> = {};
      for (const item of status) {
        statusMap[item.code] = item.value;
      }
      this.stateCache.recordSuccess(statusMap);
    } catch {
      this.stateCache.recordFailure();
      return;
    }
    this.pushState();
  }

  /** Pushes the current cached state to every bound characteristic. */
  pushState(): void {
    for (const refresh of this.refreshers) {
      refresh();
    }
  }

  // ── Mode resolution ─────────────────────────────────────────────────────────

  private resolvedModes(): { heat: string | null; cool: string | null; auto: string | null } {
    const m = this.config.mode_mappings;
    return {
      heat: m.heat === 'None' ? null : TUYA_WIRE[m.heat],
      cool: m.cool === 'None' ? null : TUYA_WIRE[m.cool],
      auto: m.auto === 'None' ? null : TUYA_WIRE[m.auto],
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
    const svc = this.getOrAddService(Service.Switch, 'sleep', 'Sleep Mode');
    this.getOrAddService(Service.HeaterCooler).addLinkedService(svc);
    svc.setCharacteristic(Characteristic.ConfiguredName, 'Sleep Mode');
    const c = svc.getCharacteristic(Characteristic.On);
    this.bindGet(c, () => !!this.stateCache.state[dpCode]);
    this.bindSet(c, async (value) => {
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
    const svc = this.getOrAddService(Service.Switch, 'dry', 'Dry Mode');
    this.getOrAddService(Service.HeaterCooler).addLinkedService(svc);
    svc.setCharacteristic(Characteristic.ConfiguredName, 'Dry Mode');
    const c = svc.getCharacteristic(Characteristic.On);
    this.bindGet(c, () => this.stateCache.state.mode === 'Dyr');
    this.bindSet(c, async (value) => { await this.testSetDryMode(value as boolean); });
  }

  private setupFanSwitch(): void {
    const { Service, Characteristic } = this.hap;
    if (!this.config.expose_fan_only_mode_switch) {
      this.removeService(Service.Switch, 'fan');
      return;
    }
    const svc = this.getOrAddService(Service.Switch, 'fan', 'Fan Only');
    this.getOrAddService(Service.HeaterCooler).addLinkedService(svc);
    svc.setCharacteristic(Characteristic.ConfiguredName, 'Fan Only');
    const c = svc.getCharacteristic(Characteristic.On);
    this.bindGet(c, () => this.stateCache.state.mode === 'Fan');
    this.bindSet(c, async (value) => { await this.testSetFanMode(value as boolean); });
  }

  private setupHeaterCoolerService(): void {
    const { Service, Characteristic } = this.hap;
    const svc = this.getOrAddService(Service.HeaterCooler);

    // Make the HeaterCooler the accessory's primary service so its controls
    // (child lock, fan speed, etc.) surface at the accessory's top level rather
    // than being buried behind a per-service sub-page. The Switch services
    // (sleep/dry/fan-only) are linked to it below in their own setup methods.
    svc.setPrimaryService(true);

    // Active (power on/off)
    const active = svc.getCharacteristic(Characteristic.Active);
    this.bindGet(active, () => (this.stateCache.state.switch ? HK_ACTIVE_ACTIVE : 0));
    this.bindSet(active, async (value) => { await this.testSetActive(value as number); });

    // CurrentHeaterCoolerState — derived from switch + mode (read-only)
    this.bindGet(
      svc.getCharacteristic(Characteristic.CurrentHeaterCoolerState),
      () => this.getCurrentHeaterCoolerState(),
    );

    // TargetHeaterCoolerState — driven entirely by mode_mappings; 'None' excludes a state
    const resolvedModes = this.resolvedModes();
    const validTargetStates: number[] = [];
    if (resolvedModes.auto !== null) validTargetStates.push(HK_HEATER_COOLER_AUTO);
    if (resolvedModes.heat !== null) validTargetStates.push(HK_HEATER_COOLER_HEAT);
    if (resolvedModes.cool !== null) validTargetStates.push(HK_HEATER_COOLER_COOL);

    const target = svc.getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .setProps({ validValues: validTargetStates });
    this.bindGet(target, () => this.getTargetHeaterCoolerState());
    this.bindSet(target, async (value) => { await this.testSetTargetState(value as number); });

    // CurrentTemperature (read-only)
    if (this.map.resolve('currentTemp')) {
      const cr = this.profile.currentTempRange;
      const curTemp = svc.getCharacteristic(Characteristic.CurrentTemperature)
        .setProps({ minValue: cr?.min ?? 0, maxValue: cr?.max ?? 100, minStep: cr?.step ?? 0.1 });
      this.bindGet(curTemp, () => {
        const raw = this.stateCache.state[this.map.resolve('currentTemp') ?? 'temp_current'] as number | undefined;
        return raw !== undefined ? this.map.decodeCurrentTemp(raw) : 20;
      });
    }

    // CoolingThresholdTemperature
    if (this.profile.hasCool) {
      const { min, max, step } = this.profile.tempRange;
      const cool = svc.getCharacteristic(Characteristic.CoolingThresholdTemperature)
        .setProps({ minValue: min, maxValue: max, minStep: step });
      this.bindGet(cool, () => {
        const raw = this.stateCache.state[this.map.resolve('setpoint') ?? 'temp_set'] as number | undefined;
        return raw !== undefined ? this.map.decodeSetpoint(raw) : min;
      });
      this.bindSet(cool, async (value) => { await this.testSetCoolingThreshold(value as number); });
    }

    // HeatingThresholdTemperature (shares the same DP as cooling setpoint)
    if (this.profile.hasHeat) {
      const { min, max, step } = this.profile.tempRange;
      const heat = svc.getCharacteristic(Characteristic.HeatingThresholdTemperature)
        .setProps({ minValue: min, maxValue: max, minStep: step });
      this.bindGet(heat, () => {
        const raw = this.stateCache.state[this.map.resolve('setpoint') ?? 'temp_set'] as number | undefined;
        return raw !== undefined ? this.map.decodeSetpoint(raw) : min;
      });
      this.bindSet(heat, async (value) => { await this.testSetCoolingThreshold(value as number); });
    }

    // SwingMode
    if (this.profile.hasSwing && this.config.expose_swing_control) {
      const swing = svc.getCharacteristic(Characteristic.SwingMode);
      this.bindGet(swing, () => (this.stateCache.state.swing ? 1 : 0));
      this.bindSet(swing, async (value) => {
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

    // LockPhysicalControls (child lock) — lives on the HeaterCooler service
    if (this.config.expose_child_lock) {
      const lockCode = this.map.resolve('lock') ?? 'lock';
      const lock = svc.getCharacteristic(Characteristic.LockPhysicalControls);
      this.bindGet(lock, () => (this.stateCache.state[lockCode] ? 1 : 0));
      this.bindSet(lock, async (value) => {
        const locked = (value as number) === 1;
        this.stateCache.optimisticSet(lockCode, locked);
        try {
          await this.postCommand(this.config.tuya_device_id, lockCode, locked);
        } catch (err) {
          this.stateCache.revertOptimistic(lockCode);
          throw err;
        }
      });
    }

    const fanSpeedCode = this.map.resolve('fanSpeed');
    if (this.config.expose_fan_speed && fanSpeedCode === undefined) {
      this.log.warn('expose_fan_speed is enabled but no fan speed datapoint found in device spec (expected fan_speed_enum, windspeed, or fan_speed)');
    }
    if (this.config.expose_fan_speed && fanSpeedCode !== undefined) {
      // HomeKit's RotationSpeed is a 0–100% slider. The Meaco fan datapoint only
      // supports two speeds, so the slider is split at the midpoint: below 50% is
      // Low, 50% and above is High. 0% is treated as Low — it is not mapped to off.
      const fan = svc.getCharacteristic(Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 1 });
      this.bindGet(fan, () => {
        const level = this.stateCache.state[fanSpeedCode] as string | undefined;
        return level?.toLowerCase() === 'high' ? 100 : 25;
      });
      this.bindSet(fan, async (value) => {
        const speed = (value as number) >= 50 ? 'High' : 'Low';
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
    if (!this.stateCache.state.switch) return Characteristic.CurrentHeaterCoolerState.INACTIVE;
    const mode = this.stateCache.state.mode as string | undefined;
    const modes = this.resolvedModes();
    if (mode && mode === modes.heat) return Characteristic.CurrentHeaterCoolerState.HEATING;
    if (mode && mode === modes.cool) return Characteristic.CurrentHeaterCoolerState.COOLING;
    return Characteristic.CurrentHeaterCoolerState.IDLE;
  }

  private getTargetHeaterCoolerState(): number {
    const mode = this.stateCache.state.mode as string | undefined;
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
      this.previousNonSpecialMode = (this.stateCache.state.mode as string | undefined) ?? null;
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
      this.previousNonSpecialMode = (this.stateCache.state.mode as string | undefined) ?? null;
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
