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

## Configuration

Configure the plugin through the Homebridge UI, or add a platform block to your
`config.json`. See the plugin settings for the required Tuya credentials
(access ID, access secret, region and linked account details).

## License

[Apache-2.0](./LICENSE)
