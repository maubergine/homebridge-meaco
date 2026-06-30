import type { PlatformAccessory, Service, Logger, WithUUID } from 'homebridge';

import type { StateCache } from '../core/stateCache.js';

export abstract class BaseAccessory {
  protected readonly log: Logger;
  protected readonly accessory: PlatformAccessory;
  protected readonly stateCache: StateCache;

  constructor(log: Logger, accessory: PlatformAccessory, stateCache: StateCache) {
    this.log = log;
    this.accessory = accessory;
    this.stateCache = stateCache;
  }

  protected getOrAddService(ServiceClass: WithUUID<typeof Service>, subtype?: string, name?: string): Service {
    const existing = subtype
      ? this.accessory.getServiceById(ServiceClass, subtype)
      : this.accessory.getService(ServiceClass);
    if (existing) return existing;
    const displayName = name ?? this.accessory.displayName;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return subtype
      ? this.accessory.addService(ServiceClass as any, displayName, subtype)
      : this.accessory.addService(ServiceClass as any);
  }

  protected removeService(ServiceClass: WithUUID<typeof Service>, subtype?: string): void {
    const svc = subtype
      ? this.accessory.getServiceById(ServiceClass, subtype)
      : this.accessory.getService(ServiceClass);
    if (svc) this.accessory.removeService(svc);
  }
}
