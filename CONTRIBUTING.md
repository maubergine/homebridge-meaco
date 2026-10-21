# Contributing

homebridge-meaco is a Homebridge plugin for Meaco air conditioners, using the Tuya Cloud OpenAPI.

Bug reports and feature requests are welcome as [issues](https://github.com/maubergine/homebridge-meaco/issues). Pull requests are
welcome too; CI on a pull request from a fork may wait for the maintainer to approve it.

## Dev setup

```bash
git clone https://github.com/maubergine/homebridge-meaco
cd homebridge-meaco
npm install
mkdir homebridge-debug
# Add a minimal config to homebridge-debug/config.json
npm run watch   # builds, links, starts Homebridge with nodemon
```

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `fix:`, `feat:`, `chore:`, `docs:` and so on. They
decide the next version: `fix` releases a patch, `feat` a minor version, and a breaking change a major one. CI checks
every commit (`commitlint.yml`). To check them locally before you push:

```sh
npm install   # installs commitlint and turns on .githooks/commit-msg
```

Commits to `main` must be signed.

## Tests

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

These are the steps `ci.yml` runs on Node 22 and 24.
