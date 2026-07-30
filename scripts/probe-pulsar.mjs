/**
 * Live probe: subscribe to Tuya's Message Service (Pulsar) and dump every pushed
 * message, fully decrypted, as it arrives.
 *
 * This drives the plugin's own PulsarClient, so it exercises the real connection,
 * auth, decryption, ack and reconnect paths. It tees each raw frame before the
 * client processes it, so you see *everything* on the subscription — not just the
 * device status reports the plugin routes to HomeKit.
 *
 * Usage:
 *   TUYA_ACCESS_KEY=xxx TUYA_SECRET_KEY=yyy node scripts/probe-pulsar.mjs [options]
 *
 * Options:
 *   --region <R>          US EU WEU CN IN       (default EU, or $TUYA_REGION)
 *   --env <E>             PROD | TEST           (default PROD)
 *   --subscription <name> subscription to consume, as a suffix (probe) or full
 *                         name (accessId-probe). Default: probe. Pass "sub" for
 *                         Tuya's shared default. Also $TUYA_PULSAR_SUBSCRIPTION.
 *   --consumer-name <n>   name to report to Pulsar, shown in the console's consumer
 *                         list (default: homebridge-meaco-probe@<host>)
 *   --device <ids>        only show these device ids, comma-separated
 *   --duration <s>        exit after N seconds  (default: run until Ctrl-C)
 *   --raw                 also print the raw envelope frame
 *   --no-ack              watch without consuming: suppress acks so messages stay
 *                         on the subscription. They redeliver every ~30s.
 *   --help
 *
 * Requires `npm run build` first — it imports from dist/.
 *
 * Give the probe its own subscription. A subscription is a consumer group: each one
 * gets an independent copy of every message, so a dedicated probe subscription lets
 * you watch without taking messages away from Homebridge. Create it in the Tuya
 * console under Cloud → your project → Message Service → Subscription Management.
 *
 * Sharing a subscription instead means competing for messages — it is Failover, so
 * only one consumer is active at a time. Either stop Homebridge first, or pass
 * --no-ack so nothing you receive is consumed.
 */

import { hostname } from 'node:os';

import { WebSocket } from 'ws';

const VALID_REGIONS = ['US', 'EU', 'WEU', 'CN', 'IN'];
const VALID_ENVS = ['PROD', 'TEST'];

// ── Arguments ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(await import('node:fs').then(fs =>
    fs.readFileSync(new URL(import.meta.url), 'utf-8').split('*/')[0].replace(/^\/\*\*\n?/, '').replace(/^ ?\* ?/gm, ''),
  ));
  process.exit(0);
}

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}

const accessKey = process.env.TUYA_ACCESS_KEY;
const secretKey = process.env.TUYA_SECRET_KEY;
const region = flag('region', process.env.TUYA_REGION ?? 'EU');
const env = flag('env', 'PROD').toUpperCase();
// Defaults to its own subscription so watching never takes messages away from
// the plugin. Note the client falls back to Tuya's shared default if this one
// does not exist, which the banner below reports.
const subscription = flag('subscription', process.env.TUYA_PULSAR_SUBSCRIPTION ?? 'probe').trim()
  || 'probe';
const consumerNameArg = flag('consumer-name', '');
const durationSec = Number(flag('duration', '0'));
const deviceFilter = flag('device', '').split(',').map(s => s.trim()).filter(Boolean);
const showRaw = argv.includes('--raw');
const shouldAck = !argv.includes('--no-ack');

const missing = ['TUYA_ACCESS_KEY', 'TUYA_SECRET_KEY'].filter(k => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}
if (!VALID_REGIONS.includes(region)) {
  console.error(`Invalid region "${region}". Must be one of: ${VALID_REGIONS.join(', ')}`);
  process.exit(1);
}
if (!VALID_ENVS.includes(env)) {
  console.error(`Invalid env "${env}". Must be one of: ${VALID_ENVS.join(', ')}`);
  process.exit(1);
}
if (Number.isNaN(durationSec) || durationSec < 0) {
  console.error('--duration must be a non-negative number of seconds.');
  process.exit(1);
}

