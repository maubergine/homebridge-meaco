import crypto from 'node:crypto';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  PulsarClient,
  buildPulsarPassword,
  buildPulsarTopicUrl,
  decryptPulsarData,
  handshakeRejectionStatus,
  parsePulsarMessage,
  resolveConsumerName,
  resolveSubscriptionName,
  toStatusMap,
} from '../../src/tuya/pulsarClient.js';
import type { PulsarSocket } from '../../src/tuya/pulsarClient.js';

const ACCESS_ID = 'abc123accessid';
const SECRET = '0123456789abcdef0123456789abcdef';
const AES_KEY = Buffer.from(SECRET.substring(8, 24), 'utf-8');

// ── Message builders — mirror what Tuya puts on the wire ─────────────────────

function encryptEcb(data: unknown): string {
  const cipher = crypto.createCipheriv('aes-128-ecb', AES_KEY, null);
  return Buffer.concat([
    cipher.update(JSON.stringify(data), 'utf-8'),
    cipher.final(),
  ]).toString('base64');
}

function encryptGcm(data: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-128-gcm', AES_KEY, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf-8'), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64');
}

interface EnvelopeOptions {
  messageId?: string;
  redeliveryCount?: number;
  gcm?: boolean;
  /** Broker publish time. Defaults to "just now" so frames read as live, not backlog. */
  publishedAt?: number;
  /** Set false to build a frame with no publishTime at all. */
  withPublishTime?: boolean;
}

/** Wraps a decrypted body in the full Tuya envelope, as a JSON frame string. */
function makeFrame(body: unknown, opts: EnvelopeOptions = {}): string {
  const encrypted = opts.gcm ? encryptGcm(body) : encryptEcb(body);
  const publishedAt = opts.publishedAt ?? Date.now();
  const payload = Buffer.from(
    JSON.stringify({ data: encrypted, protocol: 4, pv: '2.0', sign: 'deadbeef', t: publishedAt }),
  ).toString('base64');
  return JSON.stringify({
    messageId: opts.messageId ?? 'CLe1/w4QACAA',
    payload,
    properties: opts.gcm ? { em: 'aes_gcm' } : {},
    ...(opts.withPublishTime === false ? {} : { publishTime: new Date(publishedAt).toISOString() }),
    redeliveryCount: opts.redeliveryCount ?? 0,
    key: 'dev1',
  });
}

const STATUS_BODY = {
  dataId: 'f73709fe-0eed-11ec-8511-024283c73485',
  devId: 'dev1',
  productKey: 'naxxxxjz',
  // Tuya also includes the numeric DP id as a stringified key alongside code/value.
  status: [
    { '1': 'true', code: 'switch', t: 1630979005725, value: true },
    { '4': '240', code: 'temp_set', t: 1630979005725, value: 240 },
  ],
};

// ── Fake transport ───────────────────────────────────────────────────────────

class FakeSocket implements PulsarSocket {
  readyState = 1;
  readonly sent: string[] = [];
  readonly pings: (string | undefined)[] = [];
  readonly pongs: (string | undefined)[] = [];
  terminated = false;
  closed = false;

  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener as (...args: unknown[]) => void);
    this.listeners.set(event, existing);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  send(data: string): void { this.sent.push(data); }
  ping(data?: string): void { this.pings.push(data); }
  pong(data?: string): void { this.pongs.push(data); }
  close(): void { this.closed = true; this.emit('close'); }
  terminate(): void { this.terminated = true; this.emit('close'); }

  /** Message ids this socket acked back to the broker. */
  ackedIds(): string[] {
    return this.sent.map((raw) => (JSON.parse(raw) as { messageId: string }).messageId);
  }
}

