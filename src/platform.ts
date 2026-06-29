import { readFile, writeFile } from 'node:fs/promises';

import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, DEFAULTS } from './settings.js';
import type { TuyaRegion } from './settings.js';
import { CloudClient } from './tuya/cloudClient.js';
import { parseSpecification, parseModeRangeFromModel, deriveModeDefaults } from './tuya/specParser.js';
import { applyOverrides } from './core/capabilityProfile.js';
import type { CapabilityOverrides } from './core/capabilityProfile.js';
import { DatapointMap } from './core/datapointMap.js';
import { StateCache } from './core/stateCache.js';
import { Poller } from './core/poller.js';
import { AirConditionerAccessory } from './accessories/airConditionerAccessory.js';
import type { DeviceConfig, TuyaChoice } from './accessories/airConditionerAccessory.js';

type DeviceOverride = {
  tuya_device_id: string;
  enabled?: boolean;
  display_name?: string;
  display_type?: 'heater_cooler' | 'thermostat' | 'fan_only';
  temperature_unit?: 'celsius' | 'fahrenheit' | 'auto';
  expose_dry_mode_switch?: boolean;
  expose_child_lock?: boolean;
  expose_swing_control?: boolean;
  expose_sleep_mode_switch?: boolean;
  expose_fan_speed?: boolean;
  manufacturer?: string;
  model?: string;
  serial_number?: string;
  polling_interval_seconds?: number;
  unresponsive_after_failures?: number;
  capability_overrides?: CapabilityOverrides;
  mode_mappings?: { heat?: TuyaChoice; cool?: TuyaChoice; auto?: TuyaChoice };
};

interface PluginConfig extends PlatformConfig {
  cloud_credentials?: {
    tuya_region?: TuyaRegion;
    tuya_access_key?: string;
    tuya_secret_key?: string;
  };
  devices?: DeviceOverride[];
  advanced_settings?: {
    request_timeout_ms?: number;
    max_command_retries?: number;
    command_verify_interval_ms?: number;
    debug_logging?: boolean;
  };
}

export class MeacoPlatform implements DynamicPlatformPlugin {
  private readonly accessories: Map<string, PlatformAccessory> = new Map();
  private cloudClient: CloudClient | null = null;
  private readonly pollers: Poller[] = [];

