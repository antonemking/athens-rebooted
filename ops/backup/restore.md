# Lorefold M0 — backup and restore

Read this before you need it. There is one caveat in the restore path
(§4, step 4) that will silently waste your time if you meet it for the first
time during an incident.

---

## 1. What is actually your data

State is a **fold over an append-only event log**. Two things exist on disk, and
only one of them is authoritative:

| On disk (host) | What it is | Is it a backup? |
|---|---|---|
| `athens-data/fluree/` | the **event log** — every operation ever accepted | **Yes.** This is the source of truth. |
| `athens-data/datascript/persist/` | a DataScript **snapshot**, written periodically so boot is fast | **No.** |
| `athens-data/logs/` | JVM logs, heap dumps | No |

**The DataScript snapshot alone is NOT a backup.** Boot is
`snapshot + replay of every event newer than the snapshot`. The snapshot is a
performance optimisation, it lags the log by design, and restoring it on its own
gives you a graph that is silently missing whatever happened after it was
written. If you keep only one thing, keep the event log — the snapshot is
regenerated from it automatically.

Correspondingly: **never set `:in-memory? true`.** It persists nothing. There is
no error, no warning, and no file — every event is gone at restart. It exists
for tests.

Two backup kinds, both driven by `ops/backup/backup.sh`:

- **Hot (logical, nightly).** `backup.sh hot` runs the save CLI bundled in the
  published image, inside the athens container, against the running Fluree. It
  exports the event log as EDN — a sequence of `(event-id, event-data)` pairs —
  to `athens-data/datascript/backup-YYYY-MM-DD.edn`. Read-only against the
  ledger, so it is safe while people are working. This is the portable one: it
  is also the migration format used to leave Fluree behind in M1.5.
- **Cold (physical, weekly).** `backup.sh cold` stops the stack, tars all of
  `athens-data/` to
  `ops/backup/archives/<instance>/athens-data-<instance>-YYYY-MM-DD.tar.gz`, and
  starts it again. Restores fastest, but only onto a compatible Fluree version.

Rotation is automatic: `HOT_KEEP` (default 14) daily exports, `COLD_KEEP`
(default 8) weekly tarballs.

**More than one instance on the host?** Every command below takes
`LOREFOLD_ENV_FILE=ops/<instance>.env`, and compose needs
`--env-file ops/<instance>.env` before `-f` or it acts on the default instance
instead. The instance's data directory, archive directory and archive filenames
all carry its name; see `ops/RUNBOOK.md` §18. **Restoring the wrong graph over
a live one is the worst outcome in this document** — check `backup.sh verify`
reports the instance you mean before you move anything.

Both hot exports and the tarball are **plaintext copies of everything in the
graph**, unencrypted. Treat them exactly as you treat the graph itself; if they
leave the host, encrypt them in transit and at rest.

---

## 2. Taking backups

```bash
ops/backup/backup.sh hot      # nightly; stack must be running
ops/backup/backup.sh cold     # weekly; stops and restarts the stack
ops/backup/backup.sh verify   # what exists, and how old
```

Crontab is in `ops/RUNBOOK.md` §11. The script takes a lock in
`athens-data/.backup.lock`, so overlapping cron runs are refused rather than
racing. A hot export is written to a `.partial` file and promoted with an atomic
`mv` only after it is confirmed non-empty and starting with an EDN collection —
a failed run leaves the previous good backup in place and exits non-zero.

Off-host copies are your problem: a tarball on the same disk as the graph does
not survive the disk. Ship `athens-data/datascript/backup-*.edn` and
`ops/backup/archives/<instance>/*.tar.gz` somewhere else on whatever schedule your
deployment target (LF-8) makes possible.

---

## 3. Restore from a cold tarball (fastest)

Use when the whole host or data directory is lost and you have a tarball from a
compatible Fluree version.

