/**
 * Live probe: discover all devices via Tuya v2.0 API, then dump status, spec and
 * thing model for each.
 *
 * Usage:
 *   TUYA_ACCESS_KEY=xxx TUYA_SECRET_KEY=yyy node scripts/probe-device.mjs [--region EU] [--raw]
 *
 * Region defaults to EU. Valid values: US EU WEU CN IN
 * --raw prints the full JSON response for each API call.
 */

import { CloudClient } from '../dist/tuya/cloudClient.js';

const accessKey = process.env.TUYA_ACCESS_KEY;
const secretKey = process.env.TUYA_SECRET_KEY;

const regionArg = process.argv.indexOf('--region');
const region    = regionArg !== -1 ? process.argv[regionArg + 1] : (process.env.TUYA_REGION ?? 'EU');
const raw       = process.argv.includes('--raw');

const VALID_REGIONS = ['US', 'EU', 'WEU', 'CN', 'IN'];

const missing = ['TUYA_ACCESS_KEY', 'TUYA_SECRET_KEY'].filter(k => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}
if (!VALID_REGIONS.includes(region)) {
  console.error(`Invalid region "${region}". Must be one of: ${VALID_REGIONS.join(', ')}`);
  process.exit(1);
}

const client = new CloudClient({ region, accessKey, secretKey, requestTimeoutMs: 10_000 });

console.log(`\nDiscovering devices via Tuya ${region} endpoint…\n`);

const devices = await client.listAllDevices(20, 'kt');

if (devices.length === 0) {
  console.log('No devices found for this account.');
  process.exit(0);
}

console.log(`Found ${devices.length} device(s).\n`);

for (const d of devices) {
  console.log(`━━ ${d.name} (${d.id})`);
  console.log(`   model:    ${d.model || '—'}`);
  console.log(`   category: ${d.category}`);
  console.log(`   product:  ${d.productName} (${d.productId})`);
  console.log(`   online:   ${d.isOnline}`);

  // Live status
  try {
    const statusResp = await client.getDeviceStatus(d.id);
    if (raw) console.log('\n   [raw status]\n' + JSON.stringify(statusResp, null, 2));
    if (statusResp.length) {
      const w = Math.max(...statusResp.map(s => s.code.length));
      console.log('   status:');
      for (const s of statusResp) {
        console.log(`     ${s.code.padEnd(w)}  ${JSON.stringify(s.value)}`);
      }
    } else {
      console.log('   status:   (none)');
    }
  } catch (err) {
    console.error(`   status failed: ${err.message}`);
  }

  // Device-level specification
  try {
    const spec = await client.getDeviceSpecification(d.id);
    if (raw) console.log('\n   [raw specification]\n' + JSON.stringify(spec, null, 2));
    const fns = spec.result.functions ?? [];
    const sts = spec.result.status    ?? [];
    const all = [...new Map([...fns, ...sts].map(x => [x.code, x])).values()];
    const w   = all.length ? Math.max(...all.map(x => x.code.length)) : 0;
    console.log(`   spec (${fns.length} fn, ${sts.length} st):`);
    for (const dp of all) {
      const tag = fns.find(f => f.code === dp.code) ? 'fn' : 'st';
      console.log(`     [${tag}] ${dp.code.padEnd(w)}  ${dp.type.padEnd(8)} ${dp.values}`);
    }
  } catch (err) {
    console.error(`   spec failed: ${err.message}`);
  }

  // Thing model: the product-level data model, which can list DPs absent from
  // the device spec. This is what the plugin reads for mode and fan speed ranges.
  try {
    const modelResp = await client.getDeviceModel(d.id);
    if (raw) console.log('\n   [raw thing model]\n' + JSON.stringify(modelResp, null, 2));
    const model = JSON.parse(modelResp.result.model);
    const props = (model.services ?? []).flatMap(svc => svc.properties ?? []);
    const w     = props.length ? Math.max(...props.map(p => p.code.length)) : 0;
    console.log(`   thing model (${model.modelId ?? '—'}, ${props.length} properties):`);
    for (const p of props) {
      const { type, ...spec } = p.typeSpec ?? {};
      console.log(`     ${String(p.abilityId).padStart(3)} ${p.code.padEnd(w)}  ${(p.accessMode ?? '').padEnd(2)} ${String(type).padEnd(7)} ${JSON.stringify(spec)}`);
    }
  } catch (err) {
    console.error(`   thing model failed: ${err.message}`);
  }

  console.log('');
}
