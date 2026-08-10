/**
 * REST client for the Lorefold path API (LF-10).
 *
 * Two endpoints exist and no others:
 *
 *   POST /api/path/read   {path}               -> internal representation
 *   POST /api/path/write  {path, data}         -> internal representation at path
 *
 * Both are POST. `/read` is a POST too — the path is a JSON body, never a URL.
 *
 * ## The key mapping lives here and nowhere else
 *
 * The server is Clojure and its data is keyed by namespaced keywords
 * (`:page/title`, `:block/string`). muuntaja renders those into JSON as plain
 * strings that keep the namespace: `"page/title"`, `"block/string"`, and — note
 * the question mark survives — `"block/open?"`.
 *
 * Rather than let `"block/string"` string literals leak through the codebase,
 * this module is the single translation layer: everything above it works with
 * ordinary camelCase TypeScript objects (`IRBlock`, `Path`), and `WIRE` below is
 * the only place that knows the server's spellings.
 *
 * ## Things the server does that you have to know
 *
 * - A read of a path that resolves to nothing returns **HTTP 200 with an empty
 *   body**, not `null` and not a 404. `readPath` maps that to `null`.
 * - Errors come back as **plain text**, not JSON: `401 "access denied"`,
 *   `500 "Cannot resolve title."`. The text is the server's actual rejection
 *   reason and is worth far more than a generic failure, so it is carried
 *   verbatim on the thrown error.
 * - `write` with an empty `data` array crashes the server with a ClassCastException
 *   (it builds an `ex-info` with a vector where a map belongs). Guarded here.
 * - `write` accepts an optional `relation`, but only as a Clojure keyword. Sent
 *   over JSON it arrives as a string and the event fails malli validation with
 *   `500 "Invalid event"`. It is therefore deliberately not exposed; every write
 *   appends last. Verified against the live M0 stack on 2026-08-10.
 * - **`block/properties` cannot be written over JSON at all** (LF-38). The same
 *   keywordization that breaks `relation` breaks property keys, which must
 *   reach the server as page-title *strings*. `writePath` therefore switches
 *   the request body to EDN whenever the data carries properties. See `edn.ts`
 *   for the full mechanism. Responses are still requested as JSON, so only the
 *   encoding of the request changes.
 */

import { kw, map, str, vec, writeEdn, bool, type EdnValue } from './edn.js';
import type { LorefoldConfig } from './config.js';

/* ------------------------------------------------------------------ *
 * Wire keys — the single source of truth for the server's spellings.
 * ------------------------------------------------------------------ */

export const WIRE = {
  pageTitle: 'page/title',
  pageQuery: 'page/query',
  blockUid: 'block/uid',
  blockString: 'block/string',
  blockKey: 'block/key',
  blockChildren: 'block/children',
  blockOpen: 'block/open?',
  blockProperties: 'block/properties',
} as const;

/* ------------------------------------------------------------------ *
 * Internal representation, in TypeScript terms.
 * ------------------------------------------------------------------ */

export interface IRBlock {
  /** Server-assigned 9-character id. Absent on data you are about to write. */
  uid?: string;
  /** The block's text. */
  string?: string;
  /** Collapse state. The server only emits it when the block is collapsed. */
  open?: boolean;
  children?: IRBlock[];
  /** Property blocks, keyed by property name. Read-mostly; see codec.ts. */
  properties?: Record<string, IRBlock>;
}

export interface IRPage {
  title: string;
  children?: IRBlock[];
  properties?: Record<string, IRBlock>;
}

export type IRNode = IRPage | IRBlock;

export function isPage(node: IRNode): node is IRPage {
  return typeof (node as IRPage).title === 'string';
}

/* ------------------------------------------------------------------ *
 * Path grammar. This is the whole grammar; there is nothing else.
 * ------------------------------------------------------------------ */

/** The first element of a path. Resolves to a page or a block. */
export type PathRoot =
  | { pageTitle: string }
  /** Only the literal "@today" is supported. Anything else is a 500. */
  | { pageQuery: '@today' }
  | { blockUid: string };

/** Subsequent elements. Each descends one level from the previous. */
export type PathSelector =
  /** First child whose text is exactly this string. */
  | { blockString: string }
  /** The property block under this key. */
  | { blockKey: string };

export type Path = [PathRoot, ...PathSelector[]];

