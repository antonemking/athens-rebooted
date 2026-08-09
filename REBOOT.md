# Lorefold: Investigative Report and Reboot Plan

**Repo:** `antonemking/athens-rebooted`, a fork of `athensresearch/athens` frozen at `v2.1.0-beta.5` (HEAD `b463a97`, 2022-12-12, the final upstream commit).
**Prepared:** 2026-08-09, from a deep codebase exploration (build health, runtime architecture, product surface) plus public-record research on the company.
**Status of this document:** Investigative report and standing proposal. Positioning revised 2026-08-09: what began as "reboot Athens as a personal command center" is now **Lorefold, a decision intelligence platform**. Sections 1, 5, and 8-10 carry the reframe; the investigation sections (2-4, 6-7) stand as written. Nothing in the roadmap section has been started.

---

## 1. Executive summary

**What this is becoming.** Lorefold is a decision intelligence platform: the living memory of an organization. It connects the systems where work actually happens (GitHub, Slack, Drive, docs, code), organizes that context into a knowledge graph, and records **decisions as first-class objects linked to their evidence**. The questions it exists to answer are not "where is that document" but "why did we make this decision," "what is blocking the next release," "what are the biggest risks right now." It is not a note-taking app and not another chat interface; note capture is a surface, not the category. The archived Athens codebase is the substrate it gets built on, and the investigation below is the due diligence on that substrate.

Athens was an open-source, Roam-style networked note-taking tool (ClojureScript + DataScript frontend, Clojure JVM collaboration server) built by a YC W21 company that raised $1.9M and stopped work in November 2022. It did not die of technical failure; it died of venture economics in a brutal market, mid-pivot into a team command-center product.

The reboot verdict: **yes, it can come back, and it can run today.** The published Docker images are still pullable, and the compiled web client is baked into the server jar, so `docker compose up` with pinned tags yields a working collaborative Athens with zero compilation. The Electron desktop app is the only truly dead limb (Electron 12, retired Apple notarization path); the reboot is web-first.

The headline finding: **Athens already contains a machine API, switched off.** A REST API for path-based reads and writes (including "today's daily note" as a first-class address) sits behind a config flag, and the websocket sync protocol was explicitly designed to admit third-party and anonymous clients. The schema comments literally anticipate bots. An MCP server that lets Claude read and write the graph is a thin adapter over what exists, not a rebuild. The founder shut Athens down partly on the bet that AI would leapfrog note-taking; the stronger 2026 framing is the reverse: an event-sourced, datalog-queryable knowledge graph is the most agent-legible substrate there is, and agents are the best consumers of networked thought.

The honest counterweights: effectively no authentication (one optional shared password), zero mobile story, last-write-wins sync with real durability gaps, a fossilized event-log dependency (an abandoned Fluree beta), dead CI, and a hardcoded third-party analytics key that phones home from the served HTML.

---

## 2. Why Athens died

### 2.1 The company

- Jeff Tang started Athens in March 2020 after interviewing at Roam Research; a large open-source community formed around it (designers, PMs, veteran Clojurians).
- YC W21; raised $1.9M. Launched as the open-source, local-first Roam alternative.
- Pivoted from personal notes to "collaborative knowledge graphs for teams" (the self-hosted real-time-collaboration server, originally named "Lan-Party" in the code).
- November 2022: Tang announced the end in "Why We Stopped Working on Athens" with three reasons:
  1. Customer conversations convinced him there was no venture-scale business in note-taking / knowledge management / knowledge graphs.
  2. Tana had already implemented most of the ideas he still wanted to build.
  3. He suspected AI-native tools would leapfrog the entire note-taking paradigm.
- The repo was archived with the banner "Athens is no longer being actively maintained." The only migration path offered was a community exit tool (`bshepherdson/athens-export`) that converts graphs to a Logseq-compatible markdown directory.

Context that matters for a reboot: the tools-for-thought hype wave crested and collapsed around them. Obsidian (free, local, plugins) and Logseq (open-source outliner) took the niches Athens straddled, and Roam itself declined. The market punished a venture-scale bet; it says much less about a tool operated at consultancy scale with a different economic model.

### 2.2 What the code says (archaeology)

The commit history shows a hard stop, not a taper: **301 commits in September 2022, 61 in October, then one README edit in November and one data-file scrub in December.**

What they were building in the final six weeks is exactly a team command center on top of the graph:

- Tasks as a first-class block type (51 commits into `src/cljs/athens/types/tasks/`)
- Kanban and table queries over tasks (`src/cljs/athens/types/query/`)
- A tasks pane in the left sidebar, comment threads, an inbox-style notifications system

Every one of those features shipped behind an experimental feature flag and is still there, toggleable in Settings.

Three foundational efforts died unfinished:

1. **The offline-first sync rewrite** (`src/cljc/event_sync/`). The final substantive commit in the repository (2022-10-24) is its design FAQ, in which 8 of 12 questions are unanswered TODOs. The section on recovering from an unresponsive sync stage ends, verbatim: *"maybe do nothing, just infinite lag?"* The lead engineer stopped mid-thought on the hardest problem, and that is where the repository ends.
2. **The HTTP API** (`src/clj/athens/self_hosted/web/api.clj`). Built in a four-day sprint in late September 2022, gated off behind a feature flag, zero tests, one stray debug literal left in the source. The hard parts (path resolution, create-on-write) are done.
3. **The Storybook/TSX component strategy.** The entire justification for the TypeScript component layer (per ADR 0016) was Storybook; Storybook was deleted two days before the final release, with only two stories ever written.

