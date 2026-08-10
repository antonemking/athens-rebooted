# LF-38 verification report

An independent live-validation pass of the merged LF-38 decision-recording tools
(`lorefold_decision_record`, `lorefold_decisions`), run 2026-08-10 against an M0
stack brought up from scratch on an Apple-Silicon macOS host. This does not
re-litigate the implementation session's own report; it records what a second
party could reproduce end-to-end, and where the hardware stopped us.

> **Reconciliation, 2026-08-10.** Three corrections were made to this report
> after it merged, against the rest of the repository record. They are marked
> inline below: the emulation quirk was **not** documented in `AGENTS.md` as
> originally claimed (it was documented nowhere, and now lives in
> `ops/RUNBOOK.md` §13); the "Test artifacts" section covers only this run, not
> the implementation session's; and the durability gap is narrower than the
> bottom line stated. The verification results themselves are unchanged — every
> check that passed still passes.

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
`add-event!` (`src/clj/athens/self_hosted/event_log.clj:131`) allows 5 000 ms
per attempt and retries three times, so every `/api/path/write` is rejected as
`add-event! timed-out`. Both callers use the 3-arity, so no configuration
reaches those numbers.

> **Correction.** This originally read "the 'Fluree-on-M1 quirk' AGENTS.md
> flags". `AGENTS.md` says nothing about emulation, arm64, or Docker platform —
> the quirk was documented nowhere in the repository, which is why a stack that
> boots healthy and rejects every write had no troubleshooting entry to find. It
> now has one: `ops/RUNBOOK.md` §13, with the two ways out. The fix that removes
> the constraint is filed as **LF-39**.

In-memory mode bypasses Fluree — writes go to DataScript + a local snapshot —
and exercises the same event → resolve → property-materialization path for both
tools. What it does **not** exercise is the durable Fluree event-log append. So
the decision tools are verified end-to-end here; Fluree-backed durability of
decision writes is **unverified on this hardware** — an environment limitation,
not an LF-38 defect. See the bottom line for what the rest of the record already
covers.

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
gaps worth carrying into `decision-object-model.md` §10. **They are now carried
there** — the first three sharpened questions 5 and 7 with this pass's evidence,
and the fourth is question 8. §10 is the live record; the list below is what
this run saw:

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

**From this run — nothing to clean up.** All writes landed in the **ephemeral
in-memory graph** (local DataScript snapshot), not a durable shared graph: they
never reached Fluree and vanish on a wipe or a mode switch. For the record, the
decisions created were two `LF38 TEST` synthetic decisions (one superseded) and
three genuine ones — the LF-8 deployment decision, the in-memory-dev-mode
decision, and the tenancy/aggregation-model decision.

**From the implementation session — still open, and not covered by the line
above.** That session ran against the Fluree-backed compose stack, where writes
*are* durable and the API has no delete. Per the kickoff's test-artifact
discipline its throwaway writes were prefixed `LF38 TEST` and kept on that day's
daily note, to be removed in the browser. The list of exactly what it left was
in that session's final report and was never committed, so the artifacts are
findable by prefix but not enumerated here. Whoever owns that graph should
search `LF38 TEST` and delete in the UI.

## Not verified here / out of scope

- **Fluree-backed durability of decision writes on this host** — blocked by qemu
  emulation. Reproduces on any Apple-Silicon machine running the amd64 image; a
  native-arch event log or a raised `add-event!` timeout is the fix (**LF-39**;
  workarounds in `ops/RUNBOOK.md` §13). What the rest of the record covers is in
  the bottom line.
- **"Edited" provenance surfaced in the UI** — the event log records edits, but
  the product does not display them yet.
- **M2b surface** (graph-wide search, backlinks, in-place block edit) — not part
  of LF-38.

## Bottom line

LF-38's code is complete and passes every offline and live check we could run.

**Corrected:** this originally called Fluree-backed durability "the single unrun
check", which reads as an open hole in LF-38. Scoped correctly, it is a gap in
*this run*, not in the project's coverage. The implementation session validated
against the compose stack of `ops/RUNBOOK.md` §3 — Fluree-backed, since the
runbook uses no other mode — and §9 records the API behaviour it established
there on the same day, including the property-encoding finding that only a real
write path could surface. Durable decision writes were therefore exercised
then; what this hardware could not repeat is that half of it.

Two honest limits on that reconciliation: it is inferred from the runbook's
record rather than stated outright by the implementation session, and it means
no single environment has run the whole protocol end-to-end — the durable path
and the independent browser check were verified on different hosts. Neither is
a reason to hold LF-38. A first recording session on the LF-8 target host closes
both, and that is the decision gate starting anyway.