```bash
# 1. Stop everything.
docker compose -f ops/compose.m0.yml down

# 2. Move the current data aside. Do NOT delete it — if the restore turns out
#    to be from the wrong date, this is the only copy of the newer events.
mv athens-data athens-data.broken.$(date +%s)

# 3. Unpack. The tarball contains a single top-level directory named after that
#    instance's data directory — athens-data/ for the default instance,
#    athens-data-dave/ for a client channel — so unpack at its PARENT, which
#    for both of those is the repository root. Check first if unsure:
#      tar -tzf <archive> | head -1
tar -xzf ops/backup/archives/m0/athens-data-m0-YYYY-MM-DD.tar.gz -C .

# 4. Boot and wait for both services to be healthy (Fluree is slow).
docker compose -f ops/compose.m0.yml up -d
docker compose -f ops/compose.m0.yml ps

# 5. Verify — see §5.
```

Everything after the tarball's timestamp is gone. If you also hold a newer hot
export, restore that instead (§4), or restore the tarball first and then load
the newer export over it.

---

## 4. Restore from a hot EDN export (authoritative)

This rebuilds the Fluree ledger by replaying every exported event. It is the
path that works across hosts, and the one that matters most.

**The whole procedure runs against a stack whose `athens` server is NOT
serving.** The loader deletes and recreates the ledger underneath the server; a
live server on top of that is a good way to corrupt what you are restoring.

```bash
# 1. Put the export somewhere the athens container can see it. The datascript
#    volume is mounted at /srv/athens/datascript, so the host path
#    athens-data/datascript/ is the easy answer — that is where backup.sh
#    already writes.
cp /wherever/backup-YYYY-MM-DD.edn athens-data/datascript/restore.edn

# 2. Bring up ONLY fluree. The loader talks to it directly; athens must not be
#    running against the ledger while it is rewritten.
docker compose -f ops/compose.m0.yml up -d fluree
docker compose -f ops/compose.m0.yml ps          # wait for healthy

# 3. Run the loader. It needs the athens image for the jar, but not the athens
#    server process — `run --rm --no-deps` gives a throwaway container that does
#    not start the server and does not pull fluree's dependency chain again.
docker compose -f ops/compose.m0.yml run --rm --no-deps athens \
  java -cp athens-lan-party-standalone.jar clojure.main \
    -m athens.self-hosted.save-load load \
    -a http://fluree:8090 \
    -f /srv/athens/datascript/restore.edn
```

### 4. THE CAVEAT: restart Fluree after a ledger delete

**If a ledger already exists**, the loader deletes it and stops, logging:

```
Deleting the current ledger before loading data....
Please restart the fluree docker.
```

**It has not loaded anything at this point.** Fluree does not fully release a
deleted ledger until it restarts. You must:

```bash
docker compose -f ops/compose.m0.yml restart fluree
docker compose -f ops/compose.m0.yml ps          # wait for healthy again
```

…and then **run the same `load` command a second time**. The second run finds no
ledger, recreates it, and actually loads the events. Skipping the restart, or
assuming the first run did the work because it exited cleanly, leaves you with
an empty graph and a very convincing sense that the restore succeeded.

On a genuinely empty data directory (a fresh host), there is no ledger to
delete, so the first run loads immediately and this caveat does not apply.

```bash
# 5. Drop the stale DataScript snapshot. It describes the OLD graph; leaving it
#    in place means boot starts from the wrong state and replays on top of it.
#    It is regenerated from the event log automatically.
rm -rf athens-data/datascript/persist

# 6. Start the full stack.
docker compose -f ops/compose.m0.yml up -d

# 7. Verify — see §5. Then remove athens-data/datascript/restore.edn.
```

### Resuming an interrupted load

A large log takes a while, and the loader prints `Processing <id> #n/total`. If
it dies partway, re-run the **same** command with `-r`:

