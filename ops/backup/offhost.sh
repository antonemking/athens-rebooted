#!/usr/bin/env bash
#
# Copy the newest Lorefold backups off the machine that holds the graph.
#
#   ops/backup/offhost.sh push     copy newest hot export + cold archive to the destination
#   ops/backup/offhost.sh verify   report what is at the destination, and how old it is
#
# This closes the follow-on that ops/RUNBOOK.md section 15 (LF-8) leaves open:
# ops/backup/backup.sh writes its exports under athens-data/ and ops/backup/
# archives/, both of which live on the same disk as the graph. A copy on the
# same disk does not survive the disk. Until this runs somewhere else, backups
# are single-disk and the deployment decision is only half-realised.
#
# Configuration (environment, or the env file):
#   LOREFOLD_ENV_FILE       which env file to read (default: <repo>/ops/.env)
#   LOREFOLD_OFFHOST_DEST   required. Either:
#                             /Volumes/Backup/lorefold     a directory (external
#                                                          disk, mounted network
#                                                          share, synced folder)
#                             rclone:remote:path/lorefold  an rclone remote, for
#                                                          object storage
#   OFFHOST_KEEP            copies to keep at the destination (default: 14).
#                           Local destinations only — for rclone, use the
#                           bucket's own lifecycle rules.
#
# Multiple instances on one host: this script appends /<LOREFOLD_INSTANCE> to
# the destination, so several instances can share one root safely.
#
#   LOREFOLD_ENV_FILE=ops/dave.env ops/backup/offhost.sh push
#
# That subdirectory is not cosmetic. Every instance's hot export is named
# backup-<date>.edn, so a shared flat destination would have each night's push
# overwrite the last one to run — one client's ledger silently replaced by
# another's, with a fresh timestamp and the right filename.
#
# What this deliberately does NOT do: encrypt. If the destination is storage you
# do not control, put an encrypted remote in front of it (rclone crypt) — the
# export is your entire decision ledger in plain EDN.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

ENV_FILE="${LOREFOLD_ENV_FILE:-${REPO_ROOT}/ops/.env}"