// ── Plugin code under test ───────────────────────────────────────────────────

let PulsarClient, decryptPulsarData, parsePulsarMessage, resolveSubscriptionName, resolveConsumerName;
try {
  ({ PulsarClient, decryptPulsarData, parsePulsarMessage, resolveSubscriptionName,
    resolveConsumerName } = await import('../dist/tuya/pulsarClient.js'));
} catch {
  console.error('Could not load dist/tuya/pulsarClient.js — run `npm run build` first.');
  process.exit(1);
}

// ── Frame inspection ─────────────────────────────────────────────────────────

/**
 * Unwraps a frame all the way to the decrypted body, for any message type.
 * The plugin's parser only surfaces device status reports; here we want to see
 * online/offline, bind, rename and anything else Tuya puts on the topic.
 */
function unwrap(raw) {
  const envelope = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf-8'));
  let payload = null;
  let body = null;
  if (typeof envelope.payload === 'string') {
    payload = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf-8'));
    if (typeof payload.data === 'string') {
      body = decryptPulsarData(payload.data, secretKey, envelope.properties?.em);
    }
  }
  return { envelope, payload, body };
}

const stats = {
  total: 0,
  shown: 0,
  byDevice: new Map(),
  byType: new Map(),
  datapoints: new Map(),
  suppressedAcks: 0,
  firstAt: null,
  lastAt: null,
};

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Best-effort label for what kind of message this is. */
function messageType(body) {
  if (!body || typeof body !== 'object') return 'undecryptable';
  if (typeof body.bizCode === 'string') return body.bizCode;
  if (Array.isArray(body.status)) return 'deviceStatus';
  return 'unknown';
}

/** The changed datapoints, from whichever report shape this body uses. */
function datapointsOf(body) {
  if (Array.isArray(body?.status)) return body.status;
  if (Array.isArray(body?.bizData?.properties)) return body.bizData.properties;
  return [];
}

/** The device id, from whichever report shape this body uses. */
function deviceIdOf(body, envelope) {
  return body?.devId ?? body?.bizData?.devId ?? envelope.key ?? '(unknown)';
}

function onFrame(raw) {
  stats.total += 1;
  stats.lastAt = new Date();
  stats.firstAt ??= stats.lastAt;

  let parsed;
  try {
    parsed = unwrap(raw);
  } catch (err) {
    bump(stats.byType, 'unparseable');
    stats.shown += 1;
    console.log(`\n━━ [${new Date().toISOString()}] UNPARSEABLE FRAME: ${err.message}`);
    console.log(String(raw).slice(0, 2000));
    return;
  }

  const { envelope, payload, body } = parsed;
  const type = messageType(body);
  const devId = deviceIdOf(body, envelope);
  bump(stats.byType, type);
  bump(stats.byDevice, devId);

  for (const item of datapointsOf(body)) {
    if (typeof item?.code !== 'string') continue;
    const entry = stats.datapoints.get(item.code) ?? { count: 0, last: undefined };
    entry.count += 1;
    entry.last = item.value;
    stats.datapoints.set(item.code, entry);
  }

  if (deviceFilter.length && !deviceFilter.includes(devId)) return;
  stats.shown += 1;

  // What the plugin itself would make of this frame. Mirrors PulsarClient's
  // backlog rule so the verdict reflects what actually reaches HomeKit, not just
  // what the parser could extract.
  const verdict = parsePulsarMessage(raw, secretKey);
  const publishedAt = verdict.publishedAt;
  const isStartupBacklog = probeIsFirstConnection
    && probeConnectedAt !== null
    && Date.now() - probeConnectedAt <= 60_000
    && publishedAt !== null
    && publishedAt < probeConnectedAt;

  const routed = isStartupBacklog
    ? 'startup backlog — acked and discarded (state comes from the REST read at launch)'
    : verdict.status
      ? `routes to ${verdict.status.devId} → ${JSON.stringify(verdict.status.changed)}`
      : 'not routed (not a device status report)';

  console.log(`\n━━ [${new Date().toISOString()}] ${type}  ${devId}`);
  console.log(`   messageId:   ${envelope.messageId ?? '—'}`);
  console.log(`   publishTime: ${envelope.publishTime ?? '—'}`);
  console.log(`   redelivery:  ${envelope.redeliveryCount ?? 0}`);
  console.log(`   encryption:  ${envelope.properties?.em ?? 'aes_ecb (default)'}`);
  if (payload) console.log(`   protocol:    ${payload.protocol}  pv=${payload.pv}  t=${payload.t}`);
  console.log(`   plugin:      ${routed}`);
  console.log('   decrypted body:');
  console.log(String(JSON.stringify(body, null, 2)).split('\n').map(l => `     ${l}`).join('\n'));
  if (showRaw) {
    console.log('   raw envelope:');
    console.log(String(JSON.stringify(envelope, null, 2)).split('\n').map(l => `     ${l}`).join('\n'));
  }
}

