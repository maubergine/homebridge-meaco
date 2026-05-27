import { describe, it, expect, vi, beforeEach } from 'vitest';

import { AirConditionerAccessory } from '../../src/accessories/airConditionerAccessory.js';
import { StateCache } from '../../src/core/stateCache.js';
import { DatapointMap } from '../../src/core/datapointMap.js';
import { Poller } from '../../src/core/poller.js';
import type { CapabilityProfile } from '../../src/core/capabilityProfile.js';
import { createMockLogger, MockAccessory } from '../helpers/homebridgeMock.js';

const PROFILE: CapabilityProfile = {
  hasPower: true,
  hasCool: true,
  hasHeat: false,
  hasDry: true,
  hasFanOnly: true,
  hasAuto: false,
  hasSwing: true,
  hasSleep: false,
  fanSpeedLevels: ['low', 'mid', 'high'],
  tempRange: { min: 16, max: 31, step: 0.5, scale: 1 },
  rawFunctions: new Map([
    ['switch', { code: 'switch', desc: '', name: '', type: 'Boolean', values: '{}' }],
    ['mode', { code: 'mode', desc: '', name: '', type: 'Enum', values: '{"range":["cold","wet","wind"]}' }],
    ['temp_set', { code: 'temp_set', desc: '', name: '', type: 'Integer', values: '{"min":160,"max":310,"scale":1,"step":5}' }],
    ['temp_current', { code: 'temp_current', desc: '', name: '', type: 'Integer', values: '{"min":0,"max":500,"scale":1,"step":1}' }],
    ['windspeed', { code: 'windspeed', desc: '', name: '', type: 'Enum', values: '{"range":["low","mid","high"]}' }],
    ['swing', { code: 'swing', desc: '', name: '', type: 'Boolean', values: '{}' }],
  ]),
};

const DEVICE_CONFIG = {
  tuya_device_id: 'dev1',
  display_name: 'Living Room AC',
  display_type: 'heater_cooler' as const,
  temperature_unit: 'celsius' as const,
  expose_dry_mode_switch: true,
  expose_fan_only_mode_switch: true,
  expose_swing_control: true,
  expose_sleep_mode_switch: false,
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

  it('postCommand sends mode=cold when TargetHeaterCoolerState set to COOL (2)', async () => {
    const { accy, postCommand } = makeAccy();
    await accy.testSetTargetState(2); // COOL = 2 in HomeKit HeaterCooler
    expect(postCommand).toHaveBeenCalledWith('dev1', 'mode', 'cold');
  });

  it('postCommand sends temp_set when CoolingThresholdTemperature set', async () => {
    const { accy, postCommand } = makeAccy();
    await accy.testSetCoolingThreshold(24);
    expect(postCommand).toHaveBeenCalledWith('dev1', 'temp_set', 240);
  });

  it('dry mode switch turns on: sends mode=wet and switch=true', async () => {
    const { accy, postCommand } = makeAccy();
    await accy.testSetDryMode(true);
    expect(postCommand).toHaveBeenCalledWith('dev1', 'mode', 'wet');
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
});
