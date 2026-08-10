#!/usr/bin/env bash
#
# Bring the Lorefold M0 stack up on a macOS host, from launchd.
#
# Run by ~/Library/LaunchAgents/com.lorewood.lorefold.stack.plist at login, and
# safe to run by hand at any time — `compose up -d` is idempotent.
#
# The whole reason this script exists rather than launchd calling `docker
# compose` directly: at login the Docker daemon is not up yet. Docker Desktop is
# a user application that takes tens of seconds to start its VM, so a compose
# command fired the moment the agent loads fails, and launchd's retry semantics
# would just fail it again. So we wait for the daemon, then act.
#
# Configuration (environment, all optional):
#   DOCKER_WAIT_SECONDS   how long to wait for the daemon   (default: 300)
#   COMPOSE_FILE_M0       compose file                      (default: <repo>/ops/compose.m0.yml)

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

COMPOSE_FILE_M0="${COMPOSE_FILE_M0:-${REPO_ROOT}/ops/compose.m0.yml}"
DOCKER_WAIT_SECONDS="${DOCKER_WAIT_SECONDS:-300}"

# launchd hands a job a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), which does
# not include the Docker CLI or Homebrew. Add both Intel and Apple-Silicon
# Homebrew prefixes plus Docker Desktop's own bin so this works either way.
PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:${PATH}"
export PATH

log() { printf '%s [lorefold-up] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
die() { printf '%s [lorefold-up] ERROR: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 \
  || die "docker not found on PATH (${PATH}); is Docker Desktop installed?"
[ -f "${COMPOSE_FILE_M0}" ] || die "compose file not found: ${COMPOSE_FILE_M0}"

# ---------------------------------------------------------------------------
# Wait for the daemon
# ---------------------------------------------------------------------------
log "waiting up to ${DOCKER_WAIT_SECONDS}s for the Docker daemon"
waited=0
until docker info >/dev/null 2>&1; do
  if [ "${waited}" -ge "${DOCKER_WAIT_SECONDS}" ]; then
    die "Docker daemon did not become ready within ${DOCKER_WAIT_SECONDS}s. Is Docker Desktop set to open at login? (Settings → General → Start Docker Desktop when you sign in.)"
  fi
  sleep 5
  waited=$((waited + 5))
done
log "docker daemon ready after ${waited}s"

# ---------------------------------------------------------------------------
# Refuse to start a stack with the placeholder password
# ---------------------------------------------------------------------------
# Better to have no graph than a graph on the shared password that ships in the
# example file — this port is reachable from wherever ATHENS_BIND_ADDR points.
ENV_FILE="${REPO_ROOT}/ops/.env"
if [ ! -f "${ENV_FILE}" ]; then
  die "no ops/.env — copy ops/.env.example and set a real ATHENS_PASSWORD first"
fi
if grep -qE '^ATHENS_PASSWORD=(CHANGE-ME)?[[:space:]]*$' "${ENV_FILE}"; then
  die "ATHENS_PASSWORD is unset or still CHANGE-ME in ops/.env — refusing to start"
fi

# ---------------------------------------------------------------------------
# Up
# ---------------------------------------------------------------------------
log "bringing up the stack"
docker compose -f "${COMPOSE_FILE_M0}" up -d

# Health-check against whatever interface the port was actually published on.
# With ATHENS_BIND_ADDR set to the tailnet address — which is what LF-8 asks for
# — the port is NOT on loopback, so a hardcoded 127.0.0.1 check would report a
# perfectly healthy stack as broken.
BIND_ADDR="$(sed -n 's/^[[:space:]]*ATHENS_BIND_ADDR=//p' "${ENV_FILE}" | tail -1)"
BIND_ADDR="${BIND_ADDR:-0.0.0.0}"
case "${BIND_ADDR}" in
  0.0.0.0|"") HEALTH_HOST="127.0.0.1" ;;
  *)          HEALTH_HOST="${BIND_ADDR}" ;;
esac

# `up -d` returns as soon as the containers are created; athens waits on
# fluree's health check, and fluree's first boot can take two to three minutes.
# Report the real state rather than implying success.
log "waiting for the athens health check on ${HEALTH_HOST}:3010"
waited=0
until curl -fsS --max-time 5 "http://${HEALTH_HOST}:3010/health-check" >/dev/null 2>&1; do
  if [ "${waited}" -ge 300 ]; then
    log "WARNING: athens is not healthy after 300s. Check: docker compose -f ${COMPOSE_FILE_M0} logs athens"
    exit 0
  fi
  sleep 5
  waited=$((waited + 5))
done

log "stack is up and healthy (took ${waited}s after compose up)"