/** Captures log output so tests can assert what an operator would actually see. */
function createCapturingLogger() {
  const lines: { level: string; message: string }[] = [];
  const record = (level: string) => (message: string) => { lines.push({ level, message }); };
  return {
    lines,
    at: (level: string) => lines.filter((l) => l.level === level).map((l) => l.message),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
}

function makeClient(
  overrides: { env?: 'PROD' | 'TEST'; subscription?: string; consumerName?: string } = {},
) {
  const sockets: FakeSocket[] = [];
  const headers: Record<string, string>[] = [];
  const urls: string[] = [];
  const log = createCapturingLogger();

  const client = new PulsarClient(
    {
      region: 'EU',
      accessKey: ACCESS_ID,
      secretKey: SECRET,
      env: overrides.env ?? 'PROD',
      ...(overrides.subscription ? { subscription: overrides.subscription } : {}),
      ...(overrides.consumerName ? { consumerName: overrides.consumerName } : {}),
    },
    log,
    (url, hdrs) => {
      urls.push(url);
      headers.push(hdrs);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  );

  return { client, sockets, headers, urls, log };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('buildPulsarTopicUrl', () => {
  it('builds the production consumer topic from the access id', () => {
    expect(buildPulsarTopicUrl('wss://mqe.tuyaeu.com:8285/', ACCESS_ID, 'PROD')).toBe(
      'wss://mqe.tuyaeu.com:8285/ws/v2/consumer/persistent/abc123accessid/out/event/' +
      'abc123accessid-sub?subscriptionType=Failover&ackTimeoutMillis=30000',
    );
  });

  it('uses the event-test namespace for the TEST environment', () => {
    expect(buildPulsarTopicUrl('wss://mqe.tuyaeu.com:8285/', ACCESS_ID, 'TEST'))
      .toContain('/out/event-test/');
  });

  it('consumes a dedicated subscription when one is configured', () => {
    expect(buildPulsarTopicUrl('wss://mqe.tuyaeu.com:8285/', ACCESS_ID, 'PROD', 'meaco'))
      .toContain('/out/event/abc123accessid-meaco?');
  });

  it('names the consumer when one is supplied', () => {
    expect(buildPulsarTopicUrl('wss://mqe.tuyaeu.com:8285/', ACCESS_ID, 'PROD', 'meaco',
      'homebridge-meaco@pi'))
      .toContain('consumerName=homebridge-meaco%40pi');
  });

  it('omits the consumer name when there is none', () => {
    const url = buildPulsarTopicUrl('wss://mqe.tuyaeu.com:8285/', ACCESS_ID, 'PROD', 'meaco', '');
    expect(url).not.toContain('consumerName');
  });
});

describe('resolveConsumerName', () => {
  it('defaults to the plugin name and short hostname', () => {
    expect(resolveConsumerName(undefined, 'raspberrypi')).toBe('homebridge-meaco@raspberrypi');
  });

  it('strips the domain from a fully qualified hostname', () => {
    expect(resolveConsumerName(undefined, 'pi.local.lan')).toBe('homebridge-meaco@pi');
  });

  it('drops characters that do not belong in a consumer name', () => {
    expect(resolveConsumerName(undefined, 'my host!')).toBe('homebridge-meaco@myhost');
  });

  it('omits the host when there is nothing usable left', () => {
    expect(resolveConsumerName(undefined, '')).toBe('homebridge-meaco');
    expect(resolveConsumerName(undefined, '!!!')).toBe('homebridge-meaco');
  });

  it('prefers a configured override', () => {
    expect(resolveConsumerName('lounge-bridge', 'pi')).toBe('lounge-bridge');
  });

  it('treats a blank override as unset', () => {
    expect(resolveConsumerName('   ', 'pi')).toBe('homebridge-meaco@pi');
  });

  it('accepts a different base for other tools', () => {
    expect(resolveConsumerName(undefined, 'pi', 'homebridge-meaco-probe'))
      .toBe('homebridge-meaco-probe@pi');
  });
});

describe('handshakeRejectionStatus', () => {
  it('reads the status out of a refused upgrade', () => {
    expect(handshakeRejectionStatus(new Error('Unexpected server response: 404'))).toBe(404);
    expect(handshakeRejectionStatus(new Error('Unexpected server response: 401'))).toBe(401);
  });

  it('is null for errors that are not a refused handshake', () => {
    expect(handshakeRejectionStatus(new Error('connect ECONNREFUSED'))).toBeNull();
    expect(handshakeRejectionStatus(new Error('socket hang up'))).toBeNull();
  });
});

describe('resolveSubscriptionName', () => {
  it('defaults to Tuya\'s shared subscription', () => {
    expect(resolveSubscriptionName(ACCESS_ID)).toBe('abc123accessid-sub');
    expect(resolveSubscriptionName(ACCESS_ID, '')).toBe('abc123accessid-sub');
    expect(resolveSubscriptionName(ACCESS_ID, '   ')).toBe('abc123accessid-sub');
  });

  it('prefixes a bare suffix with the access id', () => {
    expect(resolveSubscriptionName(ACCESS_ID, 'meaco')).toBe('abc123accessid-meaco');
  });

  it('accepts a full name as shown in the Tuya console', () => {
    expect(resolveSubscriptionName(ACCESS_ID, 'abc123accessid-meaco'))
      .toBe('abc123accessid-meaco');
  });

  it('tolerates surrounding whitespace from a copy-paste', () => {
    expect(resolveSubscriptionName(ACCESS_ID, '  meaco  ')).toBe('abc123accessid-meaco');
  });
});

describe('buildPulsarPassword', () => {
  it('is the middle 16 chars of md5(accessId + md5(secret))', () => {
    const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
    const expected = md5(`${ACCESS_ID}${md5(SECRET)}`).substring(8, 24);
    const password = buildPulsarPassword(ACCESS_ID, SECRET);
    expect(password).toBe(expected);
    expect(password).toHaveLength(16);
  });
});

describe('decryptPulsarData', () => {
  it('decrypts the default AES-128-ECB payload', () => {
    expect(decryptPulsarData(encryptEcb(STATUS_BODY), SECRET)).toEqual(STATUS_BODY);
  });

  it('decrypts an AES-128-GCM payload when the envelope names it', () => {
    expect(decryptPulsarData(encryptGcm(STATUS_BODY), SECRET, 'aes_gcm')).toEqual(STATUS_BODY);
  });
});

describe('toStatusMap', () => {
  it('flattens code/value pairs and ignores the numeric dp id key', () => {
    expect(toStatusMap(STATUS_BODY.status)).toEqual({ switch: true, temp_set: 240 });
  });

  it('drops entries without a usable code or value', () => {
    const map = toStatusMap([
      { code: '', value: 1 },
      { code: 'mode', value: 'Cool' },
      { code: 'broken', value: null as never },
      { code: 'nested', value: { a: 1 } as never },
    ]);
    expect(map).toEqual({ mode: 'Cool' });
  });
});

// Captured from a live Meaco unit: this project's subscription pushes protocol
// 1000 property reports, not the protocol 4 status reports Tuya's SDK docs show.
// Note the datapoints sit under `bizData`, not at the top level as Tuya's
// message-type documentation describes.
const PROPERTY_BODY_ON = {
  bizCode: 'devicePropertyMessage',
  bizData: {
    devId: 'bfd7eb6b01d87805823lyz',
    dataId: '000657A884CE1BDBA066C3EE69252710',
    productId: 'pgdwirmckucamyz7',
    properties: [{ code: 'switch', dpId: 1, time: 1785231154486, value: true }],
  },
  ts: 1785231154486,
};

const PROPERTY_BODY_OFF = {
  bizCode: 'devicePropertyMessage',
  bizData: {
    devId: 'bfd7eb6b01d87805823lyz',
    dataId: '000657A8855976BEA066C3EE69252711',
    productId: 'pgdwirmckucamyz7',
    properties: [{ code: 'switch', dpId: 1, time: 1785231163619, value: false }],
  },
  ts: 1785231163619,
};

describe('parsePulsarMessage — protocol 1000 property reports', () => {
  it('routes a real power-on report', () => {
    const parsed = parsePulsarMessage(makeFrame(PROPERTY_BODY_ON, { gcm: true }), SECRET);
    expect(parsed.status).toEqual({
      devId: 'bfd7eb6b01d87805823lyz',
      changed: { switch: true },
    });
  });

  it('routes a real power-off report', () => {
    const parsed = parsePulsarMessage(makeFrame(PROPERTY_BODY_OFF, { gcm: true }), SECRET);
    expect(parsed.status).toEqual({
      devId: 'bfd7eb6b01d87805823lyz',
      changed: { switch: false },
    });
  });

  it('does not lose `false` — the off report must not be dropped as empty', () => {
    const parsed = parsePulsarMessage(makeFrame(PROPERTY_BODY_OFF, { gcm: true }), SECRET);
    expect(parsed.status?.changed).toHaveProperty('switch', false);
  });

  it('routes a multi-datapoint property report', () => {
    const body = {
      ...PROPERTY_BODY_ON,
      bizData: {
        ...PROPERTY_BODY_ON.bizData,
        properties: [
          { code: 'switch', dpId: 1, time: 1, value: true },
          { code: 'temp_set', dpId: 4, time: 1, value: 240 },
          { code: 'mode', dpId: 2, time: 1, value: 'Cool' },
        ],
      },
    };
    const parsed = parsePulsarMessage(makeFrame(body), SECRET);
    expect(parsed.status?.changed).toEqual({ switch: true, temp_set: 240, mode: 'Cool' });
  });

  it('ignores a bizCode message that carries no datapoints', () => {
    const event = {
      bizCode: 'deviceEventMessage',
      bizData: { devId: 'dev1', eventCode: 'doorbell', outputParams: {}, productId: 'p' },
      ts: 1,
    };
    expect(parsePulsarMessage(makeFrame(event), SECRET).status).toBeNull();
  });
});

describe('parsePulsarMessage', () => {
  it('unwraps an ECB status report to a device id and changed datapoints', () => {
    const parsed = parsePulsarMessage(makeFrame(STATUS_BODY), SECRET);
    expect(parsed.messageId).toBe('CLe1/w4QACAA');
    expect(parsed.status).toEqual({ devId: 'dev1', changed: { switch: true, temp_set: 240 } });
  });

  it('unwraps a GCM status report', () => {
    const parsed = parsePulsarMessage(makeFrame(STATUS_BODY, { gcm: true }), SECRET);
    expect(parsed.status?.changed).toEqual({ switch: true, temp_set: 240 });
  });

  it('accepts a Buffer frame as delivered by ws', () => {
    const parsed = parsePulsarMessage(Buffer.from(makeFrame(STATUS_BODY), 'utf-8'), SECRET);
    expect(parsed.status?.devId).toBe('dev1');
  });

  it('reports the redelivery count', () => {
    const parsed = parsePulsarMessage(makeFrame(STATUS_BODY, { redeliveryCount: 3 }), SECRET);
    expect(parsed.redeliveryCount).toBe(3);
  });

  it('keeps the message id but yields no status for a non-status message type', () => {
    const online = { bizCode: 'deviceOnline', devId: 'dev1', productId: 'p', uid: 'u', time: 1 };
    const parsed = parsePulsarMessage(makeFrame(online, { messageId: 'm-online' }), SECRET);
    expect(parsed.messageId).toBe('m-online');
    expect(parsed.status).toBeNull();
  });

  it('keeps the message id when the body cannot be decrypted', () => {
    const payload = Buffer.from(JSON.stringify({ data: 'not-real-ciphertext', protocol: 4 }))
      .toString('base64');
    const frame = JSON.stringify({ messageId: 'm-bad', payload, properties: {} });
    const parsed = parsePulsarMessage(frame, SECRET);
    expect(parsed.messageId).toBe('m-bad');
    expect(parsed.status).toBeNull();
  });

  it('returns an empty result for a frame that is not JSON', () => {
    expect(parsePulsarMessage('<html>gateway error</html>', SECRET))
      .toEqual({ messageId: null, redeliveryCount: 0, publishedAt: null, devId: null, status: null });
  });

  it('reads the broker publish time as epoch milliseconds', () => {
    const at = Date.parse('2021-09-06T16:39:36.048+08:00');
    const parsed = parsePulsarMessage(makeFrame(STATUS_BODY, { publishedAt: at }), SECRET);
    expect(parsed.publishedAt).toBe(at);
  });

  it('falls back to the payload timestamp when the envelope has no publishTime', () => {
    const at = 1630917576048;
    const parsed = parsePulsarMessage(
      makeFrame(STATUS_BODY, { publishedAt: at, withPublishTime: false }),
      SECRET,
    );
    expect(parsed.publishedAt).toBe(at);
  });
});

// ── Client behaviour ─────────────────────────────────────────────────────────

describe('PulsarClient', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('connects to the region topic with the derived credentials', () => {
    const { client, urls, headers } = makeClient();
    client.start();
    expect(urls[0]).toContain('wss://mqe.tuyaeu.com:8285/ws/v2/consumer/persistent/abc123accessid/out/event/');
    expect(headers[0]).toEqual({
      username: ACCESS_ID,
      password: buildPulsarPassword(ACCESS_ID, SECRET),
    });
    client.stop();
  });

  it('routes a pushed status report to the handler by device id', () => {
    const { client, sockets } = makeClient();
    const handler = vi.fn();
    client.onDeviceStatus(handler);
    client.start();
    sockets[0].emit('open');
    sockets[0].emit('message', makeFrame(STATUS_BODY));

    expect(handler).toHaveBeenCalledWith('dev1', { switch: true, temp_set: 240 });
    client.stop();
  });

  it('acks every message it handles', () => {
    const { client, sockets } = makeClient();
    client.onDeviceStatus(vi.fn());
    client.start();
    sockets[0].emit('message', makeFrame(STATUS_BODY, { messageId: 'm-1' }));

    expect(sockets[0].ackedIds()).toEqual(['m-1']);
    client.stop();
  });

  it('acks even when the handler throws, so the broker does not redeliver', () => {
    const { client, sockets } = makeClient();
    client.onDeviceStatus(() => { throw new Error('homekit blew up'); });
    client.start();
    sockets[0].emit('message', makeFrame(STATUS_BODY, { messageId: 'm-2' }));

    expect(sockets[0].ackedIds()).toEqual(['m-2']);
    client.stop();
  });

  it('acks message types it does not route', () => {
    const { client, sockets } = makeClient();
    const handler = vi.fn();
    client.onDeviceStatus(handler);
    client.start();
    const online = { bizCode: 'deviceOffline', devId: 'dev1', productId: 'p', uid: 'u', time: 1 };
    sockets[0].emit('message', makeFrame(online, { messageId: 'm-3' }));

    expect(handler).not.toHaveBeenCalled();
    expect(sockets[0].ackedIds()).toEqual(['m-3']);
    client.stop();
  });

  it('ignores a status report for an unknown device without failing', () => {
    const { client, sockets } = makeClient();
    const handler = vi.fn();
    client.onDeviceStatus(handler);
    client.start();
    sockets[0].emit('message', makeFrame({ ...STATUS_BODY, devId: 'other' }));

    expect(handler).toHaveBeenCalledWith('other', expect.anything());
    client.stop();
  });

  it('reports the configured consumer name on connect', () => {
    const { client, urls } = makeClient({ subscription: 'meaco', consumerName: 'homebridge-meaco@pi' });
    client.start();
    expect(urls[0]).toContain('consumerName=homebridge-meaco%40pi');
    client.stop();
  });

  it('logs the subscription and consumer name once connected', () => {
    const { client, sockets, log } = makeClient({
      subscription: 'meaco', consumerName: 'homebridge-meaco@pi',
    });
    client.start();
    sockets[0].emit('open');

    const connected = log.at('info').find((m) => m.startsWith('Connected'));
    expect(connected).toContain('abc123accessid-meaco');
    expect(connected).toContain('homebridge-meaco@pi');
    client.stop();
  });

  it('logs which subscription a reconnect landed on', () => {
    vi.useFakeTimers();
    const { client, sockets, log } = makeClient({
      subscription: 'meaco', consumerName: 'homebridge-meaco@pi',
    });
    client.start();
    sockets[0].emit('open');
    sockets[0].emit('close');
    vi.advanceTimersByTime(2_000);
    sockets[1].emit('open');

    const reconnected = log.at('info').find((m) => m.startsWith('Reconnected'));
    expect(reconnected).toContain('abc123accessid-meaco');
    expect(reconnected).toContain('homebridge-meaco@pi');
    client.stop();
  });

  it('says so when connected under a generated consumer name', () => {
    const { client, sockets, log } = makeClient({ subscription: 'meaco' });
    client.start();
    sockets[0].emit('open');

    expect(log.at('info').find((m) => m.startsWith('Connected')))
      .toContain('Pulsar-generated name');
    client.stop();
  });

  it('logs the fallback identity after the consumer name is refused', () => {
    vi.useFakeTimers();
    const { client, sockets, log } = makeClient({
      subscription: 'meaco', consumerName: 'homebridge-meaco@pi',
    });
    client.start();
    sockets[0].emit('error', new Error('Unexpected server response: 400'));
    sockets[0].emit('close');
    vi.advanceTimersByTime(2_000);
    sockets[1].emit('open');

    // The operator must be able to see the name in the console will not match.
    expect(log.at('info').find((m) => m.startsWith('Connected')))
      .toContain('Pulsar-generated name');
    client.stop();
  });

  it('drops the consumer name before giving up the subscription', () => {
    vi.useFakeTimers();
    const { client, sockets, urls } = makeClient({
      subscription: 'meaco', consumerName: 'homebridge-meaco@pi',
    });
    client.start();

    // First refusal: retry the same subscription without the cosmetic parameter.
    sockets[0].emit('error', new Error('Unexpected server response: 400'));
    sockets[0].emit('close');
    vi.advanceTimersByTime(2_000);
    expect(urls[1]).not.toContain('consumerName');
    expect(urls[1]).toContain('abc123accessid-meaco');
    expect(client.isUsingFallbackSubscription).toBe(false);

    // Still refused: only now give up the dedicated subscription.
    sockets[1].emit('error', new Error('Unexpected server response: 400'));
    sockets[1].emit('close');
    vi.advanceTimersByTime(2_000);
    expect(urls[2]).toContain('abc123accessid-sub');
    expect(client.isUsingFallbackSubscription).toBe(true);
    client.stop();
  });

  it('keeps the consumer name once a connection has succeeded', () => {
    vi.useFakeTimers();
    const { client, sockets, urls } = makeClient({
      subscription: 'meaco', consumerName: 'homebridge-meaco@pi',
    });
    client.start();
    sockets[0].emit('open');
    sockets[0].emit('close');
    vi.advanceTimersByTime(2_000);

    expect(urls[1]).toContain('consumerName=homebridge-meaco%40pi');
    client.stop();
  });

  it('falls back to the shared subscription when Tuya rejects the dedicated one', () => {
    vi.useFakeTimers();
    const { client, sockets, urls } = makeClient({ subscription: 'meaco' });
    client.start();
    expect(urls[0]).toContain('abc123accessid-meaco');

    // A refused upgrade: the socket never opens and the server answers 404.
    sockets[0].emit('error', new Error('Unexpected server response: 404'));
    sockets[0].emit('close');
    vi.advanceTimersByTime(2_000);

    expect(urls[1]).toContain('abc123accessid-sub');
    expect(client.subscriptionName).toBe('abc123accessid-sub');
    expect(client.isUsingFallbackSubscription).toBe(true);
    client.stop();
  });

  it('does not fall back on a network error — that would hide the real fault', () => {
    vi.useFakeTimers();
    const { client, sockets, urls } = makeClient({ subscription: 'meaco' });
    client.start();

    sockets[0].emit('error', new Error('connect ECONNREFUSED 1.2.3.4:8285'));
    sockets[0].emit('close');
    vi.advanceTimersByTime(2_000);

    expect(urls[1]).toContain('abc123accessid-meaco');
    expect(client.isUsingFallbackSubscription).toBe(false);
    client.stop();
  });

  it('does not fall back on 401 — bad credentials must stay visible', () => {
    vi.useFakeTimers();
    const { client, sockets, urls } = makeClient({ subscription: 'meaco' });
    client.start();

    sockets[0].emit('error', new Error('Unexpected server response: 401'));
    sockets[0].emit('close');
    vi.advanceTimersByTime(2_000);

    expect(urls[1]).toContain('abc123accessid-meaco');
    expect(client.isUsingFallbackSubscription).toBe(false);
    client.stop();
  });

  it('does not fall back once the subscription has connected successfully', () => {
    vi.useFakeTimers();
    const { client, sockets, urls } = makeClient({ subscription: 'meaco' });
    client.start();
    sockets[0].emit('open');

    // A later drop is an outage, not a missing subscription.
    sockets[0].emit('error', new Error('Unexpected server response: 404'));
    sockets[0].emit('close');
    vi.advanceTimersByTime(2_000);

    expect(urls[1]).toContain('abc123accessid-meaco');
    expect(client.isUsingFallbackSubscription).toBe(false);
    client.stop();
  });

  it('stays on the shared subscription after falling back', () => {
    vi.useFakeTimers();
    const { client, sockets, urls } = makeClient({ subscription: 'meaco' });
    client.start();
    sockets[0].emit('error', new Error('Unexpected server response: 404'));
    sockets[0].emit('close');
    vi.advanceTimersByTime(2_000);

    sockets[1].emit('error', new Error('Unexpected server response: 404'));
    sockets[1].emit('close');
    vi.advanceTimersByTime(4_000);

    expect(urls[2]).toContain('abc123accessid-sub');
    client.stop();
  });

  it('applies the device filter only after being demoted to the shared subscription', () => {
    vi.useFakeTimers();
    const { client, sockets } = makeClient({ subscription: 'meaco' });
    client.onDeviceStatus(vi.fn());
    client.setDeviceFilter((devId) => devId === 'mine');
    client.start();

    // Dedicated subscription: sole consumer, so a foreign device is still acked.
    sockets[0].emit('open');
    sockets[0].emit('message', makeFrame({ ...STATUS_BODY, devId: 'theirs' }, { messageId: 'm-a' }));
    expect(sockets[0].ackedIds()).toEqual(['m-a']);

    // Force a fallback, then the same message must be left for other consumers.
    sockets[0].emit('close');
    vi.advanceTimersByTime(2_000);
    sockets[1].emit('error', new Error('Unexpected server response: 404'));
    sockets[1].emit('close');
    vi.advanceTimersByTime(4_000);
    expect(client.isUsingFallbackSubscription).toBe(true);

    sockets[2].emit('open');
    sockets[2].emit('message', makeFrame({ ...STATUS_BODY, devId: 'theirs' }, { messageId: 'm-b' }));
    expect(sockets[2].sent).toEqual([]);
    client.stop();
  });

  it('connects to a dedicated subscription and reports its name', () => {
    const { client, urls } = makeClient({ subscription: 'meaco' });
    client.start();
    expect(client.subscriptionName).toBe('abc123accessid-meaco');
    expect(urls[0]).toContain('/out/event/abc123accessid-meaco?');
    client.stop();
  });

  it('reports the default subscription name when none is configured', () => {
    const { client } = makeClient();
    expect(client.subscriptionName).toBe('abc123accessid-sub');
  });

  it('routes a protocol 1000 property report end to end', () => {
    const { client, sockets } = makeClient();
    const handler = vi.fn();
    client.onDeviceStatus(handler);
    client.start();
    sockets[0].emit('open');
    sockets[0].emit('message', makeFrame(PROPERTY_BODY_ON, { gcm: true, messageId: 'm-prop' }));

    expect(handler).toHaveBeenCalledWith('bfd7eb6b01d87805823lyz', { switch: true });
    expect(sockets[0].ackedIds()).toEqual(['m-prop']);
    client.stop();
  });

  it('leaves a message for an unmanaged device unacked and undispatched', () => {
    const { client, sockets } = makeClient();
    const handler = vi.fn();
    client.onDeviceStatus(handler);
    client.setDeviceFilter((devId) => devId === 'mine');
    client.start();
    sockets[0].emit('open');
    sockets[0].emit('message', makeFrame({ ...STATUS_BODY, devId: 'someone-elses' }, {
      messageId: 'm-foreign',
    }));

    expect(handler).not.toHaveBeenCalled();
    expect(sockets[0].sent).toEqual([]);
    client.stop();
  });

  it('acks and dispatches a message for a managed device', () => {
    const { client, sockets } = makeClient();
    const handler = vi.fn();
    client.onDeviceStatus(handler);
    client.setDeviceFilter((devId) => devId === 'mine');
    client.start();
    sockets[0].emit('open');
    sockets[0].emit('message', makeFrame({ ...STATUS_BODY, devId: 'mine' }, { messageId: 'm-mine' }));

    expect(handler).toHaveBeenCalledWith('mine', { switch: true, temp_set: 240 });
    expect(sockets[0].ackedIds()).toEqual(['m-mine']);
    client.stop();
  });

  it('does not ack an unmanaged device even for a non-routed message type', () => {
    const { client, sockets } = makeClient();
    client.onDeviceStatus(vi.fn());
    client.setDeviceFilter((devId) => devId === 'mine');
    client.start();
    sockets[0].emit('open');
    const online = { bizCode: 'deviceOnline', devId: 'someone-elses', productId: 'p', uid: 'u', time: 1 };
    sockets[0].emit('message', makeFrame(online, { messageId: 'm-foreign-online' }));

    expect(sockets[0].sent).toEqual([]);
    client.stop();
  });

  it('identifies an unmanaged device from a protocol 1000 report', () => {
    const { client, sockets } = makeClient();
    const handler = vi.fn();
    client.onDeviceStatus(handler);
    client.setDeviceFilter((devId) => devId === 'mine');
    client.start();
    sockets[0].emit('open');
    sockets[0].emit('message', makeFrame(PROPERTY_BODY_ON, { gcm: true, messageId: 'm-prop-foreign' }));

    expect(handler).not.toHaveBeenCalled();
    expect(sockets[0].sent).toEqual([]);
    client.stop();
  });

  it('acks an unattributable message — no other consumer could claim it either', () => {
    const { client, sockets } = makeClient();
    client.onDeviceStatus(vi.fn());
    client.setDeviceFilter(() => false);
    client.start();
    sockets[0].emit('open');
    // No devId anywhere in the body, and no envelope routing key.
    const frame = JSON.parse(makeFrame({ dataId: 'x', status: [] })) as Record<string, unknown>;
    delete frame.key;
    frame.messageId = 'm-orphan';
    sockets[0].emit('message', JSON.stringify(frame));

    expect(sockets[0].ackedIds()).toEqual(['m-orphan']);
    client.stop();
  });

  it('acks everything when no device filter is set', () => {
    const { client, sockets } = makeClient();
    client.onDeviceStatus(vi.fn());
    client.start();
    sockets[0].emit('open');
    sockets[0].emit('message', makeFrame({ ...STATUS_BODY, devId: 'anyone' }, { messageId: 'm-any' }));

    expect(sockets[0].ackedIds()).toEqual(['m-any']);
    client.stop();
  });

  it('answers a server ping with the access id', () => {
    const { client, sockets } = makeClient();
    client.start();
    sockets[0].emit('ping');
    expect(sockets[0].pongs).toEqual([ACCESS_ID]);
    client.stop();
  });

  it('reconnects after an unexpected close', () => {
    vi.useFakeTimers();
    const { client, sockets } = makeClient();
    client.start();
    sockets[0].emit('open');
    expect(sockets).toHaveLength(1);

    sockets[0].emit('close');
    vi.advanceTimersByTime(2_000);

    expect(sockets).toHaveLength(2);
    client.stop();
  });

  it('backs off further on each successive failed reconnect', () => {
    vi.useFakeTimers();
    const { client, sockets } = makeClient();
    client.start();

    sockets[0].emit('close');
    vi.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(2);

    sockets[1].emit('close');
    // The second attempt waits at least 1s and at most 2s; 500ms is too soon.
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(3);

    client.stop();
  });

  it('does not reconnect after stop()', () => {
    vi.useFakeTimers();
    const { client, sockets } = makeClient();
    client.start();
    client.stop();
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].closed).toBe(true);
  });

  it('pings when the link goes idle and tears it down if nothing answers', () => {
    vi.useFakeTimers();
    const { client, sockets } = makeClient();
    client.start();
    sockets[0].emit('open');

    vi.advanceTimersByTime(30_000);
    expect(sockets[0].pings).toEqual([ACCESS_ID]);
    expect(sockets[0].terminated).toBe(false);

    vi.advanceTimersByTime(10_000);
    expect(sockets[0].terminated).toBe(true);

    client.stop();
  });

  it('keeps the link when a pong answers the idle ping', () => {
    vi.useFakeTimers();
    const { client, sockets } = makeClient();
    client.start();
    sockets[0].emit('open');

    vi.advanceTimersByTime(30_000);
    sockets[0].emit('pong');
    vi.advanceTimersByTime(10_000);

    expect(sockets[0].terminated).toBe(false);
    client.stop();
  });

  it('acks a startup backlog message but does not apply its stale state', () => {
    const { client, sockets } = makeClient();
    const handler = vi.fn();
    client.onDeviceStatus(handler);
    client.start();
    sockets[0].emit('open');

    // Queued an hour before we connected — superseded by the startup REST read.
    sockets[0].emit('message', makeFrame(STATUS_BODY, {
      messageId: 'm-old',
      publishedAt: Date.now() - 3_600_000,
    }));

    expect(handler).not.toHaveBeenCalled();
    expect(sockets[0].ackedIds()).toEqual(['m-old']);
    client.stop();
  });

  it('applies a message published after connect', () => {
    const { client, sockets } = makeClient();
    const handler = vi.fn();
    client.onDeviceStatus(handler);
    client.start();
    sockets[0].emit('open');
    sockets[0].emit('message', makeFrame(STATUS_BODY, { publishedAt: Date.now() + 5 }));

    expect(handler).toHaveBeenCalledWith('dev1', { switch: true, temp_set: 240 });
    client.stop();
  });

  it('applies an undated message, since it cannot be identified as backlog', () => {
    const { client, sockets } = makeClient();
    const handler = vi.fn();
    client.onDeviceStatus(handler);
    client.start();
    sockets[0].emit('open');

    const frame = JSON.parse(makeFrame(STATUS_BODY)) as Record<string, unknown>;
    delete frame.publishTime;
    // Strip the payload timestamp too, leaving nothing to date the message by.
    frame.payload = Buffer.from(JSON.stringify({
      data: encryptEcb(STATUS_BODY), protocol: 4, pv: '2.0', sign: 'x',
    })).toString('base64');
    sockets[0].emit('message', JSON.stringify(frame));

    expect(handler).toHaveBeenCalledWith('dev1', { switch: true, temp_set: 240 });
    client.stop();
  });

  it('stops discarding old messages once the drain window closes', () => {
    vi.useFakeTimers();
    const { client, sockets } = makeClient();
    const handler = vi.fn();
    client.onDeviceStatus(handler);
    client.start();
    sockets[0].emit('open');

    const old = Date.now() - 3_600_000;
    sockets[0].emit('message', makeFrame(STATUS_BODY, { publishedAt: old }));
    expect(handler).not.toHaveBeenCalled();

    // Past the window a stale timestamp is no longer trusted to mean "backlog" —
    // a skewed host clock must not silently swallow live updates forever.
    vi.advanceTimersByTime(61_000);
    sockets[0].emit('message', makeFrame(STATUS_BODY, { publishedAt: old }));
    expect(handler).toHaveBeenCalledTimes(1);

    client.stop();
  });

  it('applies the backlog after a reconnect — it is the changes we missed', () => {
    vi.useFakeTimers();
    const { client, sockets } = makeClient();
    const handler = vi.fn();
    client.onDeviceStatus(handler);
    client.start();
    sockets[0].emit('open');

    sockets[0].emit('close');
    vi.advanceTimersByTime(2_000);
    sockets[1].emit('open');

    // Published during the outage. Unlike at startup there is no REST read to
    // supersede it, so replaying it is what brings state back up to date.
    sockets[1].emit('message', makeFrame(STATUS_BODY, { publishedAt: Date.now() - 30_000 }));

    expect(handler).toHaveBeenCalledWith('dev1', { switch: true, temp_set: 240 });
    client.stop();
  });

  it('start() is idempotent — a second call does not open a second connection', () => {
    const { client, sockets } = makeClient();
    client.start();
    client.start();
    expect(sockets).toHaveLength(1);
    client.stop();
  });
});

describe('PulsarClient message ordering', () => {
  beforeEach(() => { vi.useRealTimers(); });

  it('merges successive partial pushes in the order received', () => {
    const { client, sockets } = makeClient();
    const seen: Record<string, unknown>[] = [];
    client.onDeviceStatus((_devId, changed) => seen.push(changed));
    client.start();

    sockets[0].emit('message', makeFrame({ ...STATUS_BODY, status: [{ code: 'mode', value: 'Cool' }] }));
    sockets[0].emit('message', makeFrame({ ...STATUS_BODY, status: [{ code: 'temp_set', value: 200 }] }));

    expect(seen).toEqual([{ mode: 'Cool' }, { temp_set: 200 }]);
    client.stop();
  });
});
