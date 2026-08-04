# homebridge-meaco

[![npm version](https://img.shields.io/npm/v/homebridge-meaco.svg)](https://www.npmjs.com/package/homebridge-meaco)

A [Homebridge](https://homebridge.io) plugin for Meaco air conditioners, exposing them to Apple HomeKit via the Tuya Cloud OpenAPI.

## Features

- Discovers Meaco air conditioners linked to your Tuya / Smart Life account
- Exposes each unit to HomeKit as an air conditioner accessory
- Power, mode and temperature control with optimistic updates
- Live updates pushed from Tuya's Message Service, so changes made on the unit
  itself appear in Home within a second or two — without polling the API

## Requirements

- Node.js >= 22
- Homebridge ^2.0.0
- A Tuya IoT Platform cloud project with OpenAPI access

## Installation

```sh
npm install -g homebridge-meaco
```

Or install via the Homebridge UI by searching for `homebridge-meaco`.

If you haven't already done so, you will need to create a [Tuya IoT Cloud](https://iot.tuya.com/) account and create a cloud project
containing your device(s). Your cloud project will have an access key and a secret key, and your device will be given a virtual device id.
You will need these three values in order to configure this plugin. The TuyAPI project has [some good instructions](https://github.com/codetheweb/tuyapi/blob/master/docs/SETUP.md#listing-tuya-devices-from-the-tuya-smart-or-smart-life-apps) on how to set this all up. Note that this may require that you
set up your device via the Tuya Smart app and not the Meaco app, but this does not reduce the functionality of your device.

You will need to log into the Tuya developer platform and under Cloud->Project Management->All Devices->{Your device} 
click the edit button and change the Control Instruction Mode from "Standard Instruction" to "DP Instruction" otherwise 
clashes between the Meaco configuration and the standard instruction set will prevent commands from being executed.

## Configuration

Configure the plugin through the Homebridge UI, or add a platform block to your
`config.json`. See the plugin settings for the required Tuya credentials
(access ID, access secret, region and linked account details).

Once first started the plugin should discover your Meaco devices and add them to its own configuration. You will then need to restar

### Push updates (Tuya Message Service)

By default the plugin subscribes to Tuya's **Message Service** and receives device
changes as they happen, instead of repeatedly asking the API what the state is.
This is both faster (changes made on the unit's own control panel show up in Home
almost immediately) and dramatically cheaper against your Tuya API allowance.

#### Setup

**1. Enable Message Service.** Tuya IoT console → *Cloud* → your project →
*Message Service*. No extra credentials are needed: the subscription authenticates
with the same access key and secret key as the REST API. Billing is per forwarded
message, so check your plan includes it; on trial plans it may be time-limited.

**2. Create a dedicated subscription — do this, don't skip it.** In the console, go
to *Message Service* → *Subscription Management*, select your environment
(Production), and create a subscription with the suffix **`meaco`**. The console
will show the full name as `<yourAccessId>-meaco`.

`meaco` is what the plugin looks for by default, so with that name there is nothing
to configure. To use a different suffix, set **Advanced** → *Message Service
Subscription Suffix*; either the suffix or the full name works.

In the console's consumer list for the subscription, the plugin identifies itself
as `homebridge-meaco@<host>` rather than the opaque name Pulsar would generate, so
you can tell which machine is connected — useful if two Homebridge instances share
a Tuya project. Override it with **Advanced** → *Message Service Consumer Name* if
the hostname isn't distinctive enough.

The name is confirmed in the log on every connect, so you can match what the
console shows against what the plugin thinks it is:

```
Connected to Tuya Message Service on subscription "xxxxxxxx-meaco",
consumer "homebridge-meaco@raspberrypi". Device updates will arrive by push.
```

**If the subscription doesn't exist**, the plugin falls back to Tuya's shared
default and logs a warning telling you to create it. Everything still works, just
with the competition problem described below — so check your log after first
start.

Both fallbacks are deliberately narrow, and happen cheapest-first: a refused
connection drops the consumer name (cosmetic) before it gives up the dedicated
subscription. Neither triggers on a network error, a timeout, a credentials
failure, or a drop on a connection that had already worked — so a transient
outage can't quietly demote you onto the shared subscription.

This matters because of how Pulsar subscriptions work. **A subscription is a
consumer group, not a mailbox.** Within one subscription each message is delivered
to exactly one consumer, and consumers are Failover — only one is active at a time.
Tuya gives every project a default subscription named `<accessId>-sub`, so if this
plugin and anything else (another Homebridge plugin, a script, Node-RED) all use
the default, they **compete for the same messages** and each sees only a fraction.
Separate subscriptions each receive their own independent copy of every message, so
every consumer gets everything it needs.

Two consequences worth knowing:

- **Cost.** Each subscription is billed its own copy of every forwarded message, so
  two subscriptions means roughly twice the message volume. That is still far below
  what polling every 30s costs, but it is not free.
- **Acking.** With a dedicated subscription the plugin acks every message, since it
  is the only consumer. On the default subscription it acks *only* messages for
  devices it manages, leaving the rest available to whatever else is consuming —
  those will be redelivered every ~30s for as long as the plugin is connected,
  which is one more reason to use a dedicated subscription.

#### Settings

All under **Advanced**:

| Setting | Default | Notes |
|---------|---------|-------|
| `use_message_service` | `true` | Turn off to fall back to REST polling only. |
| `message_service_subscription` | `meaco` | Suffix of the dedicated subscription to consume. Create it in the console; falls back to Tuya's shared default with a warning if absent. |
| `message_service_consumer_name` | `homebridge-meaco@<host>` | Name shown in the console's consumer list for the subscription. |
| `polling_interval_seconds` | `600` | Platform-wide default. With push on, polling is only a safety net for missed messages. |
| `message_service_env` | `PROD` | Which channel to consume. Production devices publish to `PROD`. Production and test subscriptions are independent. |

While Message Service is on, any poll interval below 300s (including a per-device
override) is raised to 300s, so a leftover polling-era setting can't quietly drain
your allowance. Polling never stops entirely: it seeds each device's state at
startup and reconciles afterwards, which is what keeps HomeKit correct if the push
connection drops. Disconnections and reconnection attempts are logged.

The plugin handles both datapoint report shapes Tuya uses — protocol 4
(`status[]`) and protocol 1000 `devicePropertyMessage` (`bizData.properties[]`) —
since which one a project receives depends on how its subscription is configured.

### Inspecting push messages

`scripts/probe-pulsar.mjs` subscribes to the Message Service outside Homebridge
and dumps every message it receives, fully decrypted. It drives the plugin's own
`PulsarClient`, so it exercises the real connection, auth, decryption and ack
paths — but taps the socket directly, so you see *everything* on the
subscription, not just the status reports the plugin routes to HomeKit.

**Give the probe its own subscription too.** It defaults to the suffix `probe`, so
create a second subscription with that name in the console and watching will never
take messages away from Homebridge:

```bash
npm run build   # the probe imports from dist/

TUYA_ACCESS_KEY=xxx TUYA_SECRET_KEY=yyy node scripts/probe-pulsar.mjs
```

Options: `--region`, `--env PROD|TEST`, `--subscription <name>`,
`--consumer-name <n>`, `--device <ids>`, `--duration <s>`, `--raw`, `--no-ack`,
`--help`. The subscription can also come from `$TUYA_PULSAR_SUBSCRIPTION`; pass
`--subscription sub` to consume Tuya's shared default deliberately. The probe
appears in the console as `homebridge-meaco-probe@<host>`.

For each message it prints the envelope fields, the decrypted body, and what the
plugin would do with it (route to a device, ignore, or discard as startup backlog).
On exit it summarises message types, devices, and every datapoint code seen with
its last value — useful for working out what your unit actually reports.

If you run it on the shared default subscription it will warn you, because acking
is what removes a message from the subscription: you would be taking messages away
from Homebridge. Either use a dedicated probe subscription, or pass `--no-ack` to
watch without consuming (messages then redeliver every ~30s).

## Running CI Locally

The GitHub Actions workflow (`.github/workflows/ci.yml`) installs dependencies,
lints, type-checks, tests, and builds the plugin across a matrix of Node.js
versions (22.x, 24.x). You can reproduce that workflow on your own machine
before pushing, using the `scripts/ci-local.sh` wrapper around
[`act`](https://github.com/nektos/act).

It runs the exact same steps as GitHub (checkout, set up Node.js, `npm ci`,
`npm run lint`, `npm run typecheck`, `npm test`, `npm run build`) inside Ubuntu
containers, one per matrix entry, so any failure you see locally matches what CI
will report.

The workflow runs in a local Docker image built from `ci-local.Dockerfile`,
which extends the standard `act` runner with Node.js (the stock image has no
`node` on PATH, which the checkout and setup-node actions need). The wrapper
builds this image automatically on first run.

Requirements:

- [`act`](https://github.com/nektos/act) (`brew install act` on macOS)
- A running Docker daemon

Usage:

```bash
# Run both matrix builds (22.x, 24.x) concurrently
scripts/ci-local.sh

# Run only the Node.js 24.x build
scripts/ci-local.sh -v 24.x

# List the jobs without running them
scripts/ci-local.sh -l

# Rebuild the local runner image (e.g. after editing ci-local.Dockerfile)
scripts/ci-local.sh -b

# Pass extra flags straight through to act
scripts/ci-local.sh -- --verbose
```

The first run builds the runner image, which can take a minute or two. On Apple
silicon the script automatically requests the `linux/amd64` image so the
containers match GitHub's runners. Run `scripts/ci-local.sh -h` for the full
list of options.

## Thanks
To the following projects for structure/relevant integrations.
- [`homebridge-sky-lite-evolve`](https://github.com/kevbo/homebridge-sky-lite-evolve)
  — Tuya OpenAPI client, configuration shape, dev loop.
- [`homebridge-melcloud-control`](https://github.com/grzegorz914/homebridge-melcloud-control)
  — rich per-device config schema, display-type pattern, request pacing.



## License

[Apache-2.0](./LICENSE)
