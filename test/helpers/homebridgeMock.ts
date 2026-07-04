export type GetHandler = () => unknown;
export type SetHandler = (value: unknown) => Promise<void>;

export class MockCharacteristic {
  private getHandler?: GetHandler;
  private setHandler?: SetHandler;
  public lastUpdatedValue: unknown;

  onGet(handler: GetHandler): this {
    this.getHandler = handler;
    return this;
  }

  onSet(handler: SetHandler): this {
    this.setHandler = handler;
    return this;
  }

  updateValue(value: unknown): this {
    this.lastUpdatedValue = value;
    return this;
  }

  setValue(value: unknown): this {
    this.lastUpdatedValue = value;
    return this;
  }

  setProps(_props: object): this { return this; }

  invokeGet(): unknown {
    if (!this.getHandler) throw new Error('No get handler');
    return this.getHandler();
  }

  invokeSet(value: unknown): Promise<void> {
    if (!this.setHandler) return Promise.reject(new Error('No set handler'));
    return this.setHandler(value);
  }
}

export class MockService {
  readonly characteristics = new Map<string, MockCharacteristic>();

  getCharacteristic(name: string): MockCharacteristic {
    if (!this.characteristics.has(name)) {
      this.characteristics.set(name, new MockCharacteristic());
    }
    return this.characteristics.get(name)!;
  }

  setCharacteristic(name: string, _value: unknown): this { return this; }
  addOptionalCharacteristic(_name: string): this { return this; }
  setPrimaryService(_isPrimary?: boolean): this { return this; }
  addLinkedService(_service: MockService): this { return this; }
}

export class MockAccessory {
  displayName: string;
  UUID: string;
  readonly services = new Map<string, MockService>();
  context: Record<string, unknown> = {};

  constructor(displayName: string, uuid: string) {
    this.displayName = displayName;
    this.UUID = uuid;
  }

  getService(name: string): MockService | undefined {
    return this.services.get(name);
  }

  addService(name: string): MockService {
    const svc = new MockService();
    this.services.set(name, svc);
    return svc;
  }

  getServiceById(name: string, _subtype: string): MockService | undefined {
    return this.services.get(name);
  }
}

export function createMockHap() {
  const makeChar = () => new MockCharacteristic();
  const charProxy = new Proxy({} as Record<string, unknown>, {
    get(target, key) {
      if (!(key in target)) {
        const c = makeChar();
        // Static enum values used by the accessory (INACTIVE=0, IDLE=1, HEATING=2, COOLING=3, etc.)
        Object.assign(c, { INACTIVE: 0, IDLE: 1, HEATING: 2, COOLING: 3, AUTO: 0, HEAT: 1, COOL: 2 });
        (target as Record<string, unknown>)[key as string] = c;
      }
      return (target as Record<string, unknown>)[key as string];
    },
  });

  return {
    Service: new Proxy({} as Record<string, unknown>, {
      get(target, key) {
        if (!(key in target)) (target as Record<string, unknown>)[key as string] = key;
        return (target as Record<string, unknown>)[key as string];
      },
    }),
    Characteristic: charProxy,
  };
}

export function createMockLogger() {
  return {
    debug: (..._a: unknown[]) => {},
    info: (..._a: unknown[]) => {},
    warn: (..._a: unknown[]) => {},
    error: (..._a: unknown[]) => {},
  };
}
