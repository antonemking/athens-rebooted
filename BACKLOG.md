# Lorefold backlog

Execution breakdown of the roadmap in `REBOOT.md` section 8. Ground rules for agents are in `AGENTS.md` — read that first.

**Order:** Rename → M0 → M2a → Decision layer v0 → *(decision gate)* → M1 → M1.5 → M2b.

The gate is deliberate: M0, M2a, and the decision-layer v0 together prove the thesis using published Docker images with no compilation. The test is not note capture; it is decision intelligence. Two weeks of recording real engagement decisions with evidence links, then the question: does "why did we decide X," answered from the graph, beat memory and Slack search? If not, stop there and keep it as a free internal tool. M1 onward is only worth paying for if the gate passes.

**[HUMAN]** marks tasks needing a person — real infrastructure, secrets, a domain, or two browsers side by side. Everything else is agent-executable.

Effort points: 1 ≈ 1h, 2 ≈ 2-3h, 3 ≈ 4-6h, 5 ≈ 8h, 8 ≈ 12h+.

---

## Epic A: Rename to Lorefold

### LF-1 · Rename to Lorefold across documentation · 2
Brand-level rename only. Update `REBOOT.md`, `doc/`, and any user-facing strings that name the project.

**Do not** rename `athens.*` namespaces, `:block/*` attributes, the `athens/*` property-key convention, or `[[athens/task]]` type strings — see `AGENTS.md` guardrail 1.

*Acceptance:* no user-facing doc calls the project Athens except where describing provenance; `clojure -X:test :excludes '[:fluree]'` still green; no source namespace renamed.

### LF-2 · Replace README.md · 2
The current README opens with upstream's "no longer maintained" banner. Replace with Lorefold framing: what it is, quickstart pointing at `ops/`, link to `REBOOT.md`, and an explicit provenance line ("built on the open-source Athens project, YC W21") plus EPL-1.0 notice.
*Depends on LF-1.*

*Acceptance:* README describes Lorefold, retains Athens attribution and license, links the runbook and the review.

---

## Epic B: M0 — Resurrect (running system, zero compilation)

### LF-3 · Add `ops/compose.m0.yml` with pinned images · 2
Pin `ghcr.io/athensresearch/athens:v2.1.0-beta.5` and `fluree/ledger:1.0.0-beta17` (both verified still pullable). Drop the nginx service. Do not publish Fluree's 8090. Drop the obsolete `version:` key. Leave the original `docker-compose.yml` untouched.

Set `CONFIG_EDN` with single-quoted YAML so the inner EDN double quotes survive: `CONFIG_EDN: '{:password "..." :feature-flags {:api true}}'`. Set `TZ` so `@today` matches local time. Never add `:nrepl`.

*Acceptance:* `docker compose -f ops/compose.m0.yml config` parses and shows `CONFIG_EDN` intact with quotes; no port 8090 published; no `:nrepl` anywhere.

### LF-4 · Add `ops/.env.example` · 1
Document `CONFIG_EDN`, `TZ`, and the eventual domain var. Add `.env` to `.gitignore`. Explain the EDN-in-YAML quoting trap inline.
*Depends on LF-3.*

*Acceptance:* `.env.example` committed with no real secrets; `.env` gitignored.

### LF-5 · Write `ops/RUNBOOK.md` · 3
Covers: boot and health check (`curl :3010/health-check`); the browser connect flow (the published jar serves the SPA at `:3010` — verified); the prefilled URL form using `graph-name` / `graph-url` / `graph-password` (base64); which Settings feature flags to enable (tasks, properties, queries, comments, notifications — all shipped but flagged off); and the REST smoke test:

```
curl -u claude:PW -H "Content-Type: application/json" -X POST :3010/api/path/write \
  -d '{"path":[{"page/query":"@today"}],"data":[{"block/string":"hello"}]}'
```

*Acceptance:* a reader who has never seen the project can go from clone to a working graph using only this file.