// ── Transport: the real socket, tapped ───────────────────────────────────────

/**
 * Testing hatch: point the probe at a local fake endpoint instead of Tuya. Only
 * the host is swapped — the topic path and query are preserved, so a fake endpoint
 * still sees the real subscription path.
 */
const urlOverride = process.env.TUYA_PULSAR_URL;

function applyOverride(url) {
  if (!urlOverride) return url;
  const built = new URL(url);
  const target = new URL(urlOverride);
  target.pathname = built.pathname;
  target.search = built.search;
  return target.toString();
}

// Mirrors PulsarClient's own connection state so the probe can report which
// messages the plugin would treat as startup backlog.
let probeConnectedAt = null;
let probeIsFirstConnection = true;

function teeSocketFactory(url, headers) {
  const ws = new WebSocket(applyOverride(url), {
    headers, handshakeTimeout: 15_000, autoPong: false,
  });
  return {
    get readyState() { return ws.readyState; },
    on(event, listener) {
      if (event === 'open') {
        ws.on('open', (...args) => {
          probeIsFirstConnection = probeConnectedAt === null;
          probeConnectedAt = Date.now();
          listener(...args);
        });
      } else if (event === 'message') {
        ws.on('message', (data) => {
          try {
            onFrame(data);
          } catch (err) {
            console.error(`Probe error while printing frame: ${err.message}`);
          }
          listener(data);
        });
      } else {
        ws.on(event, listener);
      }
      return this;
    },
    send(data) {
      if (shouldAck) {
        ws.send(data);
      } else {
        stats.suppressedAcks += 1;
      }
    },
    ping(data) { ws.ping(data); },
    pong(data) { ws.pong(data); },
    close() { ws.close(); },
    terminate() { ws.terminate(); },
  };
}

// ── Run ──────────────────────────────────────────────────────────────────────

const log = {
  debug: (m) => { if (showRaw) console.log(`   · ${m}`); },
  info: (m) => { console.log(`   · ${m}`); },
  warn: (m) => { console.warn(`   ! ${m}`); },
  error: (m) => { console.error(`   ✗ ${m}`); },
};

// Distinct from the plugin's name, so the console shows which tool is connected.
const consumerName = resolveConsumerName(consumerNameArg, hostname(), 'homebridge-meaco-probe');
const resolvedSubscription = resolveSubscriptionName(accessKey, subscription);
const isSharedSubscription = resolvedSubscription === resolveSubscriptionName(accessKey);

