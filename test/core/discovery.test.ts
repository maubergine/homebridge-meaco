import { readFileSync } from 'node:fs';

import { describe, it, expect, vi } from 'vitest';

import { AC_CATEGORY, classifyDevices, discoverNewDevices } from '../../src/core/discovery.js';
import type { TuyaCloudDevice } from '../../src/tuya/types.js';

const MEACO_PID = 'pgdwirmckucamyz7';

const device = (id: string, overrides: Partial<TuyaCloudDevice> = {}): TuyaCloudDevice =>
  ({
    id,
    name: `Name ${id}`,
    customName: '',
    model: '',
    productId: MEACO_PID,
    productName: 'MeacoCool MC Series 10000 PRO',
    ...overrides,
  }) as TuyaCloudDevice;

// Real capture: switch, temp_set, lock and swing, but no mode, fan speed or sleep.
const MC10000_SPEC: unknown = JSON.parse(
  readFileSync(new URL('../fixtures/specifications/meacocool-mc10000rpro.json', import.meta.url), 'utf8'),
);

const thingModel = (modes: string[], fanSpeeds: string[] = []) => ({
  success: true,
  result: {
    model: JSON.stringify({ services: [{ properties: [
      { code: 'mode', typeSpec: { type: 'enum', range: modes } },
      ...(fanSpeeds.length ? [{ code: 'fan_speed_enum', typeSpec: { type: 'enum', range: fanSpeeds } }] : []),
    ] }] }),
  },
});

const noModel = () => Promise.reject(new Error('no model'));

function makeClient(
  devices: TuyaCloudDevice[],
  { model = noModel, spec = () => Promise.resolve(MC10000_SPEC) }: {
    model?: (id: string) => Promise<unknown>;
    spec?: (id: string) => Promise<unknown>;
  } = {},
) {
  return {
    listAllDevices: vi.fn(() => Promise.resolve(devices)),
    getDeviceModel: vi.fn(model),
    getDeviceSpecification: vi.fn(spec),
  } as unknown as Parameters<typeof discoverNewDevices>[0] & {
    listAllDevices: ReturnType<typeof vi.fn>;
    getDeviceModel: ReturnType<typeof vi.fn>;
    getDeviceSpecification: ReturnType<typeof vi.fn>;
  };
}

describe('classifyDevices', () => {
  it('splits Meaco units from other devices and records why each matched', () => {
    const other = device('x', { productId: 'otherpid00000000', productName: 'Suntec AC' });
    const { matched, skipped } = classifyDevices([device('a'), other], new Set());
    expect(matched).toEqual([{ device: device('a'), match: 'product_id' }]);
    expect(skipped).toEqual([other]);
  });

  it('treats an unrecognised device as Meaco when it is already configured', () => {
    const other = device('x', { productId: 'otherpid00000000', productName: 'Air Conditioner' });
    const { matched } = classifyDevices([other], new Set(['x']));
    expect(matched[0]?.match).toBe('configured');
  });
});

