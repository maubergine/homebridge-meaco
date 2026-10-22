#!/usr/bin/env bash
#
# pack-local.sh - build the plugin from a clean dist/ and pack it into a tarball
# that npm can install from as a file, for testing on a real Homebridge before
# releasing.
#
# Usage: scripts/pack-local.sh [destination-dir]   (default: current directory)
#        npm run pack:local -- /path/to/homebridge
#
# Then, from the Homebridge storage directory: npm install /path/to/<tarball>.tgz

# -e  exit on any error
# -u  treat unset variables as errors
# -o pipefail  a pipeline fails if any command in it fails
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEST="${1:-.}"

if [[ ! -d "${DEST}" ]]; then
  echo "pack-local: destination '${DEST}' is not a directory" >&2
  exit 1
fi
DEST="$(cd "${DEST}" && pwd)"

cd "${REPO_ROOT}"

# tsc never deletes output, so files from removed sources would otherwise ship.
rm -rf dist
npm run build

TARBALL="$(npm pack --pack-destination "${DEST}" | tail -n 1)"

echo
echo "Packed ${DEST}/${TARBALL}"
echo "Install it from the Homebridge storage directory with:"
echo "  npm install <path to ${TARBALL} as Homebridge sees it>"
