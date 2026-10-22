// Fake Tuya cloud for the local harness. Answers the OpenAPI calls the plugin makes
// (src/tuya/cloudClient.ts) with three air conditioners, keeps their state in memory so
// commands from HomeKit change what later reads return, and logs every request so you can
// follow what the plugin is doing: `scripts/harness.sh logs tuya-stub`.
//
// Signatures aren't checked. Any credentials work, except an access key starting with
// "bad", which fails authentication like a wrong key does on the real cloud.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';

const fn = (code, type, values = {}) => ({ code, desc: '', name: code, type, values: JSON.stringify(values) });

// What a thing model says about a device's modes and fan speeds, which the plugin reads
// because Meaco units don't always list them in the specification.
const thingModel = (modes, fanSpeeds) => JSON.stringify({
  services: [{
    properties: [
      { code: 'mode', typeSpec: { type: 'enum', range: modes } },
      { code: 'fan_speed_enum', typeSpec: { type: 'enum', range: fanSpeeds } },
    ],
  }],
});

const DEVICES = [
  {
    // Recognised by product ID. Specification copied from the real capture in
    // test/fixtures/specifications/meacocool-mc10000rpro.json: no mode DP, so modes come
    // from the thing model, and no sleep.
    id: 'bfharness00living01',
    name: 'Living Room AC',
    model: 'MC10000RPRO',
    productId: 'pgdwirmckucamyz7',
    productName: 'MeacoCool MC Series 10000 PRO',
    functions: [
      fn('switch', 'Boolean'),
      fn('temp_set', 'Integer', { unit: '℃', min: 16, max: 32, scale: 0, step: 1 }),
      fn('lock', 'Boolean'),
      fn('swing', 'Boolean'),
      fn('temp_unit_convert', 'Enum', { range: ['c', 'f'] }),
      fn('temp_set_f', 'Integer', { unit: '℉', min: 61, max: 90, scale: 0, step: 1 }),
    ],
    statusSpecs: [
      fn('temp_current', 'Integer', { unit: '℃', min: 0, max: 99, scale: 0, step: 1 }),
      fn('fault', 'Bitmap', { label: ['E1', 'E2'] }),
      fn('temp_current_f', 'Integer', { unit: '℉', min: 32, max: 210, scale: 0, step: 1 }),
    ],
    thingModel: thingModel(['Cool', 'Dyr', 'Fan'], ['Low', 'High']),
    status: {
      switch: false, mode: 'Cool', temp_set: 22, temp_current: 26, lock: false, swing: false,
      temp_unit_convert: 'c', fault: 0, temp_set_f: 72, temp_current_f: 79, fan_speed_enum: 'Low',
    },
  },
  {
    // Recognised by its Meaco model code, as newer ranges report. Has heat and sleep.
    id: 'bfharness00bedroom1',
    name: 'Bedroom AC',
    model: 'CIRRO14000PRO',
    productId: 'harnesscirro14k0',
    productName: 'A-Cirro-14k-INV',
    functions: [
      fn('switch', 'Boolean'),
      fn('mode', 'Enum', { range: ['Cool', 'Dyr', 'Fan', 'Heat'] }),
      fn('temp_set', 'Integer', { unit: '℃', min: 16, max: 31, scale: 0, step: 1 }),
      fn('fan_speed_enum', 'Enum', { range: ['Low', 'High'] }),
      fn('swing', 'Boolean'),
      fn('lock', 'Boolean'),
      fn('sleep', 'Boolean'),
      fn('temp_unit_convert', 'Enum', { range: ['c', 'f'] }),
    ],
    statusSpecs: [fn('temp_current', 'Integer', { unit: '℃', min: 0, max: 99, scale: 0, step: 1 })],
    thingModel: thingModel(['Cool', 'Dyr', 'Fan', 'Heat'], ['Low', 'High']),
    status: {
      switch: true, mode: 'Heat', temp_set: 21, temp_current: 18, fan_speed_enum: 'High',
      swing: true, lock: false, sleep: false, temp_unit_convert: 'c',
    },
  },
  {
    // Another brand on the same Tuya hardware: discovery should list it as ignored.
    id: 'bfharness00garage01',
    name: 'Garage AC',
    model: 'WB9000',
    productId: 'suntecwb9000pid0',
    productName: 'Suntec Wellbeing 9000',
    functions: [fn('switch', 'Boolean'), fn('mode', 'Enum', { range: ['cold', 'wet', 'wind'] })],
    statusSpecs: [],
    thingModel: thingModel(['cold', 'wet', 'wind'], []),
    status: { switch: false, mode: 'cold' },
  },
];

