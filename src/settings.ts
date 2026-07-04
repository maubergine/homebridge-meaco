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

export const DEFAULTS = {
  pollingIntervalSeconds: 30,
  unresponsiveAfterFailures: 3,
  requestTimeoutMs: 8000,
  maxCommandRetries: 5,
  commandVerifyIntervalMs: 1000,
  region: 'EU' as TuyaRegion,
} as const;
