import { describe, expect, it } from 'vitest';

import type { IRBlock, IRPage } from '../src/client.js';
import {
  blocksOf,
  countBlocks,
  countProperties,
  irToMarkdown,
  markdownToIr,
  nodeToMarkdown,
  pageCreatingStrings,
  titleOf,
} from '../src/codec.js';

/** Drops nothing — the codec never emits uid/open, so equality is exact. */
const nested: IRBlock[] = [
  {
    string: 'Decision: use the existing REST API',
    children: [
      { string: 'Because it already ships' },
      {
        string: 'Alternatives considered',
        children: [{ string: 'A new websocket op' }, { string: 'Direct DataScript access' }],
      },
    ],
  },
  { string: 'Follow-up' },
];

describe('irToMarkdown', () => {
  it('renders nesting as two spaces per level', () => {
    expect(irToMarkdown(nested)).toBe(
      [
        '- Decision: use the existing REST API',
        '  - Because it already ships',
        '  - Alternatives considered',
        '    - A new websocket op',
        '    - Direct DataScript access',
        '- Follow-up',
      ].join('\n'),
    );
  });

  it('renders an empty list as an empty string', () => {
    expect(irToMarkdown([])).toBe('');
  });

  it('renders a block with no string as an empty bullet', () => {
    expect(irToMarkdown([{ uid: 'abc123456' }])).toBe('- ');
  });
});

describe('markdownToIr', () => {
  it('round-trips a nested outline exactly', () => {
    expect(markdownToIr(irToMarkdown(nested))).toEqual(nested);
  });

  it('reads four-space indentation as the same tree as two-space', () => {
    const fourSpace = ['- one', '    - two', '        - three'].join('\n');
    const twoSpace = ['- one', '  - two', '    - three'].join('\n');
    expect(markdownToIr(fourSpace)).toEqual(markdownToIr(twoSpace));
  });

  it('treats a tab as one level of indent', () => {
    expect(markdownToIr(['- one', '\t- two'].join('\n'))).toEqual([
      { string: 'one', children: [{ string: 'two' }] },
    ]);
  });

  it('accepts * and + as bullet markers but always renders -', () => {
    const parsed = markdownToIr(['* one', '  + two'].join('\n'));
    expect(parsed).toEqual([{ string: 'one', children: [{ string: 'two' }] }]);
    expect(irToMarkdown(parsed)).toBe('- one\n  - two');
  });

  it('accepts unbulleted lines as blocks, so a plain list works', () => {
    expect(markdownToIr(['first thing', 'second thing'].join('\n'))).toEqual([
      { string: 'first thing' },
      { string: 'second thing' },
    ]);
  });

  it('ignores blank lines rather than making empty blocks', () => {
    expect(markdownToIr(['- one', '', '   ', '- two'].join('\n'))).toEqual([
      { string: 'one' },
      { string: 'two' },
    ]);
  });

  it('returns nothing for empty or whitespace-only input', () => {
    expect(markdownToIr('')).toEqual([]);
    expect(markdownToIr('   \n\n\t')).toEqual([]);
  });

  it('strips exactly one bullet marker, so a block of literal "- text" survives', () => {
    const blocks: IRBlock[] = [{ string: '- a literal dash' }];
    expect(irToMarkdown(blocks)).toBe('- - a literal dash');
    expect(markdownToIr(irToMarkdown(blocks))).toEqual(blocks);
  });

  it('preserves leading whitespace inside a block string', () => {
    const blocks: IRBlock[] = [{ string: '   indented text' }];
    expect(markdownToIr(irToMarkdown(blocks))).toEqual(blocks);
  });

  it('handles a jump of several levels at once without losing blocks', () => {
    expect(markdownToIr(['- one', '      - deep', '- two'].join('\n'))).toEqual([
      { string: 'one', children: [{ string: 'deep' }] },
      { string: 'two' },
    ]);
  });

  it('handles ragged outdents by attaching to the nearest shallower block', () => {
    const parsed = markdownToIr(['- a', '    - b', '  - c'].join('\n'));
    expect(parsed).toEqual([{ string: 'a', children: [{ string: 'b' }, { string: 'c' }] }]);
  });
});

describe('documented lossy cases', () => {
  it('drops uid, so a round trip can never address an existing block', () => {
    const withUid: IRBlock[] = [{ uid: 'abc123456', string: 'text' }];
    expect(markdownToIr(irToMarkdown(withUid))).toEqual([{ string: 'text' }]);
  });

  it('drops collapse state', () => {
    const collapsed: IRBlock[] = [{ string: 'text', open: false, children: [{ string: 'hidden' }] }];
    expect(markdownToIr(irToMarkdown(collapsed))).toEqual([
      { string: 'text', children: [{ string: 'hidden' }] },
    ]);
  });

  it('turns the continuation lines of a multi-line block into children', () => {
    const multiline: IRBlock[] = [{ string: 'first line\nsecond line' }];
    expect(irToMarkdown(multiline)).toBe('- first line\n  second line');
    // This is the one round trip the codec cannot make. Asserted so the
    // behaviour is pinned rather than merely described.
    expect(markdownToIr(irToMarkdown(multiline))).toEqual([
      { string: 'first line', children: [{ string: 'second line' }] },
    ]);
  });

  it('does not render properties, and counts them so a caller can say so', () => {
    const page: IRPage = {
      title: 'Decision 1',
      children: [{ string: 'body' }],
      properties: { status: { string: 'accepted' } },
    };
    expect(nodeToMarkdown(page)).toBe('- body');
    expect(countProperties(page)).toBe(1);
  });

  it('does not interpret markdown constructs — they stay literal text', () => {
    const parsed = markdownToIr(['# Heading', '```js', 'code()', '```'].join('\n'));
    expect(parsed.map((block) => block.string)).toEqual(['# Heading', '```js', 'code()', '```']);
  });
});

describe('helpers', () => {
  it('counts blocks including nested children', () => {
    expect(countBlocks(nested)).toBe(6);
    expect(countBlocks([])).toBe(0);
  });

  it('reads the blocks of a page or a block, and nothing from null', () => {
    expect(blocksOf({ title: 'p', children: [{ string: 'a' }] })).toEqual([{ string: 'a' }]);
    expect(blocksOf({ uid: 'u', children: [{ string: 'a' }] })).toEqual([{ string: 'a' }]);
    expect(blocksOf(null)).toEqual([]);
  });

  it('reports a title only for pages', () => {
    expect(titleOf({ title: 'August 10, 2026' })).toBe('August 10, 2026');
    expect(titleOf({ uid: 'abc123456' })).toBeNull();
    expect(titleOf(null)).toBeNull();
  });

  it('flags block text that will create pages as a side effect', () => {
    const blocks = markdownToIr(
      ['- see [[Some Page]]', '- tagged #decision', '- plain text', '- not#atag'].join('\n'),
    );
    expect(pageCreatingStrings(blocks)).toEqual(['see [[Some Page]]', 'tagged #decision']);
  });
});
