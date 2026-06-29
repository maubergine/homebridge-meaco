import { describe, it, expect, vi, beforeEach } from 'vitest';

import { AirConditionerAccessory } from '../../src/accessories/airConditionerAccessory.js';
import type { DeviceConfig } from '../../src/accessories/airConditionerAccessory.js';
import { StateCache } from '../../src/core/stateCache.js';
import { DatapointMap } from '../../src/core/datapointMap.js';
import { Poller } from '../../src/core/poller.js';
import type { CapabilityProfile } from '../../src/core/capabilityProfile.js';
import { createMockLogger, createMockHap, MockAccessory } from '../helpers/homebridgeMock.js';

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
  mode_mappings: { heat: 'none' as const, cool: 'Cool' as const, auto: 'none' as const },
  polling_interval_seconds: 30,
  unresponsive_after_failures: 3,
};

function makeAccy() {
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
  const log = createMockLogger();
  const hbAccessory = new MockAccessory('Living Room AC', 'uuid-1');

  const accy = new AirConditionerAccessory(
    log as never,
    hbAccessory as never,
    cache,
    map,
    PROFILE,
    poller,
    postCommand,
    DEVICE_CONFIG,
    createMockHap() as never,
  );

  return { accy, cache, map, poller, postCommand, hbAccessory };
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

  it('reverts optimistic update after postCommand throws', async () => {
    const { accy, cache, postCommand } = makeAccy();
    postCommand.mockRejectedValueOnce(new Error('command failed'));
    const modeBefore = cache.state['mode'];
    try {
      await accy.testSetTargetState(2);
    } catch {}
    expect(cache.state['mode']).toBe(modeBefore);
  });

  function makeFanSpeedAccy() {
    const profileWithFanEnum: CapabilityProfile = {
      ...PROFILE,
      fanSpeedLevels: ['low', 'mid', 'high', 'auto'],
      rawFunctions: new Map([
        ...PROFILE.rawFunctions,
        ['fan_speed_enum', { code: 'fan_speed_enum', desc: 'Fan speed', name: 'Fan Speed Enum', type: 'Enum', values: '{"range":["low","mid","high","auto"]}' }],
      ]),
    };
    const hbAccessory = new MockAccessory('Test', 'uuid-fan');
    const cache = new StateCache(3);
    cache.recordSuccess({ switch: true, mode: 'Cool', fan_speed_enum: 'low' });
    const map = new DatapointMap(profileWithFanEnum);
    const postCommand = vi.fn().mockResolvedValue(undefined);
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
      config,
      hap as never,
    );
    const svc = hbAccessory.services.get('HeaterCooler')!;
    // The mock proxy stores characteristics keyed by the object reference returned for each
    // Characteristic property access. Retrieve via the same proxy reference.
    const rotChar = svc.characteristics.get(hap.Characteristic.RotationSpeed as never);
    return { rotChar, postCommand };
  }

  it('fan speed <=50% sends low to fan_speed_enum', async () => {
    const { rotChar, postCommand } = makeFanSpeedAccy();
    expect(rotChar).toBeDefined();
    await rotChar!.invokeSet(30);
    expect(postCommand).toHaveBeenCalledWith('dev1', 'fan_speed_enum', 'low');
  });

  it('fan speed >50% sends high to fan_speed_enum', async () => {
    const { rotChar, postCommand } = makeFanSpeedAccy();
    expect(rotChar).toBeDefined();
    await rotChar!.invokeSet(75);
    expect(postCommand).toHaveBeenCalledWith('dev1', 'fan_speed_enum', 'high');
  });
});
