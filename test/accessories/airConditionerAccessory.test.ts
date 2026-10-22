import { describe, it, expect, vi, beforeEach } from 'vitest';

import { AirConditionerAccessory } from '../../src/accessories/airConditionerAccessory.js';
import type { DeviceConfig } from '../../src/accessories/airConditionerAccessory.js';
import { StateCache } from '../../src/core/stateCache.js';
import { DatapointMap } from '../../src/core/datapointMap.js';
import { Poller } from '../../src/core/poller.js';
import type { CapabilityProfile } from '../../src/core/capabilityProfile.js';
import { createMockLogger, createMockHap, MockAccessory, MockHapStatusError, MockHAPStatus } from '../helpers/homebridgeMock.js';

const PROFILE: CapabilityProfile = {
  hasPower: true,
  hasCool: true,
  hasHeat: false,
  hasDry: true,
  hasFanOnly: true,
  hasSwing: true,
  hasSleep: false,
  fanSpeedLevels: ['low', 'mid', 'high'],
  tempRange: { min: 16, max: 31, step: 0.5, scale: 1 },
  rawFunctions: new Map([
    ['switch', { code: 'switch', desc: '', name: '', type: 'Boolean', values: '{}' }],
    ['mode', { code: 'mode', desc: '', name: '', type: 'Enum', values: '{"range":["Cool","Dyr","Fan"]}' }],
    ['temp_set', { code: 'temp_set', desc: '', name: '', type: 'Integer', values: '{"min":160,"max":310,"scale":1,"step":5}' }],
    ['temp_current', { code: 'temp_current', desc: '', name: '', type: 'Integer', values: '{"min":0,"max":500,"scale":1,"step":1}' }],
    ['windspeed', { code: 'windspeed', desc: '', name: '', type: 'Enum', values: '{"range":["low","mid","high"]}' }],
    ['swing', { code: 'swing', desc: '', name: '', type: 'Boolean', values: '{}' }],
  ]),
};

const DEVICE_CONFIG: DeviceConfig = {
  tuya_device_id: 'dev1',
  display_name: 'Living Room AC',
  manufacturer: 'Meaco',
  model: 'MC10000RPRO',
  serial_number: 'b9a619731aa8b934',
  display_type: 'heater_cooler',
  temperature_unit: 'celsius' as const,
  expose_child_lock: true,
  expose_swing_control: false,
  expose_sleep_mode_switch: true,
  expose_fan_speed: false,
  expose_dry_mode_switch: true,
  expose_fan_only_mode_switch: true,
  mode_mappings: { heat: 'None' as const, cool: 'Cool' as const, auto: 'None' as const },
  polling_interval_seconds: 30,
  unresponsive_after_failures: 3,
};

function makeAccy(config: Partial<DeviceConfig> = {}) {
  const cache = new StateCache(3);
  cache.recordSuccess({
    switch: true,
    mode: 'cold',
    temp_set: 220,
    temp_current: 240,
    windspeed: 'mid',
    swing: false,
  });

  const map = new DatapointMap(PROFILE);
  const poller = new Poller();
  const postCommand = vi.fn().mockResolvedValue(undefined);
  const fetchStatus = vi.fn().mockResolvedValue([]);
  const log = createMockLogger();
  const hbAccessory = new MockAccessory('Living Room AC', 'uuid-1');
  const hap = createMockHap();

  const accy = new AirConditionerAccessory(
    log as never,
    hbAccessory as never,
    cache,
    map,
    PROFILE,
    poller,
    postCommand,
    fetchStatus,
    { ...DEVICE_CONFIG, ...config },
    hap as never,
  );

  // Looks up a characteristic on a primary service; the mock keys them by HAP class.
  const char = (service: string, name: string) =>
    hbAccessory.getService(service)!.getCharacteristic(hap.Characteristic[name] as never);
  const hasChar = (service: string, name: string) =>
    hbAccessory.getService(service)!.characteristics.has(hap.Characteristic[name] as never);

  return { accy, cache, map, poller, postCommand, fetchStatus, hbAccessory, char, hasChar };
}

