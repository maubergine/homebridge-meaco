# homebridge-meaco — design spec

**Date:** 2026-05-26
**Author:** Marius Rubin (with Claude)
**Status:** Approved for implementation planning

## Summary

A Homebridge dynamic platform plugin for Meaco air conditioners (and, in
the longer term, other Meaco devices). Meaco units are Tuya OEMs, so the
plugin talks to them through the Tuya Cloud OpenAPI rather than any
Meaco-specific service.

Day-one scope is the **MeacoCool MC series (cool-only)**. The plugin is
architected with capability detection from day one, so adding the
heat-capable Pro variant or other Meaco device classes (fans,
dehumidifiers, humidifiers) later is additive rather than restructuring.

The reference projects that informed this design:

- [`homebridge-sky-lite-evolve`](https://github.com/kevbo/homebridge-sky-lite-evolve)
  — Tuya OpenAPI client, configuration shape, dev loop.
- [`homebridge-melcloud-control`](https://github.com/grzegorz914/homebridge-melcloud-control)
  — rich per-device config schema, display-type pattern, request pacing.
- [`homebridge-unifi-protect`](https://github.com/hjdhjd/homebridge-unifi-protect)
  — semantic-release CI/CD, beta channel, repository hygiene.

## Goals

- Control a MeacoCool MC AC from Apple Home with low setup friction.
- Reflect physical-remote and Meaco-app changes in HomeKit promptly
  (default 30 s polling).
- Surface device unreachability honestly via Home's "Not Responding"
  state rather than silently lying.
- Keep code modular enough that adding a humidifier or heat-capable AC
  later is additive.
- Ship a polished v1 with full CI/CD, beta channel, and a path to
  Homebridge "Verified Plugin" status.

## Non-goals (v1)

- Heat-capable AC support. The capability profile carries `hasHeat`, but
  the verify-loop wiring and HomeKit validity-bitmask handling for heat
  is deferred until a real unit is available for testing.
- Other Meaco device classes (humidifiers, dehumidifiers, fans).
- Local LAN transport (`tuyapi` protocol).
- Auto-discovery from a linked Tuya account.
- Tuya Pulsar real-time push subscription.
- Optional REST and MQTT bridges (melcloud-style external integrations).
- Custom UI server for guided setup.

These all live in a documented "future work" parking lot below.

## Architecture

The plugin is a Homebridge **dynamic platform** written in TypeScript
(strict mode, ESM, Node 20+22). Three independently testable concerns:

1. **Tuya transport** — auth, signed REST, pacing, retry.
2. **Capability inference** — translate a Tuya specification response
   into a canonical capability profile and datapoint map.
3. **HomeKit binding** — wire HomeKit characteristics to canonical
   capabilities via a profile-driven accessory class.

### Module layout

```
src/
├── index.ts                       — registers platform with Homebridge
├── settings.ts                    — PLUGIN_NAME, PLATFORM_NAME, defaults
├── platform.ts                    — MeacoPlatform: config parsing, discovery, accessory lifecycle
├── tuya/
│   ├── cloudClient.ts             — auth, signed REST, request pacing, retry
│   ├── specParser.ts              — Tuya /specifications → CapabilityProfile
│   └── types.ts                   — Tuya API response shapes
├── core/
│   ├── capabilityProfile.ts       — feature flags + ranges per device
│   ├── datapointMap.ts            — canonical name ↔ Tuya code translator
│   ├── stateCache.ts              — last-known state, failure counter, "responding" flag
│   └── poller.ts                  — per-device interval poller, no-overlap, triggerNow()
├── accessories/
│   ├── baseAccessory.ts           — shared lifecycle, error handling, "Not Responding" logic
│   └── airConditionerAccessory.ts — HeaterCooler/Thermostat/Fan service wiring
└── ui/
    └── customUi.ts                — placeholder; not built in v1
```

### Routing

`platform.discoverDevices()`:

1. Parse and validate config.
2. For each configured device:
   1. `cloudClient.getDeviceSpecification(id)`.
   2. `specParser.parseSpecification()` → `CapabilityProfile`.
   3. Apply `capability_overrides` from config (overrides win).
   4. Construct an accessory based on the device's Tuya `category`. Day
      one: only `kt` (air conditioner) → `AirConditionerAccessory`.

### Why this shape

- Tuya transport, capability inference, and HomeKit binding have clean,
  separately-testable input/output contracts.
- A captured Tuya `/specifications` JSON exercises `specParser` without
  any network or Homebridge runtime in the test loop.
- Adding a humidifier later means: add `humidifierAccessory.ts`, add
  fixture, register in the category routing map. No refactoring of
  existing modules.

### One existing-code observation carried over

sky-lite-evolve's `tuyaCloudApi.ts` re-fetches a Tuya access token on
every API call. With 30 s polling that doubles request volume against
the Tuya quota. We cache the token in `cloudClient` and refresh ~60 s
before expiry.

## Configuration schema

`config.schema.json` mirrors sky-lite-evolve's three-section layout
(Cloud Credentials, Devices, Advanced) with melcloud-style per-device
richness.

### Top level

- `name` — platform display name. Default `"Meaco"`.
- `cloud_credentials` — section.
  - `tuya_region` — enum of the five Tuya regional endpoints (US, EU,
    Western EU, CN, IN). Default EU.
  - `tuya_access_key`, `tuya_secret_key` — required strings.
  - `tuya_user_id` — optional, reserved for future auto-discovery.
- `devices[]` — array. Each item:
  - `tuya_device_id` — required.
  - `display_name` — default `"Air Conditioner"`.
  - `manufacturer` / `model` / `serial_number` — informational, default
    `"Meaco"` / `"MeacoCool MC"` / device ID.
  - `display_type` — enum `heater_cooler` (default) / `thermostat` /
    `fan_only`.
  - `temperature_unit` — enum `celsius` (default) / `fahrenheit`.
  - `expose_dry_mode_switch` — bool, default `true`. Adds a Switch
    service for dry mode alongside the primary service.
  - `expose_fan_only_mode_switch` — bool, default `true`. Adds a
    Switch service for fan-only mode.
  - `expose_swing_control` — bool, default `true` (hidden if device
    lacks swing). In `heater_cooler` mode this enables the
    `SwingMode` characteristic on the primary service. Has no effect
    in `thermostat` mode (Thermostat service lacks SwingMode and we
    don't add a companion switch for it in v1).
  - `expose_sleep_mode_switch` — bool, default `false`. Adds a Switch
    service for sleep mode.
  - `capability_overrides` — optional object: `has_heat?`, `has_dry?`,
    `has_swing?`, `has_sleep?`, `has_fan_only?`, `has_auto?`,
    `fan_speed_levels?`, `temp_min?`, `temp_max?`. Applied on top of
    auto-detected profile.
  - `polling_interval_seconds` — default `30`, range 5–300.
  - `unresponsive_after_failures` — default `3`, range 1–10.
- `advanced_settings`:
  - `request_timeout_ms` — default `8000`.
  - `max_command_retries` — default `5` (verify-loop after a HomeKit
    set).
  - `command_verify_interval_ms` — default `1000`.
  - `debug_logging` — bool, default `false`. Single flag (we picked the
    standard logging option, not the granular per-category one).

### Schema strictness

`strictValidation: true`, `fixArrays: true` (matches melcloud-control).
Layout uses Homebridge UI's collapsible sections so first-time setup
shows credentials + devices expanded, advanced collapsed.

### Field interactions

- `display_type = thermostat` → swing/sleep toggles hidden in the UI.
- `display_type = fan_only` → only fan-related fields shown.

These are wired via `homebridge-config-ui-x`'s
`condition.functionBody`.

### Intentional non-features

- No per-category log toggles (standard logging instead).
- No REST/MQTT (out of v1 scope).

## Capability detection & datapoint mapping

The keystone of the plugin. Two cooperating units.

### `tuya/specParser.ts`

Pure function:

```ts
function parseSpecification(spec: TuyaSpecResponse): CapabilityProfile;
```

Tuya's `/v1.0/devices/{id}/specifications` returns two arrays:
`functions` (writable datapoints) and `status` (readable). Each entry
has `code`, `type` (`Boolean` | `Enum` | `Integer` | `String`), and
`values` (a JSON string with enum range or integer min/max/scale).

The parser walks both arrays and produces:

```ts
interface CapabilityProfile {
  hasPower: boolean;            // 'switch' present
  hasCool: boolean;             // 'mode' enum contains 'cold'
  hasHeat: boolean;             //                         'hot'
  hasDry: boolean;              //                         'wet'
  hasFanOnly: boolean;          //                         'wind'
  hasAuto: boolean;             //                         'auto'
  hasSwing: boolean;            // 'swing' or 'shake' present
  hasSleep: boolean;            // 'sleep' present
  fanSpeedLevels: string[];     // values from 'windspeed' enum
  tempRange: { min: number; max: number; step: number; scale: number };
  currentTempRange?: { min: number; max: number; step: number; scale: number };
  rawFunctions: Map<string, TuyaFunctionSpec>;
}
```

The parser is **defensive**: missing-but-expected codes log a warning
and set the flag to `false`; unknown codes are ignored; malformed
`values` JSON falls back to safe defaults
(`tempRange = {16, 31, 1, 0}`).

### `core/datapointMap.ts`

Bidirectional translator between canonical names and Tuya codes. Tuya
OEM partners can rename codes (Meaco's may be `switch` vs `switch_1` vs
`power`). The map is keyed by the actual code present in the spec, with
a small ranked alias list per canonical name:

```ts
const ALIASES: Record<CanonicalName, string[]> = {
  power:        ['switch', 'switch_1', 'power'],
  mode:         ['mode', 'work_mode'],
  setpoint:     ['temp_set', 'set_temp'],
  currentTemp:  ['temp_current', 'temp_indoor'],
  fanSpeed:     ['windspeed', 'fan_speed'],
  swing:        ['swing', 'shake'],
  sleep:        ['sleep', 'sleep_mode'],
};
```

Class shape:

```ts
class DatapointMap {
  resolve(canonical: CanonicalName): string | undefined;
  encodeMode(hkState: HeaterCoolerState): { code: string; value: string };
  decodeMode(code: string, value: string): HeaterCoolerState;
  // …per-canonical encode/decode that handles type/scale/enum conversion
}
```

### Override merging happens in the platform

```ts
const detected = parseSpecification(specResponse);
const profile  = applyOverrides(detected, deviceConfig.capability_overrides);
```

This keeps the parser pure (testable with captured fixtures) and makes
override semantics obvious — overrides win, full stop. If a user sets
`has_heat: true` on a unit that genuinely cannot heat, the device
rejects the command and we surface that via the verify-loop revert
(see Polling section), not by silently swallowing.

### Captured fixtures

`test/fixtures/specifications/` holds JSON dumps from real Meaco
devices, one per model. Each fixture is paired with an
expected-profile snapshot. New device variants → drop in fixture,
generate snapshot, done. We seed with a synthetic MeacoCool MC fixture
on day one and replace it once a real one is captured.

### Why two units, not one

`specParser` answers "what can the device do?"; `datapointMap` answers
"what string do I send to make it do X?". Bundling them creates a
class that knows both Tuya wire format and HomeKit semantics — exactly
the kind of god-object that makes adding humidifiers later painful.

## Polling, command flow & error handling

Three things have to coordinate without stepping on each other: the
periodic poll, HomeKit `set` calls, and the post-set verify loop.

### `core/poller.ts`

One `Poller` per device.

```ts
class Poller {
  start(intervalSec: number, onTick: () => Promise<void>): void;
  stop(): void;
  triggerNow(): Promise<void>;   // immediate refetch after HomeKit set
}
```

Internally a `setTimeout` self-rescheduling loop (not `setInterval`)
with an in-flight flag so ticks never overlap. `triggerNow()` is a
no-op if a poll is already running — it doesn't queue; it relies on
the in-flight one finishing and pushing fresh state.

### State cache & "Not Responding"

```ts
class StateCache {
  state: Record<string, TuyaValue>;
  lastSuccess: number;
  consecutiveFailures: number;
  isResponding(): boolean;
}
```

Every poll tick calls `cloudClient.getDeviceStatus()`.

- **Success**: merge into `state`, reset `consecutiveFailures`, push
  fresh values into HomeKit via `updateCharacteristic`.
- **Failure**: increment counter, log at `warn` for first few failures
  and `error` once threshold is crossed; once
  `consecutiveFailures >= unresponsive_after_failures`, `onGet`
  handlers throw
  `HapStatusError(SERVICE_COMMUNICATION_FAILURE)` so the Home app shows
  "Not Responding". One successful poll clears it.

### HomeKit `set` flow

1. `onSet` handler called with new HomeKit value (e.g. target state =
   COOL).
2. Translate via `DatapointMap.encode...()` → `{ code, value }`.
3. **Optimistic** update of `stateCache` so the next `onGet` returns
   the new value (avoids HomeKit "lag" feel).
4. `cloudClient.postCommand(deviceId, code, value)` — single call,
   uses cached token.
5. Wait `command_verify_interval_ms`, then `poller.triggerNow()`.
6. Loop up to `max_command_retries` times: poll, check if
   `cache.state[code] === value`; break on match.
7. **If no match after all retries**: log error, **revert the
   optimistic update**, push the real state back into HomeKit so the
   Home app shows what the device actually did.

Step 7 is the crucial divergence from sky-lite-evolve, which
optimistically updates but never reverts on failure — so HomeKit can
show "On" while the device is actually off.

### Error taxonomy (in `cloudClient.ts`)

| Tuya error | Plugin response |
|---|---|
| 401 / 1010 / 1011 (token expired) | invalidate token, retry once |
| 429 / 28841105 (rate limited) | exponential backoff; persistent → poll failure |
| 5xx / network timeout | counted as poll failure, normal retry |
| Auth misconfig (bad key/secret) | log error once at startup; do **not** retry every 30 s; accessories register but show Not Responding |
| Device-not-found | log error, skip device, continue with others |
| Command rejected (e.g. mode the unit lacks) | log error, surface via verify-loop revert |

### Request pacing

A single shared `RequestPacer` in `cloudClient` (~200 ms interval, max
1 in-flight). With 5 devices polling on slightly-staggered timers we
never burst Tuya. This is what keeps us inside Tuya's per-second QPS
limit.

## HomeKit service binding

`airConditionerAccessory.ts` takes a `CapabilityProfile`,
`DatapointMap`, `StateCache`, `Poller`, and a device config block. It
picks one of three primary services based on `display_type`, then
conditionally adds companion services.

### `display_type: heater_cooler` (default)

Primary service: `Service.HeaterCooler`. Required characteristics:

| HomeKit characteristic | Tuya datapoint(s) | Mapping notes |
|---|---|---|
| `Active` (0/1) | `power` (`switch`) | trivial bool |
| `CurrentHeaterCoolerState` | `mode` + `temp_current` vs `temp_set` | INACTIVE if power off; HEATING if mode=`hot`; COOLING if mode=`cold`; IDLE if mode=`wet`/`wind` |
| `TargetHeaterCoolerState` | `mode` | AUTO=`auto`, HEAT=`hot`, COOL=`cold`. Validity bitmask reflects `hasHeat`/`hasCool`/`hasAuto`. v1 typically COOL-only on MeacoCool MC. |
| `CurrentTemperature` | `temp_current` | apply `scale` from spec |
| `CoolingThresholdTemperature` | `temp_set` | range from `tempRange` |
| `HeatingThresholdTemperature` | `temp_set` | only added if `hasHeat` (deferred until heat-capable unit available, see Non-goals) |
| `RotationSpeed` (0–100) | `windspeed` | discrete enum mapped to bands; round inbound HK values to nearest band before encoding |
| `SwingMode` (0/1) | `swing` / `shake` | only added if `hasSwing` and `expose_swing_control` |
| `TemperatureDisplayUnits` | none (HomeKit-local) | from `temperature_unit` config |

Companion services (each gated by `expose_*` flag AND capability):

- **Switch — "Dry mode"** (subtype `dry`): on → `mode=wet` and
  `power=on`; off → restore previous non-dry mode (or off).
- **Switch — "Fan-only mode"** (subtype `fan_only`): same pattern with
  `mode=wind`.
- **Switch — "Sleep"** (subtype `sleep`): toggles `sleep` independently.

These switches reflect device state — physical-remote changes flip
them on the next poll. Mutual exclusivity: turning Dry on flips
Fan-only off in HomeKit immediately.

### `display_type: thermostat`

Primary: `Service.Thermostat`. No fan-speed or swing controls
(Thermostat lacks `RotationSpeed` and `SwingMode`); `expose_swing_control`
has no effect in this mode. `TargetHeatingCoolingState`: OFF→power off,
HEAT→`hot`, COOL→`cold`, AUTO→`auto`.

### `display_type: fan_only`

Primary: `Service.Fanv2` with `Active` + `RotationSpeed`. Setting
`Active=1` forces `mode=wind` and `power=on`. Setpoint and mode hidden.

### Service identity & subtypes

One primary service plus N companion switches. Companion switches use
stable subtypes so they survive renames. The `AccessoryInformation`
service gets `Manufacturer`/`Model`/`SerialNumber` from config and
`FirmwareRevision` from the Tuya `/devices/{id}` response.

### Subtle behaviour worth flagging

HomeKit's `TargetHeaterCoolerState=AUTO` doesn't necessarily map
cleanly to a real AC's "auto" — some Tuya ACs interpret `mode=auto`
as "pick cool or heat by setpoint", others as "fan auto". We default
to the literal `auto` enum if present, fall back to `cold` if not, and
surface this in debug logs.

## Testing strategy

### Tooling

- `vitest` (faster than jest, native ESM, TypeScript out of the box).
- `nock` for HTTP mocking.
- A small (~40-line) Homebridge mock for accessory tests — fake
  `Service` that records `getCharacteristic().on('set'|'get')`
  registrations and lets the test invoke them.

### Unit tests (no network, no Homebridge)

- **`tuya/specParser.test.ts`** — fixtures in
  `test/fixtures/specifications/`, paired with expected-profile
  snapshots. New variants → drop in fixture, regenerate snapshot.
- **`core/datapointMap.test.ts`** — round-trip encode/decode for every
  canonical name; integer scale conversion (e.g. `220` with `scale=1`
  → `22.0 °C`); enum aliases; unit conversion when
  `temperature_unit=fahrenheit`.
- **`core/stateCache.test.ts`** — failure counter, `isResponding()`
  threshold, optimistic-update-then-revert sequences.
- **`core/poller.test.ts`** — fake timers; non-overlapping ticks;
  `triggerNow()` no-op while in-flight; `stop()` cleanup.

### Integration tests (mocked HTTP)

- **`tuya/cloudClient.test.ts`** with `nock` — token caching, HMAC
  sign correctness against a known-good vector, 401 → re-auth → retry,
  429 backoff, request pacing serializes concurrent calls.

### Accessory tests

- **`accessories/airConditionerAccessory.test.ts`** — drive `onSet`
  calls, assert correct Tuya commands and characteristic updates;
  exercise verify-loop revert on rejected commands.

### What we deliberately don't test

- Live Tuya end-to-end. Out of scope for CI; manual via `npm run
  watch` against a real unit (sky-lite-evolve's
  build + `npm link` + `nodemon` model).
- Homebridge's own characteristic validation.

### Coverage

80 % lines on `tuya/`, `core/`, `accessories/`. CI fails below
threshold. No coverage requirement on `index.ts` / `platform.ts`
(mostly Homebridge boilerplate).

### Test-data discipline

Every captured fixture lives under `test/fixtures/`, never in source.
Each fixture file gets a one-line header recording device model and
firmware. Surprising Tuya behaviour in production → capture response,
add fixture, write regression test, fix code.

## CI/CD & release engineering

unifi-protect-style applied at our scale. Four workflows.

### `.github/workflows/ci.yml`

Runs on every PR and push to `main` / `beta`.

```
strategy: matrix on Node 20.x, 22.x
steps:
  - npm ci
  - npm run lint           (eslint, max-warnings=0)
  - npm run typecheck      (tsc --noEmit)
  - npm run test           (vitest run --coverage)
  - npm run build          (tsc to dist/)
  - upload coverage artefact
```

Concurrency group keyed on `github.ref` so re-pushing cancels
in-flight runs.

### `.github/workflows/release.yml`

Runs on push to `main` and `beta`. Driven by
[`semantic-release`](https://semantic-release.gitbook.io). Conventional
Commits → version bump → changelog → git tag → GitHub release →
`npm publish`. Two channels:

- **`main`** → `latest` npm dist-tag → stable releases.
- **`beta`** → `beta` npm dist-tag → pre-release versions like
  `1.2.0-beta.3`. Users opt in with `npm install homebridge-meaco@beta`.

`.releaserc.json` plugins: `@semantic-release/commit-analyzer`,
`@semantic-release/release-notes-generator`,
`@semantic-release/changelog`, `@semantic-release/npm`,
`@semantic-release/github`, `@semantic-release/git`.

Required secrets: `NPM_TOKEN` (granular npm access token, publish-only,
scoped to this package). `GITHUB_TOKEN` is auto-provided.

### `.github/workflows/codeql.yml`

Weekly + on PR. Standard CodeQL JS/TS analysis.

### `.github/workflows/dependabot-auto-merge.yml`

Auto-merges Dependabot PRs that pass CI for `devDependencies` patch +
minor bumps. Production dependency updates require manual review.

### Repository hygiene

- `.github/dependabot.yml`: weekly `npm` and `github-actions`. Group
  dev-dependency patches into a single PR.
- `.github/ISSUE_TEMPLATE/`: bug report (asks for plugin version,
  Homebridge version, Node version, redacted config snippet, log
  excerpt with `debug_logging: true`), feature request, support
  question.
- `.github/pull_request_template.md`: short checklist (tests added,
  CHANGELOG considered, captured fixture if Tuya behaviour change).
- `CODEOWNERS`: just the maintainer.
- Branch protection on `main` and `beta`: require CI green, require
  linear history, no force-push.

### Commit discipline

Enforced via `commitlint` + `husky` `commit-msg` hook on local clones.
Conventional Commits — `feat(accessory):`, `fix(tuya):`,
`chore(deps):`, `docs:`, `test:`, `refactor:`. Load-bearing:
semantic-release uses these to compute version bumps.

### Pragmatic deviation from unifi-protect

unifi-protect ships a custom UI (`homebridge-ui/` directory with web
server) for guided setup. We defer custom UI in v1; the standard
config schema covers everything we need.

## Documentation, repo metadata & release plan

### Files

- `README.md` — installation, Tuya IoT account setup walkthrough
  (linking to
  [codetheweb/tuyapi SETUP.md](https://github.com/codetheweb/tuyapi/blob/master/docs/SETUP.md#listing-tuya-devices-from-the-tuya-smart-or-smart-life-apps)),
  config example, supported devices/capabilities matrix, troubleshooting
  (most common: wrong region, IP whitelisting). Badges: npm version,
  downloads, CI status, verified-by-Homebridge (eventually).
- `CHANGELOG.md` — auto-generated by `semantic-release`, pre-populated
  with v0.1.0 entry.
- `LICENSE` — Apache-2.0 (matches unifi-protect).
- `CONTRIBUTING.md` — short: dev setup, Conventional Commits, how to
  capture a fixture.
- `.editorconfig`, `.gitignore`, `.npmignore` — standard.
- `tsconfig.json` — `strict: true`, `target: ES2022`,
  `module: NodeNext`, `moduleResolution: NodeNext` (ESM).
- `.eslintrc.cjs` — `@typescript-eslint` strict + stylistic, plus
  `eslint-plugin-import`.
- `package.json` — `engines: { node: ">=20", homebridge: "^1.8.0 || ^2.0.0" }`.
  Keywords: `homebridge-plugin`, `homebridge`, `meaco`, `tuya`,
  `air-conditioner`, `aircon`.

### `package.json` scripts

```json
{
  "build":          "tsc -p tsconfig.build.json",
  "watch":          "npm run build && npm link && nodemon",
  "lint":           "eslint 'src/**/*.ts' --max-warnings=0",
  "typecheck":      "tsc --noEmit",
  "test":           "vitest run",
  "test:watch":     "vitest",
  "prepublishOnly": "npm run lint && npm run typecheck && npm run test && npm run build"
}
```

### `nodemon.json`

Watches `src/`, runs
`npm run build && homebridge -D -U ./homebridge-debug` so dev loop is
live-reload against a sandboxed Homebridge config (sky-lite-evolve
model).

### Day-one release plan

1. **v0.1.0-beta.1** to npm `beta` tag — announce in r/homebridge,
   ask volunteers with MeacoCool MC units for fixtures + bug reports.
2. Iterate on captured fixtures, fan-speed band tuning, "Not
   Responding" thresholds, mode-mapping edge cases.
3. **v1.0.0** to npm `latest` once a beta runs cleanly for ~2 weeks
   for the maintainer and at least one external user.
4. Submit to Homebridge "Verified Plugins" list (requires green CI,
   README, screenshot, working install).

## Future work (parking lot)

- Heat-capable AC support — `hasHeat` already in profile; needs HK
  validity-bitmask wiring + verify-loop testing on a real unit.
- Humidifier / fan / dehumidifier accessory classes — capability
  profile + datapoint map factored to make this additive.
- Tuya Pulsar push subscription as alternative to polling.
- Local LAN transport with cloud fallback.
- Auto-discovery via Tuya `users/{uid}/devices`.
- Custom UI server for guided setup.
- Optional REST and MQTT bridges (melcloud-style).
