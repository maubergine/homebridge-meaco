import { hostname } from 'node:os';

import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, DEFAULTS } from './settings.js';
import type { TuyaPulsarEnv, TuyaRegion } from './settings.js';
import { CloudClient } from './tuya/cloudClient.js';
import { PulsarClient, resolveConsumerName } from './tuya/pulsarClient.js';
import { buildProfile, deriveDeviceDefaults } from './core/deviceDefaults.js';
import type { CapabilityOverrides } from './core/capabilityProfile.js';
import { AC_CATEGORY, classifyDevices } from './core/discovery.js';
import { DatapointMap } from './core/datapointMap.js';
import { StateCache } from './core/stateCache.js';
import { Poller } from './core/poller.js';
import { AirConditionerAccessory } from './accessories/airConditionerAccessory.js';
import type { DeviceConfig, TuyaChoice } from './accessories/airConditionerAccessory.js';

const DISCOVERY_RETRY_MIN_MS = 30_000;
const DISCOVERY_RETRY_MAX_MS = 15 * 60_000;

interface DeviceOverride {
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
}

interface PluginConfig extends PlatformConfig {
  cloud_credentials?: {
    tuya_region?: TuyaRegion;
    tuya_access_key?: string;
    tuya_secret_key?: string;
  };
  devices?: DeviceOverride[];
  use_message_service?: boolean;
  polling_interval_seconds?: number;
  advanced_settings?: {
    request_timeout_ms?: number;
    message_service_env?: TuyaPulsarEnv;
    message_service_subscription?: string;
    message_service_consumer_name?: string;
  };
}

export class MeacoPlatform implements DynamicPlatformPlugin {
  private readonly accessories = new Map<string, PlatformAccessory>();
  /** Routing table for pushed messages, keyed by Tuya device ID. */
  private readonly accessoriesByDeviceId = new Map<string, AirConditionerAccessory>();
  private cloudClient: CloudClient | null = null;
  private pulsarClient: PulsarClient | null = null;
  private readonly pollers: Poller[] = [];
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelayMs = DISCOVERY_RETRY_MIN_MS;
  private setupStarted = false;

  constructor(
    private readonly log: Logger,
    private readonly config: PluginConfig,
    private readonly api: API,
  ) {
    this.api.on('didFinishLaunching', () => { void this.discoverDevices(); });
    this.api.on('shutdown', () => {
      if (this.retryTimer !== null) clearTimeout(this.retryTimer);
      for (const poller of this.pollers) {
        poller.stop();
      }
      this.pulsarClient?.stop();
    });
  }

  /** True when device updates arrive by push and REST polling is only a fallback. */
  private get pushEnabled(): boolean {
    return this.config.use_message_service ?? DEFAULTS.useMessageService;
  }

