#!/usr/bin/env bash
#
# ci-local.sh - run the GitHub Actions CI workflow (.github/workflows/ci.yml)
# locally using `act`, reproducing the full Node.js version matrix as
# concurrent container builds.
#
# Requirements: act (brew install act) and a running Docker daemon.

# -e  exit on any error
# -u  treat unset variables as errors
# -o pipefail  a pipeline fails if any command in it fails
set -euo pipefail

# --- locate repo root (script lives in <root>/scripts) ---------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKFLOW=".github/workflows/ci.yml"

# Runner image: the catthehacker image for the Ubuntu release GitHub's
# ubuntu-latest runs (26.04). It ships Node.js on PATH for the JS actions
# (checkout, setup-node). Pulled on every run so it stays current.
RUNNER_IMAGE="catthehacker/ubuntu:act-26.04"

# --- defaults --------------------------------------------------------------
EVENT="pull_request"
CONCURRENCY=3
NODE_VERSION=""
LIST_ONLY=0
# Declared empty up front so the variable exists under `set -u`. Because an
# empty array still trips "unbound variable" on bash 3.2, every expansion of
# it below is guarded by a ${#EXTRA_ARGS[@]} length check.
EXTRA_ARGS=()

usage() {
    # Here-doc avoids fragile sed-over-source-file parsing.
    cat <<'EOF'
ci-local.sh - run the GitHub Actions CI workflow (.github/workflows/ci.yml)
locally using `act`, reproducing the full Node.js version matrix as
concurrent container builds.

This is a faithful local mirror of "CI": it runs the exact same steps
(checkout, setup-node, npm ci, npm run lint, npm run typecheck, npm test,
npm run build) inside ubuntu containers, one per matrix entry, so failures
seen here match what GitHub reports.

Usage:
  scripts/ci-local.sh                 # run all matrix builds (22.x, 24.x, 26.x)
  scripts/ci-local.sh -v 26.x         # run only the Node.js 26.x build
  scripts/ci-local.sh -e push         # use the push event (default: pull_request)
  scripts/ci-local.sh -c 1            # limit concurrent jobs (default: 3)
  scripts/ci-local.sh -l              # list the jobs without running them
  scripts/ci-local.sh -- --verbose    # pass any extra args straight to act

Options:
  -v, --version VERSION   restrict the matrix to a single Node.js version (e.g. 22.x)
  -e, --event   EVENT     act event trigger (default: pull_request)
  -c, --concurrency N     maximum concurrent jobs (default: 3, must be a number)
  -l, --list              list jobs without running them
  -h, --help              show this help and exit

Requirements: act (brew install act) and a running Docker daemon.

The workflow runs in catthehacker/ubuntu:act-26.04, matching GitHub's
ubuntu-latest. The latest version of the image is pulled on every run.
EOF
}

# --- arg parsing -----------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case "$1" in
        -v|--version)
            NODE_VERSION="${2:?--version requires a value, e.g. 22.x}"
            shift 2
            ;;
        -e|--event)
            EVENT="${2:?--event requires a value, e.g. push}"
            shift 2
            ;;
        -c|--concurrency)
            CONCURRENCY="${2:?--concurrency requires a numeric value}"
            # Reject non-numeric values early so act gets a sensible error.
            if ! [[ "${CONCURRENCY}" =~ ^[0-9]+$ ]]; then
                echo "error: --concurrency requires a positive integer, got: ${CONCURRENCY}" >&2
                exit 2
            fi
            shift 2
            ;;
        -l|--list)
            LIST_ONLY=1
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        --)
            shift
            EXTRA_ARGS=("$@")
            break
            ;;
        *)
            echo "error: unknown option: $1" >&2
            echo "Run with -h or --help for usage." >&2
            exit 2
            ;;
    esac
done

# --- prerequisite checks ---------------------------------------------------
if ! command -v act >/dev/null 2>&1; then
    echo "error: 'act' is not installed." >&2
    echo "  macOS:  brew install act" >&2
    echo "  Linux:  https://github.com/nektos/act#installation" >&2
    exit 127
fi

# docker info writes to stdout and stderr even on success; suppress both.
if ! docker info >/dev/null 2>&1; then
    echo "error: Docker daemon is not reachable. Start Docker and retry." >&2
    exit 1
fi

# Verify the workflow file exists before handing off to act.
if [[ ! -f "${REPO_ROOT}/${WORKFLOW}" ]]; then
    echo "error: workflow file not found: ${REPO_ROOT}/${WORKFLOW}" >&2
    exit 1
fi

# On ARM hosts (Apple silicon "arm64", Linux ARM "aarch64") the act runner
# images used here are amd64; force the platform for both the pull and the run
# so the container matches GitHub's runners.
PLATFORM_PULL_ARGS=()
ACT_ARCH_ARGS=()
_arch="$(uname -m)"
if [[ "${_arch}" == "arm64" || "${_arch}" == "aarch64" ]]; then
    PLATFORM_PULL_ARGS=(--platform linux/amd64)
    ACT_ARCH_ARGS=(--container-architecture linux/amd64)
fi
unset _arch

# --- pull the latest runner image -----------------------------------------
# Always pull so local runs use the current image. Listing does not run
# containers, so skip the pull for -l.
if [[ "${LIST_ONLY}" -eq 0 ]]; then
    echo "==> Pulling runner image ${RUNNER_IMAGE}"
    docker pull ${PLATFORM_PULL_ARGS[@]+"${PLATFORM_PULL_ARGS[@]}"} "${RUNNER_IMAGE}"
fi

# --- assemble act invocation -----------------------------------------------
# -P maps the workflow's `runs-on: ubuntu-latest` to the runner image. This
# overrides the mapping in .actrc. --pull=false because the image was just
# pulled above.
ACT_ARGS=("${EVENT}" -W "${WORKFLOW}" --concurrent-jobs "${CONCURRENCY}")
ACT_ARGS+=(-P "ubuntu-latest=${RUNNER_IMAGE}" --pull=false)
if [[ ${#ACT_ARCH_ARGS[@]} -gt 0 ]]; then
    ACT_ARGS+=("${ACT_ARCH_ARGS[@]}")
fi

# Restrict to a single Node.js version when requested.
if [[ -n "${NODE_VERSION}" ]]; then
    ACT_ARGS+=(--matrix "node-version:${NODE_VERSION}")
fi

if [[ "${LIST_ONLY}" -eq 1 ]]; then
    ACT_ARGS+=(--list)
fi

if [[ ${#EXTRA_ARGS[@]} -gt 0 ]]; then
    ACT_ARGS+=("${EXTRA_ARGS[@]}")
fi

cd "${REPO_ROOT}"

echo "==> Running CI locally via act"
echo "    workflow:    ${WORKFLOW}"
echo "    runner:      ${RUNNER_IMAGE}"
echo "    event:       ${EVENT}"
if [[ -n "${NODE_VERSION}" ]]; then
    echo "    matrix:      node-version:${NODE_VERSION} (single build)"
else
    echo "    matrix:      22.x, 24.x, 26.x (up to ${CONCURRENCY} concurrent)"
fi
echo "    act:         act ${ACT_ARGS[*]}"
echo

exec act "${ACT_ARGS[@]}"
