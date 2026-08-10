#!/usr/bin/env bash
#
# Lorefold M0 backup driver.
#
#   ops/backup/backup.sh hot      logical EDN export of the event log (nightly)
#   ops/backup/backup.sh cold     stop -> tar athens-data/ -> start (weekly)
#   ops/backup/backup.sh verify   report what exists, and how old it is
#
# Safe to run from cron: it takes a lock, writes through a temp file, refuses to
# promote an empty or malformed export, and is idempotent within a day (a second
# run on the same date replaces that date's file atomically).
#
# Restore procedure and its sharp edges: ops/backup/restore.md
#
# Configuration (environment, all optional):
#   LOREFOLD_ENV_FILE compose env file        (default: <repo>/ops/.env)
#   COMPOSE_FILE_M0   compose file            (default: <repo>/ops/compose.m0.yml)
#   HOT_KEEP          daily exports to keep   (default: 14)
#   COLD_KEEP         weekly tarballs to keep (default: 8)
#   ARCHIVE_DIR       where cold tars go      (default: <script>/archives/<instance>)
#
# Multiple instances on one host: point LOREFOLD_ENV_FILE at that instance's
# env file and everything else follows from it — the compose project, the data
# directory, the archive directory and the archive filenames all carry the
# instance name, so two clients' backups cannot overwrite each other.
#
#   LOREFOLD_ENV_FILE=ops/dave.env ops/backup/backup.sh hot
#
# Getting this wrong is quiet, not loud: with the wrong env file the compose
# project resolves to the default instance and you export the wrong graph into
# the right-looking filename.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

COMPOSE_FILE_M0="${COMPOSE_FILE_M0:-${REPO_ROOT}/ops/compose.m0.yml}"
ENV_FILE="${LOREFOLD_ENV_FILE:-${REPO_ROOT}/ops/.env}"

# Read config from the env file without sourcing it. Sourcing would execute
# whatever is in there, and it is the one file here holding a real password.
env_get() {
  local key="$1"
  [ -f "${ENV_FILE}" ] || return 0
  sed -n "s/^[[:space:]]*${key}=//p" "${ENV_FILE}" | tail -1
}

LOREFOLD_INSTANCE="${LOREFOLD_INSTANCE:-$(env_get LOREFOLD_INSTANCE)}"
LOREFOLD_INSTANCE="${LOREFOLD_INSTANCE:-m0}"

