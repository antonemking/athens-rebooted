/**
 * The decision object model (LF-38), implementing `doc/decision-object-model.md`.
 *
 * A decision is a **block** — normally on the daily note for the day it was
 * made — whose own `block/string` is the decision statement, carrying its
 * metadata as property blocks. Nothing here is a new schema: it rides
 * `:block/property-of` + `:block/key`, which the graph already has.
 *
 * ## The two shapes a property value takes
 *
 * - **Scalar** — the value is the property block's own string.
 * - **Multi-value** — the property block's string is empty and each value is
 *   one child. This is the shape spec §8 specifies for `alternatives` and
 *   `evidence`.
 *
 * `context`, `participants` and `supersedes` are *not* multi-value in that
 * sense even though the caller passes a list: they are several links in one
 * string (`"[[Acme]] [[Migration]]"`). That is what §8 shows, and it is what
 * keeps the §9 datalog correct — the `superseded-by` query matches
 * `[?p :block/refs ?old]` on the property block itself, which only holds if the
 * ref is in the property block's own string rather than in a child of it.
 *
 * ## What v0 cannot do, and why that shapes this module
 *
 * `path/write` only appends. Changing a property value in place needs
 * `/api/block/save`, which is LF-30. So a decision is recorded at whatever
 * status it holds when captured, and **supersession is expressed by recording a
 * new decision** that points back at the old one — which is what an append-only
 * ledger implies anyway. The stored status of a superseded decision therefore
 * goes stale, and `effectiveStatuses` below repairs that at read time.
 */

import type { IRBlock, IRNode } from './client.js';
import { isIsoDate } from './dates.js';

/* ------------------------------------------------------------------ *
 * Vocabulary.
 * ------------------------------------------------------------------ */

/**
 * The marker that makes a block a decision, and the free index: because this
 * string is a page link, the page `lorefold/decision` accrues every decision in
 * the graph as a linked reference (spec §2). Nothing maintains that index.
 */
export const DECISION_ENTITY_TYPE = '[[lorefold/decision]]';

/** Property keys, exactly as spec §3 names them. */
export const KEY = {
  entityType: ':entity/type',
  status: ':decision/status',
  date: ':decision/date',
  context: ':decision/context',
  question: ':decision/question',
  rationale: ':decision/rationale',
  alternatives: ':decision/alternatives',
  evidence: ':decision/evidence',
  participants: ':decision/participants',
  supersedes: ':decision/supersedes',
  reviewOn: ':decision/review-on',
} as const;

/** The closed set of spec §4. A rejected option is an alternative, not a status. */
export const STATUSES = ['proposed', 'accepted', 'superseded', 'reversed'] as const;
export type DecisionStatus = (typeof STATUSES)[number];

