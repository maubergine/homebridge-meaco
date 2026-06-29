# homebridge-meaco

[![npm version](https://img.shields.io/npm/v/homebridge-meaco.svg)](https://www.npmjs.com/package/homebridge-meaco)

A [Homebridge](https://homebridge.io) plugin for Meaco air conditioners, exposing them to Apple HomeKit via the Tuya Cloud OpenAPI.

## Features

- Discovers Meaco air conditioners linked to your Tuya / Smart Life account
- Exposes each unit to HomeKit as an air conditioner accessory
- Power, mode and temperature control with optimistic updates

## Requirements

- Node.js >= 20
- Homebridge ^1.8.0 || ^2.0.0
- A Tuya IoT Platform cloud project with OpenAPI access

## Installation

```sh
npm install -g homebridge-meaco
```

Or install via the Homebridge UI by searching for `homebridge-meaco`.

If you haven't already done so, you will need to create a [Tuya IoT Cloud](https://iot.tuya.com/) account and create a cloud project
containing your device(s). Your cloud project will have an access key and a secret key, and your device will be given a virtual device id.
You will need these three values in order to configure this plugin. The TuyAPI project has [some good instructions](https://github.com/codetheweb/tuyapi/blob/master/docs/SETUP.md#listing-tuya-devices-from-the-tuya-smart-or-smart-life-apps) on how to set this all up. Note that this may require that you
set up your device via the Tuya Smart app and not the BlissHome app, but this does not reduce the functionality of your device.

## Configuration

Configure the plugin through the Homebridge UI, or add a platform block to your
`config.json`. See the plugin settings for the required Tuya credentials
(access ID, access secret, region and linked account details).

Once first started the plugin should discover your Meaco devices and add them to its own configuration. You will then need to restar


## Thanks
To the following projects for structure/relevant integrations.
- [`homebridge-sky-lite-evolve`](https://github.com/kevbo/homebridge-sky-lite-evolve)
  — Tuya OpenAPI client, configuration shape, dev loop.
- [`homebridge-melcloud-control`](https://github.com/grzegorz914/homebridge-melcloud-control)
  — rich per-device config schema, display-type pattern, request pacing.



## License

[Apache-2.0](./LICENSE)
