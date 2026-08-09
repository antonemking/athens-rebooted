# Lorefold M0 runbook — resurrect the stack

Everything here runs on **published Docker images**. Nothing is compiled in M0.
If you have Docker and a clone of this repo, you can go from nothing to a
working, multiplayer, API-addressable graph in about ten minutes — most of it
waiting for Fluree's first boot.

Read `AGENTS.md` first if you are going to change anything. This file assumes
you only want to run it.

**Contents**

1. [What you get, and what you don't](#1-what-you-get-and-what-you-dont)
2. [Prerequisites](#2-prerequisites)
3. [First boot](#3-first-boot)
4. [Health check](#4-health-check)
5. [Connect a browser](#5-connect-a-browser)
6. [Prefilled connect URLs](#6-prefilled-connect-urls)
7. [Feature flags in Settings](#7-feature-flags-in-settings)
8. [Turn off telemetry](#8-turn-off-telemetry)
9. [REST API smoke test](#9-rest-api-smoke-test)
10. [Restart and data survival](#10-restart-and-data-survival)
11. [Backups](#11-backups)
12. [Everyday operations](#12-everyday-operations)
13. [Troubleshooting](#13-troubleshooting)
14. [Security posture](#14-security-posture)
15. [Deployment target (LF-8)](#15-deployment-target-lf-8)
16. [Human verification checklist](#16-human-verification-checklist)

---

## 1. What you get, and what you don't

Two containers:

| Service | Image | Published to host | Role |
|---|---|---|---|
| `athens` | `ghcr.io/athensresearch/athens:v2.1.0-beta.5` | `3010` | JVM server: websocket sync, REST API, and it also serves the browser app |
| `fluree` | `fluree/ledger:1.0.0-beta17` | **nothing** | append-only event log |

Both tags are pinned. Never move either to `:latest` — there is no
build-from-source in M0 to fall back to if a moving tag changes under you.

You **do** get: a real collaborative graph, live presence, event-sourced
durability, and a working REST API for agents.

You **do not** get: TLS, user accounts, roles, per-page permissions, or any
audit of who changed what beyond the presence name attached to each event.
Auth is one shared password. See [section 14](#14-security-posture).

---

## 2. Prerequisites

- Docker Engine with the Compose v2 plugin (`docker compose version`).
- ~2 GB of RAM free for the JVM (the server starts with `-Xmx2560m`).
- Ports: `3010` on the host.
- A clone of this repository. All commands below are run **from the repository
  root**, not from `ops/`.

---

## 3. First boot

```bash
cp ops/.env.example ops/.env
$EDITOR ops/.env          # set ATHENS_PASSWORD and TZ
```

Set at minimum:

- `ATHENS_PASSWORD` — a long random string. `openssl rand -base64 24` is fine.
  This one password guards both the browser websocket and the REST API.
- `TZ` — your IANA timezone, e.g. `America/New_York`. The server derives
  `@today` and daily-note titles from the container clock; leave it wrong and
  notes silently land on the wrong day.

`ops/.env` is gitignored. Never commit a real password.

Now check what compose will actually send to the container **before** you boot.
This is the single most common failure in this setup:

```bash
docker compose -f ops/compose.m0.yml config | grep -E 'CONFIG_EDN|TZ|3010|8090'
```

You must see the inner double quotes around the password, intact:

```
CONFIG_EDN: '{:password "your-password-here" :feature-flags {:api true}}'
```

If the double quotes are gone, the server cannot parse the config. See the
quoting trap in [section 13](#13-troubleshooting). You must **not** see port
`8090` published anywhere.

Boot:

```bash
docker compose -f ops/compose.m0.yml up -d
```

**Fluree's first boot is slow** — it creates the ledger from scratch and can
take two to three minutes before it reports healthy. `athens` waits on
`fluree`'s health check by design, so it will sit in `Created`/`Waiting` until
then. This is normal. Watch it:

```bash
docker compose -f ops/compose.m0.yml ps
docker compose -f ops/compose.m0.yml logs -f
```

Both services should end up `healthy`.

---

## 4. Health check

```bash
curl -f http://localhost:3010/health-check
```

Returns the literal body `ok` with HTTP 200. `-f` makes curl exit non-zero on
any other status, so this is safe to use in scripts and monitors.

This endpoint needs no authentication, on purpose — it is what the container
health check uses. It reveals nothing beyond "the server is up".

---

## 5. Connect a browser

The published jar serves the browser app itself. There is **no separate web
server and no nginx container** in this stack — the nginx service from the
upstream `docker-compose.yml` is deliberately dropped.

1. Open `http://localhost:3010` (or `http://<host-ip>:3010` from another
   machine on the LAN).
2. The app boots with no graph selected and shows the **Add Workspace** modal.
3. Fill in:
   - **Workspace name** — any label you like, e.g. `Lorefold`. Local only;
     it is what the graph is called in your own UI.
   - **Remote address** — the host and port, e.g. `localhost:3010` or
     `192.168.1.20:3010`. A bare `host:port` is fine; so is a full
     `http://host:3010`. The client derives the websocket URL from it by
     appending `/ws` (`http://` → `ws://`, `https://` → `wss://`).
   - **Password** — the `ATHENS_PASSWORD` you set in `ops/.env`.
4. Click **Join**.

When the connection is live you get a presence indicator in the toolbar with an
avatar per connected client. Each browser picks a random Greek-pantheon
username on first run; rename yourself from the presence menu →
**Edit appearance**.

The workspace is remembered in that browser's local storage, so subsequent
visits connect straight through.

---

## 6. Prefilled connect URLs

You can hand someone a URL that fills the whole form in for them. Query
parameters on the app URL:

| Param | Value |
|---|---|
| `graph-name` | workspace label |
| `graph-url` | the same value you'd type into **Remote address** |
| `graph-password` | the password, **base64-encoded** |

```
http://192.168.1.20:3010/?graph-name=Lorefold&graph-url=192.168.1.20%3A3010&graph-password=Q0hBTkdFLU1F
```

Build the base64 part with:

```bash
printf %s 'your-password-here' | base64
```

On boot the app consumes these params, adds and selects the workspace, then
rewrites the URL to strip them out of the address bar (they stay in browser
history and in whatever channel you sent them over — see below).

Two things to know:

- **Supply all three params or none.** The password is base64-decoded
  unconditionally at boot; if you pass `graph-url` without `graph-password`,
  the client decodes garbage and the connection fails with a confusing error.
- The app can generate one of these for you: presence menu →
  **Copy link to page** produces a permalink to the page you are on with the
  graph params attached. **Copy link to workspace** copies the plain address
  with no credentials in it.

**This URL contains your graph password**, base64 is not encryption, and the
password is the whole security model. Send it over a channel you'd send a
password over, and don't paste it into a public issue tracker.

---

## 7. Feature flags in Settings

There are two entirely separate sets of flags. Confusing them wastes an
afternoon.

**Server flag — `:api`.** Lives in `CONFIG_EDN`, set in
`ops/compose.m0.yml`, already on. It is the only flag the server reads. With it
off, `/api/*` does not exist at all (the routes are not registered — you get
404s, not 401s).

**Client flags — everything else.** Per-browser settings stored in that
browser's local storage. They are *not* server config, they do not propagate to
other clients, and every user has to turn them on in their own browser. Find
them under **Settings → Experimental Feature Flags**.

The features below all shipped in this build and are flagged off by default:

| Flag | What it turns on | Day-one recommendation |
|---|---|---|
| **Tasks** | `[[athens/task]]` typed blocks and the task view | **On** |
| **Properties** | typed `athens/*` key-value properties on blocks and pages | **On** — the decision object model in Epic D rides on this |
| **Queries** | in-page query blocks over the graph | **On** |
| **Comments** | inline block comments | Optional |
| **Notifications** | notification inbox, driven by comments/mentions | Optional |
| **Reactions** | emoji reactions on blocks | Optional |
| **Cover Photo** | page cover images | Optional |
| **Time Controls** | time-travel controls | Leave off |

Upstream shipped all of these as experiments and made no promise they keep
working. `REBOOT.md` section 10 leaves "which hidden feature flags on day one"
open, with the leaning that tasks/properties/queries go on and
comments/reactions/notifications stay off until they've been lived with. That
is the recommendation reflected above. Record what you actually chose here once
you've decided.

---

## 8. Turn off telemetry

The stock images still carry upstream's PostHog snippet in
`resources/public/index.html`, and the client's `monitoring` setting defaults
to **on**. On first load the browser opts into analytics capture against
`app.posthog.com`.

In each browser: **Settings → Monitoring → off**.

This is a client-side toggle over a script that is still being served. Stripping
the snippet from the build is LF-16, in M1, and it is a hard prerequisite before
any client instance exists — see `REBOOT.md` section 9.

---

## 9. REST API smoke test

The API uses HTTP Basic auth. **The username is the presence name** the write
is attributed to — it shows up in the graph as the author of the event, and it
must be non-empty. The password is `ATHENS_PASSWORD`.

Write a block to today's daily note. The path is created if it does not exist,
including today's page:

```bash
curl -f -u claude:"$ATHENS_PASSWORD" \
  -H "Content-Type: application/json" \
  -X POST http://localhost:3010/api/path/write \
  -d '{"path":[{"page/query":"@today"}],"data":[{"block/string":"M0 smoke test"}]}'
```

Read it back. **`/api/path/read` is a POST**, not a GET — the path is a JSON
body, not a URL:

```bash
curl -f -u claude:"$ATHENS_PASSWORD" \
  -H "Content-Type: application/json" \
  -X POST http://localhost:3010/api/path/read \
  -d '{"path":[{"page/query":"@today"}]}'
```

The response is the page's internal representation and should contain a block
with `"block/string": "M0 smoke test"`.

Negative checks — both must fail:

```bash
# no credentials → 401
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Content-Type: application/json" -X POST \
  http://localhost:3010/api/path/read -d '{"path":[{"page/query":"@today"}]}'

# wrong password → 401
curl -s -o /dev/null -w '%{http_code}\n' -u claude:definitely-wrong \
  -H "Content-Type: application/json" -X POST \
  http://localhost:3010/api/path/read -d '{"path":[{"page/query":"@today"}]}'
```

Notes that will save you time:

- `@today` is resolved from the **container** clock. If the block lands on the
  wrong day, your `TZ` is wrong — fix `ops/.env` and recreate the stack.
- Daily-note titles are `LLLL dd, yyyy` with a **zero-padded** day
  ("August 09, 2026"). Hand-writing an unpadded title creates a second,
  duplicate daily page.
- `/api/path/write` can only **append**. Writing an existing `:block/uid`
  through it resolves to a *move*, not an edit. Editing in place needs an
  endpoint that does not exist yet (LF-30).
- Set `-H "Content-Type: application/edn" -H "Accept: application/edn"` to
  speak EDN instead of JSON.

---

## 10. Restart and data survival

```bash
docker compose -f ops/compose.m0.yml restart athens
```

Wait for healthy, then re-run the read from section 9. The block is still
there.

That round trip is the point: boot state is a **fold over the append-only event
log**. The server writes a DataScript snapshot for fast startup, then replays
newer events from Fluree on top of it. Both halves are needed. This is why the
snapshot alone is not a backup — see `ops/backup/restore.md`.

---

## 11. Backups

Full detail, including the restore procedure and its sharp edges, is in
[`ops/backup/restore.md`](backup/restore.md). The short version:

```bash
ops/backup/backup.sh hot     # logical EDN export of the event log; safe while running
ops/backup/backup.sh cold    # stop → tar athens-data/ → start; weekly
ops/backup/backup.sh verify  # report on what exists
```

`hot` writes `athens-data/datascript/backup-YYYY-MM-DD.edn` and prunes old
ones. Cron it nightly. `cold` takes the stack down for the duration of the tar,
so schedule it weekly at a quiet hour.

Suggested crontab (adjust the path):

```cron
15 2 * * *  cd /srv/lorefold && ops/backup/backup.sh hot  >> athens-data/logs/backup.log 2>&1
40 3 * * 0  cd /srv/lorefold && ops/backup/backup.sh cold >> athens-data/logs/backup.log 2>&1
```

**A backup you have never restored is not a backup.** `restore.md` documents a
full round trip into a scratch stack; do it once before you trust this.

---

## 12. Everyday operations

```bash
# status and logs
docker compose -f ops/compose.m0.yml ps
docker compose -f ops/compose.m0.yml logs -f athens
docker compose -f ops/compose.m0.yml logs -f fluree

# stop / start without destroying anything
docker compose -f ops/compose.m0.yml stop
docker compose -f ops/compose.m0.yml start

# apply a change to compose.m0.yml or ops/.env
docker compose -f ops/compose.m0.yml up -d

# remove containers but KEEP data (data lives in ./athens-data on the host)
docker compose -f ops/compose.m0.yml down
```

`down` does not delete `athens-data/`; the volumes are host bind mounts. Do not
add `-v` to `down` unless you mean to lose the graph, and take a backup first
either way.

---

## 13. Troubleshooting

**`docker compose config` shows `CONFIG_EDN` without its inner double quotes.**
The EDN-in-YAML quoting trap. The server parses this value as EDN, where string
values must be double-quoted; YAML strips those quotes from an unquoted or
double-quoted scalar. The value in `ops/compose.m0.yml` is wrapped in **single**
quotes precisely so the inner double quotes survive. If you set `CONFIG_EDN`
directly in `ops/.env`, write it bare — no outer quotes of any kind — and keep
the inner ones:

```
CONFIG_EDN={:password "your-password" :feature-flags {:api true}}
```

Always re-run `docker compose -f ops/compose.m0.yml config | grep CONFIG_EDN`
after any edit. The rendered value is the truth.

**`athens` never starts / stays in `Waiting`.** It depends on `fluree` being
healthy. Fluree's first boot takes two to three minutes.
`docker compose -f ops/compose.m0.yml logs fluree` will show it building the
ledger. If it is still unhealthy after five minutes, check that
`athens-data/fluree` is writable by the container.

**`/api/*` returns 404.** The `:api` feature flag did not reach the server —
when it is off the routes are never registered, so you get 404 rather than 401.
Check the rendered `CONFIG_EDN`. A 401 instead means the flag is on and your
credentials are wrong.

**`/api/*` returns 401 with what you think is the right password.** The
username must be non-empty (`-u claude:PW`, not `-u :PW`). And confirm you are
using the password that actually reached the container, not the one in
`.env.example`.

**Notes land on the wrong day.** `TZ` did not reach the container, so it is
running UTC. Check `docker compose -f ops/compose.m0.yml exec athens date`.

**Browser connects, then immediately disconnects.** Wrong graph password, or
you are pointing at a host/port the browser cannot actually reach. The client
gives up after two reconnect attempts and does not keep retrying; reload the
page after fixing it.

**Out-of-memory / container killed.** The JVM is configured with `-Xmx2560m`
and `-XX:OnOutOfMemoryError="kill -9 %p"`. Heap dumps land in
`athens-data/logs/`.

**Event too large.** Under default Fluree settings the maximum recommended
event size is about 2 MB. Very large pastes can exceed it.

---

## 14. Security posture

Be honest with yourself about what this is before you point it at anything that
matters.

- **One shared password, no accounts.** No roles, no per-page permissions, no
  way to revoke one person without rotating for everyone. Anything that can
  reach `:3010` can read and write the entire graph.
- **No TLS.** M0 is plain HTTP and plain `ws://`. The password crosses the wire
  in HTTP Basic (base64, not encryption) on every API call. Caddy and TLS
  arrive in M1 (LF-20/LF-22).
- **Fluree has no auth at all** and is therefore never published to the host.
  Do not add a `ports:` entry to the `fluree` service. Publishing 8090 hands
  the raw event log to anyone who can reach the port.
- **Never add `:nrepl` to `CONFIG_EDN`.** It starts an unauthenticated remote
  REPL — arbitrary code execution on a reachable host.
- **Never set `:in-memory? true`.** It silently persists nothing.
- **Telemetry is on by default** in the stock images ([section 8](#8-turn-off-telemetry)).

Practical consequence: on an untrusted network, bind to localhost
(`ATHENS_BIND_ADDR=127.0.0.1`) and reach it over SSH or a private overlay
network rather than exposing 3010. No client data belongs on this stack until
the M1 hygiene bar is met (`REBOOT.md` section 9).

---

## 15. Deployment target (LF-8)

**Status: undecided.** Options are local-only, a VPS, or Tailscale-only. The
choice determines whether TLS work (LF-20, LF-22) gets pulled forward, and it
is weightier than it looks because Lorefold brings no permissions model of its
own — whatever hosts a workspace has to satisfy that workspace's data
expectations by itself.

Record the decision here when it is made:

```
Decision:
Date:
Rationale:
```

---

## 16. Human verification checklist

These need a person. Do not mark them off from a script — the point of each is
something only eyes on real browsers can confirm. This is LF-7.

- [ ] **Two browsers, one graph, live presence.** Connect from two different
      browsers (ideally two machines). Both avatars appear in the presence
      indicator. Typing in one appears in the other within a second, and the
      other user's cursor position is visible.
- [ ] **A curl write appears live.** With both browsers open on today's daily
      note, run the `/api/path/write` command from [section 9](#9-rest-api-smoke-test).
      The block appears in both windows without a reload, attributed to the
      username you passed to `-u`.
- [ ] **Restart preserves data.** `docker compose -f ops/compose.m0.yml restart athens`,
      wait for healthy, reload both browsers. Everything written is still
      there.
- [ ] **Feature-flag walkthrough.** In one browser, Settings → Experimental
      Feature Flags: turn on Tasks, Properties and Queries. Confirm each does
      something visible (a task block renders as a task; a property can be
      added to a page; a query block returns results). Confirm the *other*
      browser is unaffected — these are per-browser settings, not server
      config. Then decide comments/notifications and record the call in
      [section 7](#7-feature-flags-in-settings).
- [ ] **Telemetry off.** Settings → Monitoring → off in every browser that will
      be used.
- [ ] **A backup exists and is non-empty.** Run `ops/backup/backup.sh hot` and
      confirm `athens-data/datascript/backup-YYYY-MM-DD.edn` exists with a
      sane size.
- [ ] **A restore actually works.** Follow `ops/backup/restore.md` into a
      scratch stack and confirm the graph comes back. Until you have done this
      once, you do not have backups.
- [ ] **Deployment target decided** and written into
      [section 15](#15-deployment-target-lf-8).
