import crypto from 'node:crypto';

import { WebSocket } from 'ws';

import { PLUGIN_NAME, TUYA_PULSAR_ENVS, TUYA_PULSAR_URLS } from '../settings.js';
import type { TuyaPulsarEnv, TuyaRegion } from '../settings.js';

import type { TuyaPulsarDatapoint, TuyaValue } from './types.js';

/** Server-side ack deadline. Unacked messages are redelivered after this. */
const ACK_TIMEOUT_MILLIS = 30_000;

/** Idle period after which we send a WebSocket ping to prove the link is alive. */
const KEEP_ALIVE_MS = 30_000;

/** How long to wait for any traffic after a ping before declaring the link dead. */
const PONG_TIMEOUT_MS = 10_000;

/**
 * How long after the *first* connection we treat older messages as backlog. Tuya
 * holds unconsumed messages for two hours, so a subscription that has been idle can
 * have a large queue waiting at startup. Every device is read over REST during
 * launch, so that queue is stale by definition: it is acked and dropped.
 *
 * This applies to the first connection only. A backlog waiting after a reconnect is
 * the set of changes we missed while disconnected, with no REST read to supersede
 * it, so those are applied normally — replaying them converges on current state.
 *
 * The window bounds the damage from clock disagreement: if the host clock ran ahead
 * of the broker's, an unbounded comparison would silently discard live updates.
 * After the window everything is applied regardless of its timestamp.
 */
const BACKLOG_DRAIN_WINDOW_MS = 60_000;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * The subset of the `ws` API this client uses. Declaring it explicitly keeps the
 * transport swappable so tests can drive the client with a fake socket.
 */
