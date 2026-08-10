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
#   LOREFOLD_ENV_FILE     which stack to bring up           (default: <repo>/ops/.env)
#   DOCKER_WAIT_SECONDS   how long to wait for the daemon   (default: 300)
#   HEALTH_WAIT_SECONDS   how long to wait for athens       (default: 300)
#   COMPOSE_FILE_M0       compose file                      (default: <repo>/ops/compose.m0.yml)
#
# One instance per invocation. To bring up a client channel instance as well,
# install a second LaunchAgent with LOREFOLD_ENV_FILE set in its
# EnvironmentVariables dict — see ops/macos/README.md.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

COMPOSE_FILE_M0="${COMPOSE_FILE_M0:-${REPO_ROOT}/ops/compose.m0.yml}"
ENV_FILE="${LOREFOLD_ENV_FILE:-${REPO_ROOT}/ops/.env}"
DOCKER_WAIT_SECONDS="${DOCKER_WAIT_SECONDS:-300}"
HEALTH_WAIT_SECONDS="${HEALTH_WAIT_SECONDS:-300}"

# --env-file must precede -f, and it REPLACES ops/.env rather than merging.
# Passing it on every call is what keeps this script pointed at one stack: the
# compose project name is interpolated from LOREFOLD_INSTANCE, so a bare
# `docker compose -f ...` here would act on the default instance instead.
compose() { docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE_M0}" "$@"; }

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
if [ ! -f "${ENV_FILE}" ]; then
  die "no env file at ${ENV_FILE} — copy ops/.env.example (or ops/instance.env.example) and set a real ATHENS_PASSWORD first"
fi
if grep -qE '^ATHENS_PASSWORD=(CHANGE-ME)?[[:space:]]*$' "${ENV_FILE}"; then
  die "ATHENS_PASSWORD is unset or still CHANGE-ME in ${ENV_FILE} — refusing to start"
fi

# ---------------------------------------------------------------------------
# Up
# ---------------------------------------------------------------------------
LOREFOLD_INSTANCE="$(sed -n 's/^[[:space:]]*LOREFOLD_INSTANCE=//p' "${ENV_FILE}" | tail -1)"
LOREFOLD_INSTANCE="${LOREFOLD_INSTANCE:-m0}"

log "bringing up the '${LOREFOLD_INSTANCE}' stack (${ENV_FILE})"
compose up -d

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

# The container always listens on 3010; LOREFOLD_PORT is the host side. A
# hardcoded 3010 here would health-check the default workspace and report a
# client instance on 3011 as healthy when it is not running at all.
LOREFOLD_PORT="$(sed -n 's/^[[:space:]]*LOREFOLD_PORT=//p' "${ENV_FILE}" | tail -1)"
LOREFOLD_PORT="${LOREFOLD_PORT:-3010}"

HEALTH_URL="http://${HEALTH_HOST}:${LOREFOLD_PORT}/health-check"

# wait_for_health <seconds> — 0 if athens answers within the budget, 1 if not.
wait_for_health() {
  local budget="$1"
  local waited=0
  until curl -fsS --max-time 5 "${HEALTH_URL}" >/dev/null 2>&1; do
    if [ "${waited}" -ge "${budget}" ]; then
      return 1
    fi
    sleep 5
    waited=$((waited + 5))
  done
  log "athens answered ${HEALTH_URL} after ${waited}s"
  return 0
}

# `up -d` returns as soon as the containers are created; athens waits on
# fluree's health check, and fluree's first boot can take two to three minutes.
# Report the real state rather than implying success.
log "waiting for the athens health check on ${HEALTH_HOST}:${LOREFOLD_PORT}"
if wait_for_health "${HEALTH_WAIT_SECONDS}"; then
  log "stack is up and healthy"
  exit 0
fi

# ---------------------------------------------------------------------------
# Recovery: the restart race
# ---------------------------------------------------------------------------
# `depends_on: condition: service_healthy` orders `compose up`, but the Docker
# daemon does not honour it when `restart: always` brings the containers back
# after a crash, a daemon restart or a reboot. Both then start in parallel,
# athens queries fluree before its web server is listening, fails with
#
#   "xhttp error - http://fluree:8090/fdb/health"
#
# and never retries. The container stays "Up" and the port stays published while
# nothing is listening on 3010 — a stack that looks healthy from `docker ps` and
# refuses every connection.
#
# Re-running `up -d` cannot clear this: it is a no-op against a running container
# whose config still matches. Athens has to be recreated explicitly, and only
# once fluree is genuinely healthy — otherwise this just loops the same race.
log "athens did not answer; checking fluree before recreating it"

FLUREE_HEALTH="$(compose ps fluree --format '{{.Health}}' 2>/dev/null | tail -1)"
if [ "${FLUREE_HEALTH}" != "healthy" ]; then
  log "WARNING: athens is down and fluree is '${FLUREE_HEALTH:-unknown}', not healthy."
  log "         Recreating athens would not help. Check: docker compose --env-file ${ENV_FILE} -f ${COMPOSE_FILE_M0} logs fluree"
  exit 0
fi

log "fluree is healthy, so this looks like the startup race — recreating athens once"
compose up -d --force-recreate athens

if wait_for_health "${HEALTH_WAIT_SECONDS}"; then
  log "stack is up and healthy after recreating athens"
  exit 0
fi

log "WARNING: athens is still not healthy after being recreated."
log "         Check: docker compose --env-file ${ENV_FILE} -f ${COMPOSE_FILE_M0} logs athens"
