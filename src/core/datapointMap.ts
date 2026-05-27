import type { CapabilityProfile } from './capabilityProfile.js';

export type CanonicalName =
  | 'power'
  | 'mode'
  | 'setpoint'
  | 'currentTemp'
  | 'fanSpeed'
  | 'swing'
  | 'sleep';

const ALIASES: Record<CanonicalName, string[]> = {
  power:       ['switch', 'switch_1', 'power'],
  mode:        ['mode', 'work_mode'],
  setpoint:    ['temp_set', 'set_temp'],
  currentTemp: ['temp_current', 'temp_indoor'],
  fanSpeed:    ['windspeed', 'fan_speed'],
  swing:       ['swing', 'shake'],
  sleep:       ['sleep', 'sleep_mode'],
};

export class DatapointMap {
  private readonly codeMap = new Map<CanonicalName, string>();
  private readonly profile: CapabilityProfile;

  constructor(profile: CapabilityProfile) {
    this.profile = profile;
    for (const [canonical, aliases] of Object.entries(ALIASES) as [CanonicalName, string[]][]) {
      for (const alias of aliases) {
        if (profile.rawFunctions.has(alias)) {
          this.codeMap.set(canonical, alias);
          break;
        }
      }
    }
  }

  resolve(canonical: CanonicalName): string | undefined {
    return this.codeMap.get(canonical);
  }

  encodeSetpoint(celsius: number, _unit: 'celsius' | 'fahrenheit'): { code: string; value: number } {
    const code = this.codeMap.get('setpoint') ?? 'temp_set';
    const scale = this.profile.tempRange.scale;
    return { code, value: Math.round(celsius * Math.pow(10, scale)) };
  }

  decodeSetpoint(raw: number): number {
    const scale = this.profile.tempRange.scale;
    return raw / Math.pow(10, scale);
  }

  decodeCurrentTemp(raw: number): number {
    const scale = this.profile.currentTempRange?.scale ?? this.profile.tempRange.scale;
    return raw / Math.pow(10, scale);
  }

  encodeFanSpeed(hkPercent: number): string {
    const levels = this.profile.fanSpeedLevels;
    if (levels.length === 0) return '';
    const step = 100 / (levels.length - 1);
    const index = Math.min(
      levels.length - 1,
      Math.floor(hkPercent / step),
    );
    return levels[index] ?? levels[0] ?? '';
  }

  decodeFanSpeed(level: string): number {
    const levels = this.profile.fanSpeedLevels;
    const index = levels.indexOf(level);
    if (index === -1 || levels.length <= 1) return 0;
    return Math.floor((index / (levels.length - 1)) * 100);
  }

  encodeSwing(on: boolean): { code: string; value: boolean } {
    const code = this.codeMap.get('swing') ?? 'swing';
    return { code, value: on };
  }
}