```bash
docker compose -f ops/compose.m0.yml run --rm --no-deps athens \
  java -cp athens-lan-party-standalone.jar clojure.main \
    -m athens.self-hosted.save-load load -r \
    -a http://fluree:8090 -f /srv/athens/datascript/restore.edn
```

`-r` finds the last event already in the ledger and continues from the next one,
instead of deleting and starting over. It refuses to run — with an explanatory
warning, not a crash — if there is no ledger, if the ledger is empty, or if the
ledger's last event is not present in the export file (which means the export
and the ledger are from different lineages; do not force it, start clean).

### Recovering failed transactions

The save CLI has a third action, `recover`, which exports events from a ledger
whose transactions failed. Use it only when a normal `save` cannot read the
ledger:

```bash
docker compose -f ops/compose.m0.yml run --rm --no-deps athens \
  java -cp athens-lan-party-standalone.jar clojure.main \
    -m athens.self-hosted.save-load recover \
    -a http://fluree:8090 -f /srv/athens/datascript/recovered.edn
```

---

## 5. Verify a restore

Do not declare victory on "the container is healthy".

```bash
# 1. Server is up.
curl -f http://localhost:3010/health-check

# 2. The graph has content — read today's daily note, or a page you know
#    existed before the incident.
curl -f -u check:"$ATHENS_PASSWORD" -H "Content-Type: application/json" \
  -X POST http://localhost:3010/api/path/read \
  -d '{"path":[{"page/title":"A page you know existed"}]}'

# 3. Open a browser (ops/RUNBOOK.md §5) and look at it. Check a recent page and
#    a deep one; confirm the newest content you expect to survive is present.

# 4. Take a fresh hot export immediately and compare its size to the one you
#    restored from. Wildly smaller means the load did not complete — most
#    likely the §4 caveat.
ops/backup/backup.sh hot
ops/backup/backup.sh verify
```

---

## 6. Test the round trip before you need it

Once, on a scratch stack, with no pressure:

1. Copy the repo to a scratch directory, or set `COMPOSE_PROJECT_NAME` to
   something else and point the volumes at a scratch data directory, so you
   cannot touch production by accident.
2. Boot it, write a few blocks, note exactly what you wrote.
3. `ops/backup/backup.sh hot`.
4. `docker compose -f ops/compose.m0.yml down`, delete the scratch
   `athens-data/`, boot a bare stack.
5. Restore per §4 — including hitting the ledger-delete caveat on purpose, so
   you have seen the message with your own eyes.
6. Confirm the blocks are back, via §5.

Write the date you did this here:

```
Round trip last verified: 2026-08-09
By: antonemking (with Claude Code)
Notes: Isolated scratch stack — copy of ops/ under /tmp, project name
  lorefold-scratch, host port 3011, its own empty athens-data/. Production on
  3010 was never stopped and stayed healthy throughout.

  Source: backup.sh hot against the live stack -> backup-2026-08-09.edn,
  22547 bytes, 7 events.

  §4 on an empty ledger: loaded all 7 events on the first run, no caveat, as
  documented. Restored graph read back byte-identical to production, block
  UIDs included.

  §4 caveat reproduced deliberately: re-running load against the now-populated
  ledger printed "Deleting the current ledger before loading data...." then
  "Please restart the fluree docker." and loaded NOTHING. `restart fluree` +
  re-running the identical command loaded all 7. Recovery works as written.

  §5 step 4: fresh export from the restored stack was byte-identical to the
  source export (22547 bytes both).
```

Until that line is filled in, treat the backups as untested.

---

## 7. What M1.5 changes

Fluree goes away and is replaced with SQLite (LF-24 – LF-27). The migration path
is exactly the hot export above: the save CLI emits the `(uuid, EDN)` pairs a
small loader reads into the new event-log table. After that, a backup is one
`.db` file plus the same EDN export, the ledger-delete caveat disappears with
Fluree, and the cold tar gets much smaller. Nothing in this document's *logic*
changes — the event log is still the only thing that is really your data.
