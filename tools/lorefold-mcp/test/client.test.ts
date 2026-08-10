import { describe, expect, it, vi } from 'vitest';

import {
  basicAuthHeader,
  decodeNode,
  encodeNode,
  encodePath,
  LorefoldApiError,
  LorefoldAuthError,
  LorefoldClient,
  LorefoldNetworkError,
  LorefoldProtocolError,
  WIRE,
  type FetchLike,
  type IRNode,
  type Path,
} from '../src/client.js';
import type { LorefoldConfig } from '../src/config.js';

const config: LorefoldConfig = {
  url: 'http://lorefold.test:3010',
  username: 'claude',
  password: 'hunter2',
  timeZone: 'America/New_York',
};

/** A fetch stub that answers once with the given status/body. */
function stubFetch(status: number, body: string): { fetchImpl: FetchLike; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  const fetchImpl: FetchLike = async (_url, init) => {
    calls.push(init);
    return new Response(body, { status });
  };
  return { fetchImpl, calls };
}

function clientWith(status: number, body: string) {
  const { fetchImpl, calls } = stubFetch(status, body);
  return { client: new LorefoldClient(config, { fetchImpl }), calls };
}

/* ------------------------------------------------------------------ *
 * Key mapping — the whole point of LF-10.
 * ------------------------------------------------------------------ */

describe('key mapping: internal representation', () => {
  const wirePage = {
    'page/title': 'August 10, 2026',
    'block/children': [
      {
        'block/uid': '55375521d',
        'block/string': 'parent',
        'block/open?': false,
        'block/children': [{ 'block/uid': 'bf605182e', 'block/string': 'child' }],
      },
    ],
  };

  const irPage: IRNode = {
    title: 'August 10, 2026',
    children: [
      {
        uid: '55375521d',
        string: 'parent',
        open: false,
        children: [{ uid: 'bf605182e', string: 'child' }],
      },
    ],
  };

  it('decodes namespaced wire keys into camelCase, recursively', () => {
    expect(decodeNode(wirePage)).toEqual(irPage);
  });

  it('encodes camelCase back into namespaced wire keys, recursively', () => {
    expect(encodeNode(irPage)).toEqual(wirePage);
  });

  it('round-trips in both directions', () => {
    expect(encodeNode(decodeNode(wirePage))).toEqual(wirePage);
    expect(decodeNode(encodeNode(irPage))).toEqual(irPage);
  });

  it('keeps the question mark in block/open?', () => {
    expect(WIRE.blockOpen).toBe('block/open?');
    expect(encodeNode({ string: 'x', open: false })).toEqual({
      'block/string': 'x',
      'block/open?': false,
    });
  });

  it('distinguishes a page from a block by page/title', () => {
    expect(decodeNode({ 'page/title': 'p' })).toEqual({ title: 'p' });
    expect(decodeNode({ 'block/uid': 'u' })).toEqual({ uid: 'u' });
  });

  it('omits absent fields rather than sending nulls', () => {
    expect(encodeNode({ string: 'only text' })).toEqual({ 'block/string': 'only text' });
  });

  it('maps block/properties both ways', () => {
    const wire = {
      'page/title': 'Decision 1',
      'block/properties': { status: { 'block/uid': 'p1', 'block/string': 'accepted' } },
    };
    const ir = { title: 'Decision 1', properties: { status: { uid: 'p1', string: 'accepted' } } };
    expect(decodeNode(wire)).toEqual(ir);
    expect(encodeNode(ir)).toEqual(wire);
  });

  it('refuses to decode something that is not an object', () => {
    expect(() => decodeNode([1, 2])).toThrow(LorefoldProtocolError);
    expect(() => decodeNode('nope')).toThrow(LorefoldProtocolError);
  });
});

describe('key mapping: paths', () => {
  it('encodes every root form in the grammar', () => {
    expect(encodePath([{ pageTitle: 'Some Page' }])).toEqual([{ 'page/title': 'Some Page' }]);
    expect(encodePath([{ blockUid: 'abc123456' }])).toEqual([{ 'block/uid': 'abc123456' }]);
    expect(encodePath([{ pageQuery: '@today' }])).toEqual([{ 'page/query': '@today' }]);
  });

  it('encodes both selector forms, in order after the root', () => {
    const path: Path = [{ pageQuery: '@today' }, { blockString: 'Section A' }, { blockKey: 'status' }];
    expect(encodePath(path)).toEqual([
      { 'page/query': '@today' },
      { 'block/string': 'Section A' },
      { 'block/key': 'status' },
    ]);
  });

  it('rejects a root outside the grammar rather than guessing', () => {
    // @ts-expect-error deliberately outside PathRoot
    expect(() => encodePath([{ pageSearch: 'anything' }])).toThrow(LorefoldProtocolError);
  });
});

/* ------------------------------------------------------------------ *
 * Auth header.
 * ------------------------------------------------------------------ */

describe('basicAuthHeader', () => {
  it('base64-encodes username:password', () => {
    expect(basicAuthHeader('claude', 'hunter2')).toBe(
      'Basic ' + Buffer.from('claude:hunter2').toString('base64'),
    );
  });

  it('handles an empty password, which a passwordless server accepts', () => {
    expect(basicAuthHeader('claude', '')).toBe('Basic ' + Buffer.from('claude:').toString('base64'));
  });

  it('handles non-ASCII credentials as UTF-8', () => {
    expect(basicAuthHeader('cläude', 'pässwörd')).toBe(
      'Basic ' + Buffer.from('cläude:pässwörd', 'utf8').toString('base64'),
    );
  });

  it('is sent on every request', async () => {
    const { client, calls } = clientWith(200, '{"page/title":"p"}');
    await client.readPath([{ pageTitle: 'p' }]);
    const headers = calls[0]!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(basicAuthHeader('claude', 'hunter2'));
    expect(headers['Content-Type']).toBe('application/json');
  });
});

