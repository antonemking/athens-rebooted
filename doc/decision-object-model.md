# The decision object model (LF-37)

**Status:** Draft for review. Specification only — no implementation.
**Implements:** `BACKLOG.md` → LF-37. Consumed by LF-38 (`lorefold_decision_record`) and LF-33 (MCP v1 query tools).

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

Exactly what LF-38 sends to `POST /api/path/write` (JSON; muuntaja renders namespaced keywords as `"block/string"`-style strings):

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

## 11. Acceptance

Per LF-37: this spec, plus validation that the §8 example produces the intended graph through `internal-representation->atomic-ops`. That validation runs as part of LF-38, since it needs a live stack (`ops/RUNBOOK.md` §9) — the shape here is derived from the schema and the tasks precedent, and is unverified against a running server until then.