export interface PulsarSocket {
  readonly readyState: number;
  on(event: 'open' | 'close' | 'ping' | 'pong', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  send(data: string): void;
  ping(data?: string): void;
  pong(data?: string): void;
  close(): void;
  terminate(): void;
}

export type PulsarSocketFactory = (url: string, headers: Record<string, string>) => PulsarSocket;

/** Structurally satisfied by Homebridge's `Logger`. */
export interface PulsarLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface PulsarClientConfig {
  region: TuyaRegion;
  /** Tuya Access ID — the same value the REST client sends as `client_id`. */
  accessKey: string;
  /** Tuya Access Secret. Doubles as the payload decryption key material. */
  secretKey: string;
  env: TuyaPulsarEnv;
  /**
   * Subscription to consume. Omit for Tuya's shared default (`{accessId}-sub`);
   * set to a dedicated subscription created in the console so this plugin does not
   * compete with other consumers on the same project.
   */
  subscription?: string;
  /**
   * Name this consumer reports to Pulsar, shown in the Tuya console's consumer
   * list for the subscription. Dropped automatically if Tuya's gateway refuses the
   * parameter, since it is cosmetic and must never cost us the connection.
   */
  consumerName?: string;
}

export type DeviceStatusHandler = (devId: string, changed: Record<string, TuyaValue>) => void;

export interface ParsedPulsarMessage {
  /** Null only when the envelope itself was unreadable, in which case we cannot ack. */
  messageId: string | null;
  redeliveryCount: number;
  /** Broker publish time in epoch ms; null when the frame carried no timestamp. */
  publishedAt: number | null;
  /**
   * The device this message concerns, for *any* message type — including ones we
   * do not route, and bodies that failed to decrypt (Tuya sets the envelope's
   * routing key to the device id). Null when nothing identifies a device.
   */
  devId: string | null;
  /** Populated only for datapoint reports; other message types parse to null. */
  status: { devId: string; changed: Record<string, TuyaValue> } | null;
}

/** Decides whether a device is one this plugin manages. */
export type DeviceFilter = (devId: string) => boolean;

// ── Pure helpers (exported for testing) ───────────────────────────────────────

function md5Hex(value: string): string {
  // codeql[js/weak-cryptographic-algorithm] -- Required by Tuya Pulsar auth contract:
  // password = middle16(md5(accessId + md5(secretKey))). Changing MD5 breaks interoperability.
  return crypto.createHash('md5').update(value).digest('hex');
}

/**
 * Tuya's Pulsar gateway authenticates with the Access ID as username and a digest of
 * the Access Secret as password: the middle 16 chars of `md5(accessId + md5(secret))`.
 */
export function buildPulsarPassword(accessId: string, secretKey: string): string {
  return md5Hex(`${accessId}${md5Hex(secretKey)}`).substring(8, 24);
}

/**
 * Resolves the Pulsar subscription name. Tuya names subscriptions
 * `{accessId}-{suffix}`, with `sub` as the default suffix — that default is shared
 * by every consumer using these credentials, so a dedicated subscription created
 * in the Tuya console gets its own independent copy of every message.
 *
 * Accepts either form the console might show: a bare suffix (`meaco`) or the full
 * name (`abc123-meaco`).
 */
export function resolveSubscriptionName(accessId: string, configured?: string): string {
  const value = configured?.trim();
  if (!value) return `${accessId}-sub`;
  return value.startsWith(`${accessId}-`) ? value : `${accessId}-${value}`;
}

/**
 * Resolves the name this consumer reports to Pulsar, which the Tuya console shows
 * in the consumer list for the subscription. Defaults to `<base>@<host>` so two
 * installs sharing a Tuya project can be told apart — the whole point of the name.
 */
export function resolveConsumerName(
  configured: string | undefined,
  host: string,
  base: string = PLUGIN_NAME,
): string {
  const value = configured?.trim();
  if (value !== undefined && value !== '') return value;
  const shortHost = host.split('.')[0].replace(/[^A-Za-z0-9_-]/g, '');
  return shortHost === '' ? base : `${base}@${shortHost}`;
}

/**
 * Builds the Pulsar WebSocket consumer topic URL. The topic is fixed per project:
 * the tenant is the Access ID and the namespace segment selects the production or
 * test channel. The final segment is the subscription — the one part that can be
 * pointed at a dedicated consumer group.
 */
export function buildPulsarTopicUrl(
  baseUrl: string,
  accessId: string,
  env: TuyaPulsarEnv,
  subscription?: string,
  consumerName?: string,
): string {
  const query = new URLSearchParams({
    subscriptionType: 'Failover',
    ackTimeoutMillis: String(ACK_TIMEOUT_MILLIS),
  });
  // Identifies this client in the console's consumer list for the subscription.
  // Without it Pulsar assigns an opaque generated name.
  if (consumerName !== undefined && consumerName !== '') {
    query.set('consumerName', consumerName);
  }
  const namespace = TUYA_PULSAR_ENVS[env];
  const name = resolveSubscriptionName(accessId, subscription);
  return `${baseUrl}ws/v2/consumer/persistent/${accessId}/out/${namespace}/${name}?${query.toString()}`;
}

/**
 * Decrypts a message body. The key is always the middle 16 chars of the Access
 * Secret; the cipher is AES-128-ECB unless the envelope names `aes_gcm`, in which
 * case the ciphertext is packed as `iv(12) || ciphertext || tag(16)`.
 *
 * ECB is Tuya's choice of wire format, not ours — this is inbound decryption of
 * their frames, so the mode is fixed by the protocol. We never encrypt.
 */
export function decryptPulsarData(
  encrypted: string,
  secretKey: string,
  encryptionModel?: string,
): unknown {
  const key = Buffer.from(secretKey.substring(8, 24), 'utf-8');
  const raw = Buffer.from(encrypted, 'base64');

  let plaintext: string;
  if (encryptionModel === 'aes_gcm') {
    const decipher = crypto.createDecipheriv('aes-128-gcm', key, raw.subarray(0, GCM_IV_BYTES));
    decipher.setAuthTag(raw.subarray(raw.length - GCM_TAG_BYTES));
    const body = raw.subarray(GCM_IV_BYTES, raw.length - GCM_TAG_BYTES);
    plaintext = decipher.update(body, undefined, 'utf-8') + decipher.final('utf-8');
  } else {
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    plaintext = decipher.update(raw, undefined, 'utf-8') + decipher.final('utf-8');
  }

  return JSON.parse(plaintext) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isTuyaValue(value: unknown): value is TuyaValue {
  return typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string';
}

/**
 * Flattens a pushed datapoint array into the partial `{ code: value }` map the
 * state cache merges. Entries without a usable code/value pair are dropped rather
 * than poisoning the cache.
 */
export function toStatusMap(items: readonly TuyaPulsarDatapoint[]): Record<string, TuyaValue> {
  const map: Record<string, TuyaValue> = {};
  for (const item of items) {
    if (typeof item.code !== 'string' || item.code === '') continue;
    if (!isTuyaValue(item.value)) continue;
    map[item.code] = item.value;
  }
  return map;
}

/**
 * Pulls the device id and changed datapoints out of a decrypted body, whichever
 * report shape it uses. Which shape a project receives depends on how its Message
 * Service subscription is configured, so both have to be handled:
 *
 *   protocol 4    `{ devId, status: [{ code, value, t }] }`
 *   protocol 1000 `{ bizCode: 'devicePropertyMessage',
 *                    bizData: { devId, properties: [{ code, value, dpId, time }] } }`
 *
 * Returns null for anything else — online/offline, bind, rename, events — and for
 * a report whose datapoints were all unusable.
 */
/**
 * The device a decrypted body concerns, regardless of message type. Datapoint
 * reports put it at the top level (protocol 4) or under `bizData` (protocol 1000);
 * management messages such as `deviceOnline` use the top level too.
 */
function extractDeviceId(body: Record<string, unknown>): string | null {
  if (typeof body.devId === 'string' && body.devId !== '') return body.devId;
  const bizData = asRecord(body.bizData);
  if (bizData && typeof bizData.devId === 'string' && bizData.devId !== '') return bizData.devId;
  return null;
}

function extractDatapoints(
  body: Record<string, unknown>,
): { devId: string; changed: Record<string, TuyaValue> } | null {
  const routed = (devId: string, items: readonly TuyaPulsarDatapoint[]) => {
    const changed = toStatusMap(items);
    return Object.keys(changed).length > 0 ? { devId, changed } : null;
  };

  if (typeof body.devId === 'string' && Array.isArray(body.status)) {
    return routed(body.devId, body.status as TuyaPulsarDatapoint[]);
  }

  const bizData = asRecord(body.bizData);
  if (bizData && typeof bizData.devId === 'string' && Array.isArray(bizData.properties)) {
    return routed(bizData.devId, bizData.properties as TuyaPulsarDatapoint[]);
  }

  return null;
}

/**
 * The HTTP status from a rejected WebSocket handshake, or null if the error was
 * something else (network, TLS, timeout). `ws` surfaces a refused upgrade only as
 * an error message, so this reads it back out of the text.
 */
export function handshakeRejectionStatus(err: Error): number | null {
  const match = /unexpected server response:\s*(\d{3})/i.exec(err.message);
  return match ? Number(match[1]) : null;
}

function toEpochMs(isoTimestamp: string): number | null {
  const ms = Date.parse(isoTimestamp);
  return Number.isNaN(ms) ? null : ms;
}

function rawToString(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf-8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf-8');
  if (Array.isArray(data) && data.every((chunk) => Buffer.isBuffer(chunk))) {
    return Buffer.concat(data).toString('utf-8');
  }
  return '';
}

/**
 * Unwraps one WebSocket frame: envelope → base64 payload → decrypted `data`.
 *
 * Never throws. A malformed body still yields the `messageId` where one could be
 * read, so the caller can ack it and stop the broker redelivering it forever.
 */
export function parsePulsarMessage(raw: unknown, secretKey: string): ParsedPulsarMessage {
  const empty: ParsedPulsarMessage = {
    messageId: null, redeliveryCount: 0, publishedAt: null, devId: null, status: null,
  };

  let envelope: Record<string, unknown> | null;
  try {
    const decoded: unknown = JSON.parse(rawToString(raw));
    envelope = asRecord(decoded);
  } catch {
    return empty;
  }
  if (!envelope) return empty;

  const messageId = typeof envelope.messageId === 'string' ? envelope.messageId : null;
  const redeliveryCount = typeof envelope.redeliveryCount === 'number' ? envelope.redeliveryCount : 0;
  const result: ParsedPulsarMessage = {
    messageId,
    redeliveryCount,
    publishedAt: typeof envelope.publishTime === 'string' ? toEpochMs(envelope.publishTime) : null,
    // Tuya routes by device, so the envelope key identifies the device even when
    // the body cannot be decrypted. Refined from the body below where possible.
    devId: typeof envelope.key === 'string' && envelope.key !== '' ? envelope.key : null,
    status: null,
  };

  if (typeof envelope.payload !== 'string') return result;

  let data: unknown;
  try {
    const payload = asRecord(JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf-8')) as unknown);
    if (!payload || typeof payload.data !== 'string') return result;
    // Fall back to the payload timestamp when the envelope carried no publish time.
    if (result.publishedAt === null && typeof payload.t === 'number') {
      result.publishedAt = payload.t;
    }
    const encryptionModel = asRecord(envelope.properties)?.em;
    data = decryptPulsarData(
      payload.data,
      secretKey,
      typeof encryptionModel === 'string' ? encryptionModel : undefined,
    );
  } catch {
    return result;
  }

  const body = asRecord(data);
  if (!body) return result;

  result.devId = extractDeviceId(body) ?? result.devId;
  result.status = extractDatapoints(body);
  return result;
}

// ── Client ────────────────────────────────────────────────────────────────────

const defaultSocketFactory: PulsarSocketFactory = (url, headers) =>
  new WebSocket(url, { headers, handshakeTimeout: HANDSHAKE_TIMEOUT_MS, autoPong: false });

/**
 * Subscribes to Tuya's Message Service and dispatches pushed datapoint changes.
 *
 * One connection serves every device on the project — the subscription is per
 * cloud project, not per device. The client knows nothing about HomeKit: it
 * decrypts, acks, and hands `(devId, changedDatapoints)` to a single callback.
 */
export class PulsarClient {
  private readonly password: string;

  /** Subscription we want: dedicated, so we are the only consumer. */
  private readonly preferredSubscription: string;
  /** Tuya's built-in subscription, shared by every consumer on the project. */
  private readonly defaultSubscription: string;
  private activeSubscription: string;
  private usingFallback = false;
  /** Cleared if the gateway refuses the consumerName parameter. */
  private sendConsumerName: boolean;

  /** Whether the current attempt reached an open socket, and how it was refused. */
  private openedThisAttempt = false;
  private handshakeStatus: number | null = null;

  private socket: PulsarSocket | null = null;
  private handler: DeviceStatusHandler | null = null;
  private deviceFilter: DeviceFilter | null = null;
  private stopped = true;
  private foreignSkipped = 0;
  private retryCount = 0;

  private connectedAt: number | null = null;
  private backlogDropped = 0;
  private isFirstConnection = true;

  private keepAliveTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly config: PulsarClientConfig,
    private readonly log: PulsarLogger,
    private readonly createSocket: PulsarSocketFactory = defaultSocketFactory,
  ) {
    this.password = buildPulsarPassword(config.accessKey, config.secretKey);
    this.preferredSubscription = resolveSubscriptionName(config.accessKey, config.subscription);
    this.defaultSubscription = resolveSubscriptionName(config.accessKey);
    this.activeSubscription = this.preferredSubscription;
    this.sendConsumerName = config.consumerName !== undefined && config.consumerName !== '';
  }

  /** The subscription currently being consumed. */
  get subscriptionName(): string {
    return this.activeSubscription;
  }

  /** True once we have given up on the preferred subscription for this session. */
  get isUsingFallbackSubscription(): boolean {
    return this.usingFallback;
  }

  /**
   * The consumer name currently in use, or null once dropped because the gateway
   * refused it — in which case Pulsar assigns a generated name instead.
   */
  get consumerName(): string | null {
    return this.sendConsumerName ? this.config.consumerName ?? null : null;
  }

  /**
   * True when consuming Tuya's shared default, where other consumers may be
   * relying on the messages we would otherwise ack away.
   */
  private get onSharedSubscription(): boolean {
    return this.activeSubscription === this.defaultSubscription;
  }

  /** Registers the single dispatch callback. Replaces any previous handler. */
  onDeviceStatus(handler: DeviceStatusHandler): void {
    this.handler = handler;
  }

  /**
   * Identifies the devices this plugin manages.
   *
   * Only consulted while consuming Tuya's shared default subscription, where other
   * consumers may need the messages we would otherwise ack away. On a dedicated
   * subscription we are the only consumer, so everything is acked — filtering there
   * would leave other devices' messages redelivering forever with nobody to claim
   * them. That distinction is made here rather than by the caller because a
   * rejected subscription can demote us onto the shared one at runtime.
   */
  setDeviceFilter(filter: DeviceFilter): void {
    this.deviceFilter = filter;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer('keepAliveTimer');
    this.clearTimer('pongTimer');
    this.clearTimer('reconnectTimer');
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        socket.terminate();
      }
    }
  }