  /**
   * Resolves a device's poll interval: per-device override, then the platform
   * default, then a built-in. With push active the poll is only a reconciliation
   * safety net, so a floor is applied to stop a polling-era override from burning
   * through the API allowance.
   */
  private resolvePollingInterval(deviceId: string, override: number | undefined): number {
    const fallback = this.pushEnabled
      ? DEFAULTS.pushPollingIntervalSeconds
      : DEFAULTS.pollingIntervalSeconds;
    const configured = override ?? this.config.polling_interval_seconds ?? fallback;
    if (!this.pushEnabled) return configured;

    const floored = Math.max(configured, DEFAULTS.pushMinPollingIntervalSeconds);
    if (floored !== configured) {
      this.log.info(
        `Device ${deviceId}: raising poll interval from ${configured}s to ${floored}s — ` +
        'Message Service is on, so polling is only a fallback.',
      );
    }
    return floored;
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * Runs discovery, retrying with backoff if Tuya can't be reached. Cached
   * accessories are left alone until it succeeds, so a Tuya outage at startup
   * doesn't wipe the user's rooms and automations.
   */
  private async discoverDevices(): Promise<void> {
    try {
      await this.loadDevices();
    } catch (err) {
      // Past this point devices have pollers and handlers; a retry would double them.
      if (this.setupStarted) {
        this.log.error(`Device discovery failed: ${String(err)}`);
        return;
      }
      this.log.error(
        `Could not load devices from Tuya: ${String(err)}. Retrying in ${this.retryDelayMs / 1000}s.`,
      );
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        void this.discoverDevices();
      }, this.retryDelayMs);
      this.retryDelayMs = Math.min(this.retryDelayMs * 2, DISCOVERY_RETRY_MAX_MS);
    }
  }

  private async loadDevices(): Promise<void> {
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
    const client = this.cloudClient;

    // One Pulsar connection serves every device — the subscription is per cloud
    // project, not per device.
    if (this.pushEnabled) {
      // A blank entry in the UI means "use the default suffix", not "use Tuya's
      // shared subscription" — that is only reached by the fallback below.
      const configured = advanced.message_service_subscription?.trim() ?? '';
      const subscription = configured === '' ? DEFAULTS.messageServiceSubscription : configured;
      this.pulsarClient = new PulsarClient(
        {
          region: creds.tuya_region ?? DEFAULTS.region,
          accessKey: creds.tuya_access_key,
          secretKey: creds.tuya_secret_key,
          env: advanced.message_service_env ?? DEFAULTS.messageServiceEnv,
          subscription,
          consumerName: resolveConsumerName(advanced.message_service_consumer_name, hostname()),
        },
        this.log,
      );
      this.pulsarClient.onDeviceStatus((devId, changed) => {
        const accessory = this.accessoriesByDeviceId.get(devId);
        if (!accessory) return;
        this.log.debug(`Push update for ${devId}: ${JSON.stringify(changed)}`);
        accessory.applyPushedStatus(changed);
      });
      // The client applies this only while on the shared default subscription,
      // where acking a message consumes it for every other consumer too. It has to
      // decide that, not us: a rejected subscription can demote it at runtime.
      this.pulsarClient.setDeviceFilter((devId) => this.accessoriesByDeviceId.has(devId));
    } else {
      this.log.info('Message Service disabled — falling back to REST polling only.');
    }

    const overridesByDeviceId = new Map<string, DeviceOverride>(
      (this.config.devices ?? []).map(d => [d.tuya_device_id, d]),
    );

    const allInCategory = await client.listAllDevices(20, AC_CATEGORY);
    const { matched, skipped } = classifyDevices(allInCategory, new Set(overridesByDeviceId.keys()));
    for (const { device: d, match } of matched) {
      this.log.debug(`Device ${d.id} (${d.productName}, ${d.productId}) matched by ${match}.`);
    }
    const discovered = matched.map(m => m.device);
    this.log.info(
      `Discovered ${discovered.length} Meaco AC device(s) from Tuya` +
      (skipped.length > 0 ? ` (ignored ${skipped.length} non-Meaco device(s) in category 'kt').` : '.'),
    );
    for (const d of skipped) {
      this.log.info(
        `Ignored device ${d.id}: product "${d.productName}" (${d.productId}). If this is a Meaco ` +
        'air conditioner, add its device ID under "devices" in the plugin config and restart.',
      );
    }

    const unconfigured = discovered.filter(d => !overridesByDeviceId.has(d.id));
    if (unconfigured.length > 0) {
      this.log.info(
        `${unconfigured.length} device(s) aren't in the plugin config, so they run on detected defaults. ` +
        'To customise them, open the plugin settings and click "Discover devices".',
      );
    }

    this.setupStarted = true;
    for (const device of discovered) {
      const overrides = overridesByDeviceId.get(device.id);
      if (overrides?.enabled === false) {
        this.log.info(`Skipping disabled device: ${device.name} (${device.id})`);
        continue;
      }
      if (!await this.setupDevice(device.id, overrides, client)) {
        // Take it off the stale list so its cached accessory survives: removing it
        // would drop the device's room and automations over a passing Tuya error.
        this.accessories.delete(this.api.hap.uuid.generate(device.id));
      }
    }

    const stale = [...this.accessories.values()];
    if (stale.length > 0) {
      this.log.info(`Removing ${stale.length} stale accessory/accessories`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }

    // Connect last: every device has already been seeded with a REST read, so the
    // first pushed change lands on top of known-good state rather than an empty cache.
    this.pulsarClient?.start();
  }

  private async setupDevice(
    deviceId: string,
    overrides: DeviceOverride | undefined,
    client: CloudClient,
  ): Promise<boolean> {
    try {
      const [infoResponse, specResponse, modelResponse] = await Promise.all([
        client.getDeviceInfo(deviceId),
        client.getDeviceSpecification(deviceId),
        client.getDeviceModel(deviceId).catch(() => null),
      ]);
      const { profile, modeRange } = buildProfile(specResponse, modelResponse, overrides?.capability_overrides);
      const defaults = deriveDeviceDefaults(profile, modeRange);
      const map = new DatapointMap(profile);

      const apiDevice = infoResponse.result;
      const displayName = overrides?.display_name ?? apiDevice.name;
      const manufacturer = overrides?.manufacturer ?? 'Meaco';
      const model = overrides?.model ?? apiDevice.model;
      const serialNumber = overrides?.serial_number ?? apiDevice.uuid;

      const cfgUnit = overrides?.temperature_unit ?? defaults.temperature_unit;
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

      accessory.getService(this.api.hap.Service.AccessoryInformation)
        ?.setCharacteristic(this.api.hap.Characteristic.Manufacturer, manufacturer)
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
        display_type: overrides?.display_type ?? defaults.display_type,
        temperature_unit: temperatureUnit,
        expose_child_lock: overrides?.expose_child_lock ?? defaults.expose_child_lock,
        expose_swing_control: overrides?.expose_swing_control ?? defaults.expose_swing_control,
        expose_sleep_mode_switch: overrides?.expose_sleep_mode_switch ?? defaults.expose_sleep_mode_switch,
        expose_fan_speed: overrides?.expose_fan_speed ?? defaults.expose_fan_speed,
        expose_dry_mode_switch: overrides?.expose_dry_mode_switch ?? defaults.expose_dry_mode_switch,
        expose_fan_only_mode_switch: defaults.expose_fan_only_mode_switch,
        mode_mappings: {
          heat: overrides?.mode_mappings?.heat ?? defaults.mode_mappings.heat,
          cool: overrides?.mode_mappings?.cool ?? defaults.mode_mappings.cool,
          auto: overrides?.mode_mappings?.auto ?? defaults.mode_mappings.auto,
        },
        polling_interval_seconds: this.resolvePollingInterval(deviceId, overrides?.polling_interval_seconds),
        unresponsive_after_failures: overrides?.unresponsive_after_failures ?? DEFAULTS.unresponsiveAfterFailures,
      };

      const airConditioner = new AirConditionerAccessory(
        this.log,
        accessory,
        cache,
        map,
        profile,
        poller,
        (id, code, value) => client.postCommand(id, code, value),
        () => client.getDeviceStatus(deviceId),
        deviceConfig,
        this.api.hap,
      );

      this.accessoriesByDeviceId.set(deviceId, airConditioner);

      // Polling and post-command refreshes share one path that updates the cache
      // and pushes the full state to every characteristic/service.
      poller.start(deviceConfig.polling_interval_seconds, () => airConditioner.pollOnce());

      // Push only reports changes made after we connect, so seed current state now.
      // Without this a device that never changes would show nothing until the first
      // scheduled poll — which, with push on, can be ten minutes away.
      await poller.triggerNow();
      return true;
    } catch (err) {
      this.log.error(`Failed to set up device ${deviceId}: ${String(err)}`);
      return false;
    }
  }
}