describe('discoverNewDevices', () => {
  it('lists only the AC category', async () => {
    const client = makeClient([]);
    await discoverNewDevices(client, new Set());
    expect(client.listAllDevices).toHaveBeenCalledWith(20, AC_CATEGORY);
  });

  it('builds entries only for devices not already configured', async () => {
    const client = makeClient([device('a'), device('b')]);
    const { added, alreadyConfigured } = await discoverNewDevices(client, new Set(['a']));
    expect(added.map(e => e.tuya_device_id)).toEqual(['b']);
    expect(alreadyConfigured).toEqual(['a']);
    expect(client.getDeviceModel).toHaveBeenCalledTimes(1);
    expect(client.getDeviceSpecification).toHaveBeenCalledTimes(1);
  });

  it('prefers the custom name and includes the model when Tuya reports one', async () => {
    const client = makeClient([device('a', { customName: 'Bedroom AC', model: 'MC10000RPRO' })]);
    const { added } = await discoverNewDevices(client, new Set());
    expect(added[0]).toMatchObject({ tuya_device_id: 'a', enabled: true, display_name: 'Bedroom AC', model: 'MC10000RPRO' });
  });

  it('falls back to the device name and leaves model out when absent', async () => {
    const { added } = await discoverNewDevices(makeClient([device('a')]), new Set());
    expect(added[0]?.display_name).toBe('Name a');
    expect(added[0]).not.toHaveProperty('model');
  });

  it('fills in every capability-based setting, as the bridge would apply them', async () => {
    const client = makeClient([device('a')], { model: () => Promise.resolve(thingModel(['Cool', 'Dyr', 'Fan'], ['Low', 'High'])) });
    const { added } = await discoverNewDevices(client, new Set());
    expect(added[0]).toEqual({
      tuya_device_id: 'a',
      enabled: true,
      display_name: 'Name a',
      display_type: 'heater_cooler',
      temperature_unit: 'auto',
      expose_child_lock: true,
      expose_swing_control: false,
      expose_sleep_mode_switch: false,
      expose_fan_speed: true,
      expose_dry_mode_switch: true,
      mode_mappings: { heat: 'None', cool: 'Cool', auto: 'None' },
    });
  });

  it('maps Heat when the unit can heat', async () => {
    const client = makeClient([device('a')], { model: () => Promise.resolve(thingModel(['Cool', 'Heat'])) });
    const { added } = await discoverNewDevices(client, new Set());
    expect(added[0]?.mode_mappings).toEqual({ heat: 'Heat', cool: 'Cool', auto: 'None' });
    expect(added[0]?.expose_fan_speed).toBe(false);
  });

  it('leaves the settings out when the specification can\'t be read', async () => {
    const client = makeClient([device('a')], { spec: () => Promise.reject(new Error('timeout')) });
    const { added } = await discoverNewDevices(client, new Set());
    expect(added[0]).toEqual({ tuya_device_id: 'a', enabled: true, display_name: 'Name a' });
  });

  describe('settings for units already configured', () => {
    const coolDryFan = { model: () => Promise.resolve(thingModel(['Cool', 'Dyr', 'Fan'], ['Low', 'High'])) };

    it('fills in only the settings the saved entry leaves unset', async () => {
      const saved = [{ tuya_device_id: 'a', expose_sleep_mode_switch: true, expose_dry_mode_switch: false, mode_mappings: { heat: 'Heat' } }];
      const { added, updates } = await discoverNewDevices(makeClient([device('a')], coolDryFan), new Set(['a']), saved);
      expect(added).toEqual([]);
      expect(updates).toEqual([{
        tuya_device_id: 'a',
        settings: {
          display_type: 'heater_cooler',
          temperature_unit: 'auto',
          expose_child_lock: true,
          expose_swing_control: false,
          expose_fan_speed: true,
          mode_mappings: { cool: 'Cool', auto: 'None' },
        },
      }]);
    });

    it('offers nothing when the saved entry sets everything', async () => {
      const saved = [{
        tuya_device_id: 'a', display_type: 'thermostat', temperature_unit: 'celsius', expose_child_lock: false, expose_swing_control: true, expose_sleep_mode_switch: true,
        expose_fan_speed: false, expose_dry_mode_switch: false, mode_mappings: { heat: 'Heat', cool: 'Cool', auto: 'Fan' },
      }];
      const { updates } = await discoverNewDevices(makeClient([device('a')], coolDryFan), new Set(['a']), saved);
      expect(updates).toEqual([]);
    });

    it('leaves units with no saved entry alone, as their settings exist only in the form', async () => {
      const { updates } = await discoverNewDevices(makeClient([device('a')], coolDryFan), new Set(['a']), []);
      expect(updates).toEqual([]);
    });

    it('offers nothing when the specification can\'t be read', async () => {
      const client = makeClient([device('a')], { spec: () => Promise.reject(new Error('timeout')) });
      const { updates } = await discoverNewDevices(client, new Set(['a']), [{ tuya_device_id: 'a' }]);
      expect(updates).toEqual([]);
    });
  });

  it('reports non-Meaco devices as ignored', async () => {
    const other = device('x', { name: 'Garage', productId: 'otherpid00000000', productName: 'Suntec AC' });
    const { added, ignored } = await discoverNewDevices(makeClient([other]), new Set());
    expect(added).toEqual([]);
    expect(ignored).toEqual([{ id: 'x', name: 'Garage', productName: 'Suntec AC', productId: 'otherpid00000000' }]);
  });

  it('propagates a failed device listing', async () => {
    const client = makeClient([]);
    client.listAllDevices.mockRejectedValueOnce(new Error('sign invalid'));
    await expect(discoverNewDevices(client, new Set())).rejects.toThrow('sign invalid');
  });
});
