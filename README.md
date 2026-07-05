# homebridge-meaco

[![npm version](https://img.shields.io/npm/v/homebridge-meaco.svg)](https://www.npmjs.com/package/homebridge-meaco)

A [Homebridge](https://homebridge.io) plugin for Meaco air conditioners, exposing them to Apple HomeKit via the Tuya Cloud OpenAPI.

## Features

- Discovers Meaco air conditioners linked to your Tuya / Smart Life account
- Exposes each unit to HomeKit as an air conditioner accessory
- Power, mode and temperature control with optimistic updates

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