  private connect(): void {
    this.log.debug(
      `Connecting to Tuya Message Service (${this.config.region}, ${this.config.env}, ` +
      `subscription ${this.activeSubscription})`,
    );
    this.openedThisAttempt = false;
    this.handshakeStatus = null;

    const url = buildPulsarTopicUrl(
      TUYA_PULSAR_URLS[this.config.region],
      this.config.accessKey,
      this.config.env,
      this.activeSubscription,
      this.sendConsumerName ? this.config.consumerName : undefined,
    );

    let socket: PulsarSocket;
    try {
      socket = this.createSocket(url, {
        username: this.config.accessKey,
        password: this.password,
      });
    } catch (err) {
      this.log.error(`Could not open Tuya Message Service connection: ${String(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.on('open', () => {
      this.retryCount = 0;
      this.openedThisAttempt = true;
      this.isFirstConnection = this.connectedAt === null;
      this.connectedAt = Date.now();
      this.backlogDropped = 0;
      const identity =
        `subscription "${this.activeSubscription}", consumer ` +
        (this.consumerName === null
          ? '(Pulsar-generated name)'
          : `"${this.consumerName}"`);
      this.log.info(
        this.isFirstConnection
          ? `Connected to Tuya Message Service on ${identity}. ` +
            'Device updates will arrive by push.'
          : `Reconnected to Tuya Message Service on ${identity}. ` +
            'Replaying anything missed while disconnected.',
      );
      this.touch();
    });

    socket.on('message', (data) => {
      this.touch();
      this.handleMessage(data);
    });

    // Tuya's gateway pings us; the SDK answers with the access ID as the pong body.
    socket.on('ping', () => {
      this.touch();
      socket.pong(this.config.accessKey);
    });

    socket.on('pong', () => { this.touch(); });

    socket.on('error', (err) => {
      // A 'close' always follows, which is where reconnection and the decision to
      // fall back are handled.
      this.handshakeStatus ??= handshakeRejectionStatus(err);
      this.log.warn(`Tuya Message Service error: ${err.message}`);
    });

    socket.on('close', () => {
      this.clearTimer('keepAliveTimer');
      this.clearTimer('pongTimer');
      if (this.stopped) {
        this.log.info('Disconnected from Tuya Message Service.');
        return;
      }
      // Ignore the close of a socket we have already replaced.
      if (this.socket !== socket) return;
      this.socket = null;
      this.degradeAfterRefusedHandshake();
      this.scheduleReconnect();
    });
  }

  private handleMessage(raw: unknown): void {
    const { messageId, redeliveryCount, publishedAt, devId, status } =
      parsePulsarMessage(raw, this.config.secretKey);

    // Someone else's device: leave it untouched and unacked so another consumer
    // can claim it. Deliberately before the redelivery log, since these will be
    // redelivered for as long as we stay connected.
    if (this.isForeignDevice(devId)) {
      this.foreignSkipped += 1;
      this.log.debug(
        `Ignoring message for unmanaged device ${devId ?? '(unknown)'} — not acked, ` +
        `left for another consumer (${this.foreignSkipped} so far)`,
      );
      return;
    }

    if (redeliveryCount > 0) {
      this.log.debug(`Redelivered Tuya message (attempt ${redeliveryCount + 1})`);
    }
    try {
      if (this.isBacklog(publishedAt)) {
        this.noteBacklogDrop();
        return;
      }
      if (status && this.handler) {
        this.handler(status.devId, status.changed);
      }
    } catch (err) {
      this.log.error(`Error handling pushed device status: ${String(err)}`);
    } finally {
      // Ack regardless of outcome — an unacked message is redelivered, and a
      // handler that fails once will fail again on every redelivery. Backlog is
      // acked too: that is what clears it from the subscription.
      if (messageId !== null) this.ack(messageId);
    }
  }

  /**
   * True for a message belonging to a device this plugin does not manage.
   *
   * A message we cannot attribute to any device is *not* treated as foreign: no
   * other consumer could claim it either, so refusing to ack it would only spin
   * up an endless redelivery loop.
   */
  private isForeignDevice(devId: string | null): boolean {
    if (!this.onSharedSubscription) return false;
    if (this.deviceFilter === null || devId === null) return false;
    return !this.deviceFilter(devId);
  }

  /** True for a message the broker queued before our first connection at startup. */
  private isBacklog(publishedAt: number | null): boolean {
    if (!this.isFirstConnection) return false;
    if (publishedAt === null || this.connectedAt === null) return false;
    if (Date.now() - this.connectedAt > BACKLOG_DRAIN_WINDOW_MS) return false;
    return publishedAt < this.connectedAt;
  }

  private noteBacklogDrop(): void {
    this.backlogDropped += 1;
    if (this.backlogDropped === 1) {
      this.log.info(
        'Draining messages that were queued before startup — discarding them rather ' +
        'than applying stale values, as every device was just read from the API.',
      );
    }
    this.log.debug(`Discarded backlogged message (${this.backlogDropped} so far)`);
  }

  private ack(messageId: string): void {
    try {
      this.socket?.send(JSON.stringify({ messageId }));
    } catch (err) {
      this.log.warn(`Failed to ack Tuya message: ${String(err)}`);
    }
  }

  /**
   * Reacts to a *refused* handshake — the socket never opened and the server
   * answered 4xx — by giving up one thing at a time, cheapest first:
   *
   *   1. the `consumerName` parameter, which is cosmetic; Tuya runs a customised
   *      Pulsar and may not accept it
   *   2. the dedicated subscription, falling back to Tuya's shared default
   *
   * Deliberately narrow. A network error, a timeout, a 401, or a drop on a
   * connection that had already opened all leave the configuration alone: none of
   * those mean the request was malformed, and silently demoting on a transient
   * fault would put us on the shared subscription competing for messages.
   */
  private degradeAfterRefusedHandshake(): void {
    if (this.openedThisAttempt) return;
    const status = this.handshakeStatus;
    // 401 is a credentials problem; degrading would not fix it and would hide it.
    if (status === null || status < 400 || status >= 500 || status === 401) return;

    if (this.sendConsumerName) {
      this.sendConsumerName = false;
      this.retryCount = 0;
      this.log.warn(
        `Tuya refused the connection (HTTP ${status}) with a consumer name set. ` +
        'Retrying without it — the consumer will show under a generated name instead.',
      );
      return;
    }

    if (this.usingFallback) return;
    if (this.preferredSubscription === this.defaultSubscription) return;
    this.fallBackToDefaultSubscription();
  }

  private fallBackToDefaultSubscription(): void {
    this.usingFallback = true;
    this.activeSubscription = this.defaultSubscription;
    this.retryCount = 0;
    this.log.warn(
      `Tuya rejected subscription "${this.preferredSubscription}" ` +
      `(HTTP ${this.handshakeStatus ?? '?'}) — it probably does not exist. Falling back to ` +
      `the shared default "${this.defaultSubscription}".`,
    );
    this.log.warn(
      'Create a dedicated subscription in the Tuya IoT console (Cloud → your project → ' +
      `Message Service → Subscription Management) with the suffix "` +
      `${this.preferredSubscription.slice(this.config.accessKey.length + 1)}", then restart. ` +
      'On the shared subscription this plugin competes for messages with anything else ' +
      'using these credentials, and only acks messages for devices it manages.',
    );
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const backoff = Math.min(RECONNECT_BASE_MS * 2 ** this.retryCount, RECONNECT_MAX_MS);
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    this.retryCount += 1;
    this.log.warn(
      `Tuya Message Service disconnected — reconnecting in ${Math.round(delay / 1000)}s ` +
      `(attempt ${this.retryCount}). Falling back to REST polling until it recovers.`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  /**
   * Resets the liveness timers after any traffic. If the link then goes quiet we
   * ping, and if even the ping draws nothing we tear the socket down so the
   * reconnect path runs — a half-open socket would otherwise sit silent forever.
   */
  private touch(): void {
    this.clearTimer('pongTimer');
    this.clearTimer('keepAliveTimer');
    this.keepAliveTimer = setTimeout(() => {
      this.keepAliveTimer = null;
      const socket = this.socket;
      if (!socket) return;
      socket.ping(this.config.accessKey);
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        this.log.warn('Tuya Message Service stopped responding — dropping the connection to retry.');
        socket.terminate();
      }, PONG_TIMEOUT_MS);
    }, KEEP_ALIVE_MS);
  }

  private clearTimer(name: 'keepAliveTimer' | 'pongTimer' | 'reconnectTimer'): void {
    const timer = this[name];
    if (timer !== null) {
      clearTimeout(timer);
      this[name] = null;
    }
  }
}