# LOREFOLD_DATA_DIR is relative to ops/ when relative, matching how compose
# resolves the bind mounts in compose.m0.yml. One rule, not two — if these ever
# disagree the backup silently archives a directory nobody is writing to.
LOREFOLD_DATA_DIR="${LOREFOLD_DATA_DIR:-$(env_get LOREFOLD_DATA_DIR)}"
LOREFOLD_DATA_DIR="${LOREFOLD_DATA_DIR:-../athens-data}"
case "${LOREFOLD_DATA_DIR}" in
  /*) DATA_DIR="${LOREFOLD_DATA_DIR}" ;;
  *)  DATA_DIR="${REPO_ROOT}/ops/${LOREFOLD_DATA_DIR}" ;;
esac
# Canonicalise so the cold tar's -C/basename split below is unambiguous. The
# directory may not exist yet on a first run, so this is best-effort.
if [ -d "${DATA_DIR}" ]; then
  DATA_DIR="$(cd -- "${DATA_DIR}" && pwd -P)"
fi

# Per-instance by default: two instances sharing one archive directory would
# both write athens-data-<date>.tar.gz and each would prune the other's.
ARCHIVE_DIR="${ARCHIVE_DIR:-${SCRIPT_DIR}/archives/${LOREFOLD_INSTANCE}}"
HOT_KEEP="${HOT_KEEP:-14}"
COLD_KEEP="${COLD_KEEP:-8}"

# Where the datascript volume is mounted inside the athens container. The hot
# export is written here so it lands on the host under athens-data/datascript/.
CONTAINER_DATASCRIPT="/srv/athens/datascript"
# The uberjar and its working directory inside the published image.
CONTAINER_JAR="athens-lan-party-standalone.jar"
# Fluree is reachable only on the compose network, under this name.
FLUREE_ADDRESS="http://fluree:8090"

LOCK_DIR="${DATA_DIR}/.backup.lock"

# Cleanup state. These are deliberately globals, not locals: the EXIT trap runs
# after the calling function has returned, so a `local` would be out of scope
# and `set -u` would abort the trap — which would in turn leave the lock behind
# and, worse, leave the stack stopped after a failed cold backup.
TMP_FILE=""
RESTART_STACK_ON_EXIT=0

log()  { printf '%s [backup] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
die()  { printf '%s [backup] ERROR: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >&2; exit 1; }

# --env-file must come before -f, and it REPLACES ops/.env rather than merging.
# Passing it explicitly is what makes the compose project name resolve to this
# instance instead of the default one.
compose() { docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE_M0}" "$@"; }

# Every step is individually best-effort: one failure must not stop the rest,
# and bringing the stack back matters more than anything else here.
cleanup() {
  if [ -n "${TMP_FILE:-}" ]; then
    rm -f -- "${TMP_FILE}" 2>/dev/null || true
  fi
  if [ "${RESTART_STACK_ON_EXIT:-0}" -eq 1 ]; then
    log "starting stack"
    compose start >/dev/null 2>&1 || log "WARNING: could not start the stack — start it by hand"
  fi
  rmdir "${LOCK_DIR}" 2>/dev/null || true
  return 0
}

acquire_lock() {
  mkdir -p "${DATA_DIR}"
  if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
    die "another backup run holds ${LOCK_DIR}; remove it by hand if that run died"
  fi
  trap cleanup EXIT
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker not found on PATH"
  [ -f "${COMPOSE_FILE_M0}" ] || die "compose file not found: ${COMPOSE_FILE_M0}"
  # Without this the compose project name falls back to the default instance,
  # so a typo in LOREFOLD_ENV_FILE would back up the wrong graph under this
  # instance's filenames instead of failing.
  [ -f "${ENV_FILE}" ] || die "env file not found: ${ENV_FILE} (set LOREFOLD_ENV_FILE, or create ops/.env from ops/.env.example)"
}

# Keep the newest $2 files matching glob $1, delete the rest.
prune() {
  local glob="$1" keep="$2" f count=0
  # Newest first. `ls -1t` is fine here: these are our own files with plain names.
  while IFS= read -r f; do
    count=$((count + 1))
    if [ "${count}" -gt "${keep}" ]; then
      log "pruning $(basename "${f}")"
      rm -f -- "${f}"
    fi
  done < <(ls -1t ${glob} 2>/dev/null || true)
}

# ---------------------------------------------------------------------------
# hot: logical export of the event log, taken while the stack is running
# ---------------------------------------------------------------------------
# Runs the save CLI bundled in the published image, inside the athens container,
# against the fluree service on the compose network. It only reads the ledger,
# so it is safe against a live stack. The output is the (event-id, EDN) pair
# stream that the matching `load` action consumes.
do_hot() {
  require_docker
  acquire_lock

  local stamp out_host tmp_name tmp_host
  stamp="$(date +%F)"
  out_host="${DATA_DIR}/datascript/backup-${stamp}.edn"
  tmp_name="backup-${stamp}.edn.partial"
  tmp_host="${DATA_DIR}/datascript/${tmp_name}"
  TMP_FILE="${tmp_host}"

  compose ps --status running --services 2>/dev/null | grep -qx athens \
    || die "athens container is not running; start the stack first (hot export needs it)"

  mkdir -p "${DATA_DIR}/datascript"
  rm -f -- "${tmp_host}"

  log "exporting event log to $(basename "${out_host}")"
  # -T: no TTY, so this works under cron.
  compose exec -T athens \
    java -cp "${CONTAINER_JAR}" clojure.main \
      -m athens.self-hosted.save-load save \
      -a "${FLUREE_ADDRESS}" \
      -f "${CONTAINER_DATASCRIPT}/${tmp_name}" \
    || { rm -f -- "${tmp_host}"; die "save CLI failed; nothing was promoted"; }

  # Refuse to promote junk. An export that is empty, or that is not the EDN
  # collection the loader expects, is worse than no file at all: it looks like
  # a backup.
  [ -s "${tmp_host}" ] || { rm -f -- "${tmp_host}"; die "export is empty; nothing was promoted"; }
  case "$(head -c 1 "${tmp_host}")" in
    '['|'(') : ;;
    *) rm -f -- "${tmp_host}"; die "export does not start with an EDN collection; nothing was promoted" ;;
  esac
  # The save CLI writes `pr-str` of the event seq, so an event log with nothing
  # in it serialises to "()". That is a valid export of a brand-new graph, but
  # on an established one it means something is badly wrong. Promote it, loudly.
  case "$(tr -d '[:space:]' < "${tmp_host}")" in
    '()'|'[]') log "WARNING: the event log is EMPTY. Fine for a graph nobody has written to yet; otherwise investigate before trusting this file." ;;
  esac

  # Atomic within the same filesystem, so a reader never sees a half file and a
  # same-day rerun replaces cleanly.
  mv -f -- "${tmp_host}" "${out_host}"
  TMP_FILE=""
  log "wrote ${out_host} ($(wc -c < "${out_host}" | tr -d ' ') bytes)"

  prune "${DATA_DIR}/datascript/backup-*.edn" "${HOT_KEEP}"
  log "hot backup complete"
}

# ---------------------------------------------------------------------------
# cold: filesystem-consistent tarball of the whole data directory
# ---------------------------------------------------------------------------
# The stack is stopped for the duration. This is the only copy that captures the
# Fluree ledger's own files; the hot export captures the events, which is what
# you actually need to rebuild, but a cold tar restores faster.
do_cold() {
  require_docker
  acquire_lock

  local stamp out tmp data_parent data_base
  stamp="$(date +%F)"
  mkdir -p "${ARCHIVE_DIR}"
  # The instance name is in the filename as well as the directory, so a tarball
  # that gets moved or copied off somewhere still says which graph it holds.
  out="${ARCHIVE_DIR}/athens-data-${LOREFOLD_INSTANCE}-${stamp}.tar.gz"
  tmp="${out}.partial"
  TMP_FILE="${tmp}"

  [ -d "${DATA_DIR}" ] || die "no data directory at ${DATA_DIR}"

  # Archive DATA_DIR by name from its parent rather than assuming it is
  # <repo>/athens-data, so a per-instance directory anywhere works.
  data_parent="$(dirname -- "${DATA_DIR}")"
  data_base="$(basename -- "${DATA_DIR}")"

  if [ -n "$(compose ps --status running --services 2>/dev/null || true)" ]; then
    # Set BEFORE stopping anything, so the EXIT trap brings the stack back up
    # no matter where this fails.
    RESTART_STACK_ON_EXIT=1
    log "stopping stack for a consistent copy"
    compose stop >/dev/null
  else
    log "stack already stopped — leaving it stopped"
  fi

  log "archiving ${data_base}/ to $(basename "${out}")"
  rm -f -- "${tmp}"
  # Exclude our own archive dir if someone points ARCHIVE_DIR inside the data
  # directory, and the lock, which is by definition held right now.
  tar -czf "${tmp}" \
    -C "${data_parent}" \
    --exclude="${data_base}/.backup.lock" \
    --exclude="${data_base}/archives" \
    "${data_base}"
  mv -f -- "${tmp}" "${out}"
  TMP_FILE=""
  log "wrote ${out} ($(wc -c < "${out}" | tr -d ' ') bytes)"

  # Scoped to this instance's own filenames. A shared ARCHIVE_DIR set by hand
  # would otherwise have each instance prune the others' archives away.
  prune "${ARCHIVE_DIR}/athens-data-${LOREFOLD_INSTANCE}-*.tar.gz" "${COLD_KEEP}"
  log "cold backup complete"
}

# ---------------------------------------------------------------------------
# verify: what have we actually got
# ---------------------------------------------------------------------------
do_verify() {
  local latest_hot latest_cold
  echo "instance       : ${LOREFOLD_INSTANCE}"
  echo "env file       : ${ENV_FILE}"
  echo "data directory : ${DATA_DIR}"
  echo "archive dir    : ${ARCHIVE_DIR}"
  echo

  echo "hot exports (keep ${HOT_KEEP}):"
  ls -lh "${DATA_DIR}"/datascript/backup-*.edn 2>/dev/null || echo "  none"
  echo
  echo "cold archives (keep ${COLD_KEEP}):"
  ls -lh "${ARCHIVE_DIR}"/athens-data-${LOREFOLD_INSTANCE}-*.tar.gz 2>/dev/null || echo "  none"
  echo

  latest_hot="$(ls -1t "${DATA_DIR}"/datascript/backup-*.edn 2>/dev/null | head -1 || true)"
  latest_cold="$(ls -1t "${ARCHIVE_DIR}"/athens-data-${LOREFOLD_INSTANCE}-*.tar.gz 2>/dev/null | head -1 || true)"
  [ -n "${latest_hot}"  ] && echo "latest hot : ${latest_hot}"  || echo "latest hot : NONE — you have no logical backup"
  [ -n "${latest_cold}" ] && echo "latest cold: ${latest_cold}" || echo "latest cold: NONE"
  echo
  echo "Reminder: a backup you have never restored is not a backup."
  echo "See ops/backup/restore.md."
}

usage() {
  sed -n '3,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

case "${1:-hot}" in
  hot)    do_hot ;;
  cold)   do_cold ;;
  verify) do_verify ;;
  -h|--help|help) usage ;;
  *) usage; exit 2 ;;
esac