### LF-6 · Add `ops/backup/backup.sh` and `restore.md` · 3
Hot logical export using the save CLI bundled in the image, run inside the container, writing to the mounted volume. Weekly cold tar of `athens-data/` around a stop/start. Rotation. Restore procedure must include the "restart fluree after ledger delete" caveat from `save_load.clj`.

State plainly in `restore.md` that the DataScript snapshot alone is **not** a backup (boot = snapshot + event replay), and that `:in-memory? true` persists nothing.

*Acceptance:* `backup.sh` is idempotent and safe to cron; `restore.md` documents a full round trip.

### LF-7 · [HUMAN] Verify the M0 stack · 2
Two browsers editing one graph live with presence avatars; `docker compose restart athens` and data survives; the curl write from LF-5 appears live in both browsers; backup produces non-empty EDN.
*Depends on LF-3, LF-5, LF-6.*

### LF-8 · [HUMAN] Decide deployment target · 1
Local only, VPS, or Tailscale-only. Determines whether TLS (LF-20, LF-22) gets pulled forward. Record the decision in `ops/RUNBOOK.md`.

---

## Epic C: M2a — MCP bridge v0 (no server changes)

Uses only the REST API that already exists. This is the differentiator and it needs nothing compiled.

### LF-9 · Scaffold `tools/lorefold-mcp/` · 2
TypeScript, `@modelcontextprotocol/sdk`, stdio transport. Config strictly from env: `LOREFOLD_URL`, `LOREFOLD_USERNAME`, `LOREFOLD_PASSWORD`. Package.json, tsconfig, build script, README with the `claude mcp add` line.

*Acceptance:* `npm run build` produces a server that starts, advertises zero tools, and exits cleanly.

### LF-10 · Implement the REST client module · 3
Wraps `POST /api/path/read` and `/api/path/write` with HTTP Basic auth. Owns the JSON key mapping in exactly one place: muuntaja emits namespaced keywords as `"page/title"`-style strings. Typed errors surfacing the server's rejection reason.
*Depends on LF-9.*

*Acceptance:* unit tests cover key mapping both directions and auth header construction.

### LF-11 · Implement the markdown ↔ internal-representation codec · 3
Indented `- ` lists ↔ `:block/string` / `:block/children`. Rendering IR to a markdown outline for agent consumption is the primary direction.

Be explicit in code comments about what this does **not** do: it is not a general markdown parser, and it must not be reused to round-trip arbitrary files (see `AGENTS.md`).
*Depends on LF-9.*

*Acceptance:* round-trip tests over nested outlines; documented lossy cases.

### LF-12 · Implement the daily-note date helper · 1
Title format `LLLL dd, yyyy` with **zero-padded day** ("August 09, 2026"). Must agree with the server's timezone, so read `TZ` and document the coupling. Getting this wrong silently creates duplicate daily pages.
*Depends on LF-9.*

*Acceptance:* tests over single-digit days, month boundaries, and an explicit non-local TZ.

### LF-13 · Implement v0 MCP tools · 5
`lorefold_daily_append`, `lorefold_page_read` (IR plus rendered markdown), `lorefold_page_write` (path upsert), `lorefold_page_create`. Zod schemas, useful descriptions, errors that tell the model what to fix.

Writes are attributed via the Basic-auth username, so they appear as a named collaborator in open clients.
*Depends on LF-10, LF-11, LF-12.*

*Acceptance:* every tool has a schema and a happy-path test against a mocked client.

### LF-14 · Unit tests for the bridge · 2
Vitest over codec, dates, and client. No live server required.
*Depends on LF-13.*

### LF-15 · [HUMAN] Register and validate end to end · 2
`claude mcp add` against the running M0 stack. Claude appends to today's daily note; it appears live in an open browser attributed to the bot user; a page reads back as markdown.
*Depends on LF-7, LF-13.*

*(The decision gate follows Epic D, once decision records are in live use.)*

