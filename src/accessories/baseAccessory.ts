import type { PlatformAccessory, Service, Logger, WithUUID } from 'homebridge';

import type { StateCache } from '../core/stateCache.js';

export abstract class BaseAccessory {
  constructor(
    protected readonly log: Logger,
    protected readonly accessory: PlatformAccessory,
    protected readonly stateCache: StateCache,
  ) {}

  private findService(ServiceClass: WithUUID<typeof Service>, subtype?: string): Service | undefined {
    return subtype
      ? this.accessory.getServiceById(ServiceClass, subtype)
      : this.accessory.getService(ServiceClass);
  }

  protected getOrAddService(ServiceClass: WithUUID<typeof Service>, subtype?: string, name?: string): Service {
    const existing = this.findService(ServiceClass, subtype);
    if (existing) return existing;
    const displayName = name ?? this.accessory.displayName;
    // HAP's generic addService signature can't be satisfied by a WithUUID service class
    // whose concrete constructor differs from the base Service constructor.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    return subtype
      ? this.accessory.addService(ServiceClass as any, displayName, subtype)
      : this.accessory.addService(ServiceClass as any);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  protected removeService(ServiceClass: WithUUID<typeof Service>, subtype?: string): void {
    const svc = this.findService(ServiceClass, subtype);
    if (svc) this.accessory.removeService(svc);
  }
}
