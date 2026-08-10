# Running Lorefold M0 on a Mac

Setup for hosting the customer-1 (Lorewood Labs) workspace on a macOS machine,
per the LF-8 deployment decision in [`../RUNBOOK.md` §15](../RUNBOOK.md): reachable
over the tailnet, never on a public interface, with an off-host backup copy.

Everything here assumes you have already done a first boot by hand following
[`../RUNBOOK.md`](../RUNBOOK.md) §3–§9. This directory is about keeping it up
without you thinking about it.

## Read this before you start

**Your Mac must be Intel.** `fluree/ledger:1.0.0-beta17` is published amd64-only.
On Apple Silicon it runs under emulation and every write fails — the stack looks
healthy, reads work, and nothing you record is saved. See
[`../RUNBOOK.md` §13](../RUNBOOK.md) and `../../doc/lf38-verification.md`.

```bash
sysctl -n machdep.cpu.brand_string    # want "Intel(R) Core(TM)...", not "Apple M..."
```

Check this and not `uname -m`, which reports `x86_64` under Rosetta even on
Apple Silicon.

**A laptop is not a server, and this setup does not pretend otherwise.** With
the lid closed it sleeps, and a sleeping host means recording fails at the
moment you try to record. That is survivable for a two-week validation window
where you are recording from that same machine. It is not a foundation for a
client workspace, which needs M1 and a separate instance anyway.

## What gets installed

| File | Does |
|---|---|
| `lorefold-up.sh` | Waits for the Docker daemon, then brings the stack up and waits for health |
| `lorefold-backup.sh` | Nightly: hot export, cold archive on Sundays, off-host push, verify |
| `com.lorewood.lorefold.stack.plist` | LaunchAgent — runs `lorefold-up.sh` at login |
| `com.lorewood.lorefold.backup.plist` | LaunchAgent — runs `lorefold-backup.sh` at 02:30 |
| `../backup/offhost.sh` | Copies the newest export off this disk |

## 1. Docker Desktop

Install the **Intel** build. Then, in Settings:

- **General → Start Docker Desktop when you sign in.** The login agent waits up
  to five minutes for the daemon, but it cannot start Docker itself.
- **Resources → Memory: at least 6 GB.** The server JVM alone is configured
  `-Xmx2560m`, and Fluree runs beside it in the same VM. Docker's default
  allocation on an older install can be 2 GB, which will have the JVM killed
  under load with `OnOutOfMemoryError` and no obvious cause.

## 2. Tailscale, and the bind address

Install Tailscale and sign in, then:

```bash
tailscale ip -4        # e.g. 100.92.14.3 — stable for this device
```

Put that address in `ops/.env`:

```
ATHENS_BIND_ADDR=100.92.14.3
```

This is the whole security posture of M0. There is no TLS and one shared
password, so the tailnet is what supplies encryption in transit and device-level
access control. Binding to `0.0.0.0` on a café network publishes a
read-write-everything graph to that network.

Two consequences worth knowing:

- `curl 127.0.0.1:3010` no longer works — use the tailnet address. The scripts
  here read `ATHENS_BIND_ADDR` and check the right interface.
- Point the MCP bridge at the same address: `LOREFOLD_URL=http://100.92.14.3:3010`.

## 3. Off-host backup destination

`ops/backup/backup.sh` writes under `athens-data/` and `ops/backup/archives/`,
both on the same disk as the graph. That is not a backup. Set a destination in
`ops/.env`:

```
# An external disk, or any always-mounted path that is not this disk:
LOREFOLD_OFFHOST_DEST=/Volumes/Backup/lorefold

# Or object storage via rclone (configure the remote first with `rclone config`):
# LOREFOLD_OFFHOST_DEST=rclone:b2-lorefold:lorefold/backups
```

If you use storage you do not control, put an `rclone crypt` remote in front of
it. The export is your entire decision ledger in plain EDN.

`offhost.sh` refuses to run if the destination directory is missing (an external
disk that is not plugged in) rather than quietly writing to the internal disk.

## 4. Install the agents

From the repository root:

```bash
mkdir -p ~/Library/LaunchAgents

sed "s|__REPO_ROOT__|$PWD|g" ops/macos/com.lorewood.lorefold.stack.plist \
  > ~/Library/LaunchAgents/com.lorewood.lorefold.stack.plist
sed "s|__REPO_ROOT__|$PWD|g" ops/macos/com.lorewood.lorefold.backup.plist \
  > ~/Library/LaunchAgents/com.lorewood.lorefold.backup.plist

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.lorewood.lorefold.stack.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.lorewood.lorefold.backup.plist
```

