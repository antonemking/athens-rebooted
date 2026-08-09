# M0 kickoff prompt (for a fresh agent session)

Precondition for the operator: merge `claude/athens-codebase-review-zdm711` into `main` first (it is docs/planning only — REBOOT.md, AGENTS.md, BACKLOG.md, CSV, this file — zero code changes), so the session starts with the guides present. Fill in the `TZ` placeholder before pasting.

---

**GOAL:** Execute Milestone M0 ("Resurrect") for Lorefold: get the pinned Athens stack running from the published Docker images with the REST API enabled, write the runbook and backup tooling, and prove it with the machine-verifiable checks below. Zero compilation — this milestone touches `ops/` and docs only.

**Read first, in this order:** `AGENTS.md` (guardrails and traps — binding), `BACKLOG.md` Epic B (LF-3 through LF-8 — the task specs), `REBOOT.md` section 8 "M0: Resurrect" (context). Those files are the spec; this prompt is the mission order. If `AGENTS.md` is missing from the repo root, you are on the wrong branch: fetch and merge `claude/athens-codebase-review-zdm711` before doing anything.

**Scope — exactly four tasks plus verification:**
1. **LF-3** `ops/compose.m0.yml`: pinned images, nginx service dropped, Fluree not exposed, `CONFIG_EDN` with password + `:feature-flags {:api true}`, `TZ` set. Leave the original `docker-compose.yml` untouched.
2. **LF-4** `ops/.env.example` documenting `CONFIG_EDN` and `TZ` (placeholders only); add `.env` to `.gitignore`; explain the EDN-in-YAML quoting trap inline.
3. **LF-5** `ops/RUNBOOK.md`: boot + health check, browser connect flow (the jar serves the SPA at `:3010`), the prefilled-URL form (`graph-name`/`graph-url`/`graph-password` base64), which Settings feature flags to enable (tasks, properties, queries, comments, notifications — shipped but flagged off), the REST smoke test, backup/restore pointers, and a **human verification checklist** at the end (see below).
4. **LF-6** `ops/backup/backup.sh` + `ops/backup/restore.md`: hot logical export via the save CLI inside the container (`java -cp athens-lan-party-standalone.jar clojure.main -m athens.self-hosted.save-load save -a http://fluree:8090 -f /srv/athens/datascript/backup-$(date +%F).edn`), weekly cold tar of `athens-data/` around stop/start, rotation, and the restore procedure including the "restart fluree after ledger delete" caveat. State plainly that the DataScript snapshot alone is NOT a backup and `:in-memory? true` persists nothing.

**Out of scope — do not touch:** the rename epic, the MCP bridge, anything in `src/`, `package.json`/`deps.edn`, the original `docker-compose.yml`, and everything in Epics D-G. Do not "improve" anything beyond the four tasks.

**Hard constraints (violating any one is failure):**
- Pin `ghcr.io/athensresearch/athens:v2.1.0-beta.5` and `fluree/ledger:1.0.0-beta17`. Never `:latest`.
- `CONFIG_EDN` in single-quoted YAML so the inner EDN double quotes survive: `CONFIG_EDN: '{:password "CHANGE-ME" :feature-flags {:api true}}'`. Verify survival with `docker compose config`.
- Never add `:nrepl` to any config — it is an unauthenticated remote REPL.
- Do not publish Fluree's port 8090 to the host — it has no auth.
- Never set `:in-memory? true` — it silently disables all durability.
- Set `TZ` to `[FILL_IN e.g. America/New_York]` so `@today` and daily-page titles match local time.
- No real secrets in git: `.env` is gitignored; only `CHANGE-ME` placeholders get committed.

**Verification protocol** (run everything your environment allows; report the rest as pending — never fake a result):
1. `docker compose -f ops/compose.m0.yml config` parses; `CONFIG_EDN` quotes intact; no 8090 published; no `:nrepl` anywhere.
2. `docker compose -f ops/compose.m0.yml up -d` → both services reach healthy; `curl -f localhost:3010/health-check` returns ok. (Fluree beta17 is slow on first boot; allow ~2-3 minutes.)
3. `GET http://localhost:3010/` returns the SPA HTML (look for `js/compiled`).
4. REST write then read: `curl -u claude:CHANGE-ME -H "Content-Type: application/json" -X POST localhost:3010/api/path/write -d '{"path":[{"page/query":"@today"}],"data":[{"block/string":"M0 smoke test"}]}'` → a subsequent `/api/path/read` of `@today` returns the block.
5. `docker compose -f ops/compose.m0.yml restart athens` → after healthy, the read still returns the block (snapshot + event replay works).
6. Run `ops/backup/backup.sh` → a non-empty EDN backup file appears under `athens-data/`.
7. Negative checks: `/api/*` without credentials is rejected; a wrong password is rejected.

Checks that need a human (leave as the checklist at the end of RUNBOOK.md, do not attempt): two browsers editing one graph with live presence avatars; a curl write appearing live in an open browser; the Settings feature-flag walkthrough.

**If Docker or registry pulls are unavailable in your environment:** still create all four deliverables, pass check 1, and mark 2-7 as pending in your final report with the exact commands the operator should run. Do not simulate or fabricate runtime results.

**Deliverables:** the four items committed with clear messages and pushed. A final report stating exactly which checks passed and which are pending, plus anything you observed that contradicts `REBOOT.md`/`BACKLOG.md` — if you find a contradiction, update the doc with evidence and say so prominently rather than building on the broken premise (per `AGENTS.md`).
