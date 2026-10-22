import type { CloudClient } from '../tuya/cloudClient.js';
import type { TuyaCloudDevice } from '../tuya/types.js';

import { buildProfile, deriveDeviceDefaults } from './deviceDefaults.js';
import type { DeviceDefaults } from './deviceDefaults.js';
import { matchMeacoDevice } from './deviceDetection.js';
import type { MeacoMatch } from './deviceDetection.js';

/** Tuya category for air conditioners. Every Meaco unit seen so far reports it. */
export const AC_CATEGORY = 'kt';

export interface ClassifiedDevices {
  matched: { device: TuyaCloudDevice; match: MeacoMatch }[];
  skipped: TuyaCloudDevice[];
}

/** Splits a Tuya device list into Meaco units and everything else. */
export function classifyDevices(
  devices: readonly TuyaCloudDevice[],
  configuredDeviceIds: ReadonlySet<string>,
): ClassifiedDevices {
  const result: ClassifiedDevices = { matched: [], skipped: [] };
  for (const device of devices) {
    const match = matchMeacoDevice(device, configuredDeviceIds);
    if (match) {
      result.matched.push({ device, match });
    } else {
      result.skipped.push(device);
    }
  }
  return result;
}

/** The capability-based settings a device entry can hold (the fan-only switch has none). */
export type DetectedSettings = Omit<DeviceDefaults, 'expose_fan_only_mode_switch'>;

/**
 * A config entry pre-filled with what Tuya tells us about a device, including every setting
 * that follows from its capabilities, so the form shows what the bridge will actually do.
 */
export type DiscoveredDeviceEntry = {
  tuya_device_id: string;
  enabled: true;
  display_name: string;
  model?: string;
} & Partial<DetectedSettings>;

/** A device entry as saved in config.json: only the settings the user has actually set. */
export interface SavedDeviceEntry {
  tuya_device_id?: string;
  mode_mappings?: Record<string, unknown>;
  [setting: string]: unknown;
}

/** Detected values for settings a saved entry doesn't set yet. */
export interface SettingUpdate {
  tuya_device_id: string;
  settings: Partial<Omit<DetectedSettings, 'mode_mappings'>> & {
    mode_mappings?: Partial<DetectedSettings['mode_mappings']>;
  };
}

export interface DiscoveryResult {
  added: DiscoveredDeviceEntry[];
  /** IDs of Meaco units found that are already in the config. */
  alreadyConfigured: string[];
  /** Settings to fill in on configured units, for the ones their saved entry leaves unset. */
  updates: SettingUpdate[];
  /** Devices in the AC category that weren't recognised as Meaco units. */
  ignored: { id: string; name: string; productName: string; productId: string }[];
}

type DiscoveryClient = Pick<CloudClient, 'listAllDevices' | 'getDeviceModel' | 'getDeviceSpecification'>;

/**
 * Works out a device's capability-based settings from its specification and thing model,
 * the same way the bridge does at startup. Null if the specification can't be read: the
 * bridge works the settings out itself then, and writing guesses here would pin them.
 */
async function detectSettings(client: DiscoveryClient, deviceId: string): Promise<DetectedSettings | null> {
  const [spec, model] = await Promise.all([
    client.getDeviceSpecification(deviceId).catch(() => null),
    // Optional, as when the bridge sets the device up: the spec covers most of it.
    client.getDeviceModel(deviceId).catch(() => null),
  ]);
  if (!spec) return null;
  const { profile, modeRange } = buildProfile(spec, model);
  const settings: Partial<DeviceDefaults> = deriveDeviceDefaults(profile, modeRange);
  // The fan-only switch has no setting of its own; the bridge always derives it.
  delete settings.expose_fan_only_mode_switch;
  return settings as DetectedSettings;
}

/** The detected settings a saved entry leaves unset, or null if it sets them all. */
function unsetSettings(saved: SavedDeviceEntry, detected: DetectedSettings): SettingUpdate['settings'] | null {
  const { mode_mappings: detectedModes, ...flags } = detected;
  const settings: SettingUpdate['settings'] = {};
  for (const key of Object.keys(flags) as (keyof typeof flags)[]) {
    if (saved[key] === undefined) Object.assign(settings, { [key]: flags[key] });
  }
  const savedModes = saved.mode_mappings ?? {};
  const modes: Partial<DetectedSettings['mode_mappings']> = {};
  for (const [key, value] of Object.entries(detectedModes) as [keyof typeof detectedModes, DetectedSettings['mode_mappings']['heat']][]) {
    if (savedModes[key] === undefined) modes[key] = value;
  }
  if (Object.keys(modes).length > 0) settings.mode_mappings = modes;
  return Object.keys(settings).length > 0 ? settings : null;
}

/**
 * Finds Meaco units not yet in the config and builds an entry for each, and works out the
 * settings that configured units' saved entries leave unset. Used by the settings UI's
 * "Discover devices" button, so the user never has to copy IDs or work out per-device
 * settings by hand.
 *
 * `savedDevices` must be the entries as saved in config.json, not as the settings form
 * shows them: the form fills unset fields with schema defaults, so it can't tell them apart
 * from settings the user chose. Settings the user has saved are never touched.
 */
export async function discoverNewDevices(
  client: DiscoveryClient,
  configuredDeviceIds: ReadonlySet<string>,
  savedDevices: readonly SavedDeviceEntry[] = [],
): Promise<DiscoveryResult> {
  const all = await client.listAllDevices(20, AC_CATEGORY);
  const { matched, skipped } = classifyDevices(all, configuredDeviceIds);
  const meaco = matched.map(m => m.device);
  const fresh = meaco.filter(d => !configuredDeviceIds.has(d.id));

  const added = await Promise.all(fresh.map(async (d): Promise<DiscoveredDeviceEntry> => ({
    tuya_device_id: d.id,
    enabled: true,
    display_name: d.customName || d.name,
    ...(d.model ? { model: d.model } : {}),
    ...await detectSettings(client, d.id),
  })));

  const savedById = new Map(savedDevices.filter(e => e.tuya_device_id).map(e => [e.tuya_device_id, e]));
  const updates = (await Promise.all(meaco.map(async (d): Promise<SettingUpdate | null> => {
    const saved = savedById.get(d.id);
    if (!saved) return null;
    const detected = await detectSettings(client, d.id);
    const settings = detected && unsetSettings(saved, detected);
    return settings ? { tuya_device_id: d.id, settings } : null;
  }))).filter((u): u is SettingUpdate => u !== null);

  return {
    added,
    alreadyConfigured: meaco.filter(d => configuredDeviceIds.has(d.id)).map(d => d.id),
    updates,
    ignored: skipped.map(d => ({ id: d.id, name: d.name, productName: d.productName, productId: d.productId })),
  };
}