/* ------------------------------------------------------------------ *
 * Encoding / decoding.
 * ------------------------------------------------------------------ */

type WireMap = Record<string, unknown>;

export function encodeNode(node: IRNode): WireMap {
  const out: WireMap = {};

  if (isPage(node)) {
    out[WIRE.pageTitle] = node.title;
  } else {
    if (node.uid !== undefined) out[WIRE.blockUid] = node.uid;
    if (node.string !== undefined) out[WIRE.blockString] = node.string;
    if (node.open !== undefined) out[WIRE.blockOpen] = node.open;
  }

  if (node.children !== undefined) {
    out[WIRE.blockChildren] = node.children.map(encodeNode);
  }
  if (node.properties !== undefined) {
    const props: WireMap = {};
    for (const [key, value] of Object.entries(node.properties)) {
      props[key] = encodeNode(value);
    }
    out[WIRE.blockProperties] = props;
  }

  return out;
}

export function decodeNode(wire: unknown): IRNode {
  if (wire === null || typeof wire !== 'object' || Array.isArray(wire)) {
    throw new LorefoldProtocolError(
      `Expected an internal-representation object from the server, got ${describe(wire)}.`,
    );
  }
  const w = wire as WireMap;

  const children = w[WIRE.blockChildren];
  const decodedChildren = Array.isArray(children)
    ? children.map((child) => decodeNode(child) as IRBlock)
    : undefined;

  const rawProps = w[WIRE.blockProperties];
  let decodedProps: Record<string, IRBlock> | undefined;
  if (rawProps !== null && typeof rawProps === 'object' && !Array.isArray(rawProps)) {
    decodedProps = {};
    for (const [key, value] of Object.entries(rawProps as WireMap)) {
      decodedProps[key] = decodeNode(value) as IRBlock;
    }
  }

  const title = w[WIRE.pageTitle];
  if (typeof title === 'string') {
    const page: IRPage = { title };
    if (decodedChildren) page.children = decodedChildren;
    if (decodedProps) page.properties = decodedProps;
    return page;
  }

  const block: IRBlock = {};
  if (typeof w[WIRE.blockUid] === 'string') block.uid = w[WIRE.blockUid] as string;
  if (typeof w[WIRE.blockString] === 'string') block.string = w[WIRE.blockString] as string;
  if (typeof w[WIRE.blockOpen] === 'boolean') block.open = w[WIRE.blockOpen] as boolean;
  if (decodedChildren) block.children = decodedChildren;
  if (decodedProps) block.properties = decodedProps;
  return block;
}

/** True when this node, or anything under it, carries a property block. */
export function carriesProperties(node: IRNode): boolean {
  if (node.properties !== undefined && Object.keys(node.properties).length > 0) return true;
  return (node.children ?? []).some(carriesProperties);
}

/* ------------------------------------------------------------------ *
 * EDN encoding, used only for writes that carry properties.
 *
 * This mirrors `encodeNode` exactly, with one difference that is the entire
 * reason it exists: the keys of a node map are *keywords*, while the keys of
 * the `block/properties` map are *strings*. JSON cannot express that
 * distinction, which is why property writes fail over JSON.
 * ------------------------------------------------------------------ */

export function ednNode(node: IRNode): EdnValue {
  const entries: [EdnValue, EdnValue][] = [];

  if (isPage(node)) {
    entries.push([kw(WIRE.pageTitle), str(node.title)]);
  } else {
    if (node.uid !== undefined) entries.push([kw(WIRE.blockUid), str(node.uid)]);
    if (node.string !== undefined) entries.push([kw(WIRE.blockString), str(node.string)]);
    if (node.open !== undefined) entries.push([kw(WIRE.blockOpen), bool(node.open)]);
  }

  if (node.children !== undefined) {
    entries.push([kw(WIRE.blockChildren), vec(node.children.map(ednNode))]);
  }
  if (node.properties !== undefined) {
    entries.push([
      kw(WIRE.blockProperties),
      // Property keys stay strings. This is the whole point.
      map(Object.entries(node.properties).map(([key, value]) => [str(key), ednNode(value)])),
    ]);
  }

  return map(entries);
}

function ednWireMap(wire: WireMap): EdnValue {
  return map(
    Object.entries(wire).map(([key, value]) => [kw(key), str(value as string)]),
  );
}

