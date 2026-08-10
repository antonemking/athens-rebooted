# The client channel model

**Status:** Decided. Mechanics implemented (`ops/RUNBOOK.md` §18); the decision
in §6 is **not yet in the ledger** — see §8.

**Relates to:** `REBOOT.md` §3.3, §3.4, §7.2, §9 · `doc/decision-object-model.md`
· `ops/RUNBOOK.md` §15 (LF-8), §18

---

## 1. The question

You work with several clients. You want one place that holds all of it, and you
want each client to see their own work and nothing else — a page the two of you
pass back and forth and edit together.

Those are two requirements, and on this substrate they pull in opposite
directions. This document records which way that tension gets resolved and what
it costs.

## 2. Why isolation can only be a second instance

There is no multi-tenancy and no permissions model:

- **One graph per server process** (`REBOOT.md` §3.3). The server holds a single
  DataScript db and a single event log.
- **One optional shared password for the whole server** (`REBOOT.md` §3.4). No
  accounts, no roles, no per-page permissions. The HTTP API never validates the
  username — it only uses it as the edit-attribution name. The browser's share
  button base64-encodes the password into a URL.
- **The client downloads the entire graph on connect.** Reads never round-trip,
  so there is no server-side filter to put a scope in.

Anything that can reach the port can read and write everything on that server.
So a boundary between two people is a boundary between two server processes.
There is no partial version of this, and building the real one — accounts,
roles, per-page scopes — is explicitly parked (`BACKLOG.md`, "Deliberately not
scheduled") because it is a months-long project on a codebase whose auth model
is one string in a config file.

## 3. What a second instance costs

The graphs cannot see each other. That is not a limitation of the deployment;
it is what makes it isolation.

Concretely, everything the decision layer relies on stops at the boundary:

- A browser connects to exactly one server. There is no multi-graph client and
  no aggregate view; two instances means two tabs.
- `[[ProMe]]` in one graph and `[[ProMe]]` in another are unrelated pages that
  happen to share a title. No backlink joins them.
- The free index of `doc/decision-object-model.md` §2 — the `lorefold/decision`
  page accruing every decision as a linked reference — is per-graph. Each
  instance gets its own partial index.
- Every datalog query in §9 of that document runs against one db.

Plus about **4 GB of RAM per instance**: two JVMs (athens at `-Xmx2560m`, plus
fluree's own heap), neither of which scales down when idle.

So "an instance per client, and I see all of them" is not a configuration
that was missed. It is the one thing this architecture cannot do.

## 4. The resolution: the client instance is a channel

Invert which side splits.

**Your workspace never splits.** One graph, every client, the whole ledger.
Backlinks work, the free index works, "what did we decide for this client"
works, because it is all one db. This is the product; it stays whole.

**The client instance is a channel, not a workspace.** It holds the page the two
of you pass back and forth, and close to nothing else. It is deliberately thin
— the piece of paper, not the client's second brain. Its graph being partial
does not matter, because nobody queries a piece of paper.

**The agent is the bridge.** The MCP bridge is configured per-instance
(`LOREFOLD_URL`, `LOREFOLD_PASSWORD`, `LOREFOLD_USERNAME` —
`tools/lorefold-mcp/src/config.ts`), so registering it twice gives an agent that
reads the channel and writes the durable record into *your* ledger:

```
lorefold_page_read     → against the channel instance   (what did we agree?)
lorefold_decision_record → against your workspace       (:decision/context [[ProMe]],
                                                         :decision/evidence ((uid)))
```

That is `lorefold_decision_record` doing exactly what it already does. No new
tool, no sync layer, no mirroring.

### What this trades away

**Anything left in the channel is invisible to your queries.** The graphs do not
merge; carrying a decision across is an act, not a background process. If the
carry-across does not happen the ledger silently has a hole in it, and the hole
looks exactly like "no decision was made".

That is a discipline problem rather than an architecture problem, which is why
it is the acceptable one — but it is real, and it is the thing to watch during
the first weeks of live use.

## 5. Why not the alternatives

**One graph, filtered per client.** The permissions model does not exist and is
parked. This is the honest answer, not a temporary one.

**Bidirectional mirroring between instances.** Turns a channel into a
distributed-systems problem — conflict resolution across two event logs with
last-write-wins semantics and no CRDT (`REBOOT.md` §3.5). It buys convenience
and costs correctness in the one place correctness is the whole point.

**A full workspace per client, and you keep N tabs.** Fragments the ledger,
which is the product. Reasonable if the client genuinely needs their own
knowledge base; that is a different offering from this one.

## 6. The decision

```
Decision: Client isolation is a separate Lorefold instance per client, and
          that instance is a CHANNEL rather than a workspace: it holds only
          the pages shared with that client. The Lorewood Labs workspace
          stays a single graph holding every client, and the MCP bridge —
          registered once per instance — carries decisions from a channel
          into that one ledger.

Status:   accepted
Date:     2026-08-10
Context:  [[Lorefold]] [[Lorewood Labs]]

Question: How does a client get access to their own work without seeing
          other clients', on a substrate with one shared password and no
          per-page permissions?

Rationale:
  Isolation can only be a process boundary here: one graph per server
  process, one shared password per server, no accounts and no per-page
  permissions, and the client downloads the whole graph on connect. There
  is nowhere to put a scope.

  Given that, the question is which side splits. Splitting the ledger
  destroys the product — backlinks, the free lorefold/decision index and
  every decision query are per-graph, so N client workspaces means N
  partial ledgers and no aggregate view, because a browser connects to
  exactly one server. Splitting the CHANNEL costs almost nothing, because
  a shared page is a conversation and nobody queries a conversation.

  The bridge already spans instances: it is configured per-instance and
  lorefold_decision_record writes wherever it is pointed. So the durable
  record lands in the one ledger with :decision/context naming the client
  and :decision/evidence pointing back at the channel block, and nothing
  new has to be built.

Alternatives considered:
  One graph filtered per client — rejected: no permissions model exists,
  and building one (accounts, roles, per-page scopes) is parked as
  months of work on a codebase whose entire auth model is one config
  string.

  Bidirectional mirroring between instances — rejected: makes a shared
  page a distributed-systems problem across two event logs with
  last-write-wins and no CRDT. Buys convenience, costs correctness.

  A full workspace per client, N tabs for the consultant — rejected:
  fragments the ledger, which is the product. Revisit only if a client
  needs their own knowledge base, which is a different offering.

Accepted cost:
  Channel content is invisible to the workspace's queries until an agent
  or a person carries it across. A missed carry-across leaves a hole in
  the ledger that looks identical to "no decision was made".

Revisit when: a real permissions model exists, or the practice passes
  roughly 10 concurrent client channels, whichever comes first. Both
  change the arithmetic — the first removes the constraint that forced
  this, the second makes per-instance RAM and ops the binding cost.

Follow-on this creates: decide what carries a decision out of a channel
  and into the ledger — agent on a schedule, agent on demand, or by
  hand — and make it a named habit. Until that exists the accepted cost
  above is unmanaged rather than accepted.
```

Three things in that block have no home in the schema of
`doc/decision-object-model.md` — the conditional `revisit when`, the
`follow-on`, and the `accepted cost`. Those are open questions 5 and 6 in §10 of
that document, hit again here, which makes this the fourth real decision to run
into them. When recorded (§8) they go into `:decision/rationale` as prose, where
a reader finds them and a query does not.

## 7. Where this goes if it becomes a product

Under this model the paying tenant is the **consultant**, not the client. You
would sell one full workspace per consultant, plus N thin channels — and a
channel is a far smaller object than a full Athens instance.

That reframes the SaaS question. It is not "how do we run a thousand graphs",
it is "how do we give someone a scoped view onto one graph" — which is the
permissions model again. **SaaS is gated on permissions, not on tenancy.**

Container-per-tenant holds until roughly 50 tenants, at which point
`REBOOT.md` §7.2 rewrite trigger 3 fires by prior agreement ("hosting economics
at 50+ tenants, where BEAM-style multi-tenancy would beat container-per-client").
Nothing here is a surprise to that plan; this document just says which object is
per-tenant.

## 8. Not done: this decision is not in the ledger

It should be recorded through the bridge, against the Lorewood Labs workspace,
using the §6 content. It has not been, because that needs a running stack.

Note the precedent: a tenancy/aggregation-model decision *was* recorded during
the LF-38 verification pass — into an in-memory graph, so it vanished
(`doc/lf38-verification.md`, "Test artifacts"). This document exists partly so
the reasoning survives the second time.

```
lorefold_decision_record
  statement:    "Client isolation is a separate Lorefold instance per client, and that
                 instance is a channel rather than a workspace: the Lorewood Labs
                 workspace stays one graph holding every client, and the MCP bridge
                 carries decisions from a channel into that ledger."
  status:       accepted
  date:         2026-08-10
  context:      ["[[Lorefold]]", "[[Lorewood Labs]]"]
  question:     "How does a client get access to their own work without seeing other
                 clients', on a substrate with one shared password and no per-page
                 permissions?"
  rationale:    <the Rationale block above, plus Accepted cost, Revisit when and
                 Follow-on as trailing paragraphs — they have no fields of their own>
  alternatives: ["One graph filtered per client — rejected: no permissions model exists
                  and building one is parked as months of work.",
                 "Bidirectional mirroring between instances — rejected: makes a shared
                  page a distributed-systems problem across two last-write-wins event
                  logs.",
                 "A full workspace per client, N tabs for the consultant — rejected:
                  fragments the ledger, which is the product."]
  evidence:     ["https://github.com/antonemking/athens-rebooted/blob/main/doc/client-channel-model.md",
                 "https://github.com/antonemking/athens-rebooted/blob/main/ops/RUNBOOK.md#18-a-second-workspace-provisioning-a-client-channel"]
  participants: ["[[Tone]]"]
```

Before running it, confirm the stack is Fluree-backed and **not** in-memory —
that is the failure that lost the last one. `docker compose ... config | grep
CONFIG_EDN` must not contain `:in-memory?`.