/* ------------------------------------------------------------------ *
 * Requests.
 * ------------------------------------------------------------------ */

describe('readPath', () => {
  it('POSTs the encoded path to /api/path/read', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response('{"page/title":"p"}', { status: 200 }));
    const client = new LorefoldClient(config, { fetchImpl });

    await client.readPath([{ pageQuery: '@today' }]);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://lorefold.test:3010/api/path/read');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ path: [{ 'page/query': '@today' }] });
  });

  it('returns null for a path that resolves to nothing (200 with an empty body)', async () => {
    const { client } = clientWith(200, '');
    await expect(client.readPath([{ pageTitle: 'Missing' }])).resolves.toBeNull();
  });
});

describe('writePath', () => {
  it('POSTs the encoded path and data to /api/path/write', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response('{"page/title":"p"}', { status: 200 }));
    const client = new LorefoldClient(config, { fetchImpl });

    await client.writePath([{ pageQuery: '@today' }], [
      { string: 'parent', children: [{ string: 'child' }] },
    ]);

    const [, init] = fetchImpl.mock.calls[0]!;
    expect(JSON.parse(init.body as string)).toEqual({
      path: [{ 'page/query': '@today' }],
      data: [
        { 'block/string': 'parent', 'block/children': [{ 'block/string': 'child' }] },
      ],
    });
  });

  it('never sends a relation, which the JSON API rejects as a string', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response('{"page/title":"p"}', { status: 200 }));
    const client = new LorefoldClient(config, { fetchImpl });
    await client.writePath([{ pageTitle: 'p' }], [{ string: 'x' }]);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body as string)).not.toHaveProperty('relation');
  });

  it('refuses an empty write locally instead of crashing the server', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response('', { status: 200 }));
    const client = new LorefoldClient(config, { fetchImpl });

    await expect(client.writePath([{ pageTitle: 'p' }], [])).rejects.toThrow(LorefoldProtocolError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /* ---------------------------------------------------------------- *
   * Properties force EDN (LF-38). JSON cannot carry them at all: muuntaja
   * keywordizes the property key, which `bfs/enhance-props` needs as a page
   * title string, and the request dies with a 500 ClassCastException from
   * malli's own error formatter.
   * ---------------------------------------------------------------- */

  it('sends EDN, not JSON, when the data carries properties', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response('{"page/title":"p"}', { status: 200 }));
    const client = new LorefoldClient(config, { fetchImpl });

    await client.writePath(
      [{ pageQuery: '@today' }],
      [{ string: 'a decision', properties: { ':decision/status': { string: 'accepted' } } }],
    );

    const [, init] = fetchImpl.mock.calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/edn');
    // The response is still negotiated as JSON, so nothing has to read EDN.
    expect(headers['Accept']).toBe('application/json');
    expect(init.body).toBe(
      '{:path [{:page/query "@today"}], ' +
        ':data [{:block/string "a decision", ' +
        ':block/properties {":decision/status" {:block/string "accepted"}}}]}',
    );
  });

  it('still sends JSON when there are no properties', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response('{"page/title":"p"}', { status: 200 }));
    const client = new LorefoldClient(config, { fetchImpl });

    await client.writePath([{ pageTitle: 'p' }], [{ string: 'plain' }]);

    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toHaveProperty('data');
  });
});

/* ------------------------------------------------------------------ *
 * Errors carry the server's own words.
 * ------------------------------------------------------------------ */

describe('error surfacing', () => {
  it('turns 401 into an auth error naming the env vars to check', async () => {
    const { client } = clientWith(401, 'access denied');
    const error = await client.readPath([{ pageQuery: '@today' }]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LorefoldAuthError);
    const authError = error as LorefoldAuthError;
    expect(authError.status).toBe(401);
    expect(authError.serverMessage).toBe('access denied');
    expect(authError.message).toContain('LOREFOLD_PASSWORD');
    expect(authError.message).toContain('LOREFOLD_USERNAME');
    expect(authError.message).toContain('"claude"');
  });

  it("carries the server's rejection reason verbatim, not a generic failure", async () => {
    const { client } = clientWith(500, 'Cannot resolve title.');
    const error = await client
      // @ts-expect-error only "@today" is in the grammar; this is what a bad one looks like
      .readPath([{ pageQuery: '@yesterday' }])
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LorefoldApiError);
    const apiError = error as LorefoldApiError;
    expect(apiError.serverMessage).toBe('Cannot resolve title.');
    expect(apiError.message).toContain('Cannot resolve title.');
    // …and adds the reason it usually happens.
    expect(apiError.message).toContain('"@today"');
  });

  it('names the path it was working on', async () => {
    const { client } = clientWith(500, 'Invalid event');
    const error = await client
      .writePath([{ pageTitle: 'Some Page' }, { blockString: 'Section A' }], [{ string: 'x' }])
      .catch((e: unknown) => e);
    expect((error as Error).message).toContain('"page/title":"Some Page"');
    expect((error as Error).message).toContain('"block/string":"Section A"');
  });

  it('reports an unreachable server as a network error with the health-check command', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError('fetch failed');
    };
    const client = new LorefoldClient(config, { fetchImpl });
    const error = await client.readPath([{ pageTitle: 'p' }]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LorefoldNetworkError);
    expect((error as Error).message).toContain('/health-check');
    expect((error as Error).message).toContain('LOREFOLD_URL');
  });

  it('reports a non-JSON 200 body as a protocol error', async () => {
    const { client } = clientWith(200, '<html>proxy error</html>');
    await expect(client.readPath([{ pageTitle: 'p' }])).rejects.toThrow(LorefoldProtocolError);
  });
});
