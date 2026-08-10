import { describe, expect, it } from 'vitest';

import { bool, EdnEncodeError, kw, map, str, vec, writeEdn } from '../src/edn.js';
import { carriesProperties, encodeWriteBodyEdn, ednNode } from '../src/client.js';
import { buildDecisionBlock, KEY } from '../src/decisions.js';

describe('writeEdn', () => {
  it('writes the scalar forms', () => {
    expect(writeEdn(kw('block/string'))).toBe(':block/string');
    expect(writeEdn(kw('block/open?'))).toBe(':block/open?');
    expect(writeEdn(str('hello'))).toBe('"hello"');
    expect(writeEdn(bool(false))).toBe('false');
  });

  it('writes vectors and maps', () => {
    expect(writeEdn(vec([str('a'), str('b')]))).toBe('["a" "b"]');
    expect(writeEdn(map([[kw('page/title'), str('X')]]))).toBe('{:page/title "X"}');
  });

  it('escapes quotes, backslashes and newlines inside strings', () => {
    expect(writeEdn(str('say "hi"'))).toBe('"say \\"hi\\""');
    expect(writeEdn(str('a\\b'))).toBe('"a\\\\b"');
    expect(writeEdn(str('line1\nline2'))).toBe('"line1\\nline2"');
  });

  it('refuses a keyword name that would not read back', () => {
    expect(() => kw(':block/string')).toThrow(EdnEncodeError);
    expect(() => kw('has space')).toThrow(EdnEncodeError);
    expect(() => kw('')).toThrow(EdnEncodeError);
  });
});

describe('ednNode', () => {
  it('writes node keys as keywords but property keys as STRINGS', () => {
    // This distinction is the entire reason EDN exists in this bridge: over
    // JSON the property key is keywordized and the write dies with a 500.
    const edn = writeEdn(
      ednNode({ string: 'statement', properties: { ':decision/status': { string: 'accepted' } } }),
    );
    expect(edn).toContain(':block/string "statement"');
    expect(edn).toContain('":decision/status"');
    expect(edn).not.toContain('::decision/status');
  });

  it('writes children as a vector, nested', () => {
    const edn = writeEdn(ednNode({ string: 'a', children: [{ string: 'b' }] }));
    expect(edn).toBe('{:block/string "a", :block/children [{:block/string "b"}]}');
  });

  it('writes a page node by title', () => {
    expect(writeEdn(ednNode({ title: 'Some Page' }))).toBe('{:page/title "Some Page"}');
  });

  it('writes a multi-value property as an empty string plus children', () => {
    const edn = writeEdn(
      ednNode({
        string: 's',
        properties: { ':decision/evidence': { string: '', children: [{ string: 'https://x' }] } },
      }),
    );
    expect(edn).toContain('":decision/evidence" {:block/string "", :block/children [{:block/string "https://x"}]}');
  });
});

describe('encodeWriteBodyEdn', () => {
  it('encodes a whole write body, path included', () => {
    const body = encodeWriteBodyEdn([{ pageQuery: '@today' }], [{ string: 'x' }]);
    expect(body).toBe('{:path [{:page/query "@today"}], :data [{:block/string "x"}]}');
  });

  it('encodes a real decision payload', () => {
    const block = buildDecisionBlock({
      statement: 'We will use SQLite',
      status: 'accepted',
      date: '2026-08-09',
      context: ['Lorefold'],
      alternatives: ['Fluree — rejected: abandoned'],
    });
    const body = encodeWriteBodyEdn([{ pageTitle: 'August 09, 2026' }], [block]);

    expect(body).toContain('{:path [{:page/title "August 09, 2026"}]');
    expect(body).toContain(`"${KEY.entityType}" {:block/string "[[lorefold/decision]]"}`);
    expect(body).toContain(`"${KEY.status}" {:block/string "accepted"}`);
    expect(body).toContain('"Fluree — rejected: abandoned"');
  });
});

describe('carriesProperties', () => {
  it('is false for plain blocks and true once a property appears at any depth', () => {
    expect(carriesProperties({ string: 'a' })).toBe(false);
    expect(carriesProperties({ string: 'a', properties: {} })).toBe(false);
    expect(carriesProperties({ string: 'a', properties: { ':k': { string: 'v' } } })).toBe(true);
    expect(
      carriesProperties({
        string: 'a',
        children: [{ string: 'b', children: [{ string: 'c', properties: { ':k': { string: 'v' } } }] }],
      }),
    ).toBe(true);
  });
});
