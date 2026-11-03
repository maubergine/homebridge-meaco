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

## How changes reach main

- Branch from `main` and open a pull request. Pull requests are squash-merged through the merge queue, so `main` is a
  line of commits that each passed the required checks (`test`, `commitlint`) on top of the one before. The owner
  (@maubergine) merges their own pull requests using the repository admin bypass; there is no second reviewer.
- The **PR title** becomes the commit on `main`. Write it as a
  [Conventional Commit](https://www.conventionalcommits.org/): `fix:` releases a patch, `feat:` a minor version, and
  `feat!:` (or a `BREAKING CHANGE:` line in the PR description) a major one. `chore`, `ci`, `docs`, `test`,
  `refactor`, `build` and `style` don't release. CI checks the title and every commit on the branch with
  [commitlint](https://commitlint.js.org/); the rules are in `commitlint.config.cjs`.
- **Every commit must be signed**, including each commit on your PR branch: one unsigned commit blocks the merge,
  even though the PR is squash-merged. Set up signing before your first PR (`git config commit.gpgsign true`, with
  an SSH or GPG key added to your GitHub account as a signing key).
- Optional local check of your commit messages, with the same rules (needs Node for `npx`; it skips quietly
  without it): `git config core.hooksPath .githooks`. `npm install` turns it on for you.

## Dependencies

Dependabot opens update PRs weekly, on Mondays, after a few days' cooldown. Minor and patch updates merge
themselves once the checks pass; major updates wait for a review. Updates to runtime dependencies are `fix(deps)`, so
each one releases a patch version to npm without anyone acting. Development and Actions updates don't release.

## Releases

Releases are automatic. Every push to `main` with releasable commits (`feat`, `fix`, `perf`, `revert`, breaking
changes) is released by the Release workflow:

1. semantic-release works out the version, commits it with `CHANGELOG.md` to `main` as `chore(release): <version>`
   (pushed with a short-lived token from the release GitHub App, the rulesets' only bypass; these commits are unsigned and unreviewed and touch only
   `package.json`, `package-lock.json` and `CHANGELOG.md`), tags `v<version>` and drafts a GitHub release.
2. The artefacts job builds the package from the tag, writes `SHA256SUMS`, attests build provenance and uploads them
   to the draft release.
3. The npm job publishes that same tarball to npm over OIDC trusted publishing, with provenance.
4. The release is published once both have succeeded.

semantic-release and its plugins are devDependencies, installed from the lockfile with `npm ci --ignore-scripts`.

## Tests

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

These are the steps `ci.yml` runs on Node 22 and 24.
