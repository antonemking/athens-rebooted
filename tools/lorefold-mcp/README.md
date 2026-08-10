# lorefold-mcp

An MCP server that lets Claude read and write a self-hosted Lorefold knowledge
graph. It is a thin bridge over the REST API the Lorefold server already
exposes — it adds no endpoints, needs nothing compiled, and touches no
ClojureScript.

Milestone M2a, tasks LF-9 through LF-14. Verified against the M0 stack on
2026-08-10.

## What it can and cannot do

Four tools:

| Tool | What it does |
|---|---|
| `lorefold_daily_append` | Appends blocks to today's daily note, creating the page on the day's first write. |
| `lorefold_page_read` | Reads a page or block by exact title, by block uid, or as today's note. Returns a markdown outline *and* the raw internal representation, which carries the block uids. |
| `lorefold_page_write` | Appends blocks at any path, creating the page and any intermediate blocks that are missing. |
| `lorefold_page_create` | Creates a new page, optionally with starting content. Refuses to write over an existing one. |

**Everything here appends.** Nothing edits or deletes. This is not a design
choice of the bridge: `POST /api/path/write` is the only write endpoint the
server has, and passing it an existing `block/uid` resolves to a *move*, not an
edit. In-place editing needs a server endpoint that does not exist yet (LF-30).

There is also **no search, no backlinks and no page listing**, so a page title
has to be exact. Those are M2b (LF-29 to LF-31).

## Setup

Requires Node 18 or newer. Note that the repository's `.nvmrc` pins Node 16 for
the ClojureScript build — that pin is for `shadow-cljs`, and the MCP SDK cannot
run on it. Use a newer Node for this directory only; nothing here shares a
toolchain with the rest of the repo.

```bash
cd tools/lorefold-mcp
npm install
npm run build
```

### Configuration

All configuration is environment variables. There is no config file and no
default credential — see guardrail 3 in `AGENTS.md`.

| Variable | Required | Meaning |
|---|---|---|
| `LOREFOLD_URL` | no | Base URL of the server. Defaults to `http://localhost:3010`. |
| `LOREFOLD_USERNAME` | **yes** | The presence name writes are attributed to. Not an account — the server has none. It must not be blank; the server answers 401 to a blank username even with the right password. |
| `LOREFOLD_PASSWORD` | usually | The single shared graph password, i.e. `ATHENS_PASSWORD` from `ops/.env`. Omit only if the server runs without a `:password`. |
| `LOREFOLD_TZ` | recommended | IANA timezone for naming daily notes. **Must match the `TZ` set for the Lorefold container in `ops/.env`.** Defaults to the host timezone. |

`LOREFOLD_USERNAME` is worth choosing deliberately: it is what shows up in an
open browser as the author of each write, so `claude` reads better than
`api-user`.

### Register with Claude Code

```bash
claude mcp add lorefold \
  --env LOREFOLD_URL=http://localhost:3010 \
  --env LOREFOLD_USERNAME=claude \
  --env LOREFOLD_PASSWORD="$ATHENS_PASSWORD" \
  --env LOREFOLD_TZ=America/New_York \
  -- node /absolute/path/to/Lorefold/tools/lorefold-mcp/dist/index.js
```

Use an absolute path to `dist/index.js`; the server is launched from whatever
directory the client happens to be in. Read the password from the environment
rather than typing it — `claude mcp add` stores what you give it, and a literal
password on that line lands in your shell history.

Verify with `claude mcp list`, which should show `lorefold` connected, and then
ask Claude to read today's note.

## The markdown dialect is narrow, on purpose

Blocks are written and read as an indented `- ` outline, two spaces per level:

```
- Decision: use the existing REST API
  - Because it already ships
  - Alternatives considered
    - A new websocket op
```

