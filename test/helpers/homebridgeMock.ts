export type GetHandler = () => unknown;
export type SetHandler = (value: unknown, callback: (err?: Error | null) => void) => void;

export class MockCharacteristic {
  private getHandler?: GetHandler;
  private setHandler?: SetHandler;
  public lastUpdatedValue: unknown;

  on(event: 'get', handler: GetHandler): this;
  on(event: 'set', handler: SetHandler): this;
  on(event: string, handler: unknown): this {
    if (event === 'get') this.getHandler = handler as GetHandler;
    if (event === 'set') this.setHandler = handler as SetHandler;
    return this;
  }

  updateValue(value: unknown): this {
    this.lastUpdatedValue = value;
    return this;
  }

  setProps(_props: object): this { return this; }

  invokeGet(): unknown {
    if (!this.getHandler) throw new Error('No get handler');
    return this.getHandler();
  }

  invokeSet(value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.setHandler) return reject(new Error('No set handler'));
      this.setHandler(value, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
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

export function createMockLogger() {
  return {
    debug: (..._a: unknown[]) => {},
    info: (..._a: unknown[]) => {},
    warn: (..._a: unknown[]) => {},
    error: (..._a: unknown[]) => {},
  };
}
