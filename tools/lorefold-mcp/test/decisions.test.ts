import { describe, expect, it } from 'vitest';

import {
  blockRef,
  buildDecisionBlock,
  DECISION_ENTITY_TYPE,
  DecisionInputError,
  effectiveStatuses,
  extractDecisions,
  isDecisionBlock,
  KEY,
  pageLink,
  parseBlockRefs,
  supersededUids,
  type DecisionInput,
  type ReadDecision,
} from '../src/decisions.js';
import type { IRBlock, IRPage } from '../src/client.js';

/** The smallest input the spec accepts: statement, status, date, context. */
function minimal(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    statement: 'We will replace Fluree with SQLite for the event log',
    status: 'accepted',
    date: '2026-08-09',
    context: ['Lorefold'],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Link rendering.
 * ------------------------------------------------------------------ */

describe('link rendering', () => {
  it('wraps a bare page name and leaves an already-wrapped one alone', () => {
    expect(pageLink('Acme Corp')).toBe('[[Acme Corp]]');
    expect(pageLink('[[Acme Corp]]')).toBe('[[Acme Corp]]');
    expect(pageLink('  [[Acme Corp]]  ')).toBe('[[Acme Corp]]');
  });

  it('does the same for block refs', () => {
    expect(blockRef('abc123456')).toBe('((abc123456))');
    expect(blockRef('((abc123456))')).toBe('((abc123456))');
  });

  it('rejects an empty link rather than creating a page named "[[]]"', () => {
    expect(() => pageLink('[[]]')).toThrow(DecisionInputError);
    expect(() => blockRef('  ')).toThrow(DecisionInputError);
  });

  it('parses uids out of a supersedes value', () => {
    expect(parseBlockRefs('((abc123456)) ((def789012))')).toEqual(['abc123456', 'def789012']);
    expect(parseBlockRefs('')).toEqual([]);
    expect(parseBlockRefs('not a ref')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * buildDecisionBlock — the payload builder.
 * ------------------------------------------------------------------ */

describe('buildDecisionBlock', () => {
  it('puts the statement in the block string, not in a property', () => {
    const block = buildDecisionBlock(minimal());
    expect(block.string).toBe('We will replace Fluree with SQLite for the event log');
  });

  it('always carries the entity-type marker that produces the free index', () => {
    const block = buildDecisionBlock(minimal());
    expect(block.properties?.[KEY.entityType]).toEqual({ string: DECISION_ENTITY_TYPE });
  });

  it('emits only the four required properties when nothing else is given', () => {
    const block = buildDecisionBlock(minimal());
    expect(Object.keys(block.properties ?? {}).sort()).toEqual(
      [KEY.entityType, KEY.status, KEY.date, KEY.context].sort(),
    );
  });

  it('renders alternatives and evidence as an empty string with one child per value', () => {
    const block = buildDecisionBlock(
      minimal({
        alternatives: ['Stay on Fluree — rejected: abandoned beta', 'Postgres — rejected: a second container'],
        evidence: ['https://example.com/reboot#verdicts'],
      }),
    );

    // Spec §8: the property block is the container, each child is one value.
    expect(block.properties?.[KEY.alternatives]).toEqual({
      string: '',
      children: [
        { string: 'Stay on Fluree — rejected: abandoned beta' },
        { string: 'Postgres — rejected: a second container' },
      ],
    });
    expect(block.properties?.[KEY.evidence]).toEqual({
      string: '',
      children: [{ string: 'https://example.com/reboot#verdicts' }],
    });
  });

  it('renders context and participants as several links in ONE string', () => {
    // Not children: the §9 superseded-by datalog matches refs on the property
    // block itself, so link-valued properties must keep their refs there.
    const block = buildDecisionBlock(
      minimal({ context: ['Acme Corp', 'Billing migration'], participants: ['Tone', 'Sarah'] }),
    );
    expect(block.properties?.[KEY.context]).toEqual({
      string: '[[Acme Corp]] [[Billing migration]]',
    });
    expect(block.properties?.[KEY.participants]).toEqual({ string: '[[Tone]] [[Sarah]]' });
  });

  it('renders supersedes as block refs in one string, and reads them back', () => {
    const block = buildDecisionBlock(minimal({ supersedes: ['abc123456', '((def789012))'] }));
    expect(block.properties?.[KEY.supersedes]).toEqual({
      string: '((abc123456)) ((def789012))',
    });
    expect(supersededUids(block)).toEqual(['abc123456', 'def789012']);
  });

  it('carries every optional field through when all are given', () => {
    const block = buildDecisionBlock(
      minimal({
        question: 'What backs the event log?',
        rationale: 'SQLite implements the seam in ~150 lines.',
        alternatives: ['Fluree — rejected'],
        evidence: ['https://example.com/x'],
        participants: ['Tone'],
        supersedes: ['abc123456'],
        reviewOn: '2026-11-01',
      }),
    );

    expect(Object.keys(block.properties ?? {}).sort()).toEqual(
      [
        KEY.entityType,
        KEY.status,
        KEY.date,
        KEY.context,
        KEY.question,
        KEY.rationale,
        KEY.alternatives,
        KEY.evidence,
        KEY.participants,
        KEY.supersedes,
        KEY.reviewOn,
      ].sort(),
    );
    expect(block.properties?.[KEY.reviewOn]).toEqual({ string: '2026-11-01' });
  });

  it('rejects a missing statement, status, date or context', () => {
    expect(() => buildDecisionBlock(minimal({ statement: '   ' }))).toThrow(/statement is required/);
    expect(() =>
      buildDecisionBlock(minimal({ status: 'pending' as never })),
    ).toThrow(/status must be one of/);
    expect(() => buildDecisionBlock(minimal({ date: '' }))).toThrow(/date must be a real calendar date/);
    expect(() => buildDecisionBlock(minimal({ context: [] }))).toThrow(/context was supplied but/);
  });

  it('rejects a malformed or impossible date', () => {
    expect(() => buildDecisionBlock(minimal({ date: '09-08-2026' }))).toThrow(DecisionInputError);
    expect(() => buildDecisionBlock(minimal({ date: '2026-8-9' }))).toThrow(DecisionInputError);
    // Date.UTC would happily roll this into March.
    expect(() => buildDecisionBlock(minimal({ date: '2026-02-30' }))).toThrow(DecisionInputError);
    expect(() => buildDecisionBlock(minimal({ reviewOn: 'soon' }))).toThrow(/review_on/);
  });

  it('rejects a list that was supplied but is empty, rather than dropping it', () => {
    expect(() => buildDecisionBlock(minimal({ alternatives: ['', '  '] }))).toThrow(
      /alternatives was supplied but contained no values/,
    );
    expect(() => buildDecisionBlock(minimal({ evidence: [] }))).toThrow(/evidence/);
  });

  it('names the status vocabulary and where a rejected option belongs', () => {
    expect(() => buildDecisionBlock(minimal({ status: 'rejected' as never }))).toThrow(
      /alternatives/,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Reading back.
 * ------------------------------------------------------------------ */

/** A decision as the server returns it, uid included. */
function stored(uid: string, statement: string, props: Record<string, IRBlock>): IRBlock {
  return {
    uid,
    string: statement,
    properties: {
      [KEY.entityType]: { uid: `${uid}-t`, string: DECISION_ENTITY_TYPE },
      ...props,
    },
  };
}

describe('extractDecisions', () => {
  it('finds decisions and ignores ordinary blocks', () => {
    const page: IRPage = {
      title: 'August 09, 2026',
      children: [
        { uid: 'n1', string: 'just a note' },
        stored('d1', 'We will use SQLite', {
          [KEY.status]: { string: 'accepted' },
          [KEY.date]: { string: '2026-08-09' },
          [KEY.context]: { string: '[[Lorefold]]' },
        }),
      ],
    };

    const found = extractDecisions(page, 'August 09, 2026');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      uid: 'd1',
      statement: 'We will use SQLite',
      storedStatus: 'accepted',
      date: '2026-08-09',
      context: '[[Lorefold]]',
      foundOn: 'August 09, 2026',
    });
  });

  it('finds a decision nested under a heading block', () => {
    const page: IRPage = {
      title: 'August 09, 2026',
      children: [
        {
          uid: 'h1',
          string: 'Decisions',
          children: [stored('d1', 'Nested one', { [KEY.status]: { string: 'accepted' } })],
        },
      ],
    };
    expect(extractDecisions(page, 'August 09, 2026').map((d) => d.uid)).toEqual(['d1']);
  });

  it('reads multi-value properties from children and scalars from the string', () => {
    const page: IRPage = {
      title: 'August 09, 2026',
      children: [
        stored('d1', 'Statement', {
          [KEY.status]: { string: 'accepted' },
          [KEY.rationale]: { string: 'because' },
          [KEY.alternatives]: {
            string: '',
            children: [{ string: 'A — rejected' }, { string: 'B — rejected' }],
          },
          [KEY.evidence]: { string: '', children: [{ string: 'https://example.com' }] },
        }),
      ],
    };

    const [decision] = extractDecisions(page, 'August 09, 2026');
    expect(decision?.alternatives).toEqual(['A — rejected', 'B — rejected']);
    expect(decision?.evidence).toEqual(['https://example.com']);
    expect(decision?.rationale).toBe('because');
  });

  it('reports a missing status rather than inventing one', () => {
    const page: IRPage = { title: 'x', children: [stored('d1', 'Statement', {})] };
    expect(extractDecisions(page, 'x')[0]?.storedStatus).toBe('(none)');
  });

  it('treats a block without the marker as not a decision', () => {
    expect(isDecisionBlock({ uid: 'n', string: 'note' })).toBe(false);
    expect(
      isDecisionBlock({ uid: 'n', string: 'note', properties: { [KEY.status]: { string: 'accepted' } } }),
    ).toBe(false);
    expect(isDecisionBlock(stored('d', 's', {}))).toBe(true);
  });

  it('returns nothing for a page that does not exist', () => {
    expect(extractDecisions(null, 'August 09, 2026')).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Effective status — the whole point of the read tool.
 * ------------------------------------------------------------------ */

function readDecision(overrides: Partial<ReadDecision> & { uid: string }): ReadDecision {
  return {
    statement: `statement ${overrides.uid}`,
    foundOn: 'August 09, 2026',
    storedStatus: 'accepted',
    alternatives: [],
    evidence: [],
    supersedes: [],
    ...overrides,
  };
}

describe('effectiveStatuses', () => {
  it('leaves a decision alone when nothing supersedes it', () => {
    const [view] = effectiveStatuses([readDecision({ uid: 'd1' })]);
    expect(view?.effectiveStatus).toBe('accepted');
    expect(view?.supersededBy).toEqual([]);
  });

  it('overrides a stale stored status and names the successor', () => {
    const views = effectiveStatuses([
      readDecision({ uid: 'd1', statement: 'Use Fluree' }),
      readDecision({ uid: 'd2', statement: 'Use SQLite', supersedes: ['d1'] }),
    ]);

    const old = views.find((view) => view.uid === 'd1');
    // The write API cannot edit, so d1 still SAYS accepted. It is not.
    expect(old?.storedStatus).toBe('accepted');
    expect(old?.effectiveStatus).toBe('superseded');
    expect(old?.supersededBy).toEqual([{ uid: 'd2', statement: 'Use SQLite' }]);

    expect(views.find((view) => view.uid === 'd2')?.effectiveStatus).toBe('accepted');
  });

  it('handles a chain, marking every replaced link superseded', () => {
    const views = effectiveStatuses([
      readDecision({ uid: 'd1' }),
      readDecision({ uid: 'd2', supersedes: ['d1'] }),
      readDecision({ uid: 'd3', supersedes: ['d2'] }),
    ]);
    expect(views.map((view) => view.effectiveStatus)).toEqual([
      'superseded',
      'superseded',
      'accepted',
    ]);
  });

  it('records several successors when more than one points at the same decision', () => {
    const views = effectiveStatuses([
      readDecision({ uid: 'd1' }),
      readDecision({ uid: 'd2', supersedes: ['d1'] }),
      readDecision({ uid: 'd3', supersedes: ['d1'] }),
    ]);
    expect(views[0]?.supersededBy.map((s) => s.uid)).toEqual(['d2', 'd3']);
  });

  it('ignores a successor pointing outside the scanned set', () => {
    // The honest failure mode: we cannot see what we did not scan.
    const views = effectiveStatuses([readDecision({ uid: 'd2', supersedes: ['not-in-window'] })]);
    expect(views[0]?.effectiveStatus).toBe('accepted');
    expect(views[0]?.supersededBy).toEqual([]);
  });

  it('keeps a reversed status, which is not the same as superseded', () => {
    const [view] = effectiveStatuses([readDecision({ uid: 'd1', storedStatus: 'reversed' })]);
    expect(view?.effectiveStatus).toBe('reversed');
  });
});
