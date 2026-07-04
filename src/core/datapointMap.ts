import type { CapabilityProfile } from './capabilityProfile.js';

export type CanonicalName =
  | 'power'
  | 'mode'
  | 'setpoint'
  | 'currentTemp'
  | 'fanSpeed'
  | 'swing'
  | 'sleep'
  | 'lock';

const ALIASES: Record<CanonicalName, string[]> = {
  power:       ['switch', 'switch_1', 'power'],
  mode:        ['mode', 'work_mode'],
  setpoint:    ['temp_set', 'set_temp'],
  currentTemp: ['temp_current', 'temp_indoor'],
  fanSpeed:    ['fan_speed_enum', 'windspeed', 'fan_speed'],
  swing:       ['swing', 'shake'],
  sleep:       ['sleep', 'sleep_mode', 'Sleep'],
  lock:        ['lock', 'child_lock'],
};

export class DatapointMap {
  private readonly codeMap = new Map<CanonicalName, string>();

  constructor(private readonly profile: CapabilityProfile) {
    for (const [canonical, aliases] of Object.entries(ALIASES) as [CanonicalName, string[]][]) {
      const alias = aliases.find((a) => profile.rawFunctions.has(a));
      if (alias !== undefined) {
        this.codeMap.set(canonical, alias);
      }
    }
  }

  resolve(canonical: CanonicalName): string | undefined {
    return this.codeMap.get(canonical);
  }

  encodeSetpoint(celsius: number, _unit: 'celsius' | 'fahrenheit'): { code: string; value: number } {
    const code = this.codeMap.get('setpoint') ?? 'temp_set';
    return { code, value: Math.round(celsius * 10 ** this.profile.tempRange.scale) };
  }

  decodeSetpoint(raw: number): number {
    return raw / 10 ** this.profile.tempRange.scale;
  }

  decodeCurrentTemp(raw: number): number {
    const scale = this.profile.currentTempRange?.scale ?? this.profile.tempRange.scale;
    return raw / 10 ** scale;
  }

  encodeSwing(on: boolean): { code: string; value: boolean } {
    const code = this.codeMap.get('swing') ?? 'swing';
    return { code, value: on };
  }
}