describe('AirConditionerAccessory', () => {
  it('constructs without throwing', () => {
    expect(() => makeAccy()).not.toThrow();
  });

  it('postCommand called with switch=true when Active set to 1', async () => {
    const { accy, postCommand } = makeAccy();
    await accy.testSetActive(1);
    expect(postCommand).toHaveBeenCalledWith('dev1', 'switch', true);
  });

  it('postCommand called with switch=false when Active set to 0', async () => {
    const { accy, postCommand } = makeAccy();
    await accy.testSetActive(0);
    expect(postCommand).toHaveBeenCalledWith('dev1', 'switch', false);
  });

  it('postCommand sends mode=Cool when TargetHeaterCoolerState set to COOL (2)', async () => {
    const { accy, postCommand } = makeAccy();
    await accy.testSetTargetState(2); // COOL = 2 in HomeKit HeaterCooler
    expect(postCommand).toHaveBeenCalledWith('dev1', 'mode', 'Cool');
  });

  it('postCommand sends temp_set when CoolingThresholdTemperature set', async () => {
    const { accy, postCommand } = makeAccy();
    await accy.testSetCoolingThreshold(24);
    expect(postCommand).toHaveBeenCalledWith('dev1', 'temp_set', 240);
  });

  it('dry mode switch on: sends mode=Dyr and switch=true', async () => {
    const { accy, postCommand } = makeAccy();
    await accy.testSetDryMode(true);
    expect(postCommand).toHaveBeenCalledWith('dev1', 'mode', 'Dyr');
    expect(postCommand).toHaveBeenCalledWith('dev1', 'switch', true);
  });

  it('fan mode switch on: sends mode=Fan and switch=true', async () => {
    const { accy, postCommand } = makeAccy();
    await accy.testSetFanMode(true);
    expect(postCommand).toHaveBeenCalledWith('dev1', 'mode', 'Fan');
    expect(postCommand).toHaveBeenCalledWith('dev1', 'switch', true);
  });

  it('applyPushedStatus merges a partial datapoint map into the cache', () => {
    const { accy, cache } = makeAccy();
    accy.applyPushedStatus({ temp_set: 200 });

    expect(cache.state['temp_set']).toBe(200);
    // Datapoints absent from the push are left as they were.
    expect(cache.state['mode']).toBe('cold');
    expect(cache.state['temp_current']).toBe(240);
  });

  it('applyPushedStatus pushes the merged state to HomeKit without a REST read', () => {
    const { accy, hap, char, fetchStatus } = makeFullAccy({ switch: false, swing: true });
    accy.applyPushedStatus({ switch: true, swing: false });

    expect(char(hap.Characteristic.Active).lastUpdatedValue).toBe(1);
    expect(char(hap.Characteristic.SwingMode).lastUpdatedValue).toBe(0);
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it('applyPushedStatus clears the failure count — a push proves the device is alive', () => {
    const { accy, cache } = makeAccy();
    cache.recordFailure();
    cache.recordFailure();
    cache.recordFailure();
    expect(cache.isResponding()).toBe(false);

    accy.applyPushedStatus({ switch: true });
    expect(cache.isResponding()).toBe(true);
  });

  it('applyPushedStatus overrides an optimistic value — the device is the source of truth', () => {
    const { accy, cache } = makeAccy();
    cache.optimisticSet('mode', 'Fan');
    accy.applyPushedStatus({ mode: 'Cool' });

    expect(cache.state['mode']).toBe('Cool');
    // The optimistic override is spent, so a later revert cannot resurrect it.
    cache.revertOptimistic('mode');
    expect(cache.state['mode']).toBe('Cool');
  });

  it('reverts optimistic update after postCommand throws', async () => {
    const { accy, cache, postCommand } = makeAccy();
    postCommand.mockRejectedValueOnce(new Error('command failed'));
    const modeBefore = cache.state['mode'];
    try {
      await accy.testSetTargetState(2);
    } catch {}
    expect(cache.state['mode']).toBe(modeBefore);
  });

  function makeFanSpeedAccy(stateOverrides: Record<string, boolean | number | string> = {}) {
    const profileWithFanEnum: CapabilityProfile = {
      ...PROFILE,
      fanSpeedLevels: ['Low', 'High'],
      rawFunctions: new Map([
        ...PROFILE.rawFunctions,
        ['fan_speed_enum', { code: 'fan_speed_enum', desc: 'Fan speed', name: 'Fan Speed Enum', type: 'Enum', values: '{"range":["Low","High"]}' }],
      ]),
    };
    const hbAccessory = new MockAccessory('Test', 'uuid-fan');
    const cache = new StateCache(3);
    cache.recordSuccess({ switch: true, mode: 'Cool', fan_speed_enum: 'Low', ...stateOverrides });
    const map = new DatapointMap(profileWithFanEnum);
    const postCommand = vi.fn().mockResolvedValue(undefined);
    const fetchStatus = vi.fn().mockResolvedValue([]);
    const config: DeviceConfig = { ...DEVICE_CONFIG, expose_fan_speed: true };
    const hap = createMockHap();
    new AirConditionerAccessory(
      createMockLogger() as never,
      hbAccessory as never,
      cache,
      map,
      profileWithFanEnum,
      new Poller(),
      postCommand,
      fetchStatus,
      config,
      hap as never,
    );
    const svc = hbAccessory.services.get('HeaterCooler')!;
    // The mock proxy stores characteristics keyed by the object reference returned for each
    // Characteristic property access. Retrieve via the same proxy reference.
    const rotChar = svc.characteristics.get(hap.Characteristic.RotationSpeed as never);
    return { rotChar, postCommand };
  }

  it('slider below 50% sends Low to fan_speed_enum', async () => {
    const { rotChar, postCommand } = makeFanSpeedAccy();
    expect(rotChar).toBeDefined();
    await rotChar!.invokeSet(40);
    expect(postCommand).toHaveBeenCalledWith('dev1', 'fan_speed_enum', 'Low');
  });

  it('slider at exactly 50% sends High to fan_speed_enum', async () => {
    const { rotChar, postCommand } = makeFanSpeedAccy();
    expect(rotChar).toBeDefined();
    await rotChar!.invokeSet(50);
    expect(postCommand).toHaveBeenCalledWith('dev1', 'fan_speed_enum', 'High');
  });

  it('slider above 50% sends High to fan_speed_enum', async () => {
    const { rotChar, postCommand } = makeFanSpeedAccy();
    expect(rotChar).toBeDefined();
    await rotChar!.invokeSet(85);
    expect(postCommand).toHaveBeenCalledWith('dev1', 'fan_speed_enum', 'High');
  });

  it('slider at 0% sends Low (not mapped to off)', async () => {
    const { rotChar, postCommand } = makeFanSpeedAccy();
    expect(rotChar).toBeDefined();
    await rotChar!.invokeSet(0);
    expect(postCommand).toHaveBeenCalledWith('dev1', 'fan_speed_enum', 'Low');
  });

  it('get returns 100 when current speed is High, 25 otherwise', async () => {
    const { rotChar } = makeFanSpeedAccy({ fan_speed_enum: 'High' });
    expect(rotChar!.invokeGet()).toBe(100);
    const { rotChar: lowChar } = makeFanSpeedAccy({ fan_speed_enum: 'Low' });
    expect(lowChar!.invokeGet()).toBe(25);
  });

  // ── Fully-featured accessory: exercises every HeaterCooler get/set handler ────

  function makeFullAccy(stateOverrides: Record<string, boolean | number | string> = {}) {
    const profile: CapabilityProfile = { ...PROFILE, hasHeat: true, hasSleep: true };
    const config: DeviceConfig = {
      ...DEVICE_CONFIG,
      expose_swing_control: true,
      expose_sleep_mode_switch: true,
      expose_child_lock: true,
      expose_fan_speed: true,
      mode_mappings: { heat: 'Heat', cool: 'Cool', auto: 'Dry' },
    };
    const cache = new StateCache(3);
    cache.recordSuccess({
      switch: true,
      mode: 'Heat',
      temp_set: 220,
      temp_current: 240,
      windspeed: 'mid',
      swing: true,
      lock: true,
      sleep: true,
      ...stateOverrides,
    });
    const hap = createMockHap();
    const hbAccessory = new MockAccessory('Full AC', 'uuid-full');
    const postCommand = vi.fn().mockResolvedValue(undefined);
    const fetchStatus = vi.fn().mockResolvedValue([]);
    const poller = new Poller();
    const accy = new AirConditionerAccessory(
      createMockLogger() as never,
      hbAccessory as never,
      cache,
      new DatapointMap(profile),
      profile,
      poller,
      postCommand,
      fetchStatus,
      config,
      hap as never,
    );
    const svc = hbAccessory.services.get('HeaterCooler')!;
    const char = (c: unknown) => svc.characteristics.get(c as never)!;
    return { accy, cache, postCommand, fetchStatus, poller, hap, char };
  }

  it('exposes get handlers reflecting cached state', () => {
    const { hap, char } = makeFullAccy();
    const C = hap.Characteristic;
    expect(char(C.Active).invokeGet()).toBe(1);
    expect(char(C.CurrentHeaterCoolerState).invokeGet())
      .toBe(C.CurrentHeaterCoolerState.HEATING);
    expect(char(C.TargetHeaterCoolerState).invokeGet()).toBe(1); // HEAT
    expect(char(C.CurrentTemperature).invokeGet()).toBe(24);
    expect(char(C.HeatingThresholdTemperature).invokeGet()).toBe(22);
    expect(char(C.CoolingThresholdTemperature).invokeGet()).toBe(22);
    expect(char(C.SwingMode).invokeGet()).toBe(1);
    expect(char(C.LockPhysicalControls).invokeGet()).toBe(1);
    expect(char(C.RotationSpeed).invokeGet()).toBe(25); // 'mid' is not High -> 25
  });

  it('set handler rejects with SERVICE_COMMUNICATION_FAILURE and reverts when postCommand fails', async () => {
    const { hap, char, cache, postCommand } = makeFullAccy({ switch: true });
    postCommand.mockRejectedValueOnce(new Error('cloud down'));
    const rejection = char(hap.Characteristic.Active).invokeSet(0);
    await expect(rejection).rejects.toBeInstanceOf(MockHapStatusError);
    await expect(rejection).rejects.toMatchObject({ hapStatus: MockHAPStatus.SERVICE_COMMUNICATION_FAILURE });
    expect(cache.state['switch']).toBe(true);
  });

  it('CurrentHeaterCoolerState is INACTIVE when powered off', () => {
    const { hap, char } = makeFullAccy({ switch: false });
    const C = hap.Characteristic;
    expect(char(C.CurrentHeaterCoolerState).invokeGet())
      .toBe(C.CurrentHeaterCoolerState.INACTIVE);
  });

  it('CurrentHeaterCoolerState is COOLING in cool mode, target is COOL by default', () => {
    const { hap, char } = makeFullAccy({ mode: 'Cool' });
    const C = hap.Characteristic;
    expect(char(C.CurrentHeaterCoolerState).invokeGet())
      .toBe(C.CurrentHeaterCoolerState.COOLING);
    expect(char(C.TargetHeaterCoolerState).invokeGet()).toBe(2);
  });

  it('CurrentHeaterCoolerState is IDLE and target is AUTO when auto maps to Dry (Dyr)', () => {
    // auto -> 'Dry' wires to Tuya 'Dyr'; an incoming 'Dyr' mode resolves to the Auto state
    const { hap, char } = makeFullAccy({ mode: 'Dyr' });
    const C = hap.Characteristic;
    expect(char(C.CurrentHeaterCoolerState).invokeGet())
      .toBe(C.CurrentHeaterCoolerState.IDLE);
    expect(char(C.TargetHeaterCoolerState).invokeGet()).toBe(0); // AUTO
  });

  it('a target state mapped to Dry sends Tuya mode=Dyr', async () => {
    const { accy, postCommand } = makeFullAccy();
    await accy.testSetTargetState(0); // AUTO -> mapped to 'Dry'
    expect(postCommand).toHaveBeenCalledWith('dev1', 'mode', 'Dyr');
  });

  it('a target state mapped to None sends no command (state is hidden)', async () => {
    const { accy, postCommand } = makeAccy(); // DEVICE_CONFIG maps heat -> 'None'
    await accy.testSetTargetState(1); // HEAT
    expect(postCommand).not.toHaveBeenCalled();
  });

  it('SwingMode set sends encoded swing command', async () => {
    const { hap, char, postCommand } = makeFullAccy();
    await char(hap.Characteristic.SwingMode).invokeSet(0);
    expect(postCommand).toHaveBeenCalledWith('dev1', 'swing', false);
  });

  it('LockPhysicalControls set sends lock command', async () => {
    const { hap, char, postCommand } = makeFullAccy();
    await char(hap.Characteristic.LockPhysicalControls).invokeSet(1);
    expect(postCommand).toHaveBeenCalledWith('dev1', 'lock', true);
  });

  it('HeatingThreshold set sends temp_set', async () => {
    const { hap, char, postCommand } = makeFullAccy();
    await char(hap.Characteristic.HeatingThresholdTemperature).invokeSet(20);
    expect(postCommand).toHaveBeenCalledWith('dev1', 'temp_set', 200);
  });

  it('swing set reverts optimistic update when postCommand fails', async () => {
    const { hap, char, cache, postCommand } = makeFullAccy();
    postCommand.mockRejectedValueOnce(new Error('fail'));
    const before = cache.state['swing'];
    await expect(char(hap.Characteristic.SwingMode).invokeSet(0)).rejects.toThrow();
    expect(cache.state['swing']).toBe(before);
  });

  it('lock set reverts optimistic update when postCommand fails', async () => {
    const { hap, char, cache, postCommand } = makeFullAccy();
    postCommand.mockRejectedValueOnce(new Error('fail'));
    const before = cache.state['lock'];
    await expect(char(hap.Characteristic.LockPhysicalControls).invokeSet(0)).rejects.toThrow();
    expect(cache.state['lock']).toBe(before);
  });

  it('dry mode off restores the previous mode', async () => {
    const { accy, postCommand } = makeFullAccy();
    await accy.testSetDryMode(false);
    expect(postCommand).toHaveBeenCalledWith('dev1', 'mode', 'Cool');
  });

  it('fan mode off restores the previous mode', async () => {
    const { accy, postCommand } = makeFullAccy();
    await accy.testSetFanMode(false);
    expect(postCommand).toHaveBeenCalledWith('dev1', 'mode', 'Cool');
  });

  it('fan mode on then off restores the remembered mode', async () => {
    const { accy, postCommand } = makeFullAccy({ mode: 'Heat' });
    await accy.testSetFanMode(true);
    postCommand.mockClear();
    await accy.testSetFanMode(false);
    expect(postCommand).toHaveBeenCalledWith('dev1', 'mode', 'Heat');
  });

  it('dry mode on reverts both mode and switch when postCommand fails', async () => {
    const { accy, cache, postCommand } = makeFullAccy({ mode: 'Cool', switch: false });
    postCommand.mockRejectedValueOnce(new Error('fail'));
    await expect(accy.testSetDryMode(true)).rejects.toThrow();
    expect(cache.state['mode']).toBe('Cool');
    expect(cache.state['switch']).toBe(false);
  });

  it('fan mode on reverts both mode and switch when postCommand fails', async () => {
    const { accy, cache, postCommand } = makeFullAccy({ mode: 'Cool', switch: false });
    postCommand.mockRejectedValueOnce(new Error('fail'));
    await expect(accy.testSetFanMode(true)).rejects.toThrow();
    expect(cache.state['mode']).toBe('Cool');
    expect(cache.state['switch']).toBe(false);
  });

  it('active set reverts optimistic update when postCommand fails', async () => {
    const { accy, cache, postCommand } = makeFullAccy({ switch: true });
    postCommand.mockRejectedValueOnce(new Error('fail'));
    await expect(accy.testSetActive(0)).rejects.toThrow();
    expect(cache.state['switch']).toBe(true);
  });

  it('cooling threshold set reverts optimistic update when postCommand fails', async () => {
    const { accy, cache, postCommand } = makeFullAccy({ temp_set: 220 });
    postCommand.mockRejectedValueOnce(new Error('fail'));
    await expect(accy.testSetCoolingThreshold(24)).rejects.toThrow();
    expect(cache.state['temp_set']).toBe(220);
  });

  // ── State refresh / cross-service interaction ────────────────────────────────

  it('pollOnce fetches device status, updates the cache, and pushes to all characteristics', async () => {
    const { accy, cache, hap, char, fetchStatus } = makeFullAccy({ switch: false, mode: 'Cool' });
    // The device reports a Fan-mode-with-power-on interaction
    fetchStatus.mockResolvedValueOnce([
      { code: 'switch', value: true },
      { code: 'mode', value: 'Fan' },
      { code: 'swing', value: false },
    ]);
    await accy.pollOnce();
    expect(cache.state['switch']).toBe(true);
    expect(cache.state['mode']).toBe('Fan');
    // Values were pushed to HomeKit, not merely available on demand
    expect(char(hap.Characteristic.Active).lastUpdatedValue).toBe(1);
    expect(char(hap.Characteristic.SwingMode).lastUpdatedValue).toBe(0);
  });

  it('a HomeKit set schedules a refresh that re-reads and pushes the whole device state', async () => {
    vi.useFakeTimers();
    try {
      const { accy, hap, char, fetchStatus, poller } = makeFullAccy({ switch: false });
      poller.start(99999, () => accy.pollOnce());
      // Device-side interaction: the command turns the unit on
      fetchStatus.mockResolvedValue([{ code: 'switch', value: true }]);

      await char(hap.Characteristic.Active).invokeSet(1);
      expect(fetchStatus).not.toHaveBeenCalled(); // settle delay not yet elapsed

      await vi.advanceTimersByTimeAsync(1300);
      expect(fetchStatus).toHaveBeenCalledTimes(1);
      expect(char(hap.Characteristic.Active).lastUpdatedValue).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rapid successive sets coalesce into a single refresh', async () => {
    vi.useFakeTimers();
    try {
      const { accy, hap, char, fetchStatus, poller } = makeFullAccy();
      poller.start(99999, () => accy.pollOnce());
      await char(hap.Characteristic.Active).invokeSet(1);
      await char(hap.Characteristic.Active).invokeSet(0);
      await char(hap.Characteristic.SwingMode).invokeSet(1);
      await vi.advanceTimersByTimeAsync(1300);
      expect(fetchStatus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AirConditionerAccessory display types', () => {
  it('heater_cooler adds a HeaterCooler and no Thermostat or Fanv2', () => {
    const { hbAccessory } = makeAccy();
    expect(hbAccessory.getService('HeaterCooler')).toBeDefined();
    expect(hbAccessory.getService('Thermostat')).toBeUndefined();
    expect(hbAccessory.getService('Fanv2')).toBeUndefined();
  });

  it('removes a cached primary service left from a different display type', () => {
    const cache = new StateCache(3);
    const hb = new MockAccessory('AC', 'uuid-1');
    hb.addService('HeaterCooler');
    new AirConditionerAccessory(
      createMockLogger() as never, hb as never, cache, new DatapointMap(PROFILE), PROFILE, new Poller(),
      vi.fn().mockResolvedValue(undefined), vi.fn().mockResolvedValue([]),
      { ...DEVICE_CONFIG, display_type: 'thermostat' }, createMockHap() as never,
    );
    expect(hb.getService('HeaterCooler')).toBeUndefined();
    expect(hb.getService('Thermostat')).toBeDefined();
  });

  describe('thermostat', () => {
    it('reports Off when powered off and Cool when cooling', () => {
      const { char, cache } = makeAccy({ display_type: 'thermostat' });
      cache.recordSuccess({ switch: true, mode: 'Cool' });
      expect(char('Thermostat', 'TargetHeatingCoolingState').invokeGet()).toBe(2);
      expect(char('Thermostat', 'CurrentHeatingCoolingState').invokeGet()).toBe(2);
      cache.recordSuccess({ switch: false });
      expect(char('Thermostat', 'TargetHeatingCoolingState').invokeGet()).toBe(0);
      expect(char('Thermostat', 'CurrentHeatingCoolingState').invokeGet()).toBe(0);
    });

    it('Off turns the unit off', async () => {
      const { accy, postCommand } = makeAccy({ display_type: 'thermostat' });
      await accy.testSetThermostatTarget(0);
      expect(postCommand).toHaveBeenCalledWith('dev1', 'switch', false);
    });

    it('picking Cool while off sets the mode and turns the unit on', async () => {
      const { accy, cache, postCommand } = makeAccy({ display_type: 'thermostat' });
      cache.recordSuccess({ switch: false });
      await accy.testSetThermostatTarget(2);
      expect(postCommand.mock.calls).toEqual([['dev1', 'mode', 'Cool'], ['dev1', 'switch', true]]);
    });

    it('picking Cool while on only sets the mode', async () => {
      const { accy, postCommand } = makeAccy({ display_type: 'thermostat' });
      await accy.testSetThermostatTarget(2);
      expect(postCommand.mock.calls).toEqual([['dev1', 'mode', 'Cool']]);
    });

    it('a target mapped to None sends nothing', async () => {
      const { accy, postCommand } = makeAccy({ display_type: 'thermostat' });
      await accy.testSetThermostatTarget(1);
      expect(postCommand).not.toHaveBeenCalled();
    });

    it('reverts mode and power when the command fails', async () => {
      const { accy, cache, postCommand } = makeAccy({ display_type: 'thermostat' });
      cache.recordSuccess({ switch: false, mode: 'Fan' });
      postCommand.mockRejectedValueOnce(new Error('offline'));
      await expect(accy.testSetThermostatTarget(2)).rejects.toThrow('offline');
      expect(cache.state.mode).toBe('Fan');
      expect(cache.state.switch).toBe(false);
    });

    it('TargetTemperature sets the setpoint', async () => {
      const { char, postCommand } = makeAccy({ display_type: 'thermostat' });
      expect(char('Thermostat', 'TargetTemperature').invokeGet()).toBe(22);
      await char('Thermostat', 'TargetTemperature').invokeSet(24);
      expect(postCommand).toHaveBeenCalledWith('dev1', 'temp_set', 240);
    });

    it('display units follow the configured unit and ignore HomeKit changes', async () => {
      const { char, postCommand } = makeAccy({ display_type: 'thermostat', temperature_unit: 'fahrenheit' });
      const units = char('Thermostat', 'TemperatureDisplayUnits');
      expect(units.invokeGet()).toBe(1);
      await units.invokeSet(0);
      expect(postCommand).not.toHaveBeenCalled();
    });

    it('adds no fan speed, swing or child lock', () => {
      const { hasChar } = makeAccy({ display_type: 'thermostat', expose_swing_control: true, expose_fan_speed: true });
      expect(hasChar('Thermostat', 'RotationSpeed')).toBe(false);
      expect(hasChar('Thermostat', 'SwingMode')).toBe(false);
      expect(hasChar('Thermostat', 'LockPhysicalControls')).toBe(false);
    });
  });

  describe('fan_only', () => {
    it('is active only when on and in Fan mode', () => {
      const { char, cache } = makeAccy({ display_type: 'fan_only' });
      const active = char('Fanv2', 'Active');
      cache.recordSuccess({ switch: true, mode: 'Cool' });
      expect(active.invokeGet()).toBe(0);
      cache.recordSuccess({ mode: 'Fan' });
      expect(active.invokeGet()).toBe(1);
    });

    it('turning on selects Fan mode and powers on', async () => {
      const { char, postCommand } = makeAccy({ display_type: 'fan_only' });
      await char('Fanv2', 'Active').invokeSet(1);
      expect(postCommand.mock.calls).toEqual([['dev1', 'mode', 'Fan'], ['dev1', 'switch', true]]);
    });

    it('turning off powers the unit off', async () => {
      const { char, postCommand } = makeAccy({ display_type: 'fan_only' });
      await char('Fanv2', 'Active').invokeSet(0);
      expect(postCommand).toHaveBeenCalledWith('dev1', 'switch', false);
    });

    it('keeps swing and child lock on the fan', () => {
      const { hasChar } = makeAccy({ display_type: 'fan_only', expose_swing_control: true });
      expect(hasChar('Fanv2', 'SwingMode')).toBe(true);
      expect(hasChar('Fanv2', 'LockPhysicalControls')).toBe(true);
    });
  });
});