Other telling artifacts: a dead experimental file that cannot compile due to a typo'd namespace (`views/jetsam.cljs` requires `blocks.eitor`); the task-assignee dropdown hardcodes the team's own first names (`["None" "Sid" "Jeff" "Stuart" "Filipe" "Alex"]`); the desktop backup docstring reads *"User should eventually have MANY backups files. It's their job to manage these backups :)"*. This was a team sprinting on product surface while the foundations were still open questions, and then the money ran out of patience.

---

## 3. State of the codebase

### 3.1 Shape and size

| Layer | Files | LOC | Notes |
|---|---|---|---|
| ClojureScript frontend (`src/cljs`) | 103 | ~16.8k | re-frame + DataScript + posh; views |
| Shared client/server (`src/cljc`) | 27 | ~5.0k | The crown jewels: schema, events, resolvers, parser |
| Clojure server (`src/clj`) | 15 | ~1.9k | http-kit + compojure; component system |
| TypeScript components (`src/js`) | 64 | ~7.6k | Chakra UI v1 presentational layer (1k of it is the theme file) |
| Tests | 36 + 10 e2e | ~7.9k | ~166 deftests, concentrated on the event/graph core |

### 3.2 Build and toolchain health

Frozen as a unit in late 2022:

- **Node 16** (`.nvmrc`), Yarn v1 lockfile, **shadow-cljs 2.19.5**, TypeScript 4.3.
- **Electron 12.2.3** (March 2021, ~31 major versions behind; electron-builder 22.x uses Apple's `altool` notarization, shut off by Apple in Nov 2023). Desktop is unrecoverable at reasonable cost and should be abandoned; web-first.
- **React 17.0.1 + Chakra UI 1.8.6 + Reagent 1.0.0 + framer-motion 6**: an atomic upgrade knot; all move together or not at all. Recommendation: rebuild as-is from lockfiles, do not upgrade.
- **Clojure 1.11.1, DataScript 1.3.10, http-kit 2.5.3**, plus **`com.fluree/db 1.0.0-rc33`** (a release candidate of an abandoned product line) and five raw-SHA git deps.
- **CI is 100% dead**: the single workflow uses `actions/upload-artifact@v2` and `download-artifact@v2` (hard-shut-off by GitHub in Jan 2025), `::set-output` (removed), and Node-runtime action versions GitHub deleted. Everything needs rewriting before CI produces anything.
- **Telemetry**: `resources/public/index.html` ships a live PostHog project key that phones home on every page load. Sentry is compiled in but inert without a DSN. The PostHog snippet must be stripped at first rebuild.
- The old CI proves the server AOT-compiles on **temurin 17**; the Brewfile says Java 11; the Dockerfile says `openjdk:16`. Three JDKs named, none current; 17 is the proven target.

**Verified still alive today:** `ghcr.io/athensresearch/athens:v2.1.0-beta.5`, `ghcr.io/athensresearch/nginx:v2.1.0-beta.5`, and `fluree/ledger:1.0.0-beta17` all still pull. And critically, the release pipeline baked the compiled SPA into the server uberjar (`release-server` ran after `build-app` and packed `resources/public`), so **the athens image alone serves the full web client at `:3010`**. Zero-build resurrection is real.

### 3.3 Runtime architecture

- **Data model** (`src/cljc/athens/common_db.cljc`): a page is just an entity with `:node/title`; blocks have `:block/uid` (9-char, immutable, the universal address), `:block/string`, `:block/children`, `:block/order`, `:block/refs`. A v2 schema adds **properties** (a block can be a property of another block under a page-title key: effectively a triple store), and a v3 schema adds **on-graph edit attribution** (every event writes `:event/auth` entities). Tasks are pure property sugar: blocks with properties keyed by pages literally titled `":task/status"`, `":task/title"`, etc.
- **Event sourcing** (`src/cljc/athens/common_events/`): the entire write vocabulary is **12 atomic operations** (`:block/new`, `:block/save`, `:block/open`, `:block/remove`, `:block/move`, `:page/new`, `:page/rename`, `:page/merge`, `:page/remove`, `:shortcut/new|remove|move`), composable into composites, validated by malli schemas, resolved to DataScript transactions by shared resolvers. ADR 0018 (Accepted) is the constitution: an append-only immutable log of deterministic operations, with a stability guarantee that ops may be added or loosened but never removed or tightened.
- **Server** (`src/clj/athens/self_hosted/`): http-kit + compojure, raw websocket at `/ws`, transit-JSON wire format, a single in-process presence registry, a global single-writer lock serializing (event-log append, DataScript transact) so order is total and consistent. **One graph per server process; no multi-tenancy.** For a consultancy this is arguably a feature: one lightweight container per client engagement is clean isolation.
- **Durability**: events append to a **Fluree ledger** (`fluree/ledger:1.0.0-beta17` via HTTP) as `(uuid, EDN-string)` pairs with a server-assigned total order; the server also writes a full DataScript JSON snapshot every 100 events; boot = load snapshot + replay newer events. A `save`/`load`/`recover` CLI exists (with a cron wrapper script) for logical backups. In-memory mode exists but persists nothing.
- **Self-healing middleware** runs on every transaction and at boot: `linkmaker` (recomputes block refs from parsed strings), `orderkeeper` (repairs sibling order), plus a health check that logs a knowledge-graph integrity sweep.

### 3.4 Authentication: the real answer

**There is one optional shared plaintext password for the whole server. That is the entire auth model.**

- Off by default (`;; :password "SuchWow"` commented out in `config.default.edn`); supplied via `CONFIG_EDN`.
- Sent as a plaintext field inside the websocket hello payload; a blank server password means a fully open server.
- Stored in plaintext in browser localStorage; **base64-encoded into shareable invite URLs** (the "share" button produces a link containing the server password).
- No user accounts, no roles, no per-page permissions. Presence identity is client-chosen (default username is a random Greek god); two clients can claim the same name.
- The HTTP API uses Basic auth where the **username is never validated**; it simply becomes the edit-attribution name.
- One inconsistency: the websocket treats a blank configured password as "open", the HTTP API treats only a *missing* password as "open".
- **Danger switch**: an optional `:nrepl` config key starts an unauthenticated remote REPL (arbitrary code execution). It must never be enabled on a reachable host.

Practical posture for a reboot: password on, TLS + reverse-proxy (Caddy) or Tailscale in front, nREPL off. Real accounts only matter if this ever becomes multi-client SaaS.

### 3.5 Sync semantics and their limits

- Total order comes solely from server arrival; **conflicts are last-write-wins** on whole block strings. The event-sync README says plainly that semantic conflict handling does not exist.
- Client applies its own events optimistically and rolls back/reapplies when the server disagrees; the rollback path has an acknowledged "It's very bad if this happens" edge case.
- The **offline queue is an in-memory atom**: a refresh loses queued edits. The designed local-storage durability stage was never built.
- Reconnect: fixed 3s delay, **gives up permanently after 2 attempts**, then silently falls back to a local in-memory graph. Every reconnect re-downloads the entire graph.
- Undo is local-only, capped at 20 steps.

Fine for a small trusted team on a stable connection. Not yet a paid-product promise.

### 3.6 Mobile

None. Zero. No PWA manifest, no service worker, **not a single `@media` query in the entire codebase**, no responsive props on the Chakra components. The editor is a textarea with ~880 lines of keyboard-event handling. The only mobile-aware artifact is the viewport meta tag. A mobile client is new work; the cheap future approximation is a capture-only PWA that writes through the API.

### 3.7 Feature inventory

Shipped and visible: Roam-grade outliner (textarea + 3-stage instaparse parser), daily notes, bidirectional links with linked and unlinked references, block references and embeds, force-directed graph view (global and per-page), command palette ("Athena"), right sidebar, keyboard-driven editing, KaTeX (with chemistry extension), fenced code blocks, YouTube/iframe embeds, TODO checkboxes, Roam JSON import, HTML-to-markdown paste, themes, presence avatars and shared editing.

Correction worth noting, because it is easy to assume otherwise: **code blocks have no syntax highlighting.** `src/cljs/athens/parse_renderer.cljs:264-272` parses the language tag, logs it under a debug flag, then discards it and emits plain `[:pre [:code text]]`. `highlight.js`, `react-highlight.js`, `codemirror`, and `react-codemirror2` are all pinned in `package.json` but imported nowhere in `src/`; the only trace is a reader-discarded `#_[:> CodeMirror ...]` sketch and a TODO for issue #989. All four are dead weight and can be dropped at M1.

Shipped but **hidden behind Settings feature flags** (the command-center surface they died building): tasks, task queries (kanban + table), properties, comments, reactions, notifications, time-travel controls, cover photos. These are client-side flags; no rebuild is needed to try them.

Known feature gaps: markdown export does not exist (import only), image upload is Electron-only (files written to local disk as `file://` URLs; broken for web/multiplayer), search is an in-browser linear regex scan over all blocks capped at 20 results with no index or ranking, templates are shallow (`;;` copies an existing block subtree), and there is **no plugin system of any kind**; the HTTP API is the only out-of-process extension surface.

### 3.8 Tests, CI, docs

- **The testing gravity is exactly where a reboot wants it**: ~166 deftests concentrated on the atomic-op resolvers, common-db, linkmaker/orderkeeper, and the parser, all in `.cljc` (run on JVM and browser). Views and TSX components: zero tests. The e2e Playwright suite exists (10 specs) but never ran in CI and pins a 2021 Playwright.
- Fluree-tagged tests are excluded even locally (they hang on a known upstream bug); the old CI ran `clojure -X:test :excludes [:fluree]`.
- **26 ADRs** in `doc/adr/` record the architecture decisions; only 8 ever reached "Accepted", and the two most load-bearing (0018 Protocol Principles, 0013 Source of Truth) are among them. ADR 0026 (Properties) is the best design doc in the repo and frames the graph explicitly as a triple store with a JSON mapping.
- 118 TODOs; the largest cluster (14) documents known Roam-markup incompatibilities in the parser.

---

## 4. The agent opportunity (headline finding)

Athens was, almost accidentally, architected for programmatic access. Three layers make an agent bridge a thin adapter rather than a project:

### 4.1 A dormant REST API

`src/clj/athens/self_hosted/web/api.clj`, gated behind `:feature-flags {:api true}` (off in the default config, on in the dev config):

- `POST /api/path/read`: path addressing with roots `{:page/title ...}`, `{:block/uid ...}`, or `{:page/query "@today"}` (today's daily note as a first-class address) and selectors by exact child string or property key. Returns the entire subtree in the canonical "internal representation" (nested `:block/string` / `:block/children` / `:block/properties`).
- `POST /api/path/write`: **creates any missing path segments, including the root page itself**. Daily-note append and page-creation-by-path work over REST today. Writes flow through malli validation, the event log, the resolvers, and broadcast live to every connected client. Content negotiation covers JSON and EDN. Working curl examples sit in the source comments.
- Known limits: no search, no backlinks, no page listing, no block edit/delete by uid, `@today` is the only query, zero tests.

### 4.2 A websocket protocol designed for third parties

The wire protocol (transit-JSON) and every event constructor live in `.cljc` shared code, with malli schemas whose own comments state the intent: *"Having all keys optional enables us to have anonymous or third party clients."* The connect flow hands a bot the entire graph: hello → session id → **a full dump of every datom in one message** → live broadcast of all subsequent events. A bot also appears as a named collaborator in the presence UI. The db-dump is plain 5-element vectors over standard transit; no custom handlers are needed to decode it from JavaScript.

### 4.3 A pure graph library

`common_db.cljc` exposes ~90 pure query helpers a bridge can reuse, including `get-internal-representation` (canonical JSON-able tree of any entity) and `get-linked-refs-by-page-title` (backlinks in one call). `bfs.cljc` converts nested JSON trees into valid atomic-op sequences. Every block is deep-linkable in-app (`#/page/<block-uid>`).

The strategic irony: the founder's third reason for quitting was that AI-native tools would leapfrog note-taking. Four years later the leverage runs the other way. Markdown-folder tools give an agent a pile of files; Athens gives an agent a typed, event-sourced, uid-addressed, backlink-indexed graph with a validated mutation vocabulary and live multiplayer broadcast. **The knowledge graph is not what AI replaces; it is what AI finally makes cheap to feed and traverse.**

---

## 5. Honest liabilities

**The decision-intelligence positioning inverts this list.** Under a personal command center, the items below were deferrable polish. For client workspaces holding organizational decision context, three findings become product-critical: every browser session receives the entire graph on connect, there is no permissions model of any kind (section 3.4), and retrieval is an unranked in-browser scan (items 3 and 8). The architectural consequence is recorded in section 8's decision-layer milestone: bulk ingested evidence should probably never live in the graph itself; the graph holds decisions and links, an evidence store holds the corpus. That single choice defuses the scale and search problems and shrinks the permissions surface to something one person can actually secure.

1. **Sync durability gaps** (section 3.5): volatile offline queue, LWW conflicts, 2-try reconnect. Fine internally; fix before making promises to clients. Note for architecture debates: all of these live in the ClojureScript client or the shared protocol layer, not in the server (see 7.2).
2. **Fluree fossil**: the event log lives in an abandoned beta of a discontinued product line, pinned to an image their own compose file says cannot be upgraded. It works when pinned; it should eventually be replaced by a boring append log (the seam is four functions; see roadmap M1.5).
3. **Search** is the biggest product liability: a linear regex scan over every block datom, 20-result cap, no index or ranking, **running in the browser** (`src/cljs/athens/db.cljs:344,387`), and no server-side endpoint at all. The fix is not a new search service: M1.5 already brings SQLite into the stack, so **SQLite FTS5** provides ranked server-side search with zero additional containers. Implementation note: the event log stores opaque `(uuid, EDN-string)` pairs, so FTS needs a block-string projection maintained off the same single-writer path that appends events, not an index over the log itself.
4. **No export**; the exit path is a third-party tool. An export endpoint should exist before any client data lives in a graph.
5. **Images broken for web/multiplayer.**
6. **Dead CI, stale e2e, dead upstream**: no fixes are coming from anywhere; the fork is on its own (mitigated by the small, well-tested core surface).
7. **Telemetry key** in the served HTML until first rebuild.
8. **Client-side rendering is the real performance ceiling.** Because the whole graph lives in the browser and reads never round-trip, backend work cannot improve the two slowest interactions: opening a page with thousands of linked references, and rendering very long child lists. `react-window` is already a dependency but is applied in exactly one place (`src/js/components/AllPagesTable/AllPagesTable.tsx`); reference lists and block children are unvirtualized. The honest mitigation is virtualized/paginated reference rendering on the client, which is separate from everything in the roadmap below.
9. **EPL-1.0 license** (see 7.3): compatible with the plan, but it travels with the code.

---

## 6. Easy wins (ranked, cheapest first)

1. **`docker compose up` with pinned tags**: a running collaborative Athens today, zero build (the SPA is inside the jar).
2. **Flip `:feature-flags {:api true}` and set a password via `CONFIG_EDN`**: instant machine API.
3. **Toggle the hidden Settings flags** (tasks, properties, queries/kanban, comments, notifications): the command-center surface is already shipped, just switched off.
4. **Backups**: the save/load/recover CLI and a cron wrapper already exist.
5. **MCP bridge v0** over the existing REST API: daily-note append, page read/write/create, with edits attributed to "claude" and appearing live in the UI. No server changes required. (The bridge is the agent doorway; the decision ledger built on top of it is the differentiator.)
6. **Strip PostHog, rebrand** at first frontend rebuild.

---

## 7. Technology verdicts

### 7.1 What stays, what goes

| Layer | Verdict | Why |
|---|---|---|
| Fluree event ledger | **Goes** (roadmap M1.5) | An abandoned beta of a distributed semantic ledger used as a glorified append-only list. The storage seam is 4 verified functions over (uuid, EDN-string) pairs; SQLite implements it in ~150 lines. Removes a container, the scariest build dependency, and reduces backup to copying one file. |
| DataScript (the graph DB) | **Stays** | It IS the product: the datalog schema, ~90 query helpers, client/server shared code, the reactivity layer. Swapping it is not a swap, it is a rewrite. Personal/team graphs fit in memory by orders of magnitude, and datalog is the agent-legibility story itself. |
| Clojure/ClojureScript core | **Stays** | ~30k LOC of working code whose only complete behavioral spec is the code itself. The tests cover the graph core, not the views, and e2e never ran, so any port's parity is proven by weeks of human daily use, not by compilation. A port also improves the layer that already works (the 1.9k-line server) while doing nothing for the weak layers (mobile, search, images). Operationally the core is one fat jar. |
| New code (MCP, agents, integrations) | **TypeScript** | Everything written on a recurring basis lives at the REST boundary in TS. After the roadmap's API additions, the Clojure touch surface is a few hundred lines a year, agents write those diffs, and the test suite is the guardrail. The 2022 "tiny Clojure talent pool" problem is largely neutralized by agents in 2026. |
| React 17 + Chakra 1 + Reagent frontend | **Stays frozen** | Atomic upgrade knot (all four move together), low value. Rebuild as-is from lockfiles; revisit only in a deliberate v3. |
| Last-write-wins sync | **Stays for now** | A CRDT retrofit is a research project. Small-trusted-team semantics are acceptable for internal use and engagement workspaces. Becomes a real project only if client-facing multiplayer becomes a paid promise. |

### 7.2 The rewrite question (Elixir, TypeScript, agent labor)

Agent labor makes *writing* a port nearly free. It does not make the port cheap, because the surviving costs are spec extraction and verification: the editor's behavior (caret math, selection, slash menus, paste, drag) exists only as code and feel, and parity is established by a human living in it. The bottleneck is owner attention, not engineering hours.

Elixir specifically: the right answer for a greenfield collaborative server (Phoenix channels/presence/OTP are superb), the wrong answer for this reboot. It replaces the smallest, healthiest layer and does not help the hard 40% (the editor is ClojureScript; LiveView's server-round-trip model is an anti-fit for caret-heavy outliner editing, so a port ends up writing a TypeScript editor anyway).

**The decisive test: locate the weaknesses, then ask which layer they live in.** Every sync weakness catalogued in section 3.5 is in ClojureScript client code or shared protocol semantics, not in the server: the volatile offline queue is an in-memory atom in `self_hosted/client.cljs`; the 2-try give-up is `MAX_RECONNECT_TRY` in the same file; the optimistic-apply rollback lives in `events/remote.cljs`; last-write-wins is a semantic choice in the shared `.cljc` resolvers. **Porting the JVM server to Elixir fixes zero of them.** The mirror image also holds: the things a BEAM runtime is genuinely great at (realtime multiplayer, presence, WebSocket concurrency, fault isolation, async pipelines) map precisely onto the ~1.9k-line Clojure server, which is the smallest and healthiest part of this codebase. A port would spend its entire budget rewriting the one layer that already works. Athens also already satisfies the standard architectural advice for this product category on its own terms: the recommendation to use "CRDT or operation-log sync" is met by the existing 12-op append-only event log.

Note when reading external performance critiques of this product category: analyses of *Roam Research* (proprietary, different codebase, different architecture) are not evidence about Athens. Athens is local-first in a way Roam is not, which changes where the bottlenecks sit (see the liability on client-side rendering in section 5).

**Rewrite triggers** (evaluate after living with the system; any one suffices): (1) a deliberate pivot to a closed proprietary product; (2) mobile-first becomes a real client requirement; (3) hosting economics at 50+ tenants, where BEAM-style multi-tenancy would beat container-per-client. If triggered, the move is a greenfield implementation against the Athens protocol as spec (the 12-op vocabulary + internal representation), clean-room where license escape is required, with the running rebooted system as the parity oracle.

The decision-intelligence reframe weakens the rewrite case further. The expensive, risky part of any port was always the editor; the reframe demotes the editor from core product to capture surface, while the parts a port would have to re-earn (the append-only event log, typed properties, datalog) are exactly the parts the new positioning leans on hardest.

### 7.3 License and attribution (EPL-1.0)

- **Hosting** Athens for yourself or clients triggers no obligations (EPL-1.0 has no network copyleft).
- **Distributing** modified builds requires making the modified source available, which matches the stated intent to keep it open anyway. Rebranding is permitted (trademark is separate from copyright; rename regardless).
- **A port does not launder the license.** An agent-driven port of this source into another language is a translation, i.e., a derivative work, and remains EPL-1.0 with attribution intact. Escaping EPL requires clean-room reimplementation from behavior/protocol specs without lifting expression from the source. That only matters under a closed proprietary pivot, which is currently the opposite of the strategy: given the plan to give the tool away as client value, the Athens/YC lineage is a credibility asset, not a debt. (This is an engineering read, not legal advice; if a proprietary pivot ever gets serious, obtain a formal opinion first.)

---

## 8. Proposed roadmap (PROPOSAL ONLY; nothing started; pending further planning)

Sequence: **M0 resurrect → M2a agent bridge v0 → decision layer v0 → *(gate)* → M1 own the build → M1.5 replace Fluree with SQLite → M2b full agent toolset.** The bridge splits in two because the existing REST API already supports the core demo with zero server changes, while search/backlinks/tasks need ~5 new endpoints, which first requires building the server from source. The decision layer sits **before** the gate deliberately: M0 + M2a + decision records v0 all run on published images with zero compilation, so the actual thesis (decision intelligence, not note capture) gets tested before any expensive work starts. Estimated total: **~35-56 hours** of build work plus the decision-layer spec work.

### M0: Resurrect (~2-4 h)

- Add a pinned compose file (leave the original pristine): `ghcr.io/athensresearch/athens:v2.1.0-beta.5` + `fluree/ledger:1.0.0-beta17`; drop the nginx service (direct `:3010` is fine pre-TLS); do not publish Fluree's 8090 (it has no auth).
- `CONFIG_EDN: '{:password "CHANGE-ME" :feature-flags {:api true}}'` (single-quoted YAML so the inner EDN quotes survive). Never add `:nrepl`.
- Connect at `http://host:3010` via the db picker's "Remote address" field, or a prefilled URL with `graph-name`/`graph-url`/`graph-password` (base64) params.
- REST smoke test (verified to auto-create missing pages, including today's):
  `curl -u claude:PW -X POST :3010/api/path/write -d '{"path":[{"page/query":"@today"}],"data":[{"block/string":"hello from curl"}]}'`
- Backups: hot logical export via the bundled save CLI inside the container; weekly cold tar of `athens-data/`. The DataScript snapshot alone is NOT a backup (boot = snapshot + Fluree replay). Never run `:in-memory? true` in production.
- **Acceptance:** two browsers editing live with presence; container restart preserves data; a curl write appears live in open clients; a non-empty EDN backup exports.

### M2a: MCP bridge v0 (~1 day, no server changes)

- `tools/lorefold-mcp/` in TypeScript (`@modelcontextprotocol/sdk`, stdio; env: `LOREFOLD_URL`/`LOREFOLD_USERNAME`/`LOREFOLD_PASSWORD`).
- v0 tools over the existing API only: `lorefold_daily_append` (daily titles are `LLLL dd, yyyy` with zero-padded day, e.g. "August 09, 2026"), `lorefold_page_read` (internal representation + rendered markdown), `lorefold_page_write` (path upsert), `lorefold_page_create`. Markdown ↔ internal-representation codec in TS.
- **Acceptance:** Claude appends a note to today's daily page; it appears live in the browser attributed to "claude"; page reads round-trip as markdown.

### Decision layer v0 (spec + one tool; runs on the M0 stack, nothing compiled)

What separates Lorefold from a notes tool, sequenced before the gate:

- **Architecture decision (owner call, agent-drafted spike): where does evidence live?** Recommended default: not in the graph. The graph holds decision objects and links; source-system URLs serve as evidence at first, a dedicated evidence store later. This resolves full-graph-on-connect and search, and shrinks the permissions surface. Written decision lands in `doc/`.
- **Ingestion spike: adopt vs build.** Continuous ingestion of GitHub/Slack/Drive/docs means auth, pagination, rate limits, incremental sync, and permission mapping, times four. Evaluate standing on an existing OSS enterprise-search layer (Onyx/Danswer and peers) as the evidence store, with Lorefold owning only the decision ledger. Building four connectors solo is the classic way a one-person product dies; the pipes are commodity, the ledger is not.
- **Decision object model spec:** `:entity/type "[[lorefold/decision]]"` plus properties: status (proposed / accepted / superseded / reversed), date, question, rationale, alternatives considered, participants, evidence links, supersedes / superseded-by. Rides the existing property model with **zero schema migration**, and the append-only log already records how each decision evolved. Spec includes the datalog for "why did we decide X" and "what decisions touch Y".
- **`lorefold_decision_record` MCP tool (v0):** creates a decision object via `/api/path/write`, evidence as URLs (a Slack permalink is evidence; a PR link is evidence). **Zero connectors, zero new infrastructure.** Ingestion is an optimization on capture, not the thesis.
- **Acceptance:** decisions from a live engagement recorded and queried for two weeks; "why did we decide X" answered from the graph, with evidence links, at least weekly. That is the gate.

### M1: Own the build (~14-23 h)

- **Server from source** on temurin 17 (the proven JDK; 21 as bonus attempt): AOT `athens.self-hosted.core`, uberjar via `:uberdeps`. Fluree dep risk (`com.fluree/db 1.0.0-rc33` on Clojars): probably fine (Clojars is immutable); insurance = vendor the full `~/.m2/repository` tarball the moment resolution succeeds; last resort = keep running the published jar while owning only the frontend build.
- **Frontend from source** in a `node:16-bullseye` + temurin 17 container (shadow-cljs runs on the JVM and resolves deps.edn): `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, `yarn components && shadow-cljs release app` (never `yarn prod`, which drags the Electron builds). Strip the PostHog snippet from `resources/public/index.html`.
- 3-stage Dockerfile (frontend → server-build → temurin-17-JRE runtime, SPA baked before the uberjar, mirroring old CI order); compose with Caddy 2 for TLS (the client derives `wss://` from `https://` automatically). Auth layering: the graph password guards `/ws`, Athens Basic auth guards `/api/*`; any Caddy basic-auth must be scoped away from those paths (single Authorization header). Set `TZ` so `@today` and daily titles match local time.
- CI rewrite: clj-kondo pinned at the repo's clean version, `clojure -X:test :excludes '[:fluree]'` (~166 deftests), image build on tags/main.
- Nightly hot export + weekly cold tar + documented restore.
- **Acceptance:** clean-machine `up --build` from a fresh clone; view-source shows no PostHog; two-browser RTC over TLS; CI green; test-restore into a scratch stack.

### M1.5: Replace Fluree with SQLite (~6-12 h)

- New event-log namespace implementing the verified 4-function seam (`init!`, `add-event!` idempotent insert, `events` ordered scan with since-id, `last-event-id`) over `(event_order INTEGER PRIMARY KEY, event_id TEXT UNIQUE, data TEXT)`, WAL mode. The existing single-writer lock already serializes appends.
- Migration without Fluree code in the new build: export with the old stack's save CLI (it emits exactly the (uuid, EDN) pairs), import with a small loader. Then **delete the Fluree namespaces and dependency entirely**; the rc33 build risk disappears with them.
- **Acceptance:** contract tests match the old event-log behavior; the M0 verification suite passes on the swapped stack; the stack is two containers (athens + caddy); backup is one `.db` file plus the EDN export.

### M2b: Full agent toolset (~12-18 h)

- Extend `api.clj` (same flag + auth), each endpoint 10-25 lines reusing verified `common_db` fns: `/api/pages`, `/api/search` (linear scan + breadcrumbs to ship it; upgrade to SQLite FTS5 over a block-string projection once M1.5 lands, rather than adding a search service), `/api/backlinks`, `/api/block/save` + `/api/block/remove` (path-write can only append; writing an existing uid resolves to a move), `/api/export`, stretch `/api/query` (read-only datalog escape hatch).
- First-ever api.clj tests: op-shape units + round-trip integration against in-memory mode (skips Fluree; ideal for tests).
- MCP v1 adds: `lorefold_search`, `lorefold_backlinks`, `lorefold_pages`, `lorefold_block_edit`, `lorefold_tasks` (property-backed), `lorefold_export`. Optional: a 30-line WS hello so "claude" appears in the presence avatars; a Streamable-HTTP mode behind Caddy for claude.ai use, which is also the per-client hosted story (one stack + one sidecar per client, config = env vars).
- **Acceptance:** Claude answers "what links to [[Client X]]?" and "what tasks are open?" correctly; export markdown matches the UI.

---

## 9. Business model and customer sequence

**Category.** Decision intelligence, not note-taking and not hosted PKM. The note-taking market is the one Athens died in; the postmortem stands. "Why did we decide this" is a different buyer and a different budget line, and it happens to be the productized form of the consulting practice itself (retrieval and AI adoption): a decision-context layer with citations *is* a retrieval product.

**Customer 1: the practice itself (Lorewood Labs).** Run the consultancy on it: engagement decisions, architecture calls, the operating log, every decision recorded with evidence links during real work. This is the gate: if answering "why did we decide X" from the graph does not beat memory and Slack search within two weeks of honest use, stop at M0 and keep it as a free internal tool.

**Customer 2: one design-partner client.** A client with high trust and an existing retainer relationship, brought in only after the experience and technicals are settled at customer 1. Three conditions, none waivable:

1. **Hygiene bar first.** M1 complete: telemetry stripped (the pinned upstream images still phone home to PostHog), TLS, an isolated per-client instance, tested backups. No client touches the stock images.
2. **IP fenced in writing.** Lorefold is Lorewood Labs product IP, provided as value-add *outside* the engagement SOW. Never allow ambiguity about whether tooling used during a retainer is engagement work product; that ambiguity gets expensive when equity or long relationships are involved. Bound the support expectations explicitly, or the product becomes unpaid-support surface area.
3. **Data discipline.** Decision context only: roadmap calls, architecture decisions, status. Evidence enters as links into the client's own systems, not as copies. No sensitive data classes (anything involving minors, health, or regulated records) until a real permissions model exists; Lorefold's auth today is one shared password.

**What customer 2 proves, and what it cannot.** A design partner validates the *experience*: does the client actually return to the decision ledger, does the recurring report become a view over it, does it change how meetings go. A design partner does **not** validate price; a friendly with an existing relationship renews for relationship reasons. **Customer 3, at arm's length and separately priced, is the revenue proof.** Whenever access continues past an engagement, it must be a separate line item; bundled access proves nothing.

**The natural wedge for customer 2** is the report the practice already delivers: regenerate the monthly report as a *view over the decision ledger* — what was decided, why, on what evidence, what changed since last month. It makes the product legible to the client instantly and costs nothing extra once decisions are being recorded.

**Connector discipline.** Do not build GitHub/Slack/Drive/docs connectors solo. If the ingestion spike says adopt, stand on an OSS evidence layer and keep Lorefold's defensible core the decision ledger plus the curation practice around it. The pipes are commodity; the ledger and the judgment are not.

**License.** EPL-1.0: hosting for clients is unrestricted (no network copyleft); distributing modified builds requires source availability, which fits keeping it open. Rebrand permitted; Athens provenance retained as a credibility line, not an identity.

**Focus guard.** Client delivery stays priority one; Lorefold is built in the gaps, not instead of billable work. Timeboxes: M0 half a day, M2a one day, decision-layer spec spread across the gate window, M1 two to three days, M1.5 one day, M2b one to two days. The gate is real: fail it and the project stops at a free internal tool.

---

## 10. Open questions for the next planning session

Resolved since first writing:

1. ~~Name and brand~~ — **Lorefold.** Kin to Lorewood Labs; a fold is where the flock is kept, and the graph state is literally a fold over the append-only operation log (ADR 0018). Web-search collisions are clean (the earlier candidate, Sorbet, collided with Stripe's Ruby type-checker and was dropped). Still to check before anything public: domain, npm scope, GitHub org, USPTO classes 9/42.
2. ~~M2a-first vs M1-first~~ — M2a first, confirmed by the reframe: the thesis test (decision records in live use) runs entirely on published images. The M1 hygiene bar becomes mandatory at the moment a client instance exists, not before.
3. ~~What data goes in first~~ — the practice's own engagement decisions (customer 1). A design-partner client comes only after the gate and the M1 hygiene bar (section 9).

Still open:

4. **Deployment target for M0.** Local / VPS / Tailscale-only. Weightier under the reframe: whatever hosts a client workspace must satisfy that client's data expectations, and Lorefold brings no permissions model of its own.
5. **Evidence store: adopt vs build.** Output of the ingestion spike. Leading candidate shape: an OSS enterprise-search layer as the corpus, Lorefold as the ledger linking into it.
6. **Minimum auth bar for customer 2.** Is per-client isolation + TLS + strong graph password + Caddy basic-auth enough for decision-context-only data, or does customer 2 wait for real accounts?
7. **Export before adoption?** `/api/export` (M2b) may deserve promotion; an exit path is part of the trust story a consultancy sells.
8. **Which hidden feature flags on day one.** Tasks/properties/queries likely on; comments/reactions/notifications likely off until stabilized (all shipped as experiments).
9. **Pricing shape for continued access** after an engagement ends. Separate line item by rule; amount and packaging decided once customer 2 exists, validated only by customer 3.
10. **Gate metric, concretely.** Proposed: during two weeks of live use, "why did we decide X" gets answered from the graph with evidence at least weekly, and the weekly review runs out of Lorefold instead of memory. Refine before starting the clock.

---

## 11. Backlog: candidate features beyond the roadmap

Ideas assessed and deliberately parked. Nothing here is scheduled; each entry records the assessment so the thinking does not have to be redone.

### B1. Connect to GitHub repos for client documentation

**The need.** Editing documentation through the GitHub web UI is cumbersome, and this happens constantly across multiple client codebases: README updates, wiki and doc corrections, no code changes. The wish is to browse repo files IDE-style inside the tool, edit docs, and review a diff in a side panel.

**Assessment: valuable need, but mostly the wrong tool to satisfy it.** The idea splits into three features with very different economics (seam audit performed against this codebase):

| Sub-feature | Cost | Verdict |
|---|---|---|
| Mirror repo markdown into the graph as reference pages | M | **The part worth building** |
| Side-panel raw-text editor with diff view | L | Skip; competes with free, better tools |
| Commit / PR flow from inside the app | XL | Skip; structurally unsound here |

**Why the editing half is a trap.** Three findings from the audit, in order of severity:

1. **The round trip cannot be lossless.** `text-to-blocks` (`src/cljs/athens/views/blocks/internal_representation.cljs:123`) is an indentation parser, not a markdown parser: `#` headings survive as strings that the block parser then reads as *hashtag links, creating spurious pages*, and fenced code blocks explode into sibling blocks. Worse, **no blocks-to-markdown serializer exists anywhere in the codebase**. Lossy ingestion plus a from-scratch serializer means a no-op edit produces a spurious diff, which makes the resulting PRs unreviewable. That is the structural blocker; the GitHub API plumbing is the easy part.
2. **"Read-only" is not a concept in the data model.** There is no read-only page and no per-block write guard; every block is editable by construction. Enforcement would have to be built, not enabled.
3. **The sidebar fights this.** Sidebar items are stored as graph blocks (properties under `athens/right-sidebar` on the user page) and filtered through `common-db/block-exists?` (`right_sidebar/shared.cljs:70-71`), so an item not backed by a real entity **silently disappears with no error**. Transient state such as an editor buffer, dirty flag, or scroll position has nowhere natural to live, since that store is the synced graph. Also note CodeMirror is *not* a free head start: it is unimported, and pinned at the legacy v5.

**Recommended shape if this is ever built.** A one-way **reference mirror**: one page per document, raw text preserved rather than outlined, with provenance stored as properties (`athens/repo/owner`, `/name`, `/path`, `/sha`, `/branch`) using the existing `:block/property-of` + `:block/key` model, which round-trips cleanly through internal representation and is indexed by `get-reactive-instances-of-key-value`. Ingestion needs **no new server endpoint**: `POST /api/path/write` already accepts internal representation. The payoff is unified search across notes and client docs, and backlinks from a meeting note straight to the document under discussion.

Editing routes to Claude Code, which already performs byte-exact file edits and opens PRs. The tool supplies the context and the entry point; GitHub supplies the diff review, where the tooling is already excellent. For "browse like an IDE," `github.dev` (press `.` on any repo) is one keystroke and free. A cheap later addition, if the side-panel diff itch persists, is rendering an existing PR's patch read-only in the sidebar (**S**: GitHub computes the diff, so no diff library is needed; none exists in the codebase today).

**Hard constraint.** A token that can write to client repositories must live server-side, in the MCP sidecar, as a fine-grained GitHub App scoped per repository, never a PAT in the browser. The app's own auth is a single shared password kept in localStorage and base64-encoded into share URLs (section 3.4); client repository write access cannot sit behind that.

**Honest scoping note.** The cross-referencing benefit is narrower than it first appears, because an agent can already read GitHub directly. The mirror's real and defensible value is unified search plus backlinks from notes, not agent access.

## Appendix A: Key file map

| Area | Path |
|---|---|
| Graph schema + query library | `src/cljc/athens/common_db.cljc` |
| Atomic ops (the write vocabulary) | `src/cljc/athens/common_events/graph/atomic.cljc` |
| Event constructors + transit serialization | `src/cljc/athens/common_events.cljc` |
| Wire schemas (third-party clients anticipated) | `src/cljc/athens/common_events/schema.cljc` |
| Tree → ops converter | `src/cljc/athens/common_events/bfs.cljc` |
| Resolvers (ops → DataScript txs) | `src/cljc/athens/common_events/resolver/atomic.cljc` |
| Server entrypoint + component system | `src/clj/athens/self_hosted/core.clj` |
| Websocket + routes | `src/clj/athens/self_hosted/components/web.clj` |
| **Dormant REST API** | `src/clj/athens/self_hosted/web/api.clj` |
| Event log (Fluree; the M1.5 seam) | `src/clj/athens/self_hosted/event_log.clj` |
| Backup CLI | `src/clj/athens/self_hosted/save_load.clj` |
| Server config defaults | `src/clj/config.default.edn` |
| Parser (3-stage instaparse) | `src/cljc/athens/parser/impl.cljc` |
| Editor surface | `src/cljs/athens/views/blocks/editor.cljs`, `textarea_keydown.cljs` |
| Tasks / queries (flag-gated) | `src/cljs/athens/types/tasks/`, `src/cljs/athens/types/query/` |
| Feature flags UI | `src/cljs/athens/views/pages/settings.cljs` |
| Architecture decision records | `doc/adr/` (0018, 0013, 0026 are load-bearing) |
| The unfinished sync rewrite | `src/cljc/event_sync/` |

## Appendix B: Sources

- Jeff Tang, ["Why We Stopped Working on Athens, and What I'm Doing Next"](https://hardpivot.substack.com/p/why-we-stopped-working-on-athens) (Nov 2022)
- [Hacker News: "Athens is no longer being actively maintained"](https://news.ycombinator.com/item?id=34285769) (Jan 2023)
- [Launch HN: Athens Research (YC W21)](https://news.ycombinator.com/item?id=26316793) (Mar 2021)
- [athensresearch/athens](https://github.com/athensresearch/athens) (archived upstream)
- [athens-export](https://github.com/bshepherdson/athens-export) (community migration tool referenced by the upstream README)
- This repository's own `doc/adr/`, `CHANGELOG.md`, and git history (analysis performed 2026-08-09 at commit `b463a97`)