log() { printf '%s [offhost] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"; }
die() { printf '%s [offhost] ERROR: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >&2; exit 1; }

# Read config from ops/.env without sourcing it. Sourcing would execute whatever
# is in that file, and it is the one file here that holds a real password.
env_get() {
  local key="$1"
  [ -f "${ENV_FILE}" ] || return 0
  sed -n "s/^[[:space:]]*${key}=//p" "${ENV_FILE}" | tail -1
}

LOREFOLD_OFFHOST_DEST="${LOREFOLD_OFFHOST_DEST:-$(env_get LOREFOLD_OFFHOST_DEST)}"
OFFHOST_KEEP="${OFFHOST_KEEP:-$(env_get OFFHOST_KEEP)}"
OFFHOST_KEEP="${OFFHOST_KEEP:-14}"

LOREFOLD_INSTANCE="${LOREFOLD_INSTANCE:-$(env_get LOREFOLD_INSTANCE)}"
LOREFOLD_INSTANCE="${LOREFOLD_INSTANCE:-m0}"

# Same resolution rule as compose.m0.yml and backup.sh: relative paths are
# relative to ops/, because that is where compose resolves its bind mounts.
LOREFOLD_DATA_DIR="${LOREFOLD_DATA_DIR:-$(env_get LOREFOLD_DATA_DIR)}"
LOREFOLD_DATA_DIR="${LOREFOLD_DATA_DIR:-../athens-data}"
case "${LOREFOLD_DATA_DIR}" in
  /*) DATA_DIR="${LOREFOLD_DATA_DIR}" ;;
  *)  DATA_DIR="${REPO_ROOT}/ops/${LOREFOLD_DATA_DIR}" ;;
esac
ARCHIVE_DIR="${ARCHIVE_DIR:-${SCRIPT_DIR}/archives/${LOREFOLD_INSTANCE}}"

# Everything below works against the per-instance subdirectory, never the root
# the user configured. See the header for why this is load-bearing.
DEST_ROOT="${LOREFOLD_OFFHOST_DEST}"
LOREFOLD_OFFHOST_DEST="${DEST_ROOT%/}/${LOREFOLD_INSTANCE}"

# Checked per-action rather than at load time, so `--help` still works on a host
# where nothing is configured yet — which is exactly when someone reads it.
require_dest() {
  [ -n "${DEST_ROOT}" ] \
    || die "LOREFOLD_OFFHOST_DEST is not set (environment or ${ENV_FILE}). See the header of this script."
}

is_rclone() { case "${LOREFOLD_OFFHOST_DEST}" in rclone:*) return 0 ;; *) return 1 ;; esac; }
rclone_remote() { printf '%s' "${LOREFOLD_OFFHOST_DEST#rclone:}"; }

# ---------------------------------------------------------------------------
# Destination checks
# ---------------------------------------------------------------------------
check_dest() {
  if is_rclone; then
    command -v rclone >/dev/null 2>&1 || die "rclone not found on PATH but LOREFOLD_OFFHOST_DEST is an rclone remote"
    # Check the configured root, not the per-instance subdirectory: rclone
    # creates paths on write, so the subdirectory legitimately does not exist
    # until the first push.
    rclone lsd "${DEST_ROOT#rclone:}" >/dev/null 2>&1 \
      || die "rclone cannot reach ${DEST_ROOT#rclone:} — check 'rclone config' and connectivity"
    return 0
  fi

  # A destination ROOT that does not exist is almost always an external disk
  # that is not plugged in. Fail loudly: silently creating the mount point
  # would write the "backup" onto the internal disk, which is the exact failure
  # this script exists to prevent.
  #
  # The per-instance subdirectory under it is a different matter — that one is
  # ours to create, and its absence just means this instance has not pushed
  # before.
  [ -d "${DEST_ROOT}" ] \
    || die "destination directory does not exist: ${DEST_ROOT} (external disk not mounted?)"
  [ -w "${DEST_ROOT}" ] \
    || die "destination is not writable: ${DEST_ROOT}"

  # Refuse a destination inside the repo, or anywhere under the data directory.
  # That is not off-host by any definition, and it would be an easy thing to
  # configure by accident and never notice.
  #
  # Checked against the ROOT, and before the mkdir below, so a rejected
  # destination does not leave a stray instance directory behind on the way out.
  local resolved
  resolved="$(cd -- "${DEST_ROOT}" && pwd -P)"
  case "${resolved}/" in
    "${REPO_ROOT}"/*)
      die "destination ${resolved} is inside the repository — that is the same disk as the graph, which is the thing this guards against" ;;
  esac

  mkdir -p "${LOREFOLD_OFFHOST_DEST}" \
    || die "could not create the per-instance destination: ${LOREFOLD_OFFHOST_DEST}"
}

newest() { ls -1t $1 2>/dev/null | head -1 || true; }

copy_one() {
  local src="$1" label="$2"
  [ -n "${src}" ] || { log "WARNING: no ${label} to copy — run ops/backup/backup.sh first"; return 0; }
  [ -s "${src}" ] || { log "WARNING: ${label} $(basename "${src}") is empty; not copying"; return 0; }

  if is_rclone; then
    log "copying ${label} $(basename "${src}") → $(rclone_remote)"
    rclone copy --checksum -- "${src}" "$(rclone_remote)" \
      || die "rclone copy failed for ${src}"
  else
    # Write through a temp name in the destination, then rename, so an
    # interrupted copy never leaves a truncated file that looks like a backup.
    local base tmp
    base="$(basename "${src}")"
    tmp="${LOREFOLD_OFFHOST_DEST}/.${base}.partial"
    log "copying ${label} ${base} → ${LOREFOLD_OFFHOST_DEST}"
    rm -f -- "${tmp}"
    cp -- "${src}" "${tmp}" || { rm -f -- "${tmp}"; die "copy failed for ${src}"; }
    mv -f -- "${tmp}" "${LOREFOLD_OFFHOST_DEST}/${base}"
  fi
}

prune_dest() {
  is_rclone && return 0
  local glob="$1" keep="$2" f count=0
  while IFS= read -r f; do
    count=$((count + 1))
    if [ "${count}" -gt "${keep}" ]; then
      log "pruning $(basename "${f}") at destination"
      rm -f -- "${f}"
    fi
  done < <(ls -1t ${glob} 2>/dev/null || true)
}

do_push() {
  require_dest
  check_dest
  copy_one "$(newest "${DATA_DIR}/datascript/backup-*.edn")"                       "hot export"
  copy_one "$(newest "${ARCHIVE_DIR}/athens-data-${LOREFOLD_INSTANCE}-*.tar.gz")"  "cold archive"
  prune_dest "${LOREFOLD_OFFHOST_DEST}/backup-*.edn"                               "${OFFHOST_KEEP}"
  prune_dest "${LOREFOLD_OFFHOST_DEST}/athens-data-*.tar.gz"                       "${OFFHOST_KEEP}"
  log "off-host push complete → ${LOREFOLD_OFFHOST_DEST}"
}

do_verify() {
  require_dest
  echo "instance    : ${LOREFOLD_INSTANCE}"
  echo "env file    : ${ENV_FILE}"
  echo "destination : ${LOREFOLD_OFFHOST_DEST}"
  echo

  if is_rclone; then
    rclone lsl "$(rclone_remote)" 2>/dev/null || echo "  (cannot list remote)"
    echo
    echo "Reminder: a backup you have never restored is not a backup."
    echo "See ops/backup/restore.md."
    return 0
  fi

  if [ ! -d "${LOREFOLD_OFFHOST_DEST}" ]; then
    if [ -d "${DEST_ROOT}" ]; then
      echo "  destination root ${DEST_ROOT} is present, but this instance has never pushed."
      echo "  You have no off-host copy of the '${LOREFOLD_INSTANCE}' graph."
    else
      echo "  DESTINATION NOT PRESENT — external disk unplugged? You have no off-host copy."
    fi
    return 0
  fi

  ls -lh "${LOREFOLD_OFFHOST_DEST}"/backup-*.edn 2>/dev/null || echo "  no hot exports at destination"
  ls -lh "${LOREFOLD_OFFHOST_DEST}"/athens-data-*.tar.gz 2>/dev/null || echo "  no cold archives at destination"
  echo

  local latest age_days mtime
  latest="$(newest "${LOREFOLD_OFFHOST_DEST}/backup-*.edn")"
  if [ -n "${latest}" ]; then
    # BSD stat (macOS) is `-f %m`; GNU stat is `-c %Y`. Do NOT chain these with
    # `||` — GNU's `-f` means --file-system and *succeeds*, printing "File: ...",
    # so the fallback never fires and the arithmetic below then dies on a
    # non-numeric value. Take the result only if it is actually a number.
    mtime="$(stat -f %m -- "${latest}" 2>/dev/null || true)"
    case "${mtime}" in ''|*[!0-9]*) mtime="$(stat -c %Y -- "${latest}" 2>/dev/null || true)" ;; esac
    case "${mtime}" in ''|*[!0-9]*) mtime="" ;; esac

    if [ -n "${mtime}" ]; then
      age_days=$(( ( $(date +%s) - mtime ) / 86400 ))
      echo "newest off-host export: $(basename "${latest}") — ${age_days} day(s) old"
      if [ "${age_days}" -gt 2 ]; then
        echo "  WARNING: that is stale. Is the nightly job running, and the disk mounted?"
      fi
    else
      echo "newest off-host export: $(basename "${latest}") — age unknown (stat not understood)"
    fi
  else
    echo "newest off-host export: NONE — you have no off-host copy"
  fi
  echo
  echo "Reminder: a backup you have never restored is not a backup."
  echo "See ops/backup/restore.md."
}

usage() { sed -n '3,38p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

case "${1:-push}" in
  push)   do_push ;;
  verify) do_verify ;;
  -h|--help|help) usage ;;
  *) usage; exit 2 ;;
esac
