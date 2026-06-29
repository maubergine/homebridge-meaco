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