launchd does no variable expansion, which is why the paths are substituted in
rather than written as `~`.

Prove the backup job works now, rather than discovering it in a month:

```bash
launchctl kickstart -p gui/$(id -u)/com.lorewood.lorefold.backup
tail -f athens-data/logs/launchd-backup.log
```

## 5. Sleep

On power, with the lid open:

```bash
sudo pmset -c sleep 0 disksleep 0 displaysleep 10
```

That keeps the machine awake while plugged in and still blanks the screen. It
does **not** survive closing the lid — macOS sleeps on clamshell regardless
unless an external display is attached. If you need it up with the lid closed,
either attach a display or run `caffeinate -dims` in a terminal you leave open,
and know that you are fighting the hardware.

`pmset -g` shows what is actually in effect.

## 6. Verify

```bash
# stack
curl -fsS http://$(tailscale ip -4):3010/health-check && echo OK

# agents loaded, and their last exit status
launchctl print gui/$(id -u)/com.lorewood.lorefold.stack  | grep -E 'state|last exit'
launchctl print gui/$(id -u)/com.lorewood.lorefold.backup | grep -E 'state|last exit'

# backups, local and off-host
ops/backup/backup.sh verify
ops/backup/offhost.sh verify
```

Then the one that matters: **restore into a scratch stack and confirm your
decisions come back.** `../backup/restore.md` has the procedure and its sharp
edges. A backup you have never restored is not a backup.

## 7. A second instance, for a client channel

Provision it first — [`../RUNBOOK.md` §18](../RUNBOOK.md) — then give it its own
pair of agents. Both scripts take `LOREFOLD_ENV_FILE` and derive the instance,
data directory, port, archive directory and off-host subdirectory from it.

Copy each plist to a new label and add the env file to it:

```bash
INSTANCE=dave

for job in stack backup; do
  sed -e "s|__REPO_ROOT__|$PWD|g" \
      -e "s|com.lorewood.lorefold.${job}|com.lorewood.lorefold.${INSTANCE}.${job}|g" \
      -e "s|launchd-${job}.log|launchd-${INSTANCE}-${job}.log|g" \
      ops/macos/com.lorewood.lorefold.${job}.plist \
    > ~/Library/LaunchAgents/com.lorewood.lorefold.${INSTANCE}.${job}.plist
done
```

Then add this dict to each of the two new files, inside the top-level `<dict>`:

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>LOREFOLD_ENV_FILE</key>
  <string>__REPO_ROOT__/ops/dave.env</string>
</dict>
```

substituting the real repo path — launchd does no variable expansion, so a
literal `~` or `$HOME` silently fails, exactly as for `__REPO_ROOT__`. Then
`launchctl bootstrap` both, as in [section 4](#4-install-the-agents).

Three things to get right:

- **Separate log paths**, which the `sed` above handles. Two jobs writing one
  log file interleave and you cannot tell which instance failed.
- **Stagger the backup hour.** A cold archive stops the stack it is archiving;
  two jobs at 02:30 both stop *their own* stack, which is fine, but they compete
  for disk and CPU on the same machine. Change `StartCalendarInterval` in the
  copy.
- **Separate jobs, not a loop inside one.** A run that half-fails on one client
  should not mark the other client's backup failed — `launchctl print` shows one
  last-exit status per job, and a shared one tells you nothing about which graph
  is unprotected.

Verify each independently:

```bash
LOREFOLD_ENV_FILE=ops/dave.env ops/backup/backup.sh verify
LOREFOLD_ENV_FILE=ops/dave.env ops/backup/offhost.sh verify
```

Both must report `instance : dave` and paths under `dave`. If either says `m0`,
the env file is not reaching the script and you are about to back up the wrong
graph under the right-looking filename.

## Uninstall

```bash
launchctl bootout gui/$(id -u)/com.lorewood.lorefold.stack
launchctl bootout gui/$(id -u)/com.lorewood.lorefold.backup
rm ~/Library/LaunchAgents/com.lorewood.lorefold.{stack,backup}.plist
```

Per-instance agents uninstall the same way under their own labels, e.g.
`com.lorewood.lorefold.dave.stack`.

Containers keep running; stop them with
`docker compose -f ops/compose.m0.yml down`. That leaves `athens-data/` alone —
it is a host bind mount, not a Docker volume.
