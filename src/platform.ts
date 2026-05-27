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
import { parseSpecification } from './tuya/specParser.js';
import { applyOverrides } from './core/capabilityProfile.js';
import type { CapabilityOverrides } from './core/capabilityProfile.js';
import { DatapointMap } from './core/datapointMap.js';
import { StateCache } from './core/stateCache.js';
import { Poller } from './core/poller.js';
import { AirConditionerAccessory } from './accessories/airConditionerAccessory.js';
import type { DeviceConfig } from './accessories/airConditionerAccessory.js';

interface PluginConfig extends PlatformConfig {
  cloud_credentials?: {
    tuya_region?: TuyaRegion;
    tuya_access_key?: string;
    tuya_secret_key?: string;
  };
  devices?: Array<{
    tuya_device_id: string;
    display_name?: string;
    display_type?: 'heater_cooler' | 'thermostat' | 'fan_only';
    temperature_unit?: 'celsius' | 'fahrenheit';
    expose_dry_mode_switch?: boolean;
    expose_fan_only_mode_switch?: boolean;
    expose_swing_control?: boolean;
    expose_sleep_mode_switch?: boolean;
    manufacturer?: string;
    model?: string;
    serial_number?: string;
    polling_interval_seconds?: number;
    unresponsive_after_failures?: number;
    capability_overrides?: CapabilityOverrides;
  }>;
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

  constructor(
    private readonly log: Logger,
    private readonly config: PluginConfig,
    private readonly api: API,
  ) {
    this.api.on('didFinishLaunching', () => { void this.discoverDevices(); });
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

    for (const deviceCfg of this.config.devices ?? []) {
      await this.setupDevice(deviceCfg, advanced);
    }
  }

  private async setupDevice(
    rawCfg: NonNullable<PluginConfig['devices']>[number],
    _advanced: NonNullable<PluginConfig['advanced_settings']>,
  ): Promise<void> {
    const client = this.cloudClient!;
    try {
      const specResponse = await client.getDeviceSpecification(rawCfg.tuya_device_id);
      const detected = parseSpecification(specResponse);
      const profile = applyOverrides(detected, rawCfg.capability_overrides);
      const map = new DatapointMap(profile);

      const uuid = this.api.hap.uuid.generate(rawCfg.tuya_device_id);
      const displayName = rawCfg.display_name ?? 'Air Conditioner';

      let accessory = this.accessories.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(displayName, uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
      this.accessories.delete(uuid);

      const cache = new StateCache(
        rawCfg.unresponsive_after_failures ?? DEFAULTS.unresponsiveAfterFailures,
      );

      const poller = new Poller();
      const deviceConfig: DeviceConfig = {
        tuya_device_id: rawCfg.tuya_device_id,
        display_name: displayName,
        display_type: rawCfg.display_type ?? 'heater_cooler',
        temperature_unit: rawCfg.temperature_unit ?? 'celsius',
        expose_dry_mode_switch: rawCfg.expose_dry_mode_switch ?? true,
        expose_fan_only_mode_switch: rawCfg.expose_fan_only_mode_switch ?? true,
        expose_swing_control: rawCfg.expose_swing_control ?? true,
        expose_sleep_mode_switch: rawCfg.expose_sleep_mode_switch ?? false,
        polling_interval_seconds: rawCfg.polling_interval_seconds ?? DEFAULTS.pollingIntervalSeconds,
        unresponsive_after_failures: rawCfg.unresponsive_after_failures ?? DEFAULTS.unresponsiveAfterFailures,
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
      );

      poller.start(deviceConfig.polling_interval_seconds, async () => {
        try {
          const status = await client.getDeviceStatus(rawCfg.tuya_device_id);
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
      this.log.error(`Failed to set up device ${rawCfg.tuya_device_id}: ${String(err)}`);
    }
  }
}