console.log(`
Tuya Message Service probe
  region:       ${region}
  env:          ${env}
  accessId:     ${accessKey.slice(0, 4)}${'*'.repeat(Math.max(0, accessKey.length - 4))}
  subscription: ${resolvedSubscription}${isSharedSubscription ? '  (Tuya default — shared)' : '  (dedicated)'}
  consumer:     ${consumerName}
  acking:       ${shouldAck ? 'yes — messages are consumed from this subscription' : 'NO — messages stay queued and will redeliver'}
  filter:       ${deviceFilter.length ? deviceFilter.join(', ') : '(all devices)'}
  duration:     ${durationSec > 0 ? `${durationSec}s` : 'until Ctrl-C'}
${isSharedSubscription && shouldAck ? `
WARNING: consuming Tuya's shared default subscription with acking on, so every
message you receive is taken from whatever else consumes it — including Homebridge.
Create a dedicated probe subscription in the Tuya console, or run with --no-ack.
` : ''}${!isSharedSubscription ? `
If "${resolvedSubscription}" does not exist in the Tuya console, the client will say so
and fall back to the shared default — watch for that warning before trusting a
quiet run.
` : ''}`);

const client = new PulsarClient(
  { region, accessKey, secretKey, env, consumerName, ...(subscription ? { subscription } : {}) },
  log,
  teeSocketFactory,
);

client.onDeviceStatus(() => {
  // Printing happens in the frame tap, which sees every message type. This
  // handler exists only so the client's dispatch path runs as it would in
  // Homebridge.
});

client.start();

let finished = false;
function finish(reason) {
  if (finished) return;
  finished = true;
  client.stop();
  printSummary(reason);
  // Give the close frame a moment to flush.
  setTimeout(() => process.exit(0), 250);
}

function printSummary(reason) {
  const seconds = stats.firstAt ? Math.round((stats.lastAt - stats.firstAt) / 1000) : 0;
  console.log(`\n\n━━━━━━━━ Summary (${reason}) ━━━━━━━━`);
  console.log(`Messages:  ${stats.total} received${deviceFilter.length ? `, ${stats.shown} shown` : ''}` +
    (stats.total > 1 ? ` over ${seconds}s` : ''));
  if (!shouldAck) console.log(`Acks suppressed: ${stats.suppressedAcks} (messages remain on the subscription)`);

  if (stats.byType.size) {
    console.log('\nBy message type:');
    for (const [type, n] of [...stats.byType].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)}  ${type}`);
    }
  }
  if (stats.byDevice.size) {
    console.log('\nBy device:');
    for (const [dev, n] of [...stats.byDevice].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)}  ${dev}`);
    }
  }
  if (stats.datapoints.size) {
    const w = Math.max(...[...stats.datapoints.keys()].map(c => c.length));
    console.log('\nDatapoints seen (code, times reported, last value):');
    for (const [code, e] of [...stats.datapoints].sort((a, b) => b[1].count - a[1].count)) {
      console.log(`  ${code.padEnd(w)}  ${String(e.count).padStart(4)}  ${JSON.stringify(e.last)}`);
    }
  }
  if (stats.total === 0) {
    console.log(`
No messages received. Things to check:
  - Message Service is enabled for this project in the Tuya IoT console
    (Cloud → your project → Message Service), and subscription
    ${resolvedSubscription} shows a consumer connected while this was running.
  - The subscription exists. If it does not, look for a fallback warning above.
    A freshly created subscription may also start from the latest message, so it
    will look empty until something changes.
  - You are on the right channel: production devices publish to --env PROD.
  - Something actually changed. Push only reports changes, so poke the unit's
    control panel or the Smart Life app while this is running.
  - Nothing else is consuming the subscription (Homebridge, another probe).`);
  }
  console.log('');
}

process.on('SIGINT', () => { finish('interrupted'); });
process.on('SIGTERM', () => { finish('terminated'); });

if (durationSec > 0) {
  setTimeout(() => { finish(`${durationSec}s elapsed`); }, durationSec * 1000);
}
