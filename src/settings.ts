export const PLUGIN_NAME = 'homebridge-meaco';
export const PLATFORM_NAME = 'MeacoPlatform';

export const TUYA_REGIONS = {
  US: 'https://openapi.tuyaus.com',
  EU: 'https://openapi.tuyaeu.com',
  WEU: 'https://openapi-weeu.tuyaeu.com',
  CN: 'https://openapi.tuyacn.com',
  IN: 'https://openapi.tuyain.com',
} as const;

export type TuyaRegion = keyof typeof TUYA_REGIONS;

/**
 * Message Service (Pulsar) WebSocket endpoints. Tuya publishes no distinct host for
 * Western Europe, so `WEU` shares the `EU` endpoint.
 */
export const TUYA_PULSAR_URLS: Record<TuyaRegion, string> = {
  US: 'wss://mqe.tuyaus.com:8285/',
  EU: 'wss://mqe.tuyaeu.com:8285/',
  WEU: 'wss://mqe.tuyaeu.com:8285/',
  CN: 'wss://mqe.tuyacn.com:8285/',
  IN: 'wss://mqe.tuyain.com:8285/',
};

/** Pulsar topic segment per subscription environment. */
export const TUYA_PULSAR_ENVS = {
  PROD: 'event',
  TEST: 'event-test',
} as const;

export type TuyaPulsarEnv = keyof typeof TUYA_PULSAR_ENVS;

export const DEFAULTS = {
  pollingIntervalSeconds: 30,
  unresponsiveAfterFailures: 3,
  requestTimeoutMs: 8000,
  maxCommandRetries: 5,
  commandVerifyIntervalMs: 1000,
  region: 'EU' as TuyaRegion,
  useMessageService: true,
  messageServiceEnv: 'PROD' as TuyaPulsarEnv,
  // Preferred subscription suffix. A dedicated subscription is its own consumer
  // group, so this plugin does not compete for messages with anything else using
  // the same Tuya credentials. Falls back to Tuya's shared default if absent.
  messageServiceSubscription: 'meaco',
  // With push carrying live updates the REST poll is only a reconciliation safety
  // net, so it runs far slower than the 30s used when polling was the only source.
  pushPollingIntervalSeconds: 600,
  // Floor applied to any configured interval while push is active, to protect the
  // Tuya API allowance from a per-device override left at a polling-era value.
  pushMinPollingIntervalSeconds: 300,
} as const;
