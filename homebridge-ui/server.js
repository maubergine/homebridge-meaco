// Backend for the plugin's settings page. It runs in the Homebridge UI, not in the bridge, and
// only answers requests from the page. It reads config.json but never writes it: the page puts
// discovered devices and settings into the form, and the user saves them.
import { readFile } from 'node:fs/promises';

import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';

import { discoverNewDevices } from '../dist/core/discovery.js';
import { DEFAULTS, PLATFORM_NAME, TUYA_REGIONS } from '../dist/settings.js';
import { CloudClient } from '../dist/tuya/cloudClient.js';

class MeacoUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/discover', this.discover.bind(this));
    this.ready();
  }

  /**
   * Lists Meaco units on the Tuya project that aren't configured yet. Takes the credentials
   * from the form, so discovery works before the user has saved them.
   */
  async discover({ credentials, configuredDeviceIds, requestTimeoutMs } = {}) {
    const region = credentials?.tuya_region ?? DEFAULTS.region;
    if (!credentials?.tuya_access_key || !credentials.tuya_secret_key) {
      throw new RequestError('Enter your Tuya access key and secret key first.', { status: 400 });
    }
    if (!(region in TUYA_REGIONS)) {
      throw new RequestError(`Unknown Tuya region "${region}".`, { status: 400 });
    }

    const client = new CloudClient({
      region,
      accessKey: credentials.tuya_access_key,
      secretKey: credentials.tuya_secret_key,
      requestTimeoutMs: requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
    });
    try {
      return await discoverNewDevices(client, new Set(configuredDeviceIds ?? []), await this.savedDevices());
    } catch (err) {
      throw new RequestError(`Tuya request failed: ${err instanceof Error ? err.message : String(err)}`, { status: 502 });
    }
  }

  /**
   * The device entries as saved in config.json. The form can't provide these: it fills unset
   * fields with schema defaults, so they look the same as settings the user chose.
   */
  async savedDevices() {
    try {
      const config = JSON.parse(await readFile(this.homebridgeConfigPath, 'utf8'));
      const block = config.platforms?.find((p) => p.platform === PLATFORM_NAME);
      return Array.isArray(block?.devices) ? block.devices : [];
    } catch {
      // Unreadable config: offer no updates rather than risk overwriting the user's choices.
      return [];
    }
  }
}

(() => new MeacoUiServer())();
