# The decision object model (LF-37)

**Status:** Validated against a running server and implemented. See §11.
**Implements:** `BACKLOG.md` → LF-37. Consumed by LF-38 (`lorefold_decision_record`) and LF-33 (MCP v1 query tools).

> **Correction, 2026-08-10 (LF-38).** §8 said this payload is sent as JSON. It
> cannot be: **`block/properties` is unwritable over JSON**, and every example
> in this document originally failed with a 500 on the first attempt. The
> *shape* below is correct and verified; the *encoding* has to be EDN. §8 now
> carries both forms and the reason. Nothing else in this spec changed.

This is the thing that makes Lorefold a decision intelligence platform rather than a notes tool. Everything else in the roadmap is plumbing that serves this.

---

## 1. What a decision is here

A **decision** is a human organizational choice, recorded at the moment it is made, with the reasoning and evidence that produced it.

It is deliberately *not* the same object Semantica and similar frameworks call a decision. Those record what an **AI agent** concluded, for audit and provenance of model outputs. Lorefold records what **people** chose, so a team can answer "why is it like this?" a year later when everyone who was in the room has forgotten. Different object, different consumer, complementary rather than competing (see `REBOOT.md` §8, LF-36).

The three questions the model must answer:

1. **Why did we decide X?** → rationale, alternatives considered, evidence, participants.
2. **What decisions touch Y?** (a client, a project, a system) → context links.
3. **How did our thinking change?** → supersedes chains, plus the event log's own edit history.

## 2. Where decisions live

**A decision is a block, captured wherever you already are — normally today's daily note.** It is not a page, and it does not require navigating anywhere to record.

This is the right call on this substrate for three reasons: blocks are uid-addressed and individually deep-linkable (`#/page/<uid>`); capture-in-flow is the only capture that actually happens; and the graph does the organizing through backlinks, so a decision recorded in Monday's log is still reachable from the client page, the status, and every topic it references.

Corollary: **there is no decision index to maintain.** Because `:entity/type` carries the string `[[lorefold/decision]]`, the page `lorefold/decision` accrues every decision in the graph as a linked reference, automatically, via the linkmaker middleware. That page *is* the index.

## 3. Property schema

All properties ride the existing `:block/property-of` + `:block/key` model (`src/cljc/athens/common_db.cljc:33-47`). **Zero schema migration** — no new DataScript attributes, no server change.

The decision block's own `:block/string` is the decision statement, in plain declarative language: *"We will replace Fluree with SQLite for the event log."* No separate title property; the statement is the title.

| Property key | Required | Value | Notes |
|---|---|---|---|
| `:entity/type` | ✅ | `[[lorefold/decision]]` | The marker. Also produces the free index (§2). |
| `:decision/status` | ✅ | one of §4 | Plain string in v0 (see §7). |
| `:decision/date` | ✅ | `YYYY-MM-DD` | When it was **decided**, which is not when it was **recorded** — see §6. |
| `:decision/context` | ✅ | `[[Client]] [[Project]]` page links | The consultancy hook. Makes the client page a decision log. |
| `:decision/question` | ○ | text | What was actually being decided. Omit when the statement is self-evident. |
| `:decision/rationale` | ○ | text, children allowed | Why this, in prose. The single highest-value field — a decision without it is a fact, not a decision. |
| `:decision/alternatives` | ○ | children | One child per option considered, each stating why it lost. |
| `:decision/evidence` | ○ | children | One child per URL or `((block-ref))`. See §5. |
| `:decision/participants` | ○ | `[[Person]]` page links | Person pages become "decisions this person was part of". |
| `:decision/supersedes` | ○ | `((uid))` block refs | Points **backwards** only. See §6. |
| `:decision/review-on` | ○ | `YYYY-MM-DD` | For decisions taken under uncertainty that deserve revisiting. |

Only four fields are required. That is intentional: a capture path with ten mandatory fields does not get used, and a decision recorded with a statement, a status, a date and a client is already worth more than the same decision in someone's memory.

