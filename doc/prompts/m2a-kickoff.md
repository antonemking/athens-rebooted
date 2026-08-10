# M2a kickoff prompt (for a fresh agent session)

Precondition: `main` contains the merged M0 work (`ops/RUNBOOK.md`, `ops/compose.m0.yml`). Ideally the M0 stack is running and reachable, so the agent can verify against it live; the prompt degrades honestly if not.

Fill in `LOREFOLD_URL` if the stack is not at `http://localhost:3010`.

---

**GOAL:** Build the Lorefold MCP bridge v0 — a TypeScript MCP server that lets Claude read and write the knowledge graph through the REST API that already exists in the running M0 stack. This is milestone M2a, tasks LF-9 through LF-14. No changes to the Clojure server; no compilation of the graph app.

**Read first, in this order:** `AGENTS.md` (guardrails — binding), `BACKLOG.md` Epic C (LF-9 to LF-15 — the task specs), and **`ops/RUNBOOK.md` sections 9 and 14** (the REST API smoke test and security posture — these were written against the real running stack, so trust them over any example elsewhere, including this prompt). Skim `REBOOT.md` section 4 for why the API exists at all.

**Scope — six tasks, all inside `tools/lorefold-mcp/`:**
1. **LF-9** Scaffold: TypeScript, `@modelcontextprotocol/sdk`, stdio transport, config strictly from env (`LOREFOLD_URL`, `LOREFOLD_USERNAME`, `LOREFOLD_PASSWORD`), package.json + tsconfig + build script + README with the `claude mcp add` line.
2. **LF-10** REST client module wrapping `POST /api/path/read` and `/api/path/write` with HTTP Basic auth. Own the JSON key mapping in exactly one place — muuntaja emits namespaced keywords as `"page/title"`-style strings. Errors must surface the server's rejection reason, not a generic failure.
3. **LF-11** Markdown ↔ internal-representation codec. Indented `- ` lists ↔ `:block/string` / `:block/children`. Rendering IR to a markdown outline for agent consumption is the primary direction.
4. **LF-12** Daily-note date helper. Title format `LLLL dd, yyyy` with a **zero-padded day** ("August 09, 2026"), matching the server's timezone.
5. **LF-13** The v0 tools: `lorefold_daily_append`, `lorefold_page_read` (IR plus rendered markdown), `lorefold_page_write` (path upsert), `lorefold_page_create`. Zod schemas; descriptions written for a model to read; errors that say what to fix.
6. **LF-14** Vitest unit tests over codec, dates, and client. No live server required to run them.

LF-15 is human — leave it.

**Out of scope — do not touch:** anything in `src/`, `ops/`, `deps.edn`, `package.json` at the repo root, or the decision layer (LF-35 to LF-38, Epic D). Do not add server endpoints; search, backlinks, page listing, and in-place block edit are M2b (LF-29 to LF-31) and deliberately absent here.

**Hard constraints (violating any one is failure):**
- **Config from env only.** No credentials in code, in tests, or in git. No `.env` committed.
- **`path/write` can only append.** Writing an existing `:block/uid` through it resolves to a *move*, not an edit — verified in the resolver. Do not attempt in-place edits; that is LF-30 in M2b.
- **The daily title's day is zero-padded**, and must agree with the server's `TZ` (set in `ops/.env`). Getting this wrong silently creates duplicate daily pages, which is a data problem, not a display bug.
- **The codec is not a general markdown parser** and must never be used to round-trip arbitrary files. Say so in a code comment; `AGENTS.md` explains why.
- **Do not invent API shapes.** The path grammar is: roots `{:page/title ...}` / `{:block/uid ...}` / `{:page/query "@today"}` (only the literal `"@today"` is supported), selectors `{:block/string ...}` / `{:block/key ...}`. If you need something outside that, stop and report rather than guessing.
- The bridge talks to a server whose auth is one shared password and which has no per-page permissions. Do not build anything that assumes otherwise.

**Verification protocol** (run what you can; report the rest as pending — never fake a result):
1. `npm run build` succeeds; `npx tsc --noEmit` clean.
2. `npm test` green — codec round-trips nested outlines, date helper handles single-digit days, month boundaries, and an explicit non-local TZ; client key-mapping tested both directions.
3. Server starts over stdio and lists exactly the four tools with valid schemas.
4. **Against a live stack** (default `http://localhost:3010`, credentials from env): `lorefold_daily_append` writes to today's page; `lorefold_page_read` reads it back; `lorefold_page_create` makes a new page; a bad password produces a clear auth error, not a crash.
5. Confirm the daily page the tool targets is the same page the browser shows for today — the zero-padding and TZ trap in one check.

If the stack is unreachable from your environment, complete 1-3, mark 4-5 pending with the exact commands to run, and say so plainly.

**Deliverables:** `tools/lorefold-mcp/` committed and pushed, with a README covering env setup, `claude mcp add`, and the four tools. A final report listing which checks passed and which are pending, plus anything that contradicts `BACKLOG.md`, `REBOOT.md`, or `ops/RUNBOOK.md` — if the API behaves differently than documented, update the doc with evidence and flag it prominently rather than coding around it.