const byId = new Map(DEVICES.map((d) => [d.id, d]));
const statusList = (d) => Object.entries(d.status).map(([code, value]) => ({ code, value }));
const ok = (result) => ({ success: true, t: Date.now(), result });
const fail = (code, msg) => ({ success: false, t: Date.now(), code, msg });

function route(method, url, headers, body) {
  if (url.pathname === '/healthz') return ok('ok');

  if (url.pathname === '/v1.0/token') {
    if (String(headers.client_id ?? '').startsWith('bad')) return fail(1004, 'sign invalid');
    return ok({ access_token: 'harness-token', expire_time: 7200, refresh_token: 'harness-refresh', uid: 'harness' });
  }

  if (url.pathname === '/v2.0/cloud/thing/device') {
    const category = url.searchParams.get('categories');
    return ok(DEVICES.filter(() => !category || category === 'kt').map((d) => ({
      id: d.id, name: d.name, customName: '', model: d.model, category: 'kt',
      productId: d.productId, productName: d.productName, isOnline: true, uuid: d.id,
      icon: '', ip: '', lat: '', lon: '', localKey: '', sub: false, timeZone: '+00:00',
      bindSpaceId: '', activeTime: 0, createTime: 0, updateTime: 0,
    })));
  }

  let m = url.pathname.match(/^\/v2\.0\/cloud\/thing\/([^/]+)\/model$/);
  if (m) {
    const d = byId.get(m[1]);
    return d ? ok({ model: d.thingModel }) : fail(2001, 'device not found');
  }

  m = url.pathname.match(/^\/v1\.0\/devices\/([^/]+)(\/status|\/specifications|\/commands)?$/);
  if (m) {
    const d = byId.get(m[1]);
    if (!d) return fail(2001, 'device not found');
    switch (m[2]) {
      case '/status':
        return ok(statusList(d));
      case '/specifications':
        return ok({ category: 'kt', functions: d.functions, status: [...d.functions, ...d.statusSpecs] });
      case '/commands': {
        if (method !== 'POST') break;
        for (const { code, value } of body?.commands ?? []) d.status[code] = value;
        return ok(true);
      }
      default:
        return ok({
          id: d.id, name: d.name, category: 'kt', product_id: d.productId, product_name: d.productName,
          online: true, status: statusList(d), sub: false, time_zone: '+00:00', uid: 'harness',
          uuid: d.id, owner_id: 'harness', ip: '', local_key: '', model: d.model, mac: '', sn: '',
          create_time: 0, update_time: 0, active_time: 0,
        });
    }
  }

  return fail(1108, 'uri path invalid');
}

const server = createServer({
  key: readFileSync('/certs/server.key'),
  cert: readFileSync('/certs/server.pem'),
}, (req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const url = new URL(req.url, `https://${req.headers.host}`);
    let body;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
    const reply = route(req.method, url, req.headers, body);
    if (url.pathname !== '/healthz') {
      const detail = body ? ` ${JSON.stringify(body)}` : '';
      const outcome = reply.success ? 'ok' : `FAIL ${reply.code} ${reply.msg}`;
      console.log(`[tuya-stub] ${req.method} ${req.headers.host}${url.pathname}${url.search}${detail} -> ${outcome}`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
});

server.listen(443, () => {
  console.log(`[tuya-stub] serving ${DEVICES.length} devices on :443 (${DEVICES.map((d) => d.name).join(', ')})`);
});