## 4. Status vocabulary

Closed set of four:

- **`proposed`** — under consideration, not yet binding.
- **`accepted`** — in force. The normal state.
- **`superseded`** — replaced by a later decision, which points at it via `:decision/supersedes`.
- **`reversed`** — undone, with no replacement. The team went back.

`superseded` and `reversed` are distinct on purpose: "we changed our approach" and "we abandoned the approach" are different histories, and conflating them destroys the most interesting signal in the ledger.

A rejected option is **not** a decision with a status — it belongs in the winning decision's `:decision/alternatives`. Otherwise the ledger fills with non-decisions and the index becomes noise.

## 5. Evidence

Evidence is a **link to where the thing actually lives**, never a copy of it.

- External systems → the URL: a Slack permalink, a PR, a Drive doc, a CI run.
- Inside the graph → a `((block-ref))`, which produces a real reference and therefore a backlink.

This is the concrete expression of the architecture bet in LF-35: bulk content stays in its source system, the graph holds decisions and pointers. It also means the entire decision layer works today with zero connectors — a Slack permalink pasted into an evidence child is a complete, functioning evidence link. Ingestion (LF-36) only ever makes capture *easier*; it is never a prerequisite.

## 6. Relations and time

**Store `supersedes`, derive `superseded-by`.** Only the backward pointer is written; the forward direction comes free from `:block/_refs` on the superseded decision. Storing both invites contradiction, and the graph already maintains reverse refs automatically.

**Two different timestamps, both needed:**

- `:decision/date` — when the decision was *made*. Asserted by the recorder, often backdated ("we settled this on Tuesday").
- The event log — when it was *recorded* and every subsequent edit, with author attribution, via `:block/create` and `:block/edits` → `:event/time` / `:event/auth`.

The second is free and automatic. It is also the answer to "how did our thinking change": every revision of a decision block is already an event in an append-only log. Nothing needs building for that — it is the property of the substrate that made Athens worth reviving.

## 7. What v0 deliberately omits

- **Status as a plain string, not a block-ref enum.** The tasks feature stores status as `((uid))` pointing at an enum block (`types/tasks/handlers.cljs`). That buys referential integrity and rename-safety; it costs a bootstrap step and makes every write two-phase. Skipped for v0 because `get-reactive-instances-of-key-value` already answers "all decisions with status X" directly. Promotion later is a mechanical migration along the tasks precedent.
- **No server-side decision endpoints.** v0 reads through `/api/path/read`. Query endpoints are M2b (LF-29).
- **All values are strings.** The property model has no number or date primitive. Dates are ISO strings and sort lexically, which is sufficient.
- **No access control.** There is none to have; see `REBOOT.md` §3.4.

## 8. Worked example

### 8.1 The shape

This is the internal representation LF-38 writes. It is verified against the
live M0 stack: sent as EDN it produces exactly the graph §3 describes, with the
properties under the right keys, `alternatives` and `evidence` as children, and
live page links in `context` and `participants`.

Shown here in JSON because it is easier to read, and because JSON is what the
rest of the API takes — but see §8.2 before sending it.

```json
{
  "path": [{"page/query": "@today"}],
  "data": [{
    "block/string": "We will replace Fluree with SQLite for the event log",
    "block/properties": {
      ":entity/type":           {"block/string": "[[lorefold/decision]]"},
      ":decision/status":       {"block/string": "accepted"},
      ":decision/date":         {"block/string": "2026-08-09"},
      ":decision/context":      {"block/string": "[[Lorefold]]"},
      ":decision/participants": {"block/string": "[[Tone]]"},
      ":decision/question":     {"block/string": "What backs the append-only event log now that Fluree v1 is abandoned?"},
      ":decision/rationale":    {"block/string": "The storage seam is four functions over (uuid, EDN-string) pairs in total order. SQLite implements it in ~150 lines, removes a container and the only abandoned dependency in the runtime path, and reduces backup to copying one file."},
      ":decision/alternatives": {"block/string": "", "block/children": [
        {"block/string": "Stay on fluree/ledger:1.0.0-beta17 — rejected: abandoned beta, pinned forever, cannot upgrade past a version that still ships curl"},
        {"block/string": "Postgres — rejected: a second container and a network hop for a single-writer append-only log"}
      ]},
      ":decision/evidence":     {"block/string": "", "block/children": [
        {"block/string": "https://github.com/antonemking/athens-rebooted/blob/main/REBOOT.md#7-technology-verdicts"}
      ]}
    }
  }]
}
```

