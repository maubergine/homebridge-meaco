# Contributing

## Dev setup

```bash
git clone https://github.com/<your-org>/homebridge-meaco
cd homebridge-meaco
npm install
mkdir homebridge-debug
# Add a minimal config to homebridge-debug/config.json
npm run watch   # builds, links, starts Homebridge with nodemon
```

## Commit messages

This repo uses Conventional Commits enforced by commitlint:

- `feat(scope):` — new feature → minor bump
- `fix(scope):` — bug fix → patch bump
- `chore(deps):` — dependency update
- `test:` — test-only changes
- `docs:` — documentation only
- `refactor:` — no behaviour change

`BREAKING CHANGE:` in the footer triggers a major bump.

## Capturing a Tuya fixture

When you see unexpected behaviour from a real device, capture the raw
API response and add it as a fixture:

```bash
# In your Homebridge debug logs (debug_logging: true), find the
# raw /specifications response for your device ID, paste it into:
test/fixtures/specifications/<model-name>.json
```

Then add a test in `test/tuya/specParser.test.ts` that exercises the
new fixture. See the existing synthetic fixture for the expected shape.
