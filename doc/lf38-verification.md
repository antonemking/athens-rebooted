# LF-38 verification report

An independent live-validation pass of the merged LF-38 decision-recording tools
(`lorefold_decision_record`, `lorefold_decisions`), run 2026-08-10 against an M0
stack brought up from scratch on an Apple-Silicon macOS host. This does not
re-litigate the implementation session's own report; it records what a second
party could reproduce end-to-end, and where the hardware stopped us.

## Environment

| Piece | What ran |
|---|---|
| Docker runtime | colima VM (Docker Desktop not present) |
| Event log | `fluree/ledger:1.0.0-beta17` (amd64, under qemu emulation) |
| Server | `clojure -M:athens`, JDK 17, `:feature-flags {:api true}`, `:nrepl false` |
| Frontend | `shadow-cljs release app` → single `app.js`, served by the server at `:3010` |
| Bridge | `tools/lorefold-mcp` built with Node 26 (README pins ≥18; 26 worked), `npm ci && npm run build` |

**Key constraint — validation ran in `:in-memory? true` mode.** Fluree writes
time out on this host: the amd64 image runs under qemu emulation, and
`add-event!` (`event_log.clj`) uses a hardcoded 5s × 3 timeout, so every
`/api/path/write` is rejected as `add-event! timed-out`. This is the
"Fluree-on-M1 quirk" AGENTS.md flags, reproduced. In-memory mode bypasses Fluree
— writes go to DataScript + a local snapshot — and exercises the same
event → resolve → property-materialization path for both tools. What it does
**not** exercise is the durable Fluree event-log append. So the decision tools
are verified end-to-end; Fluree-backed durability of decision writes is
**unverified on this hardware** — an environment limitation, not an LF-38 defect.

## What was verified

Against the kickoff's verification protocol:

| # | Check | Result |
|---|---|---|
| 1 | `npm run build` + `tsc --noEmit` clean | ✅ |
| 1 | `npm test` (incl. decision-payload builder + effective-status logic) | ✅ 155 tests |
| 2 | stdio server lists the full tool set with valid schemas | ✅ 6 tools; the two new ones match spec §1 |
| 3 | Record a decision with every field → read back | ✅ full round-trip |
| 4 | Supersede → effective status | ✅ prior flips to `superseded (stored as "accepted")`, names successor |
| 5 | Reject bad cases | ✅ missing required field (`-32602`), malformed date, dangling `supersedes` uid, empty write (`data:[]` guard) |
| 6 | Record the real LF-8 decision (RUNBOOK §15) | ✅ recorded faithfully, backdated to its daily note |
| 7 | LF-37 §8 literal graph shape | ✅ raw read shows `:entity/type = [[lorefold/decision]]` + `:decision/*` keys; multi-values as children |
| 8 | `lorefold/decision` free index (browser) | ✅ confirmed in Chromium — decisions render as Linked References |

Every check in the protocol passed. Nothing is pending in the code.

## Findings — about the model, not the code

Recording *real* decisions (LF-8, plus two genuine project decisions) surfaced
gaps worth carrying into `decision-object-model.md` §10:

- **Event-based revisit triggers have no home.** `review_on` is a date, but real
  triggers are conditional — "when M1 ships", "past ~50 tenants". Hit on three
  separate real decisions; each had to bury the trigger in prose.
- **No field for "follow-on this creates"** — the actions a decision spawns
  (RUNBOOK §15's backup follow-on) have nowhere to live.
- **Compound decisions collapse to one long statement.** LF-8 and the tenancy
  decision are each really several sub-decisions; the model treats a decision as
  a single statement string.
- **Correction vs. revision are conflated.** Fixing a mis-capture (the agent got
  it wrong) is different from a real change of mind (supersede). The agent has
  only supersede today; in-place edit is LF-30 (M2b). Note: on Fluree an
  in-browser edit is itself a logged event, so history survives; in-memory has
  no such trail.

## Test artifacts

All writes landed in the **ephemeral in-memory graph** (local DataScript
snapshot), not a durable shared graph — they do not persist to Fluree and vanish
on a wipe or a mode switch, so there is nothing to clean up in a shared graph.
For the record, the decisions created were: two `LF38 TEST` synthetic decisions
(one superseded), and three genuine ones — the LF-8 deployment decision, the
in-memory-dev-mode decision, and the tenancy/aggregation-model decision.

## Not verified here / out of scope

- **Fluree-backed durability of decision writes** — blocked by qemu emulation on
  this host. Reproduces on any Apple-Silicon machine running the amd64 image; a
  native-arch event log or a raised `add-event!` timeout is the fix.
- **"Edited" provenance surfaced in the UI** — the event log records edits, but
  the product does not display them yet.
- **M2b surface** (graph-wide search, backlinks, in-place block edit) — not part
  of LF-38.

## Bottom line

LF-38's code is complete and passes every offline and live check we could run.
The single unrun check is Fluree-backed durability of decision writes, which this
hardware cannot exercise.