/** The EDN body for `POST /api/path/write`. */
export function encodeWriteBodyEdn(path: Path, data: IRNode[]): string {
  return writeEdn(
    map([
      [kw('path'), vec(encodePath(path).map(ednWireMap))],
      [kw('data'), vec(data.map(ednNode))],
    ]),
  );
}

export function encodePathRoot(root: PathRoot): WireMap {
  if ('pageTitle' in root) return { [WIRE.pageTitle]: root.pageTitle };
  if ('pageQuery' in root) return { [WIRE.pageQuery]: root.pageQuery };
  if ('blockUid' in root) return { [WIRE.blockUid]: root.blockUid };
  throw new LorefoldProtocolError(
    `Unsupported path root ${JSON.stringify(root)}. Valid roots are ` +
      '{pageTitle}, {blockUid}, or {pageQuery: "@today"}.',
  );
}

export function encodePathSelector(selector: PathSelector): WireMap {
  if ('blockString' in selector) return { [WIRE.blockString]: selector.blockString };
  if ('blockKey' in selector) return { [WIRE.blockKey]: selector.blockKey };
  throw new LorefoldProtocolError(
    `Unsupported path selector ${JSON.stringify(selector)}. Valid selectors are ` +
      '{blockString} and {blockKey}.',
  );
}

export function encodePath(path: Path): WireMap[] {
  const [root, ...selectors] = path;
  if (root === undefined) {
    throw new LorefoldProtocolError('A path needs at least a root element.');
  }
  return [encodePathRoot(root), ...selectors.map(encodePathSelector)];
}

/** Human-readable rendering of a path, for error messages. */
export function describePath(path: Path): string {
  return encodePath(path)
    .map((segment) => JSON.stringify(segment))
    .join(' > ');
}

/* ------------------------------------------------------------------ *
 * Errors.
 * ------------------------------------------------------------------ */

export class LorefoldError extends Error {}

/** The server said no, and said why. `serverMessage` is its own words. */
export class LorefoldApiError extends LorefoldError {
  override readonly name: string = 'LorefoldApiError';
  constructor(
    readonly status: number,
    readonly endpoint: string,
    readonly serverMessage: string,
    message: string,
  ) {
    super(message);
  }
}

/** 401. Wrong password, or a blank username, which the server also rejects. */
export class LorefoldAuthError extends LorefoldApiError {
  override readonly name: string = 'LorefoldAuthError';
}

/** Could not reach the server at all. */
export class LorefoldNetworkError extends LorefoldError {
  override readonly name: string = 'LorefoldNetworkError';
}

/** The server answered, but not with something we can read. */
export class LorefoldProtocolError extends LorefoldError {
  override readonly name: string = 'LorefoldProtocolError';
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/* ------------------------------------------------------------------ *
 * The client.
 * ------------------------------------------------------------------ */

/** Injectable for tests; matches the shape of global `fetch`. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface LorefoldClientOptions {
  fetchImpl?: FetchLike;
  /** Milliseconds before a request is abandoned. Default 15000. */
  timeoutMs?: number;
}

const JSON_CONTENT_TYPE = 'application/json';
const EDN_CONTENT_TYPE = 'application/edn';

export function basicAuthHeader(username: string, password: string): string {
  return 'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
}