Note the shape of a multi-value property: an empty `block/string` with `block/children`. The property block is the container; each child is one value.

Note also which properties are *not* multi-value. `context`, `participants` and `supersedes` take several values from the caller but render as **several links in one string** — `"[[Acme Corp]] [[Billing migration]]"`, `"((abc123456)) ((def789012))"`. That is what the example shows, and it is load-bearing: the superseded-by query in §9 matches `[?p :block/refs ?old]` on the **property block itself**, which only holds while the ref lives in that block's own string. Move those to children and the derived reverse direction silently stops working.

### 8.2 Send it as EDN. JSON does not work.

**A write carrying `block/properties` must use `Content-Type: application/edn`.** Over JSON it fails, always, with:

```
500 class clojure.lang.Keyword cannot be cast to class java.lang.Number
```

The mechanism, established against the live stack on 2026-08-10:

1. muuntaja keywordizes JSON object keys, so `":decision/status"` arrives as a Clojure **keyword** rather than a string.
2. `bfs/enhance-props` (`src/cljc/athens/common_events/bfs.cljc:41-45`) takes that key and uses it as a **page title**, building the property block's position as `{:relation {:page/title <key>}}`. A page title must be a string.
3. The resulting event fails malli validation — and malli's *error formatter* then throws while describing the failure, treating the keyword as a path index. The cast error is what reaches the client, so the response names neither the field nor the real cause.

Filed as `BACKLOG.md` → LF-29b (3). Until it is fixed, EDN is not a workaround to be tidied away later — it is the only way to write a property at all. The same payload in EDN, which is what the bridge actually sends:

```clojure
{:path [{:page/query "@today"}]
 :data [{:block/string "We will replace Fluree with SQLite for the event log"
         :block/properties
         {":entity/type"           {:block/string "[[lorefold/decision]]"}
          ":decision/status"       {:block/string "accepted"}
          ":decision/date"         {:block/string "2026-08-09"}
          ":decision/context"      {:block/string "[[Lorefold]]"}
          ":decision/participants" {:block/string "[[Tone]]"}
          ":decision/question"     {:block/string "What backs the append-only event log now that Fluree v1 is abandoned?"}
          ":decision/rationale"    {:block/string "The storage seam is four functions over (uuid, EDN-string) pairs in total order."}
          ":decision/alternatives" {:block/string ""
                                    :block/children [{:block/string "Stay on fluree/ledger:1.0.0-beta17 — rejected: abandoned beta"}
                                                     {:block/string "Postgres — rejected: a second container for a single-writer log"}]}
          ":decision/evidence"     {:block/string ""
                                    :block/children [{:block/string "https://github.com/antonemking/athens-rebooted/blob/main/REBOOT.md#7-technology-verdicts"}]}}}]}
```

The distinction JSON cannot express is visible here: the keys of a *node* map are keywords, the keys of the *properties* map are strings. Note that only the request has to be EDN — `Accept: application/json` still returns JSON, so a client needs an EDN writer and no EDN reader.

### 8.3 Filing a backdated decision

`:decision/date` is when the decision was *made*, and the block belongs on that day's daily note — which is usually not today. There is no `@yesterday`; the only query the server understands is the literal `"@today"`.

So a same-day decision is written to `{:page/query "@today"}`, letting the server's clock decide, and a backdated one is written to `{:page/title "August 09, 2026"}`. Addressing a past day by title is safe: the `:page/new` resolver derives a date-shaped title back to the canonical daily uid (`resolver/atomic.cljc:151`), so the page it creates is `08-09-2026` — the same page the calendar shows, not a duplicate. Verified. The title format has to be exactly `LLLL dd, yyyy` with a zero-padded day for that to hold.