**This is not general markdown and must never be used to round-trip markdown
files.** A Lorefold page is a tree of block strings; headings, code fences,
tables and quotes have no representation and survive only as literal text. The
sharp edge is that `# Heading` is a *hashtag* to the server: writing it creates
a page named after the rest of the line. `[[Wiki links]]` do the same, which is
normal and useful when you mean it. The tools tell you when a write contains
one.

What the codec drops, in both directions:

- **Block uids**, when parsing markdown. Parsed blocks are always new blocks;
  you cannot address an existing one through markdown. Read the IR for uids.
- **Collapse state** (`block/open?`). No bullet syntax for it.
- **Properties**, when rendering. They have no honest bullet syntax, so
  `lorefold_page_read` reports how many exist and leaves them in the JSON
  rather than inventing one.
- **Multi-line block strings**, when round-tripping. A block whose text
  contains a newline renders across several lines and re-parses as parent plus
  children. This is the only round trip the codec cannot make.

Leading whitespace inside a block, and a literal leading `- `, both survive.

## Daily notes and the timezone coupling

Daily pages are titled `LLLL dd, yyyy` with a **zero-padded** day — `August 09,
2026`, never `August 9, 2026`. Nothing enforces one page per day, so an
unpadded title does not fail: it silently creates a second daily note that no
calendar view will show.

Writes therefore never name the daily page. They use the path root
`{"page/query": "@today"}` and let the server resolve the day from its own
container clock, which removes the failure mode entirely. `LOREFOLD_TZ` exists
so the bridge can *report* which page that is, and so it can compare its own
answer against the title the server returned. When those disagree,
`lorefold_daily_append` says `TIMEZONE MISMATCH` loudly — that is the only
reliable detector of `LOREFOLD_TZ` drifting from the container's `TZ`.

## Security posture you are inheriting

The Lorefold server has one shared password, no accounts, no roles and no
per-page permissions, and M0 speaks plain HTTP. Anything that can reach the
port can read and write the entire graph, and the password crosses the wire
base64-encoded on every call. This bridge cannot improve on that and does not
pretend to; see section 14 of `ops/RUNBOOK.md` before pointing it at anything
that matters.

## Development

```bash
npm test           # vitest; no server required
npm run typecheck  # tsc --noEmit
npm run build      # tsc -> dist/
```

| File | Responsibility |
|---|---|
| `src/config.ts` | Environment parsing, with errors that name the variable to fix. |
| `src/client.ts` | The two REST endpoints, HTTP Basic auth, and **the only place that knows the server's JSON key spellings** (`page/title`, `block/open?`). |
| `src/codec.ts` | Markdown outline ↔ internal representation. |
| `src/dates.ts` | Daily-note titles and uids. |
| `src/tools.ts` | The four tools, their schemas and their error messages. |
| `src/index.ts` | stdio entrypoint. |

### Server behaviour worth knowing before you extend this

Established empirically against the live M0 stack, and not all of it obvious
from the source:

- A read of a path that resolves to nothing is **HTTP 200 with an empty body** —
  not `null`, not 404. `readPath` maps it to `null`.
- Errors are **plain text, not JSON**: `401 access denied`,
  `500 Cannot resolve title.` There is no exception middleware, so a rejected
  request surfaces as a 500 carrying the message of the thrown `ex-info`. That
  text is the most useful thing in the response and is passed through verbatim.
- `write` with an empty `data` array **crashes the server** with a
  `ClassCastException` rather than no-opping (`api.clj` builds an `ex-info` with
  a vector where a map belongs). The client refuses the call locally instead.
- `write` accepts a `relation`, but only as a Clojure keyword. Sent over JSON it
  arrives as a string and fails malli validation with `500 Invalid event`. It is
  deliberately not exposed, so every write appends last. Use EDN content
  negotiation if you ever need it.
- The path grammar is closed: roots `{page/title}`, `{block/uid}`,
  `{page/query: "@today"}` — only that literal query string — and selectors
  `{block/string}`, `{block/key}`. Anything else is a 500. Do not guess at
  extensions; add them to the server instead.