export class LorefoldClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: LorefoldConfig,
    options: LorefoldClientOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** The presence name writes are attributed to. */
  get username(): string {
    return this.config.username;
  }

  get baseUrl(): string {
    return this.config.url;
  }

  /**
   * Reads the internal representation at `path`.
   *
   * Returns `null` when the path resolves to nothing — a page that does not
   * exist, or a selector that matched no child. That is a 200 with an empty
   * body on the wire, not an error.
   */
  async readPath(path: Path): Promise<IRNode | null> {
    const body = await this.post(
      '/api/path/read',
      JSON.stringify({ path: encodePath(path) }),
      JSON_CONTENT_TYPE,
      path,
    );
    return body === null ? null : decodeNode(body);
  }

  /**
   * Appends `data` at `path`, creating any missing pages and selector blocks
   * along the way, and returns the internal representation *at that path*
   * afterwards (the whole page for a page-rooted path, not just what was added).
   *
   * Append only. Supplying an existing `uid` in `data` resolves to a *move*, not
   * an edit — in-place editing needs a server endpoint that does not exist yet
   * (LF-30). Do not try to route around this.
   *
   * The request goes out as JSON unless `data` carries properties, in which
   * case it goes out as EDN because JSON cannot carry them (see `edn.ts`).
   */
  async writePath(path: Path, data: IRNode[]): Promise<IRNode | null> {
    if (data.length === 0) {
      // The server would answer 500 with a ClassCastException here. Fail with
      // something the caller can act on instead.
      throw new LorefoldProtocolError(
        `Refusing to write nothing to ${describePath(path)}. ` +
          'The write endpoint requires at least one block; ' +
          'an empty write crashes the server rather than no-opping.',
      );
    }

    const useEdn = data.some(carriesProperties);
    const [body, contentType] = useEdn
      ? [encodeWriteBodyEdn(path, data), EDN_CONTENT_TYPE]
      : [
          JSON.stringify({ path: encodePath(path), data: data.map(encodeNode) }),
          JSON_CONTENT_TYPE,
        ];

    const response = await this.post('/api/path/write', body, contentType, path);
    return response === null ? null : decodeNode(response);
  }

  private async post(
    endpoint: string,
    body: string,
    contentType: string,
    path: Path,
  ): Promise<unknown> {
    const url = `${this.config.url}${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          // Always JSON coming back, whatever went out — muuntaja negotiates
          // the two directions independently, so nothing here has to read EDN.
          Accept: JSON_CONTENT_TYPE,
          Authorization: basicAuthHeader(this.config.username, this.config.password),
        },
        body,
        signal: controller.signal,
      });
    } catch (cause) {
      const reason = (cause as Error)?.name === 'AbortError'
        ? `no response within ${this.timeoutMs}ms`
        : (cause as Error)?.message ?? String(cause);
      throw new LorefoldNetworkError(
        `Could not reach Lorefold at ${url}: ${reason}. ` +
          'Check that the stack is running (`curl -f ' +
          `${this.config.url}/health-check\`) and that LOREFOLD_URL points at it.`,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();

    if (!response.ok) {
      throw this.toApiError(response.status, endpoint, text.trim(), path);
    }

    // A resolved-to-nothing read is 200 with a zero-length body.
    if (text.trim() === '') return null;

    try {
      return JSON.parse(text);
    } catch {
      throw new LorefoldProtocolError(
        `Lorefold answered ${endpoint} with ${response.status} but the body was not JSON: ` +
          truncate(text),
      );
    }
  }

  private toApiError(
    status: number,
    endpoint: string,
    serverMessage: string,
    path: Path,
  ): LorefoldApiError {
    if (status === 401) {
      return new LorefoldAuthError(
        status,
        endpoint,
        serverMessage,
        `Lorefold rejected the credentials (401: ${serverMessage || 'access denied'}). ` +
          `Check LOREFOLD_PASSWORD against ATHENS_PASSWORD in ops/.env, and note that ` +
          `LOREFOLD_USERNAME must not be blank — the server 401s on a blank username ` +
          `even when the password is right. Current username: ${JSON.stringify(this.config.username)}.`,
      );
    }

    // The server has no exception middleware, so a rejected request arrives as a
    // 500 whose body is the message from the thrown ex-info. Pass it through:
    // "Cannot resolve title." tells the caller far more than "request failed".
    const hint = hintFor(serverMessage);
    return new LorefoldApiError(
      status,
      endpoint,
      serverMessage,
      `Lorefold rejected ${endpoint} for path ${describePath(path)} ` +
        `with ${status}: ${serverMessage || '(empty body)'}${hint ? ` — ${hint}` : ''}`,
    );
  }
}

function hintFor(serverMessage: string): string | null {
  if (serverMessage.includes('Cannot resolve title')) {
    return 'the only page/query the server understands is the literal "@today"';
  }
  if (serverMessage.includes('Cannot resolve root')) {
    return 'a path root must be one of {pageTitle}, {blockUid}, {pageQuery: "@today"}';
  }
  if (serverMessage.includes('Invalid event')) {
    return 'the request built an event the server would not accept; check that the ' +
      'blocks carry plain strings and that no unsupported field was sent';
  }
  return null;
}

function truncate(text: string, limit = 500): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… (${text.length} bytes)`;
}
