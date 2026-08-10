#!/usr/bin/env bash
#
# Nightly Lorefold backup, for launchd.
#
# Run by ~/Library/LaunchAgents/com.lorewood.lorefold.backup.plist. One job, so
# the ordering is guaranteed and the off-host copy can never run before the
# export it is meant to copy:
#
#   1. hot export           every night      (ops/backup/backup.sh hot)
#   2. cold archive         Sundays only     (ops/backup/backup.sh cold)
#   3. off-host push        every night      (ops/backup/offhost.sh push)
#   4. verify, to the log   every night
#
# Steps 1-3 are individually best-effort: a failed cold archive must not stop
# the off-host copy of a perfectly good hot export. Failures are logged loudly
# and the exit status reflects whether anything failed, so `launchctl print`
# shows a non-zero last exit rather than a silent green light.
#
# Configuration:
#   LOREFOLD_ENV_FILE   which stack to back up (default: <repo>/ops/.env)
#
# One instance per invocation, and it is exported so every child script agrees
# on which graph this run is about. Backing up a second instance means a second
# LaunchAgent with LOREFOLD_ENV_FILE set — not a loop in here, because a single
# job that half-fails on one client should not mark the other's backup failed.
# See ops/macos/README.md.

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

LOREFOLD_ENV_FILE="${LOREFOLD_ENV_FILE:-${REPO_ROOT}/ops/.env}"
export LOREFOLD_ENV_FILE

PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:${PATH}"
export PATH

log() { printf '%s [nightly] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }

failed=0

run_step() {
  local label="$1"; shift
  log "--- ${label}"
  if "$@"; then
    log "--- ${label}: ok"
  else
    log "--- ${label}: FAILED (exit $?)"
    failed=1
  fi
}

log "==== nightly run starting (env file: ${LOREFOLD_ENV_FILE})"

# The hot export needs a running stack. If the machine was off and Docker has
# not come back yet, say so rather than emitting a confusing save-CLI error.
if ! docker info >/dev/null 2>&1; then
  log "docker daemon is not running — skipping hot and cold, attempting off-host push of whatever exists"
  failed=1
else
  run_step "hot export" "${REPO_ROOT}/ops/backup/backup.sh" hot

  # Sunday. %u is 1-7 with Sunday as 7 on BSD date; %w is 0-6 with Sunday as 0.
  if [ "$(date +%w)" = "0" ]; then
    run_step "cold archive (Sunday)" "${REPO_ROOT}/ops/backup/backup.sh" cold
  else
    log "--- cold archive: skipped (not Sunday)"
  fi
fi

run_step "off-host push" "${REPO_ROOT}/ops/backup/offhost.sh" push

log "--- state"
"${REPO_ROOT}/ops/backup/backup.sh" verify   || true
"${REPO_ROOT}/ops/backup/offhost.sh" verify  || true

if [ "${failed}" -ne 0 ]; then
  log "==== nightly run finished WITH FAILURES"
  exit 1
fi
log "==== nightly run finished clean"
