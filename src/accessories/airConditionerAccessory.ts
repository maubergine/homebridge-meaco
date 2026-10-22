import type { API, Characteristic, CharacteristicValue, Logger, PlatformAccessory, Service, WithUUID } from 'homebridge';

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
const HK_THERMOSTAT_OFF     = 0;
const HK_THERMOSTAT_HEAT    = 1;
const HK_THERMOSTAT_COOL    = 2;
const HK_THERMOSTAT_AUTO    = 3;

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

    const primary = this.setupPrimaryService();
    this.setupSleepSwitch(primary);
    this.setupDrySwitch(primary);
    this.setupFanSwitch(primary);
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
   * Registers a set handler that schedules a refresh of the whole device once the
   * command settles, so interacting side effects surface on every service. A failed
   * command is logged once here and surfaced to HomeKit as a communication failure
   * (the inner handlers revert their optimistic state and rethrow). The refresh still
   * runs after a failure so HomeKit re-syncs with the device's real state.
   */
  private bindSet(char: Char, setFn: (value: unknown) => Promise<void>): void {
    char.onSet(async (value) => {
      try {
        await setFn(value);
      } catch (err) {
        if (err instanceof this.hap.HapStatusError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(
          `Command failed for ${this.accessory.displayName} (${this.config.tuya_device_id}), ${char.displayName}: ${message}`,
        );
        throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      } finally {
        this.scheduleRefresh();
      }
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
      const statusMap: Record<string, TuyaValue> = Object.fromEntries(
        status.map((item) => [item.code, item.value]),
      );
      this.stateCache.recordSuccess(statusMap);
    } catch {
      this.stateCache.recordFailure();
      return;
    }
    this.pushState();
  }

  /**
   * Applies a partial datapoint map pushed by the Tuya Message Service, then
   * refreshes HomeKit. The cache merges rather than replaces, so a push carrying
   * only the datapoints that changed layers correctly onto the last known state.
   *
   * A push is authoritative device state, so `recordSuccess` clearing the failure
   * count and any optimistic override is the behaviour we want — if a push races a
   * command we just sent, the device's own value wins.
   */
  applyPushedStatus(changed: Record<string, TuyaValue>): void {
    this.stateCache.recordSuccess(changed);
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

  private setupSleepSwitch(primary: Service): void {
    const { Service, Characteristic } = this.hap;
    if (!this.profile.hasSleep || !this.config.expose_sleep_mode_switch) {
      this.removeService(Service.Switch, 'sleep');
      return;
    }
    const dpCode = this.map.resolve('sleep') ?? 'sleep';
    const svc = this.getOrAddService(Service.Switch, 'sleep', 'Sleep Mode');
    primary.addLinkedService(svc);
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

  private setupDrySwitch(primary: Service): void {
    const { Service, Characteristic } = this.hap;
    if (!this.config.expose_dry_mode_switch) {
      this.removeService(Service.Switch, 'dry');
      return;
    }
    const svc = this.getOrAddService(Service.Switch, 'dry', 'Dry Mode');
    primary.addLinkedService(svc);
    svc.setCharacteristic(Characteristic.ConfiguredName, 'Dry Mode');
    const c = svc.getCharacteristic(Characteristic.On);
    this.bindGet(c, () => this.stateCache.state.mode === 'Dyr');
    this.bindSet(c, async (value) => { await this.testSetDryMode(value as boolean); });
  }

  private setupFanSwitch(primary: Service): void {
    const { Service, Characteristic } = this.hap;
    // As a fan, the accessory's own power control already selects Fan mode.
    if (!this.config.expose_fan_only_mode_switch || this.config.display_type === 'fan_only') {
      this.removeService(Service.Switch, 'fan');
      return;
    }
    const svc = this.getOrAddService(Service.Switch, 'fan', 'Fan Only');
    primary.addLinkedService(svc);
    svc.setCharacteristic(Characteristic.ConfiguredName, 'Fan Only');
    const c = svc.getCharacteristic(Characteristic.On);
    this.bindGet(c, () => this.stateCache.state.mode === 'Fan');
    this.bindSet(c, async (value) => { await this.testSetFanMode(value as boolean); });
  }

  /**
   * Adds the service HomeKit shows the unit as, chosen by `display_type`, and
   * removes the other types' services left in the cache from a previous choice.
   */
  private setupPrimaryService(): Service {
    const { Service } = this.hap;
    const services: Record<DeviceConfig['display_type'], WithUUID<typeof Service>> = {
      heater_cooler: Service.HeaterCooler,
      thermostat: Service.Thermostat,
      fan_only: Service.Fanv2,
    };
    for (const [type, ServiceClass] of Object.entries(services)) {
      if (type !== this.config.display_type) this.removeService(ServiceClass);
    }
    const svc = this.getOrAddService(services[this.config.display_type]);

    // Make it the accessory's primary service so its controls (child lock, fan
    // speed, etc.) surface at the accessory's top level rather than being buried
    // behind a per-service sub-page. The Switch services (sleep/dry/fan-only) are
    // linked to it in their own setup methods.
    svc.setPrimaryService(true);

    switch (this.config.display_type) {
      case 'thermostat': this.setupThermostat(svc); break;
      case 'fan_only': this.setupFan(svc); break;
      default: this.setupHeaterCooler(svc);
    }
    return svc;
  }

  private setupHeaterCooler(svc: Service): void {
    const { Characteristic } = this.hap;

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

    if (this.map.resolve('currentTemp')) this.bindCurrentTemperature(svc);

    // CoolingThresholdTemperature
    if (this.profile.hasCool) {
      const { min, max, step } = this.profile.tempRange;
      const cool = svc.getCharacteristic(Characteristic.CoolingThresholdTemperature)
        .setProps({ minValue: min, maxValue: max, minStep: step });
      this.bindGet(cool, () => this.getSetpoint());
      this.bindSet(cool, async (value) => { await this.testSetCoolingThreshold(value as number); });
    }

    // HeatingThresholdTemperature (shares the same DP as cooling setpoint)
    if (this.profile.hasHeat) {
      const { min, max, step } = this.profile.tempRange;
      const heat = svc.getCharacteristic(Characteristic.HeatingThresholdTemperature)
        .setProps({ minValue: min, maxValue: max, minStep: step });
      this.bindGet(heat, () => this.getSetpoint());
      this.bindSet(heat, async (value) => { await this.testSetCoolingThreshold(value as number); });
    }

    this.bindFanControls(svc);
  }

  /**
   * Thermostat view. It has no power control of its own, so Off in the mode
   * picker turns the unit off, and picking a mode turns it back on. HomeKit
   * doesn't allow fan speed, swing or child lock on a thermostat.
   */
  private setupThermostat(svc: Service): void {
    const { Characteristic } = this.hap;

    // CurrentHeatingCoolingState has no idle value, so dry and fan modes show as Off.
    this.bindGet(svc.getCharacteristic(Characteristic.CurrentHeatingCoolingState), () => {
      if (!this.stateCache.state.switch) return HK_THERMOSTAT_OFF;
      const mode = this.stateCache.state.mode as string | undefined;
      const modes = this.resolvedModes();
      if (mode === modes.heat) return HK_THERMOSTAT_HEAT;
      if (mode === modes.cool) return HK_THERMOSTAT_COOL;
      return HK_THERMOSTAT_OFF;
    });

    const modes = this.resolvedModes();
    const validTargetStates = [HK_THERMOSTAT_OFF];
    if (modes.heat !== null) validTargetStates.push(HK_THERMOSTAT_HEAT);
    if (modes.cool !== null) validTargetStates.push(HK_THERMOSTAT_COOL);
    if (modes.auto !== null) validTargetStates.push(HK_THERMOSTAT_AUTO);
    const target = svc.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .setProps({ validValues: validTargetStates });
    this.bindGet(target, () => {
      if (!this.stateCache.state.switch) return HK_THERMOSTAT_OFF;
      const mode = this.stateCache.state.mode as string | undefined;
      if (mode === modes.heat) return HK_THERMOSTAT_HEAT;
      if (mode === modes.auto) return HK_THERMOSTAT_AUTO;
      return HK_THERMOSTAT_COOL;
    });
    this.bindSet(target, async (value) => { await this.testSetThermostatTarget(value as number); });

    this.bindCurrentTemperature(svc);

    const { min, max, step } = this.profile.tempRange;
    const setpoint = svc.getCharacteristic(Characteristic.TargetTemperature)
      .setProps({ minValue: min, maxValue: max, minStep: step });
    this.bindGet(setpoint, () => this.getSetpoint());
    this.bindSet(setpoint, async (value) => { await this.testSetCoolingThreshold(value as number); });

    // Display units are a HomeKit-side preference; the unit keeps its own setting.
    const units = svc.getCharacteristic(Characteristic.TemperatureDisplayUnits);
    this.bindGet(units, () => (this.config.temperature_unit === 'fahrenheit'
      ? Characteristic.TemperatureDisplayUnits.FAHRENHEIT
      : Characteristic.TemperatureDisplayUnits.CELSIUS));
    units.onSet(() => undefined);
  }

  /** Fan view: on means running in Fan mode; the setpoint and modes are hidden. */
  private setupFan(svc: Service): void {
    const { Characteristic } = this.hap;
    const active = svc.getCharacteristic(Characteristic.Active);
    this.bindGet(active, () =>
      (this.stateCache.state.switch && this.stateCache.state.mode === 'Fan' ? HK_ACTIVE_ACTIVE : 0));
    this.bindSet(active, async (value) => {
      if (value === HK_ACTIVE_ACTIVE) {
        await this.testSetFanMode(true);
      } else {
        await this.testSetActive(0);
      }
    });
    this.bindFanControls(svc);
  }

  private bindCurrentTemperature(svc: Service): void {
    const cr = this.profile.currentTempRange;
    const curTemp = svc.getCharacteristic(this.hap.Characteristic.CurrentTemperature)
      .setProps({ minValue: cr?.min ?? 0, maxValue: cr?.max ?? 100, minStep: cr?.step ?? 0.1 });
    this.bindGet(curTemp, () => {
      const raw = this.stateCache.state[this.map.resolve('currentTemp') ?? 'temp_current'] as number | undefined;
      return raw !== undefined ? this.map.decodeCurrentTemp(raw) : 20;
    });
  }

  private getSetpoint(): number {
    const raw = this.stateCache.state[this.map.resolve('setpoint') ?? 'temp_set'] as number | undefined;
    return raw !== undefined ? this.map.decodeSetpoint(raw) : this.profile.tempRange.min;
  }

  /** Swing, child lock and fan speed: valid on the heater/cooler and fan views. */
  private bindFanControls(svc: Service): void {
    const { Characteristic } = this.hap;

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

    // LockPhysicalControls (child lock)
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
    if (mode === modes.heat) return Characteristic.CurrentHeaterCoolerState.HEATING;
    if (mode === modes.cool) return Characteristic.CurrentHeaterCoolerState.COOLING;
    return Characteristic.CurrentHeaterCoolerState.IDLE;
  }

  private getTargetHeaterCoolerState(): number {
    const mode = this.stateCache.state.mode as string | undefined;
    const modes = this.resolvedModes();
    if (mode === modes.heat) return HK_HEATER_COOLER_HEAT;
    if (mode === modes.auto) return HK_HEATER_COOLER_AUTO;
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

  async testSetThermostatTarget(hkState: number): Promise<void> {
    if (hkState === HK_THERMOSTAT_OFF) {
      await this.testSetActive(0);
      return;
    }
    const modes = this.resolvedModes();
    const mode = hkState === HK_THERMOSTAT_HEAT ? modes.heat
      : hkState === HK_THERMOSTAT_AUTO ? modes.auto
      : modes.cool;
    if (!mode) return;
    const wasOn = !!this.stateCache.state.switch;
    this.stateCache.optimisticSet('mode', mode);
    this.stateCache.optimisticSet('switch', true);
    try {
      await this.postCommand(this.config.tuya_device_id, 'mode', mode);
      if (!wasOn) await this.postCommand(this.config.tuya_device_id, 'switch', true);
    } catch (err) {
      this.stateCache.revertOptimistic('mode');
      this.stateCache.revertOptimistic('switch');
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
      const restoreMode = this.previousNonSpecialMode ?? this.resolvedModes().cool ?? 'Cool';
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
      const restoreMode = this.previousNonSpecialMode ?? this.resolvedModes().cool ?? 'Cool';
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
