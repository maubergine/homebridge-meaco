# Local Homebridge harness

Runs the plugin built from this checkout inside the official Homebridge Docker image
(`homebridge/homebridge`, Synology tag), so you can use its settings page, read its logs
and see its accessories in the Homebridge UI, much as a user would.

Requires Docker with the compose plugin, plus Node.js and npm to build the plugin.

## Commands

```sh
scripts/harness.sh up           # real Tuya cloud: enter your own credentials
scripts/harness.sh up --stub    # fake Tuya cloud: no account needed
scripts/harness.sh reload       # rebuild and reinstall the plugin after a code change
scripts/harness.sh logs         # follow Homebridge's log (add tuya-stub for the stub's)
scripts/harness.sh down         # stop, keeping config and plugins
scripts/harness.sh reset        # stop and delete everything, for a fresh install
```

`npm run harness -- <command>` does the same. The UI is at <http://localhost:8581>, with
login turned off. Set `HARNESS_UI_PORT` to use another port. The plugin is under
**Plugins → Homebridge Meaco**.

On the first `up`, Homebridge has no config for the plugin, so its settings page opens as
it would on a fresh install. `up` remembers the mode you chose; `reload`, `logs` and `down`
use it.

## Real or stub

Without `--stub`, the plugin talks to the real Tuya cloud with whatever credentials you
enter, exactly as it would on your own Homebridge.

With `--stub`, a second container stands in for Tuya's servers. The plugin runs unmodified:
the stub answers for Tuya's real hostnames on the harness network, with a certificate from
its own CA, which the Homebridge container trusts through `NODE_EXTRA_CA_CERTS`. Nothing
reaches the real cloud. The stub:

- accepts any credentials, except an access key starting with `bad`, which fails as a
  wrong key would
- has three air conditioners: **Living Room AC** (recognised by product ID, a real
  MeacoCool MC capture), **Bedroom AC** (recognised by model code, with heat and sleep)
  and **Garage AC** (another brand, which discovery should ignore)
- keeps device state in memory, so commands from the Home or Accessories tab change what
  later polls return
- logs every call the plugin makes: `scripts/harness.sh logs tuya-stub`
- doesn't serve Tuya's Message Service: turn **Use Tuya Message Service** off under
  **Advanced**, or the plugin keeps retrying the connection

Switching between modes keeps the harness config, including any credentials and devices
you entered. Run `reset` first to start clean.

## Files

| Path | What it is |
|------|------------|
| `Dockerfile` | The pinned Homebridge image, kept current by Dependabot |
| `compose.yaml` | Homebridge, with the packed plugin mounted in |
| `compose.stub.yaml` | Adds the Tuya stub and trusts its CA |
| `tuya-stub/` | The stub: certificate setup and a small HTTPS server |
| `data/` | Homebridge storage: config, plugins, logs (git-ignored) |
| `pkg/` | The packed plugin the container installs (git-ignored) |