---

## Epic D: Decision layer v0 (the differentiator; runs on the M0 stack)

What separates Lorefold from a notes tool. Sequenced before the gate because none of it needs compilation.

### LF-35 · [HUMAN] Architecture decision: where evidence lives · 3
The decision-intelligence reframe makes three known weaknesses product-critical: every client receives the whole graph on connect, there is no permissions model, and search is an in-browser scan. Agent drafts the spike document; the owner makes the call. Recommended default: evidence does **not** live in the graph — the graph holds decision objects plus links (source-system URLs at first, an evidence store later).

*Acceptance:* written decision in `doc/` covering evidence placement, the per-client isolation boundary, and the minimum auth bar before any client data is referenced.

### LF-36 · Spike: ingestion adopt vs build · 3
Continuous ingestion of GitHub/Slack/Drive/docs means auth, pagination, rate limits, incremental sync, and permission mapping, times four. Evaluate adopting an OSS layer as the evidence store, with Lorefold owning only the decision ledger. Candidates, hands-on: **Semantica** (`semantica-agi/semantica`, MIT, `pip` framework: context graphs, entity resolution, W3C PROV-O provenance, large connector surface incl. Drive/Git/Postgres/Kafka, ships its own MCP server; note its "decision intelligence" records *AI-agent* decisions, not human organizational ones) and **Onyx/Danswer**-class enterprise search. Criteria: connector coverage, self-hostability, per-client isolation, license compatibility, citation/permalink support, maintenance burden, project maturity/bus factor (Semantica is young and fast-moving; evaluate only the canonical repo — search results include multiple clone/SEO mirrors).

*Acceptance:* written adopt-or-build recommendation in `doc/`, which must explicitly answer two questions with evidence: (1) could Semantica serve as Lorefold's evidence/context layer, and (2) does anything in it (or its trajectory) invalidate building the human decision ledger on the Athens substrate. No code.

### LF-37 · Spec the decision object model · 3
`:entity/type "[[lorefold/decision]]"` plus properties: status (proposed / accepted / superseded / reversed), date, question, rationale, alternatives considered, participants, evidence links, supersedes / superseded-by. Rides the existing `:block/property-of` + `:block/key` model with zero schema migration; the append-only log already records each decision's evolution. Include worked internal-representation examples and the datalog for "why did we decide X" and "what decisions touch Y". Follow the `[[athens/task]]` string convention. Study Semantica's decision API shapes (`record_decision`, `trace_decision_chain`, `find_similar_decisions`) as prior art — different decision object (AI outputs vs human choices), useful precedent for causal links and precedent search.

*Acceptance:* spec committed to `doc/`; examples validate against `internal-representation->atomic-ops` in a REPL or test.

### LF-38 · Implement `lorefold_decision_record` MCP tool · 2
Creates a decision object via `/api/path/write` per the LF-37 spec, evidence as URLs (Slack permalinks, PR links). Zero connectors, zero new infrastructure; ingestion is an optimization on capture, not the thesis. Include a `lorefold_decisions` read tool listing decisions by status/date via path reads (server-side query endpoints arrive in Epic G).
*Depends on LF-13, LF-37.*

*Acceptance:* a decision recorded end-to-end from Claude, visible in the UI with properties and evidence links.

**← Decision gate. Two weeks of live decision-recording on a real engagement before starting Epic E.**

---

## Epic E: M1 — Own the build

### LF-16 · Strip the PostHog snippet · 1
`resources/public/index.html` ships a live analytics key that phones home on every load. Remove it. Sentry needs no action (its DSN goog-define defaults to empty in source builds).

*Acceptance:* no third-party analytics in the served HTML; app still boots.

### LF-17 · Remove dead dependencies · 1
`highlight.js`, `react-highlight.js`, `codemirror`, `react-codemirror2` — all pinned, none imported. Remove from `package.json`, refresh the lockfile, and delete the reader-discarded CodeMirror sketch in `parse_renderer.cljs`.

