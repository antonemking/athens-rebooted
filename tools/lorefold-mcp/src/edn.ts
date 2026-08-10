/**
 * A minimal EDN writer (LF-38).
 *
 * ## Why this exists at all
 *
 * The bridge speaks JSON everywhere else, and JSON is the documented default of
 * the Lorefold API. But **`block/properties` cannot be written over JSON**, and
 * that is not a limitation of this bridge — it is a defect in the server.
 *
 * muuntaja keywordizes JSON object keys. A property map arrives as
 * `{:%3Adecision/status {...}}` — Clojure keywords — where `bfs/enhance-props`
 * expects the key to be a *page title string*: it builds the new block's
 * position as `{:relation {:page/title <key>}}`. A keyword there fails malli
 * validation, and then malli's own error formatter throws
 * `ClassCastException: Keyword cannot be cast to Number` while trying to
 * describe the failure. The request dies with a 500 carrying that cast message
 * and no hint of the real cause. Verified against the live M0 stack 2026-08-10;
 * see `doc/decision-object-model.md` §8 and `ops/RUNBOOK.md` §9.
 *
 * Sent as EDN the same key stays a string and the write succeeds. So writes
 * that carry properties go out as EDN. Everything else is unchanged, and the
 * *response* is still requested as JSON — content negotiation is per-direction,
 * so this module is a writer only. There is deliberately no EDN reader here.
 *
 * ## Scope
 *
 * Enough EDN to express a `path/write` body and nothing more: maps, vectors,
 * strings, keywords, booleans. No numbers, sets, symbols, tagged literals,
 * chars or nil — none of them appear in the payload, and supporting them would
 * invite this module to be mistaken for a general EDN library.
 */

export type EdnValue =
  | { t: 'kw'; name: string }
  | { t: 'str'; value: string }
  | { t: 'bool'; value: boolean }
  | { t: 'vec'; items: EdnValue[] }
  | { t: 'map'; entries: [EdnValue, EdnValue][] };

/**
 * A keyword. `name` is written after the colon verbatim, so it must already be
 * in `namespace/name` form — `block/string`, not `:block/string`.
 */
export function kw(name: string): EdnValue {
  if (name === '' || /[\s(){}[\]"',;`~^@\\]/.test(name) || name.startsWith(':')) {
    throw new EdnEncodeError(
      `Cannot write ${JSON.stringify(name)} as an EDN keyword. Keyword names ` +
        'are written after the colon, contain no whitespace or delimiters, and ' +
        'never start with a colon themselves.',
    );
  }
  return { t: 'kw', name };
}

export function str(value: string): EdnValue {
  return { t: 'str', value };
}

export function bool(value: boolean): EdnValue {
  return { t: 'bool', value };
}

export function vec(items: EdnValue[]): EdnValue {
  return { t: 'vec', items };
}

export function map(entries: [EdnValue, EdnValue][]): EdnValue {
  return { t: 'map', entries };
}

export class EdnEncodeError extends Error {
  override readonly name: string = 'EdnEncodeError';
}

/**
 * Serialises an EDN value.
 *
 * Strings go through `JSON.stringify`, which is not a shortcut: JSON's string
 * grammar is a subset of EDN's. It emits `\" \\ \n \r \t \b \f` and `\uXXXX`
 * for other control characters, all of which EDN reads identically, and leaves
 * non-ASCII as raw UTF-8, which EDN also accepts. A block string containing a
 * quote, a backslash or a newline therefore survives intact.
 */
export function writeEdn(value: EdnValue): string {
  switch (value.t) {
    case 'kw':
      return `:${value.name}`;
    case 'str':
      return JSON.stringify(value.value);
    case 'bool':
      return value.value ? 'true' : 'false';
    case 'vec':
      return `[${value.items.map(writeEdn).join(' ')}]`;
    case 'map':
      return `{${value.entries
        .map(([k, v]) => `${writeEdn(k)} ${writeEdn(v)}`)
        .join(', ')}}`;
  }
}
