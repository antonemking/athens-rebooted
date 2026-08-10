# Agent guide: Lorefold

Read this before touching anything. It encodes decisions that are already made and traps that are already mapped. `REBOOT.md` is the full investigation; this file is the operating manual.

## What this is

Lorefold is a **decision intelligence platform** built on a reboot of [Athens](https://github.com/athensresearch/athens) (YC W21, archived December 2022): a self-hosted, collaborative, event-sourced knowledge graph. ClojureScript + re-frame + DataScript frontend, Clojure JVM server, shared `.cljc` protocol layer.

The product thesis: organizations lose the *why* behind their decisions. Lorefold records **decisions as first-class typed objects linked to their evidence**, on a graph that is uid-addressed, datalog-queryable, and mutated through a small validated operation vocabulary — which also makes it unusually legible to AI agents. The differentiators are the decision ledger and the MCP bridge; note capture is a surface, not the category.

The name is **Lorefold** (decided). The upstream project is Athens; keep that provenance in prose, not in code churn.

## Guardrails

These are not suggestions. Each one is a decision with a reason.

1. **The rename is docs-and-brand only.** Do NOT rename `athens.*` Clojure namespaces, `:block/*` / `:node/*` attributes, the `athens/*` property-key convention, or the `[[athens/task]]` entity-type strings. Those names are load-bearing in the persisted event log, the wire protocol, and 166 tests. Renaming them buys nothing and risks the data.
2. **Never enable `:nrepl` in server config.** It starts an unauthenticated remote REPL, which is arbitrary code execution on a reachable host.
3. **Never commit tokens, passwords, or `CONFIG_EDN` with a real password.** Anything with credentials goes in `.env` (gitignored) or GitHub Actions secrets. Repo-write tokens for any future GitHub integration live server-side only, never in the browser.
4. **Electron is abandoned.** Web-first. Do not fix, build, or test the desktop app. Do not run `yarn dist`.
5. **Do not upgrade React, Reagent, Chakra, or framer-motion.** They form one atomic version knot (React 17 + Reagent 1.0 + Chakra 1 + framer-motion 6). Bump one and you must bump all four; it is a deliberate deferral, not an oversight.
6. **Do not touch `src/cljs/athens/views/**` or the editor** unless the task explicitly says so. There are zero tests over the view layer and the e2e suite has never run in CI, so regressions there are invisible.
7. **Preserve the EPL-1.0 license and attribution.** The license travels with the code.

## Build and test

```bash
# JVM tests — the fluree-tagged tests hang, so the exclusion is mandatory
clojure -X:test :excludes '[:fluree]'

# Browser tests
yarn components && yarn shadow-cljs compile karma-test && karma start --single-run

# Frontend build (web only)
yarn components && yarn shadow-cljs release app

# Server, against a running fluree
clojure -M:athens
```

Traps:

- **`yarn components` must run before any shadow-cljs build.** It babels `src/js/components/*.tsx` into `src/gen/`, which is gitignored *and* on the `deps.edn` classpath. Skipping it produces confusing classpath errors rather than a clear message.
- **Never run `yarn prod`.** It builds the two Electron targets alongside the web app. Use `shadow-cljs release app`.
- `ELECTRON_SKIP_BINARY_DOWNLOAD=1` on `yarn install`, or it fetches an Electron 12 binary you will never use.
- Node 16 (`.nvmrc`), Yarn v1, temurin 17 for the JVM. These are pinned to what the original CI proved; do not modernize opportunistically.
- CI is dead as inherited (GitHub retired the action versions). Do not try to repair `.github/workflows/build.yml` in place; it is replaced wholesale in LF-21.

## Where things live

| Concern | Path |
|---|---|
| Graph schema + ~90 query helpers | `src/cljc/athens/common_db.cljc` |
| The 12 atomic operations (entire write vocabulary) | `src/cljc/athens/common_events/graph/atomic.cljc` |
| Nested-tree → operations converter | `src/cljc/athens/common_events/bfs.cljc` |
| Operation resolvers (ops → DataScript) | `src/cljc/athens/common_events/resolver/atomic.cljc` |
| Wire schemas (malli) | `src/cljc/athens/common_events/schema.cljc` |
| Server entrypoint + component system | `src/clj/athens/self_hosted/core.clj` |
| Websocket + routes | `src/clj/athens/self_hosted/components/web.clj` |
| **REST API (feature-flagged off)** | `src/clj/athens/self_hosted/web/api.clj` |
| Event log (Fluree; the swap seam) | `src/clj/athens/self_hosted/event_log.clj` |
| Server config defaults | `src/clj/config.default.edn` |
| Ops, compose, backups | `ops/` |
| MCP bridge | `tools/lorefold-mcp/` |
| Decision object model | `doc/decision-object-model.md` |
| Client isolation and the channel model | `doc/client-channel-model.md` |

## Architecture facts worth knowing before you edit

- **State is a fold over an append-only log.** ADR 0018 (`doc/adr/`) is the constitution: operations may be added or loosened, never removed or tightened. The name Lorefold refers to this.
- **The client holds the whole graph.** On connect the server dumps every datom and the browser runs its own DataScript db. Reads never round-trip. This means backend work cannot fix page-open or search latency; those are client-rendering problems.
- **The REST API already exists** and is gated behind `:feature-flags {:api true}`. `POST /api/path/write` auto-creates missing pages, including today's daily note. Prefer extending it over inventing new transport.
- **`POST /api/path/write` can only append.** Writing an existing `:block/uid` through it resolves to a *move*, not an edit. Editing in place needs `build-block-save-op` (this is why LF-30 exists).
- **Daily note titles are `LLLL dd, yyyy` with a zero-padded day** ("August 09, 2026"). Get this wrong and you silently create duplicate daily pages.
- **`text-to-blocks` is an indentation parser, not a markdown parser.** Feeding it markdown turns `# Heading` into a hashtag link and creates spurious pages. There is no blocks→markdown serializer anywhere.
- **Auth is one optional shared password.** No accounts, no roles, no per-page permissions. Assume anything reachable is fully readable and writable by whoever can reach it.
- Dead dependencies, safe to remove: `highlight.js`, `react-highlight.js`, `codemirror`, `react-codemirror2`. Imported nowhere. Code blocks render unstyled today.

## Working conventions

- Branch from the current working branch; one logical change per PR.
- Every task in `BACKLOG.md` carries acceptance criteria. Satisfy them literally, and say plainly if you could not.
- Tasks marked **[HUMAN]** need a person: real infrastructure, secrets, a domain, or eyes on two browsers. Do not fake their verification. If you are blocked on one, finish everything that does not depend on it and report the gap.
- When a task's premise turns out to be wrong (this codebase has surprised us repeatedly), say so and stop rather than building on a bad assumption.