Note: this does not change behavior. Code blocks already render unstyled.

*Acceptance:* build succeeds; karma tests pass; bundle no smaller than expected is fine, correctness is the point.

### LF-18 · Build the server from source on temurin 17 · 5
`clojure -P`, AOT compile `athens.self-hosted.core`, uberjar via `:uberdeps`. Temurin 17 is the JDK the original CI proved; try 21 opportunistically but do not block on it.

Primary risk is resolving `com.fluree/db 1.0.0-rc33` from Clojars. **The moment resolution succeeds, vendor the entire `~/.m2/repository` as a tarball** and document how builds consume it. That insurance is required even if Clojars works, because the artifact is an abandoned release candidate.

Document every breakpoint hit, in order.

*Acceptance:* a jar that boots against a running Fluree; vendored m2 archived; breakpoints written up in `ops/RUNBOOK.md`.

### LF-19 · Build the frontend from source · 3
`node:16-bullseye` plus temurin 17 (shadow-cljs runs on the JVM and resolves `deps.edn`). `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, then `yarn components && shadow-cljs release app`. Never `yarn prod`.
*Depends on LF-16, LF-17.*

*Acceptance:* a static SPA bundle built from source with no telemetry.

### LF-20 · Add `ops/Dockerfile` and `ops/compose.yml` · 5
Three stages: frontend → server build → temurin-17-JRE runtime. Copy the built SPA into `resources/public` **before** the uberjar step, mirroring the original CI order that baked the client into the jar. Compose adds Caddy 2 for TLS; the client derives `wss://` from `https://` automatically.

Auth layering rule: the graph password guards `/ws`, Athens Basic auth guards `/api/*`. Any Caddy `basic_auth` must be scoped away from both, since there is only one `Authorization` header.
*Depends on LF-18, LF-19.*

*Acceptance:* `docker compose -f ops/compose.yml up --build` yields a working stack from a clean clone.

### LF-21 · Rewrite CI · 3
New `.github/workflows/ci.yml`: clj-kondo pinned at the version the repo was clean against (a modern kondo drowns you in new findings), `clojure -X:test :excludes '[:fluree]'`, and an image build on tags and main. Drop the style and carve jobs. Disable or delete the inherited `build.yml`, which is unrunnable.

*Acceptance:* green on a no-op PR; image pushed on tag.

### LF-22 · [HUMAN] Domain, DNS, TLS, secrets · 2
Register/point the domain, let Caddy issue certs, add GitHub Actions secrets.
*Depends on LF-8, LF-20.*

### LF-23 · Clean-machine build verification · 2
Fresh clone on a machine with only Docker → `up --build` → view-source shows no PostHog → two-browser RTC over TLS → REST smoke over TLS → test-restore of a backup into a scratch stack.
*Depends on LF-20, LF-21, LF-22.*

---

## Epic F: M1.5 — Replace Fluree with SQLite

Kills a container, kills the scariest build dependency, and reduces backup to copying one file.

### LF-24 · Implement the SQLite event log · 5
New namespace behind the verified four-function seam: `init!`, `add-event!` (idempotent insert, preserving the existing double-write tolerance), `events` (ordered scan with `:since-event-id`), `last-event-id`. Schema `(event_order INTEGER PRIMARY KEY, event_id TEXT UNIQUE, data TEXT)`, WAL mode. Config switch `:event-log {:backend :sqlite :path ...}`.

The existing single-writer lock in `web/datascript.clj` already serializes appends; do not add another.

*Acceptance:* implements the seam with no caller changes outside config wiring.

### LF-25 · Contract tests for the SQLite backend · 3
Mirror the cases in `event_log_test.clj`, including idempotent double-write and ordered replay from a mid-log event id.
*Depends on LF-24.*

### LF-26 · Migration tool · 3
The old stack's save CLI emits exactly the `(uuid, EDN-string)` pairs the new interface needs. Write the loader, with a verification pass comparing event counts and the final graph state.
*Depends on LF-24.*

