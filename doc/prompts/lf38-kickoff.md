# LF-38 kickoff prompt (for a fresh agent session)

Precondition: `main` contains the merged M2a bridge (`tools/lorefold-mcp/`) and `doc/decision-object-model.md`. The M0 stack should be running and reachable so the session can validate against it live; the prompt degrades honestly if not.

Adjust `LOREFOLD_URL` if the stack is not at `http://localhost:3010`.

---

**GOAL:** Add decision recording to the Lorefold MCP bridge. This is the milestone that makes Lorefold a decision intelligence platform rather than a notes tool — everything before it was plumbing. Task LF-38, plus the deferred validation of LF-37.

**Read first, in this order:** `AGENTS.md` (guardrails — binding), **`doc/decision-object-model.md` (the specification you are implementing — read it completely before writing anything)**, `BACKLOG.md` → LF-38, and **`ops/RUNBOOK.md` §9**, which records real API behaviour discovered while building the bridge. Then read the existing bridge in `tools/lorefold-mcp/src/` — you are extending it, not starting over.

**Scope — two tools inside `tools/lorefold-mcp/`:**

1. **`lorefold_decision_record`** — records a decision per the spec. Inputs mirror §3: the decision statement (the block's own string), required `status` / `date` / `context`, and optional `question`, `rationale`, `alternatives[]`, `evidence[]`, `participants[]`, `supersedes[]`, `review_on`. Writes to the daily note for `date` via `/api/path/write`, using the exact payload shape in spec §8. Multi-value properties are an empty `block/string` with `block/children` — one child per value.

2. **`lorefold_decisions`** — reads decisions back. **Read the constraint below before designing this.**

Reuse the existing client, codec, config and date helpers. Do not duplicate them.

**The read tool's real constraint.** There are no server-side query endpoints yet — `/api/search`, `/api/backlinks` and `/api/pages` are M2b (LF-29). The only read primitive is `/api/path/read`, which returns a page's full subtree including derived `block/properties`. So `lorefold_decisions` works by reading daily notes across a **date range** and filtering for blocks whose `:entity/type` is `[[lorefold/decision]]`. Take `from`/`to` dates (default: last 14 days), and support optional `status` and `context` filters applied client-side.

Say plainly in the tool description that this is a windowed scan, not a graph-wide query, and that graph-wide search arrives in M2b. Do not fake completeness.

**Status transitions are impossible in v0, and that is not a bug to work around.** `path/write` only appends; changing an existing property value needs `/api/block/save`, which is LF-30 in M2b. Consequences to implement deliberately:

- Record a decision at whatever status it holds when captured. In practice that is usually `accepted`, because decisions get written down after they are made.
- Supersession is expressed by **recording a new decision** whose `supersedes` points at the old one's `((uid))` — which is what an append-only ledger implies anyway. Do not try to mutate the old decision.
- Because of that, the *stored* status of a superseded decision goes stale. Have `lorefold_decisions` compute an **effective status**: within the window it scanned, if some decision supersedes this one, report it as superseded regardless of the stored string, and say which decision superseded it. Note in the description that this only holds within the scanned window.

**Out of scope — do not touch:** anything in `src/` (the Clojure server), `ops/`, or the repo-root build files. Do not add server endpoints. Do not fix the `api.clj` defects — those are filed as LF-29b and belong to the M2b session. Do not implement search, backlinks, page listing or block editing.

**Hard constraints (violating any one is failure):**
- **Implement the spec as written.** `doc/decision-object-model.md` §10 lists four open questions that are the owner's to settle. Do not resolve them unilaterally. If implementing reveals that the spec is *wrong* — not merely incomplete — stop and report rather than quietly diverging.
- **Never send `"data": []`.** It crashes the request (`api.clj:141`, filed as LF-29b). Refuse locally with a clear message.
- **Do not expose `relation`.** It must be a Clojure keyword and fails malli validation as a JSON string. Everything appends last.
- A read that resolves to nothing returns **200 with an empty body**, not 404. Handle it as "not found", not as success-with-content.
- Errors arrive as **plain text, often a 500 carrying the thrown message**. That text is the most useful thing in the response — pass it through, as the existing client already does.
- The daily-note title must come from the existing date helper: `LLLL dd, yyyy`, zero-padded day, server timezone. Do not reimplement it.
- No credentials in code, tests, or git.

**Validation of LF-37 (explicitly part of this task).** The spec's §11 defers its own acceptance to here: its payload shape and datalog were derived from the schema and the tasks precedent, and have never been exercised against a running server. So:

- Send the §8 example and confirm it produces the intended graph — properties present under the right keys, `alternatives` and `evidence` as children, page links live in `context` and `participants`.
- Confirm the free index works: after recording, the page `lorefold/decision` shows the decision as a linked reference (check in the browser; there is no API for backlinks yet).
- **If the real shape differs from §8, update `doc/decision-object-model.md` with what actually works and flag it prominently.** The spec serves the implementation, not the reverse.

**Verification protocol** (run what you can; report the rest as pending — never fake a result):
1. `npm run build` and `npx tsc --noEmit` clean; `npm test` green, including new unit tests for the decision payload builder and the effective-status logic.
2. The stdio server lists the full tool set with valid schemas.
3. Against the live stack: record a decision with every field populated; read it back with `lorefold_decisions`; confirm the properties survive a round trip.
4. Record a second decision that supersedes the first; confirm `lorefold_decisions` reports the first as superseded and names its successor.
5. Reject the bad cases cleanly: empty data, a missing required field, a malformed date, a `supersedes` uid that does not exist.
6. **The real test.** Record the LF-8 deployment-target decision — it is already written in `ops/RUNBOOK.md` §15 in exactly this shape (statement, status, date, context, rationale, alternatives with reasons, revisit trigger). It is a genuine decision, made under real constraints, and it is intended as the ledger's first entry. If the model cannot express it faithfully, that is a finding about the model, and more valuable than a passing test.

**Test-artifact discipline.** The M2a session left probe pages in the graph that could not be removed, because the API cannot delete. Prefix every throwaway write with `LF38 TEST` so it is findable, keep them on today's daily note rather than scattered, and list exactly what you left behind in your final report so it can be cleaned up in the browser.

**Deliverables:** the two tools committed and pushed, README updated, unit tests included. A final report covering which checks passed and which are pending, what the LF-8 recording exercise revealed about the model, any divergence between the spec and real API behaviour (with the doc updated), and the list of test artifacts left in the graph.