## 9. Datalog

Written against the real schema. A property block `?p` has `:block/property-of` → its owner and `:block/key` → the *page* whose `:node/title` is the property name.

**All decisions.** (This is the `get-reactive-instances-of-key-value` pattern.)

```clojure
[:find ?d ?statement
 :where
 [?p :block/property-of ?d]
 [?p :block/key ?k]
 [?k :node/title ":entity/type"]
 [?p :block/string "[[lorefold/decision]]"]
 [?d :block/string ?statement]]
```

**Why did we decide X** — pull the whole decision once located by uid. `get-internal-representation` already returns the nested tree with `:block/properties` derived, so the MCP tool needs no bespoke query:

```clojure
(common-db/get-internal-representation @db [:block/uid "abc123456"])
```

**What decisions touch [[Acme Corp]]** — the reference may sit on a property block (`:decision/context`) or in the statement itself, so match both and walk up:

```clojure
[:find ?d ?statement
 :in $ ?title
 :where
 [?page :node/title ?title]
 (or-join [?d ?page]
   (and [?p :block/refs ?page]
        [?p :block/property-of ?d])
   [?d :block/refs ?page])
 [?t :block/property-of ?d]
 [?t :block/key ?tk]
 [?tk :node/title ":entity/type"]
 [?t :block/string "[[lorefold/decision]]"]
 [?d :block/string ?statement]]
```

**Open decisions by status:**

```clojure
[:find ?d ?statement
 :in $ ?status
 :where
 [?s :block/property-of ?d]
 [?s :block/key ?sk]
 [?sk :node/title ":decision/status"]
 [?s :block/string ?status]
 [?d :block/string ?statement]]
```

**Superseded-by, derived rather than stored** — who points at this decision:

```clojure
[:find ?newer ?statement
 :in $ ?uid
 :where
 [?old :block/uid ?uid]
 [?p :block/refs ?old]
 [?p :block/key ?k]
 [?k :node/title ":decision/supersedes"]
 [?p :block/property-of ?newer]
 [?newer :block/string ?statement]]
```

**How this decision evolved** — free from the event log:

```clojure
[:find ?ts ?author
 :in $ ?uid
 :where
 [?d :block/uid ?uid]
 [?d :block/edits ?ev]
 [?ev :event/time ?t]
 [?t :time/ts ?ts]
 [?ev :event/auth ?a]
 [?a :presence/id ?author]]
```

## 10. Open questions

1. **Vocabulary.** Are four statuses right? A `blocked`/`deferred` state is plausible for decisions waiting on someone else, but it risks becoming a task tracker — the line worth holding is that Lorefold records what was *chosen*, not what is *pending*.
2. **Is `:decision/context` required?** Marking it required makes every decision reachable from a client or project page, which is the consultancy value. It also adds friction to personal decisions with no client. Recommend keeping it required and using `[[Lorewood Labs]]` for internal ones.
3. **Participants as page links** creates a person page per collaborator. Valuable ("every decision Sarah was in"), but it puts client staff names in the graph — worth confirming against the data-discipline rule in `REBOOT.md` §9 before a client workspace exists.
4. **Decision granularity.** No guidance yet on what is too small to record. Likely answer after two weeks of live use, not before.

### Raised by real recordings (LF-38), not resolved here

Recording the LF-8 deployment-target decision — a genuine decision made under real constraints, written up in `ops/RUNBOOK.md` §15 — surfaced three places where the model does not quite fit a real decision. The independent validation pass (`doc/lf38-verification.md`) recorded two further genuine decisions and added a fourth. Stated as questions for the owner, deliberately not answered:

5. **`:decision/review-on` is a date, but real revisit conditions are events.** LF-8 says "revisit when M1 ships (TLS + telemetry strip), or a client workspace is provisioned — whichever comes first". There is no date that means that, and inventing one throws away the actual trigger. The recording put the trigger in the rationale prose, which preserves it for a human reader and hides it from every query. Options: allow `review-on` to hold a free-text trigger; add a separate `:decision/review-when`; or accept that triggers live in prose. This is the sharpest of the four — the field as specified could not express the real thing.

   **It is also the most repeatable.** The validation pass hit the same wall on every real decision it recorded — LF-8 again, plus the in-memory-dev-mode and tenancy-model decisions ("when M1 ships", "past ~50 tenants") — each time burying the trigger in prose. Three distinct real decisions, three conditional triggers, zero dates: not an edge case in the sample so far.

6. **A decision can create an obligation, and there is nowhere to put it.** LF-8 ends "follow-on this creates: pick the off-host backup target on the tailnet and wire it into the nightly job. Until that exists, backups are still single-disk and this decision is only half-realised." That is not an alternative, not evidence, and not a separate decision — it is unfinished work the decision produced. Adding a field for it walks toward the task tracker §4 deliberately refuses to become, so the tension is real and worth deciding on purpose rather than by omission.

7. **"The statement is the title" strains at length.** LF-8's statement is a full paragraph, because the decision genuinely has several inseparable parts (tailnet-only, bind to the tailnet interface, most always-on host, no VPS until M1). It records fine and reads fine in the block, but it is a poor title anywhere a decision gets listed. Either the model wants a short statement plus a longer `:decision/detail`, or listings need to truncate — currently they truncate nowhere.

   The validation pass reached the same place from the other direction and named the cause more precisely: LF-8 and the tenancy decision are each really *several sub-decisions* that happen to have been made together. Length is the symptom; compoundness is the thing. That matters for the fix — a `:decision/detail` field only tidies the display, while sub-decisions that can be superseded independently would need structure. Worth knowing which problem is being solved before adding a field.

8. **Correction and revision are the same operation, and they should not be.** Raised by the validation pass. Fixing a mis-capture — the agent recorded the decision wrongly — is not the same event as changing your mind, but `supersedes` is the only tool for both, so the ledger reads a typo and a reversal identically. Today the agent cannot edit in place at all (that is LF-30, M2b), so every correction inflates into a second decision object. Options: a distinct `:decision/corrects` relation; leave corrections to in-place edit once LF-30 lands and keep `supersedes` for genuine changes of mind; or accept the conflation and rely on reading the pair. Note the durability angle — on Fluree an in-browser edit is itself a logged event, so the original survives in the event log either way; with `:in-memory? true` there is no such trail.

## 11. Acceptance

Per LF-37: this spec, plus validation that the §8 example produces the intended graph through `internal-representation->atomic-ops`. That validation needed a live stack, so it ran as part of LF-38 on 2026-08-10 against the M0 stack (`ops/RUNBOOK.md` §9).

**Result: the shape is correct; the encoding in §8 was not.**

Confirmed against the running server:

- The §8 payload produces the intended graph — every property under its own key, `alternatives` and `evidence` as one child per value, `context` and `participants` as live page links that created the pages they name.
- The free index of §2 works. `lorefold/decision` and `Lorewood Labs` both exist as pages although no write ever named them; they exist *because* `[[lorefold/decision]]` and `[[Lorewood Labs]]` were parsed as page links from property strings, which is the same mechanism that produces the linked references. Seeing those references rendered in the browser is still a human check.
- Backdated filing lands on the existing daily page with the canonical uid (`08-09-2026`), not a duplicate — see §8.3.
- A full round trip survives: every property written was read back unchanged through `/api/path/read`.

Corrected as a result: §8 now specifies EDN and explains why (§8.2), and §8.3 documents backdated filing, which the original spec did not address.

Not verified, because no API exposes it: the datalog in §9 has still never been executed. It is written against the real schema, but the REST API returns internal representations rather than query results, so nothing in v0 can run it. It becomes testable with the query endpoints in M2b (LF-29).