export function isDecisionStatus(value: string): value is DecisionStatus {
  return (STATUSES as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ *
 * Input.
 * ------------------------------------------------------------------ */

export interface DecisionInput {
  /** The decision statement. Becomes the block's own string; there is no title. */
  statement: string;
  status: DecisionStatus;
  /** `YYYY-MM-DD`, when the decision was *made*. */
  date: string;
  /** Page names. Required — spec §3 and §10 Q2. */
  context: string[];
  question?: string;
  rationale?: string;
  alternatives?: string[];
  evidence?: string[];
  participants?: string[];
  /** Block uids of decisions this one replaces. Points backwards only. */
  supersedes?: string[];
  reviewOn?: string;
}

/** A caller mistake that must never reach the server. */
export class DecisionInputError extends Error {
  override readonly name: string = 'DecisionInputError';
}

/* ------------------------------------------------------------------ *
 * Link rendering.
 * ------------------------------------------------------------------ */

/**
 * `Acme Corp` and `[[Acme Corp]]` both render as `[[Acme Corp]]`.
 *
 * Accepting the already-bracketed form matters because a model reading the spec
 * will often pass it, and double-wrapping would create a page literally named
 * `[[Acme Corp]]` — a silent corruption rather than an error.
 */
export function pageLink(name: string): string {
  const bare = name.trim().replace(/^\[\[(.*)\]\]$/s, '$1').trim();
  if (bare === '') {
    throw new DecisionInputError('A page link cannot be empty.');
  }
  return `[[${bare}]]`;
}

/** `abc123456` and `((abc123456))` both render as `((abc123456))`. */
export function blockRef(uid: string): string {
  const bare = uid.trim().replace(/^\(\((.*)\)\)$/s, '$1').trim();
  if (bare === '') {
    throw new DecisionInputError('A block reference cannot be empty.');
  }
  return `((${bare}))`;
}

/** The bare uids named by a `supersedes` property value. */
export function parseBlockRefs(text: string): string[] {
  return [...text.matchAll(/\(\(([^()]+)\)\)/g)].map((match) => match[1]!.trim());
}

/* ------------------------------------------------------------------ *
 * Building the payload.
 * ------------------------------------------------------------------ */

function scalar(value: string): IRBlock {
  return { string: value };
}

/** Spec §8: an empty string plus one child per value. */
function multi(values: string[]): IRBlock {
  return { string: '', children: values.map((value) => ({ string: value })) };
}

function requireText(value: string | undefined, field: string): string {
  const text = (value ?? '').trim();
  if (text === '') {
    throw new DecisionInputError(
      `${field} is required and must not be blank. A decision needs at least a ` +
        'statement, a status, a date and a context — see doc/decision-object-model.md §3.',
    );
  }
  return text;
}

/**
 * Non-blank entries of a list the caller supplied.
 *
 * A field given as `[]` or `["", " "]` is a caller mistake worth naming rather
 * than silently dropping: the model meant to record something and did not.
 */
function requireList(values: string[], field: string): string[] {
  const kept = values.map((value) => value.trim()).filter((value) => value !== '');
  if (kept.length === 0) {
    throw new DecisionInputError(
      `${field} was supplied but contained no values. Omit it entirely, or give ` +
        'it at least one non-empty entry.',
    );
  }
  return kept;
}

function requireIsoDate(value: string, field: string): string {
  const date = value.trim();
  if (!isIsoDate(date)) {
    throw new DecisionInputError(
      `${field} must be a real calendar date in YYYY-MM-DD form, not ` +
        `${JSON.stringify(value)}. This is the date the decision was made, which ` +
        'is often earlier than the date it is being recorded.',
    );
  }
  return date;
}

/**
 * The block to send as the write payload's single `data` element.
 *
 * Validates first and throws `DecisionInputError` on anything wrong, so a bad
 * decision never reaches the graph — the API cannot delete, so a bad write is
 * permanent.
 */
export function buildDecisionBlock(input: DecisionInput): IRBlock {
  const statement = requireText(input.statement, 'statement');

  const status = (input.status ?? '').trim();
  if (!isDecisionStatus(status)) {
    throw new DecisionInputError(
      `status must be one of ${STATUSES.join(', ')} — got ${JSON.stringify(input.status)}. ` +
        'A rejected option is not a decision with a status; it belongs in the ' +
        "winning decision's alternatives.",
    );
  }

  const properties: Record<string, IRBlock> = {
    [KEY.entityType]: scalar(DECISION_ENTITY_TYPE),
    [KEY.status]: scalar(status),
    [KEY.date]: scalar(requireIsoDate(input.date ?? '', 'date')),
    [KEY.context]: scalar(
      requireList(input.context ?? [], 'context').map(pageLink).join(' '),
    ),
  };

  if (input.question !== undefined) {
    properties[KEY.question] = scalar(requireText(input.question, 'question'));
  }
  if (input.rationale !== undefined) {
    properties[KEY.rationale] = scalar(requireText(input.rationale, 'rationale'));
  }
  if (input.alternatives !== undefined) {
    properties[KEY.alternatives] = multi(requireList(input.alternatives, 'alternatives'));
  }
  if (input.evidence !== undefined) {
    properties[KEY.evidence] = multi(requireList(input.evidence, 'evidence'));
  }
  if (input.participants !== undefined) {
    properties[KEY.participants] = scalar(
      requireList(input.participants, 'participants').map(pageLink).join(' '),
    );
  }
  if (input.supersedes !== undefined) {
    properties[KEY.supersedes] = scalar(
      requireList(input.supersedes, 'supersedes').map(blockRef).join(' '),
    );
  }
  if (input.reviewOn !== undefined) {
    properties[KEY.reviewOn] = scalar(requireIsoDate(input.reviewOn, 'review_on'));
  }

  return { string: statement, properties };
}

/** The uids a built decision block claims to supersede. */
export function supersededUids(block: IRBlock): string[] {
  return parseBlockRefs(block.properties?.[KEY.supersedes]?.string ?? '');
}

/* ------------------------------------------------------------------ *
 * Reading decisions back.
 * ------------------------------------------------------------------ */

export interface ReadDecision {
  uid?: string;
  statement: string;
  /** The daily note it was found on. Not the same as `date` if it was backdated. */
  foundOn: string;
  /** The status as *stored*. May be stale — see `effectiveStatuses`. */
  storedStatus: string;
  date?: string;
  context?: string;
  question?: string;
  rationale?: string;
  participants?: string;
  reviewOn?: string;
  alternatives: string[];
  evidence: string[];
  supersedes: string[];
}

export interface DecisionView extends ReadDecision {
  /**
   * `superseded` when something in the scanned window replaced this decision,
   * otherwise the stored status. Only as good as the window — see the tool
   * description.
   */
  effectiveStatus: string;
  /** The decisions that superseded this one, within the window. */
  supersededBy: { uid?: string; statement: string }[];
}

/** A property's values: its children when it has them, else its own string. */
function valuesOf(property: IRBlock | undefined): string[] {
  if (property === undefined) return [];
  const children = property.children ?? [];
  if (children.length > 0) {
    return children.map((child) => child.string ?? '').filter((value) => value !== '');
  }
  const own = property.string ?? '';
  return own === '' ? [] : [own];
}

function scalarOf(property: IRBlock | undefined): string | undefined {
  const value = (property?.string ?? '').trim();
  return value === '' ? undefined : value;
}

/** True when this block carries the decision entity-type marker. */
export function isDecisionBlock(block: IRBlock): boolean {
  return scalarOf(block.properties?.[KEY.entityType]) === DECISION_ENTITY_TYPE;
}

/**
 * Every decision block anywhere under `node`, including nested ones.
 *
 * The whole subtree is walked rather than just the page's direct children: a
 * decision filed under a heading block is still a decision, and `path/write`
 * makes that easy to do by accident.
 */
export function extractDecisions(node: IRNode | null, foundOn: string): ReadDecision[] {
  const found: ReadDecision[] = [];

  const walk = (blocks: IRBlock[]): void => {
    for (const block of blocks) {
      if (isDecisionBlock(block)) found.push(toReadDecision(block, foundOn));
      walk(block.children ?? []);
    }
  };

  walk(node?.children ?? []);
  return found;
}

function toReadDecision(block: IRBlock, foundOn: string): ReadDecision {
  const props = block.properties ?? {};
  const decision: ReadDecision = {
    statement: block.string ?? '',
    foundOn,
    storedStatus: scalarOf(props[KEY.status]) ?? '(none)',
    alternatives: valuesOf(props[KEY.alternatives]),
    evidence: valuesOf(props[KEY.evidence]),
    supersedes: parseBlockRefs(props[KEY.supersedes]?.string ?? ''),
  };

  if (block.uid !== undefined) decision.uid = block.uid;
  const date = scalarOf(props[KEY.date]);
  if (date !== undefined) decision.date = date;
  const context = scalarOf(props[KEY.context]);
  if (context !== undefined) decision.context = context;
  const question = scalarOf(props[KEY.question]);
  if (question !== undefined) decision.question = question;
  const rationale = scalarOf(props[KEY.rationale]);
  if (rationale !== undefined) decision.rationale = rationale;
  const participants = scalarOf(props[KEY.participants]);
  if (participants !== undefined) decision.participants = participants;
  const reviewOn = scalarOf(props[KEY.reviewOn]);
  if (reviewOn !== undefined) decision.reviewOn = reviewOn;

  return decision;
}

/**
 * Repairs stale statuses across a scanned set.
 *
 * `path/write` cannot edit, so nothing ever rewrites a decision's status to
 * `superseded` when a later decision replaces it. The successor's backward
 * pointer is the only record, so the truth is derived here rather than stored:
 * if anything in the set supersedes a decision, that decision is superseded
 * regardless of what its own status block says.
 *
 * **This is only as complete as the set it is given.** A successor recorded
 * outside the scanned window is invisible, and the decision will be reported at
 * its stored status. Graph-wide certainty needs the query endpoints in M2b.
 */
export function effectiveStatuses(decisions: ReadDecision[]): DecisionView[] {
  const successors = new Map<string, { uid?: string; statement: string }[]>();

  for (const decision of decisions) {
    for (const uid of decision.supersedes) {
      const list = successors.get(uid) ?? [];
      const entry: { uid?: string; statement: string } = { statement: decision.statement };
      if (decision.uid !== undefined) entry.uid = decision.uid;
      list.push(entry);
      successors.set(uid, list);
    }
  }

  return decisions.map((decision) => {
    const supersededBy = (decision.uid !== undefined && successors.get(decision.uid)) || [];
    return {
      ...decision,
      supersededBy,
      effectiveStatus: supersededBy.length > 0 ? 'superseded' : decision.storedStatus,
    };
  });
}
