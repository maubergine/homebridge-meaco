#!/usr/bin/env bash
#
# entrypoint.sh - start the fake Tuya cloud for the harness (compose.stub.yaml).
#
# Creates a throwaway CA and a certificate for Tuya's OpenAPI hostnames on first start,
# then serves the stub over HTTPS. The Homebridge container trusts the CA through
# NODE_EXTRA_CA_CERTS. Certificates live in the stub-certs volume, so they survive restarts
# and only change after `scripts/harness.sh reset`.

# -e  exit on any error
# -u  treat unset variables as errors
# -o pipefail  a pipeline fails if any command in it fails
set -euo pipefail

CERT_DIR=/certs
HOSTS=(openapi.tuyaus.com openapi.tuyaeu.com openapi-weeu.tuyaeu.com openapi.tuyacn.com openapi.tuyain.com localhost)

if [[ ! -f "${CERT_DIR}/server.pem" ]]; then
  echo "[tuya-stub] creating harness CA and server certificate"
  cd "${CERT_DIR}"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -subj "/CN=homebridge-meaco harness CA" -keyout ca.key -out ca.pem 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=openapi.tuyaeu.com" \
    -keyout server.key -out server.csr 2>/dev/null
  san="subjectAltName=$(printf 'DNS:%s,' "${HOSTS[@]}")"
  openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 825 \
    -extfile <(printf '%s\nextendedKeyUsage=serverAuth\n' "${san%,}") -out server.pem 2>/dev/null
  rm -f server.csr
  # Homebridge runs as root in the container, but keep the CA key out of reach anyway.
  chmod 600 ca.key server.key
fi

exec node /harness/tuya-stub/server.mjs