  constructor(
    private readonly log: Logger,
    private readonly config: PluginConfig,
    private readonly api: API,
  ) {
    this.api.on('didFinishLaunching', () => { void this.discoverDevices(); });
    this.api.on('shutdown', () => {
      for (const poller of this.pollers) {
        poller.stop();
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  private async discoverDevices(): Promise<void> {
    const creds = this.config.cloud_credentials;
    if (!creds?.tuya_access_key || !creds.tuya_secret_key) {
      this.log.error('Missing Tuya credentials. Plugin will not load devices.');
      return;
    }

    const advanced = this.config.advanced_settings ?? {};
    this.cloudClient = new CloudClient({
      region: creds.tuya_region ?? DEFAULTS.region,
      accessKey: creds.tuya_access_key,
      secretKey: creds.tuya_secret_key,
      requestTimeoutMs: advanced.request_timeout_ms ?? DEFAULTS.requestTimeoutMs,
    });

    const overridesByDeviceId = new Map<string, DeviceOverride>(
      (this.config.devices ?? []).map(d => [d.tuya_device_id, d]),
    );

    const discovered = await this.cloudClient.listAllDevices(20, 'kt');
    this.log.info(`Discovered ${discovered.length} AC device(s) from Tuya.`);

    const newDevices = discovered.filter(d => !overridesByDeviceId.has(d.id));
    if (newDevices.length > 0) {
      const client = this.cloudClient!;
      const newEntries = await Promise.all(newDevices.map(async (d) => {
        const modelResponse = await client.getDeviceModel(d.id).catch(() => null);
        const modeRange = modelResponse ? parseModeRangeFromModel(modelResponse.result.model) : [];
        const { expose_dry_mode_switch } = deriveModeDefaults(modeRange);
        return {
          tuya_device_id: d.id,
          enabled: true,
          display_name: d.customName || d.name,
          expose_dry_mode_switch,
          ...(d.model ? { model: d.model } : {}),
        };
      }));
      await this.persistNewDevices(newEntries);
    }

    for (const device of discovered) {
      const overrides = overridesByDeviceId.get(device.id);
      if (overrides?.enabled === false) {
        this.log.info(`Skipping disabled device: ${device.name} (${device.id})`);
        continue;
      }
      await this.setupDevice(device.id, overrides, advanced);
    }

    const stale = [...this.accessories.values()];
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} stale accessory/accessories`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }

  private async persistNewDevices(entries: Pick<DeviceOverride, 'tuya_device_id' | 'enabled' | 'display_name' | 'expose_dry_mode_switch'>[]): Promise<void> {
    try {
      const configPath = this.api.user.configPath();
      const raw = await readFile(configPath, 'utf-8');
      const configJson = JSON.parse(raw) as { platforms?: Array<Record<string, unknown>> };
      const platform = configJson.platforms?.find(p => p['platform'] === PLATFORM_NAME);
      if (!platform) return;
      const existing = (platform['devices'] ?? []) as DeviceOverride[];
      platform['devices'] = [...existing, ...entries];
      await writeFile(configPath, JSON.stringify(configJson, null, 4));
      this.log.info(`Added ${entries.length} new device(s) to config: ${entries.map(e => e.tuya_device_id).join(', ')}`);
    } catch (err) {
      this.log.warn(`Could not persist new devices to config: ${String(err)}`);
    }
  }

  private async setupDevice(
    deviceId: string,
    overrides: DeviceOverride | undefined,
    _advanced: NonNullable<PluginConfig['advanced_settings']>,
  ): Promise<void> {
    const client = this.cloudClient!;
    try {
      const [infoResponse, specResponse, modelResponse] = await Promise.all([
        client.getDeviceInfo(deviceId),
        client.getDeviceSpecification(deviceId),
        client.getDeviceModel(deviceId).catch(() => null),
      ]);
      const detected = parseSpecification(specResponse);
      const profile = applyOverrides(detected, overrides?.capability_overrides);

      const modeRange = modelResponse
        ? parseModeRangeFromModel(modelResponse.result.model)
        : [...(profile.hasHeat ? ['Heat'] : []), ...(profile.hasCool ? ['Cool'] : []),
           ...(profile.hasDry ? ['Dyr'] : []), ...(profile.hasFanOnly ? ['Fan'] : [])];
      const modeDefaults = deriveModeDefaults(modeRange);
      const map = new DatapointMap(profile);

      const apiDevice = infoResponse.result;
      const displayName = overrides?.display_name || apiDevice.name || 'Air Conditioner';
      const manufacturer = overrides?.manufacturer ?? 'Meaco';
      const model = overrides?.model ?? apiDevice.model ?? apiDevice.product_id;
      const serialNumber = overrides?.serial_number ?? apiDevice.uuid;

      const cfgUnit = overrides?.temperature_unit ?? 'auto';
      const detectedUnit = apiDevice.status.find(s => s.code === 'temp_unit_convert')?.value === 'f'
        ? 'fahrenheit' : 'celsius';
      const temperatureUnit: 'celsius' | 'fahrenheit' =
        cfgUnit === 'auto' ? detectedUnit : cfgUnit;

      const uuid = this.api.hap.uuid.generate(deviceId);

      let accessory = this.accessories.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(displayName, uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
      this.accessories.delete(uuid);

      accessory.getService(this.api.hap.Service.AccessoryInformation)!
        .setCharacteristic(this.api.hap.Characteristic.Manufacturer, manufacturer)
        .setCharacteristic(this.api.hap.Characteristic.Model, model)
        .setCharacteristic(this.api.hap.Characteristic.SerialNumber, serialNumber);

      const cache = new StateCache(
        overrides?.unresponsive_after_failures ?? DEFAULTS.unresponsiveAfterFailures,
      );

      const poller = new Poller();
      this.pollers.push(poller);
      const deviceConfig: DeviceConfig = {
        tuya_device_id: deviceId,
        display_name: displayName,
        manufacturer,
        model,
        serial_number: serialNumber,
        display_type: overrides?.display_type ?? 'heater_cooler',
        temperature_unit: temperatureUnit,
        expose_child_lock: overrides?.expose_child_lock ?? true,
        expose_swing_control: overrides?.expose_swing_control ?? false,
        expose_sleep_mode_switch: overrides?.expose_sleep_mode_switch ?? true,
        expose_fan_speed: overrides?.expose_fan_speed ?? true,
        expose_dry_mode_switch: overrides?.expose_dry_mode_switch ?? modeDefaults.expose_dry_mode_switch,
        expose_fan_only_mode_switch: modeDefaults.expose_fan_only_mode_switch,
        mode_mappings: {
          heat: overrides?.mode_mappings?.heat ?? modeDefaults.mode_mappings.heat,
          cool: overrides?.mode_mappings?.cool ?? modeDefaults.mode_mappings.cool,
          auto: overrides?.mode_mappings?.auto ?? modeDefaults.mode_mappings.auto,
        },
        polling_interval_seconds: overrides?.polling_interval_seconds ?? DEFAULTS.pollingIntervalSeconds,
        unresponsive_after_failures: overrides?.unresponsive_after_failures ?? DEFAULTS.unresponsiveAfterFailures,
      };

      new AirConditionerAccessory(
        this.log,
        accessory,
        cache,
        map,
        profile,
        poller,
        (id, code, value) => client.postCommand(id, code, value),
        deviceConfig,
        this.api.hap,
      );

      poller.start(deviceConfig.polling_interval_seconds, async () => {
        try {
          const status = await client.getDeviceStatus(deviceId);
          const statusMap: Record<string, boolean | number | string> = {};
          for (const item of status) {
            statusMap[item.code] = item.value as boolean | number | string;
          }
          cache.recordSuccess(statusMap);
        } catch {
          cache.recordFailure();
        }
      });
    } catch (err) {
      this.log.error(`Failed to set up device ${deviceId}: ${String(err)}`);
    }
  }
}