### LF-27 · Remove Fluree entirely · 3
Delete the Fluree namespaces, drop `com.fluree/db` from `deps.edn`, remove the service from compose, remove the fluree test exclusion from CI (it exists only because those tests hang).
*Depends on LF-25, LF-26.*

*Acceptance:* no Fluree reference in the runtime path; `clojure -X:test` green with no exclusions; two-container stack.

### LF-28 · [HUMAN] Migrate real data · 2
Export from the running Fluree stack, import to SQLite, verify page counts and spot-check content, keep the old volume until confident.
*Depends on LF-26, LF-27.*

---

## Epic G: M2b — Full agent toolset

### LF-29 · Add read endpoints to `api.clj` · 5
`/api/pages` (`get-all-pages`), `/api/search` (linear scan plus `breadcrumb-string` and owning page), `/api/backlinks` (`get-linked-refs-by-page-title`). Same feature flag, same Basic auth, each 10-25 lines reusing verified `common_db` helpers.

Search ships as a scan; the FTS5 upgrade rides on LF-24's SQLite and is a separate follow-up.

*Acceptance:* each endpoint returns JSON and EDN; documented with curl examples in the file's comment block, matching existing convention.

### LF-29b · Fix two api.clj defects found while building the bridge · 1
Both confirmed against source during the M2a review; fold into the LF-29 work rather than a separate pass.

1. **`"data":[]` crashes the request.** `write-in-path-evt` (`src/clj/athens/self_hosted/web/api.clj:140-141`) does `(throw (ex-info "No data to write" data))` where `data` is a *vector*. `ex-info` requires a map for ex-data, so the intended error becomes a ClassCastException. Fix: `{:data data}`. Add a test — this is the API's first.
2. **`relation` is unreachable over JSON.** It must arrive as a Clojure keyword; a JSON string fails malli validation with a 500 "Invalid event". Either coerce strings to keywords at the API boundary or document the field as EDN-only. Until then every REST write appends last, which the MCP bridge relies on.

Also consider: there is no exception middleware, so any rejected request surfaces as a 500 carrying the thrown message. That text is genuinely the most useful part of the response, so if you add middleware, preserve it.

*Acceptance:* `"data":[]` returns a clean 400-class error with a readable message; a decision is made and documented on `relation`.

### LF-30 · Add write endpoints to `api.clj` · 3
`/api/block/save` and `/api/block/remove` via `build-block-save-op` / `build-block-remove-op`. These exist because path-write can only append — writing an existing uid through it resolves to a *move*.
*Depends on LF-29.*

### LF-31 · Add `/api/export` · 2
All pages as internal representation, for a real exit path. There is currently no export of any kind, which is a prerequisite for trusting the tool with irreplaceable notes.
*Depends on LF-29.*

### LF-32 · First tests for `api.clj` · 3
The API has never had a test. Op-shape unit tests plus round-trip integration against `:in-memory? true`, which skips Fluree entirely and is ideal for tests.
*Depends on LF-29, LF-30, LF-31.*

### LF-33 · MCP v1 tools · 5
`lorefold_search`, `lorefold_backlinks`, `lorefold_pages`, `lorefold_block_edit`, `lorefold_tasks`, `lorefold_export`. Tasks are blocks carrying properties keyed by pages titled `":task/status"` and friends.
*Depends on LF-30, LF-31, LF-13.*

### LF-34 · [HUMAN] Validate the agent toolset · 2
Claude answers "what links to [[Client X]]?" and "what tasks are open?" correctly; export markdown matches the UI.
*Depends on LF-33.*

---

## Deliberately not scheduled

Parked with reasons in `REBOOT.md` (sections 5, 7, 11): CRDT conflict resolution, mobile client, real user accounts and permissions, image upload for web, reference-list virtualization, the GitHub docs integration, and any frontend framework upgrade.
