#!/usr/bin/env bash
#
# harness.sh - run the plugin from this checkout in a local Docker Homebridge, with its
# settings page, logs and accessories viewable in the Homebridge UI.
#
# Requirements: Docker with the compose plugin, Node.js and npm.
#
# Usage: scripts/harness.sh <command> [options]
#   up [--stub]   Build and install the plugin, then start Homebridge. Talks to the real
#                 Tuya cloud with whatever credentials you enter, unless --stub is given:
#                 then a fake Tuya cloud with three air conditioners answers instead.
#                 The choice sticks for later commands until the next `up`.
#   reload        Rebuild and reinstall the plugin, then restart Homebridge.
#   logs [svc]    Follow logs: homebridge (default) or tuya-stub.
#   down          Stop the containers, keeping config and installed plugins.
#   reset         Stop the containers and delete all harness data (config, users, certs).
#
# Environment: HARNESS_UI_PORT (default 8581) sets the UI port on the host.

# -e  exit on any error
# -u  treat unset variables as errors
# -o pipefail  a pipeline fails if any command in it fails
set -euo pipefail

# --- locate repo root (script lives in <root>/scripts) ---------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
HARNESS_DIR="${REPO_ROOT}/harness"
DATA_DIR="${HARNESS_DIR}/data"
PKG_DIR="${HARNESS_DIR}/pkg"
ENV_FILE="${HARNESS_DIR}/.env"
UI_PORT="${HARNESS_UI_PORT:-8581}"
UI_URL="http://localhost:${UI_PORT}"

usage() {
  sed -n '3,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

compose() {
  # Compose reads COMPOSE_FILE (real or stub mode) from harness/.env, and resolves its
  # paths against the working directory, so run it from there.
  (cd "${HARNESS_DIR}" && docker compose "$@")
}

# Packs the plugin exactly as npm would publish it, under a fixed name for package.json.
pack_plugin() {
  mkdir -p "${PKG_DIR}"
  rm -f "${PKG_DIR}"/*.tgz
  local out
  if ! out="$("${SCRIPT_DIR}/pack-local.sh" "${PKG_DIR}" 2>&1)"; then
    echo "${out}" >&2
    exit 1
  fi
  mv "${PKG_DIR}"/homebridge-meaco-*.tgz "${PKG_DIR}/homebridge-meaco.tgz"
  echo "Packed plugin into harness/pkg/homebridge-meaco.tgz"
}

# First run only: a bridge and the UI with login turned off. The plugin's own block is
# left out, so its settings page starts from a fresh install.
seed_data() {
  mkdir -p "${DATA_DIR}"
  if [[ ! -f "${DATA_DIR}/config.json" ]]; then
    cat > "${DATA_DIR}/config.json" <<'JSON'
{
  "bridge": {
    "name": "Homebridge Meaco Harness",
    "username": "0E:4D:45:41:43:4F",
    "port": 51826,
    "pin": "031-45-154"
  },
  "platforms": [
    { "platform": "config", "name": "Config", "port": 8581, "auth": "none" }
  ]
}
JSON
  fi
  # The container installs everything in package.json on each start, including this
  # plugin from the packed tarball. It adds Homebridge itself on first start.
  if [[ ! -f "${DATA_DIR}/package.json" ]]; then
    printf '{ "dependencies": { "homebridge-meaco": "file:/harness/pkg/homebridge-meaco.tgz" } }\n' \
      > "${DATA_DIR}/package.json"
  fi
}

# Removes paths under harness/. Files Homebridge wrote are owned by root on Linux hosts,
# so fall back to deleting them from inside a container.
remove_paths() {
  rm -rf "$@" 2>/dev/null && return 0
  local inside=()
  for p in "$@"; do inside+=("/h/${p#"${HARNESS_DIR}/"}"); done
  docker run --rm -v "${HARNESS_DIR}:/h" --entrypoint rm homebridge-meaco-harness:local -rf "${inside[@]}"
}

wait_for_ui() {
  echo "Waiting for the Homebridge UI on ${UI_URL} (the first start installs Homebridge, so give it a few minutes)..."
  for _ in $(seq 1 180); do
    if curl -sf -o /dev/null "${UI_URL}/"; then
      return 0
    fi
    sleep 2
  done
  echo "harness: the UI didn't come up. Check: scripts/harness.sh logs" >&2
  exit 1
}

# The UI insists on a user even with login turned off. Create one on first run.
ensure_user() {
  local token
  token="$(curl -sf "${UI_URL}/api/setup-wizard/get-setup-wizard-token" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).access_token??"")}catch{}})')" || true
  [[ -z "${token}" ]] && return 0
  curl -sf -X POST "${UI_URL}/api/setup-wizard/create-first-user" \
    -H "Authorization: Bearer ${token}" -H 'Content-Type: application/json' \
    -d '{"name":"Harness","username":"admin","password":"harness-admin","admin":true}' >/dev/null
  echo "Created UI user admin / harness-admin (login is off, so you won't need it)"
}

cmd_up() {
  local mode=real
  case "${1:-}" in
    --stub) mode=stub ;;
    "") ;;
    *) echo "harness: unknown option '$1'" >&2; usage; exit 1 ;;
  esac

  if [[ "${mode}" == stub ]]; then
    printf 'COMPOSE_FILE=compose.yaml:compose.stub.yaml\nHARNESS_UI_PORT=%s\n' "${UI_PORT}" > "${ENV_FILE}"
  else
    printf 'COMPOSE_FILE=compose.yaml\nHARNESS_UI_PORT=%s\n' "${UI_PORT}" > "${ENV_FILE}"
  fi

  pack_plugin
  seed_data
  # A new tarball under the same name isn't always reinstalled, so clear the old copy.
  [[ -d "${DATA_DIR}/node_modules/homebridge-meaco" ]] && remove_paths "${DATA_DIR}/node_modules/homebridge-meaco"
  compose up -d --build --remove-orphans --force-recreate
  wait_for_ui
  ensure_user

  echo
  echo "Homebridge UI: ${UI_URL}  (Plugins → Homebridge Meaco → settings)"
  if [[ "${mode}" == stub ]]; then
    echo "Tuya: STUB. Enter any access key and secret key (an access key starting with 'bad' fails auth)."
    echo "      Turn off Message Service under Advanced: the stub doesn't serve it."
    echo "      Follow the plugin's Tuya calls with: scripts/harness.sh logs tuya-stub"
  else
    echo "Tuya: REAL cloud. Enter your own credentials."
  fi
}

cmd_reload() {
  [[ -f "${ENV_FILE}" ]] || { echo "harness: not set up yet. Run: scripts/harness.sh up [--stub]" >&2; exit 1; }
  pack_plugin
  [[ -d "${DATA_DIR}/node_modules/homebridge-meaco" ]] && remove_paths "${DATA_DIR}/node_modules/homebridge-meaco"
  compose restart homebridge
  wait_for_ui
  echo "Reloaded. Reopen the plugin settings in ${UI_URL} to pick up UI changes."
}

cmd_logs() {
  compose logs -f --tail 200 "${1:-homebridge}"
}

cmd_down() {
  compose down
}

cmd_reset() {
  compose down --volumes --remove-orphans || true
  rm -f "${ENV_FILE}"
  remove_paths "${DATA_DIR}" "${PKG_DIR}"
  echo "Harness data removed."
}

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  reload) cmd_reload ;;
  logs) shift; cmd_logs "$@" ;;
  down) cmd_down ;;
  reset) cmd_reset ;;
  -h|--help|help|"") usage ;;
  *) echo "harness: unknown command '$1'" >&2; usage; exit 1 ;;
esac
