/**
 * The tool surface (LF-13, extended by LF-38).
 *
 * Six tools, all built on the two path endpoints that already exist:
 *
 *   lorefold_daily_append    append to today's daily note
 *   lorefold_page_read       read a page or block as IR + markdown
 *   lorefold_page_write      append at an arbitrary path, creating it if missing
 *   lorefold_page_create     create a new page
 *   lorefold_decision_record record a decision as a typed object     (LF-38)
 *   lorefold_decisions       read decisions back over a date window  (LF-38)
 *
 * Search, backlinks, page listing and in-place block editing are absent on
 * purpose — they need server work that belongs to M2b (LF-29 to LF-31). Every
 * write here appends; nothing edits. See `client.ts` for why.
 *
 * Tool descriptions are written for a model to act on, and errors are written
 * to say what to do differently rather than that something went wrong.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { LorefoldConfig } from './config.js';
import {
  LorefoldError,
  isPage,
  type IRBlock,
  type IRNode,
  type LorefoldClient,
  type Path,
  type PathRoot,
  type PathSelector,
} from './client.js';
import {
  countBlocks,
  countProperties,
  markdownToIr,
  nodeToMarkdown,
  pageCreatingStrings,
  titleOf,
} from './codec.js';
import {
  dailyNoteTitle,
  dailyNoteTitleForIso,
  isoDateIn,
  isoDateRange,
  isoDaysBefore,
  isIsoDate,
  timeZoneMismatchWarning,
} from './dates.js';
import {
  buildDecisionBlock,
  DecisionInputError,
  effectiveStatuses,
  extractDecisions,
  isDecisionBlock,
  STATUSES,
  supersededUids,
  type DecisionInput,
  type DecisionView,
  type ReadDecision,
} from './decisions.js';

/* ------------------------------------------------------------------ *
 * Shared schema fragments.
 * ------------------------------------------------------------------ */

const MARKDOWN_DESCRIPTION =
  'An outline as indented "- " bullets. Two spaces of indent per level makes a ' +
  'child block. This is NOT general markdown: headings, code fences, tables and ' +
  'quotes have no meaning and are stored as literal block text. Avoid starting a ' +
  'line with "#" unless you mean to create a page — "#" and "[[…]]" are page ' +
  'links, and writing one creates that page if it does not exist.';

const rootShape = z
  .object({
    pageTitle: z.string().min(1).optional().describe('Address a page by its exact title.'),
    blockUid: z
      .string()
      .min(1)
      .optional()
      .describe('Address a specific block by the uid returned from a previous read.'),
    pageQuery: z
      .literal('@today')
      .optional()
      .describe(
        'The literal string "@today", resolved to the daily note by the server\'s ' +
          'own clock. No other query value exists.',
      ),
  })
  .describe('Exactly one of pageTitle, blockUid or pageQuery.');

const selectorShape = z
  .object({
    blockString: z
      .string()
      .optional()
      .describe('Descend into the first child block whose text matches this exactly.'),
    blockKey: z.string().min(1).optional().describe('Descend into the property under this key.'),
  })
  .describe('Exactly one of blockString or blockKey.');

const UNDER_DESCRIPTION =
  'Optional list of block texts to descend through before writing, outermost ' +
  'first. Each must match a child block exactly; any that is missing is created. ' +
  'Use this to file content under an existing heading block.';

/* ------------------------------------------------------------------ *
 * Result helpers.
 * ------------------------------------------------------------------ */

function textResult(parts: string[], isError = false): CallToolResult {
  const content = parts
    .filter((part) => part.trim() !== '')
    .map((text) => ({ type: 'text' as const, text }));
  return isError ? { content, isError: true } : { content };
}

function failure(message: string): CallToolResult {
  return textResult([message], true);
}

/**
 * Turns a thrown value into something a model can act on.
 *
 * Errors from `client.ts` already carry the server's own rejection reason and a
 * remedy, so they pass through verbatim. Anything else is unexpected and is
 * labelled as such rather than dressed up.
 */
function errorResult(error: unknown): CallToolResult {
  if (error instanceof LorefoldError || error instanceof DecisionInputError) {
    return failure(error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return failure(`The Lorefold bridge failed unexpectedly: ${message}`);
}

function renderNode(node: IRNode | null): string {
  const markdown = nodeToMarkdown(node);
  return markdown === '' ? '(no blocks)' : markdown;
}

function irResult(node: IRNode | null): string {
  return `Internal representation (JSON):\n${JSON.stringify(node, null, 2)}`;
}

function describeNode(node: IRNode | null): string {
  if (node === null) return 'nothing';
  const title = titleOf(node);
  if (title !== null) return `page "${title}"`;
  const uid = (node as IRBlock).uid;
  return uid ? `block ${uid}` : 'block';
}

function propertyNote(node: IRNode | null): string {
  const count = countProperties(node);
  if (count === 0) return '';
  return (
    `Note: ${count} property block(s) are present but not shown in the outline — ` +
    'properties have no bullet syntax. They are in the JSON below.'
  );
}

function pageLinkNote(blocks: IRBlock[]): string {
  const offenders = pageCreatingStrings(blocks);
  if (offenders.length === 0) return '';
  const sample = offenders.slice(0, 3).map((text) => `"${text}"`).join(', ');
  return (
    `Note: ${offenders.length} block(s) contain a page link (# or [[…]]) and will ` +
    `create those pages if they do not already exist: ${sample}` +
    (offenders.length > 3 ? ', …' : '')
  );
}

/* ------------------------------------------------------------------ *
 * Path construction, with errors aimed at the caller.
 * ------------------------------------------------------------------ */

type RootInput = z.infer<typeof rootShape>;
type SelectorInput = z.infer<typeof selectorShape>;

/** Thrown for caller mistakes that never reach the network. */
class InvalidArgumentError extends LorefoldError {
  override readonly name: string = 'InvalidArgumentError';
}

function toRoot(root: RootInput): PathRoot {
  const given = (['pageTitle', 'blockUid', 'pageQuery'] as const).filter(
    (key) => root[key] !== undefined && root[key] !== '',
  );
  if (given.length !== 1) {
    throw new InvalidArgumentError(
      given.length === 0
        ? 'The path root is empty. Set exactly one of pageTitle, blockUid, or ' +
          'pageQuery: "@today".'
        : `The path root sets ${given.join(' and ')}. Set exactly one of them.`,
    );
  }
  if (root.pageTitle !== undefined && root.pageTitle !== '') return { pageTitle: root.pageTitle };
  if (root.blockUid !== undefined && root.blockUid !== '') return { blockUid: root.blockUid };
  return { pageQuery: '@today' };
}

function toSelector(selector: SelectorInput, index: number): PathSelector {
  const hasString = selector.blockString !== undefined;
  const hasKey = selector.blockKey !== undefined && selector.blockKey !== '';
  if (hasString === hasKey) {
    throw new InvalidArgumentError(
      `Selector ${index + 1} must set exactly one of blockString or blockKey.`,
    );
  }
  return hasString ? { blockString: selector.blockString! } : { blockKey: selector.blockKey! };
}

function buildPath(root: RootInput, selectors: SelectorInput[] = []): Path {
  return [toRoot(root), ...selectors.map(toSelector)];
}

function underPath(root: PathRoot, under: string[] = []): Path {
  return [root, ...under.map((blockString) => ({ blockString }))];
}

function parseOutline(markdown: string, field = 'markdown'): IRBlock[] {
  const blocks = markdownToIr(markdown);
  if (blocks.length === 0) {
    throw new InvalidArgumentError(
      `The ${field} argument produced no blocks — it was empty or only whitespace. ` +
        'Provide at least one line, e.g. "- something to record".',
    );
  }
  return blocks;
}

/* ------------------------------------------------------------------ *
 * Registration.
 * ------------------------------------------------------------------ */

export interface RegisterOptions {
  /** Overridable so tests do not depend on the wall clock. */
  now?: () => Date;
}

export function registerTools(
  server: McpServer,
  client: LorefoldClient,
  config: LorefoldConfig,
  options: RegisterOptions = {},
): void {
  const now = options.now ?? (() => new Date());

  /* -------------------------------------------------------------- *
   * lorefold_daily_append
   * -------------------------------------------------------------- */

  server.registerTool(
    'lorefold_daily_append',
    {
      title: "Append to today's daily note",
      description:
        "Append blocks to today's daily note in the Lorefold knowledge graph, " +
        'creating the page if this is the first write of the day. The day is ' +
        "resolved by the Lorefold server's own clock, not this machine's. " +
        'This is the right tool for logging notes, decisions and observations as ' +
        'they happen. Appends only — it never edits or replaces existing blocks.',
      inputSchema: {
        markdown: z.string().describe(MARKDOWN_DESCRIPTION),
        under: z.array(z.string()).optional().describe(UNDER_DESCRIPTION),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ markdown, under }): Promise<CallToolResult> => {
      try {
        const blocks = parseOutline(markdown);
        const path = underPath({ pageQuery: '@today' }, under);
        const written = await client.writePath(path, blocks);

        // Confirm which page the server actually chose. When `under` was used
        // the write returns a block, so ask for the page separately — this
        // check is the only reliable way to catch a TZ mismatch.
        const page =
          under && under.length > 0 ? await client.readPath([{ pageQuery: '@today' }]) : written;
        const serverTitle = titleOf(page);
        const expected = dailyNoteTitle(now(), config.timeZone);
        const warning = timeZoneMismatchWarning(serverTitle, expected, config.timeZone);

        const location = under && under.length > 0 ? ` under ${under.map((s) => `"${s}"`).join(' > ')}` : '';
        const summary =
          `Appended ${countBlocks(blocks)} block(s) to ${describeNode(page)}${location}, ` +
          `attributed to "${client.username}".`;

        return textResult([
          summary,
          warning ?? '',
          pageLinkNote(blocks),
          propertyNote(written),
          renderNode(written),
          irResult(written),
        ]);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  /* -------------------------------------------------------------- *
   * lorefold_page_read
   * -------------------------------------------------------------- */

  server.registerTool(
    'lorefold_page_read',
    {
      title: 'Read a Lorefold page or block',
      description:
        'Read a page or a block from the Lorefold knowledge graph, returned both as ' +
        'a markdown outline for reading and as the raw internal representation, ' +
        'which carries the block uids you need to address blocks later. ' +
        'Address the page by exact title, by block uid, or set today: true for ' +
        "today's daily note. There is no search and no page listing in this " +
        'version, so the title must be exact.',
      inputSchema: {
        title: z.string().min(1).optional().describe('Exact page title, e.g. "August 10, 2026".'),
        uid: z.string().min(1).optional().describe('Block uid from a previous read.'),
        today: z.boolean().optional().describe("Read today's daily note."),
        under: z.array(z.string()).optional().describe(
          'Optional block texts to descend through before reading, outermost first. ' +
            'Unlike writes, reading does not create anything: a missing one reads as nothing.',
        ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ title, uid, today, under }): Promise<CallToolResult> => {
      try {
        const roots = [
          title !== undefined ? ({ pageTitle: title } as PathRoot) : null,
          uid !== undefined ? ({ blockUid: uid } as PathRoot) : null,
          today === true ? ({ pageQuery: '@today' } as PathRoot) : null,
        ].filter((root): root is PathRoot => root !== null);

        if (roots.length !== 1) {
          return failure(
            roots.length === 0
              ? 'Nothing to read. Set exactly one of title, uid, or today: true.'
              : 'Set exactly one of title, uid, or today: true — not several.',
          );
        }

        const path = underPath(roots[0]!, under);
        const node = await client.readPath(path);

        if (node === null) {
          const what =
            title !== undefined
              ? `No page titled "${title}" exists`
              : uid !== undefined
                ? `No block with uid "${uid}" exists`
                : "Today's daily note does not exist yet";
          const because =
            under && under.length > 0
              ? ', or one of the `under` blocks does not match a child exactly'
              : '';
          return failure(
            `${what}${because}. Titles must match exactly, including capitalisation and ` +
              'punctuation — daily notes are formatted "August 09, 2026" with a ' +
              'zero-padded day. Use lorefold_page_create to create a page, or ' +
              'lorefold_daily_append to start today\'s note.',
          );
        }

        const blockCount = countBlocks(node.children ?? []);
        const summary = `Read ${describeNode(node)} — ${blockCount} block(s).`;

        return textResult([
          summary,
          propertyNote(node),
          renderNode(node),
          irResult(node),
        ]);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  /* -------------------------------------------------------------- *
   * lorefold_page_write
   * -------------------------------------------------------------- */

  server.registerTool(
    'lorefold_page_write',
    {
      title: 'Append blocks at a Lorefold path',
      description:
        'Append blocks anywhere in the Lorefold graph, creating the page and any ' +
        'intermediate blocks that do not exist yet (an upsert of the path, an ' +
        'append of the content). Use this for writing to a named page, or for ' +
        'filing content under a specific block. ' +
        'It cannot edit or delete: new blocks are always added last, and existing ' +
        'blocks are never changed. Editing a block in place is not supported by ' +
        'the server yet.',
      inputSchema: {
        root: rootShape,
        selectors: z
          .array(selectorShape)
          .optional()
          .describe(
            'Optional path segments descending from the root, outermost first. ' +
              'Missing blocks named by blockString are created.',
          ),
        markdown: z.string().describe(MARKDOWN_DESCRIPTION),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ root, selectors, markdown }): Promise<CallToolResult> => {
      try {
        const blocks = parseOutline(markdown);
        const path = buildPath(root, selectors);
        const written = await client.writePath(path, blocks);

        const summary =
          `Appended ${countBlocks(blocks)} block(s) to ${describeNode(written)}, ` +
          `attributed to "${client.username}".`;

        return textResult([
          summary,
          pageLinkNote(blocks),
          propertyNote(written),
          renderNode(written),
          irResult(written),
        ]);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  /* -------------------------------------------------------------- *
   * lorefold_page_create
   * -------------------------------------------------------------- */

  server.registerTool(
    'lorefold_page_create',
    {
      title: 'Create a Lorefold page',
      description:
        'Create a new page in the Lorefold knowledge graph, optionally with ' +
        'starting content. Fails if a page with that title already exists rather ' +
        'than appending to it — use lorefold_page_write for that. ' +
        'Titles are the graph\'s addressing scheme: a page linked as [[Title]] ' +
        'anywhere already exists, so check with lorefold_page_read first if unsure.',
      inputSchema: {
        title: z.string().min(1).describe('Exact title for the new page. Must not already exist.'),
        markdown: z
          .string()
          .optional()
          .describe(`Optional starting content. ${MARKDOWN_DESCRIPTION}`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ title, markdown }): Promise<CallToolResult> => {
      try {
        const path: Path = [{ pageTitle: title }];

        const existing = await client.readPath(path);
        if (existing !== null) {
          const blockCount = countBlocks(existing.children ?? []);
          return failure(
            `A page titled "${title}" already exists (${blockCount} block(s)). ` +
              'Use lorefold_page_write with root {pageTitle} to append to it, or ' +
              'lorefold_page_read to see what is already there. Note that a page can ' +
              'exist without you creating it: linking to [[Title]] from any block ' +
              'creates it.',
          );
        }

        // With content, the blocks themselves pull the page into existence.
        // Without, `{page/title}` as the payload emits a bare :page/new op —
        // the write endpoint rejects an empty data array outright.
        const blocks = markdown !== undefined ? parseOutline(markdown) : [];
        const data: IRNode[] = blocks.length > 0 ? blocks : [{ title }];
        const written = await client.writePath(path, data);

        const created = written !== null && isPage(written) ? written.title : title;
        const summary =
          `Created page "${created}"` +
          (blocks.length > 0 ? ` with ${countBlocks(blocks)} block(s)` : ' (empty)') +
          `, attributed to "${client.username}".`;

        return textResult([
          summary,
          pageLinkNote(blocks),
          renderNode(written),
          irResult(written),
        ]);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  /* -------------------------------------------------------------- *
   * lorefold_decision_record (LF-38)
   * -------------------------------------------------------------- */

  server.registerTool(
    'lorefold_decision_record',
    {
      title: 'Record a decision',
      description:
        'Record an organizational decision as a first-class typed object in the ' +
        'Lorefold graph: the statement, plus why it was made, what else was ' +
        'considered, and the evidence behind it. This is what Lorefold is for — ' +
        'use it whenever a real choice gets made, not for notes or tasks.\n\n' +
        'The decision is filed as a block on the daily note for `date`, which is ' +
        'the date the decision was **made** — often earlier than today, because ' +
        'decisions get written down after the fact. It becomes visible on every ' +
        'page it links to (its context, its participants) and on the ' +
        'lorefold/decision page, which indexes every decision automatically.\n\n' +
        'Statuses are proposed, accepted, superseded and reversed. In practice a ' +
        'decision is recorded as `accepted`, because it is captured after being ' +
        'made. A rejected option is NOT a decision — put it in `alternatives`, ' +
        'stating why it lost.\n\n' +
        'Appends only. Once recorded, a decision cannot be edited or deleted ' +
        'through this API, so get it right the first time. To replace a decision, ' +
        'record a NEW one with `supersedes` set to the old block uid — the ledger ' +
        'is append-only by design, and the old decision stays as history.',
      inputSchema: {
        statement: z
          .string()
          .min(1)
          .describe(
            'The decision itself, in plain declarative language: "We will replace ' +
              'Fluree with SQLite for the event log." This is the object\'s title; ' +
              'there is no separate title field.',
          ),
        status: z
          .enum(STATUSES)
          .describe(
            'proposed = under consideration; accepted = in force (the normal case); ' +
              'superseded = replaced by a later decision; reversed = undone with no ' +
              'replacement.',
          ),
        date: z
          .string()
          .describe('YYYY-MM-DD, the date the decision was MADE. Backdating is normal.'),
        context: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            'Page names this decision belongs to — the client, the project, the ' +
              'system. Required: it is what makes a client page a decision log. ' +
              'Plain names, e.g. ["Acme Corp", "Billing migration"]; the brackets ' +
              'are added for you. Pages are created if they do not exist.',
          ),
        question: z
          .string()
          .optional()
          .describe('What was actually being decided. Omit when the statement says it.'),
        rationale: z
          .string()
          .optional()
          .describe(
            'Why this choice, in prose. The highest-value field in the whole model — ' +
              'a decision without it is a fact, not a decision.',
          ),
        alternatives: z
          .array(z.string().min(1))
          .optional()
          .describe('One entry per option considered, each stating why it lost.'),
        evidence: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'One entry per URL or ((block-uid)). Link to where the thing lives — a ' +
              'Slack permalink, a PR, a doc, a CI run — never a copy of it.',
          ),
        participants: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Names of the people who made the decision. Each becomes a page, so ' +
              'their page answers "every decision this person was part of".',
          ),
        supersedes: z
          .array(z.string().min(1))
          .optional()
          .describe(
            'Block uids of decisions this one replaces. Points backwards only; the ' +
              'forward direction is derived. Each uid is checked to exist before ' +
              'anything is written.',
          ),
        review_on: z
          .string()
          .optional()
          .describe('YYYY-MM-DD. For decisions taken under uncertainty that deserve revisiting.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const input: DecisionInput = {
          statement: args.statement,
          status: args.status,
          date: args.date,
          context: args.context,
          ...(args.question !== undefined ? { question: args.question } : {}),
          ...(args.rationale !== undefined ? { rationale: args.rationale } : {}),
          ...(args.alternatives !== undefined ? { alternatives: args.alternatives } : {}),
          ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
          ...(args.participants !== undefined ? { participants: args.participants } : {}),
          ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
          ...(args.review_on !== undefined ? { reviewOn: args.review_on } : {}),
        };

        const block = buildDecisionBlock(input);

        // Check every superseded uid before writing anything. A dangling
        // ((uid)) is not an error to the server — it is stored as literal text
        // and produces no reference at all, so the link would silently not
        // exist. There is no delete, so the bad write would be permanent.
        const claimed = supersededUids(block);
        for (const uid of claimed) {
          const target = await client.readPath([{ blockUid: uid }]);
          if (target === null) {
            return failure(
              `No block with uid "${uid}" exists, so supersedes would produce a ` +
                'dangling reference that is stored as plain text rather than a real ' +
                'link. Nothing was written. Find the decision first with ' +
                'lorefold_decisions and use the uid it reports.',
            );
          }
          if (!isDecisionBlock(target as IRBlock)) {
            return failure(
              `Block "${uid}" exists but is not a decision — supersedes must point at ` +
                'another decision block. Nothing was written.',
            );
          }
        }

        // A decision goes on the daily note of the day it was made. When that is
        // today we let the server resolve "@today" from its own clock, which is
        // authoritative; when it is backdated there is no query for it, so we
        // address the page by title. That is safe because the server derives a
        // date-shaped title's page uid back to the canonical daily uid.
        const todayIso = isoDateIn(now(), config.timeZone);
        const backdated = input.date.trim() !== todayIso;
        const path: Path = backdated
          ? [{ pageTitle: dailyNoteTitleForIso(input.date) }]
          : [{ pageQuery: '@today' }];

        const written = await client.writePath(path, [block]);

        const landedOn = titleOf(written);
        const warning = backdated
          ? null
          : timeZoneMismatchWarning(landedOn, dailyNoteTitle(now(), config.timeZone), config.timeZone);

        // The write returns the whole page; the decision just added is the last
        // one whose statement matches.
        const recorded = extractDecisions(written, landedOn ?? '(unknown page)')
          .filter((decision) => decision.statement === block.string)
          .pop();

        const uidLine =
          recorded?.uid !== undefined
            ? `Its block uid is ${recorded.uid} — use that uid in \`supersedes\` if this ` +
              'decision is later replaced.'
            : 'The server did not return a uid for it; read the page back to find it.';

        const links = [
          ...(input.context ?? []),
          ...(input.participants ?? []),
        ];
        const linkLine =
          links.length > 0
            ? `Linked to ${links.length} page(s): ${links.join(', ')} — any that did not ` +
              'exist have been created, and each now lists this decision as a backlink.'
            : '';

        const summary =
          `Recorded a ${input.status} decision on ${describeNode(written)} ` +
          `(dated ${input.date}${backdated ? ', backdated' : ''}), ` +
          `attributed to "${client.username}".`;

        return textResult([
          summary,
          warning ?? '',
          uidLine,
          linkLine,
          'It is indexed automatically on the page lorefold/decision, which accrues ' +
            'every decision in the graph as a linked reference.',
          irResult(recorded ?? null),
        ]);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  /* -------------------------------------------------------------- *
   * lorefold_decisions (LF-38)
   * -------------------------------------------------------------- */

  server.registerTool(
    'lorefold_decisions',
    {
      title: 'List recorded decisions',
      description:
        'List decisions recorded in the Lorefold graph over a range of days, with ' +
        'their status, context, rationale, alternatives and evidence.\n\n' +
        'IMPORTANT — this is a WINDOWED SCAN, not a graph-wide query. It reads the ' +
        'daily note for each day in the range and collects the decisions filed ' +
        'there. Decisions outside the range are invisible to it, so an empty ' +
        'result means "none in these days", never "none in the graph". There are ' +
        'no server-side query endpoints yet; graph-wide search, backlinks and page ' +
        'listing arrive in M2b. Widen `from` and `to` before concluding anything.\n\n' +
        'Defaults to the last 14 days. A decision is filed on the daily note for ' +
        'the date it was MADE, so a decision backdated outside the window will not ' +
        'appear even if it was recorded today.\n\n' +
        'Status is reported as an EFFECTIVE status: because the API cannot edit an ' +
        'existing block, a decision that has been replaced still stores its ' +
        'original status. If any decision in the scanned window supersedes ' +
        'another, that other one is reported as superseded and its successor is ' +
        'named — but only for successors that fall inside the window.',
      inputSchema: {
        from: z
          .string()
          .optional()
          .describe('YYYY-MM-DD, first day to scan. Defaults to 13 days before `to`.'),
        to: z
          .string()
          .optional()
          .describe('YYYY-MM-DD, last day to scan, inclusive. Defaults to today.'),
        status: z
          .enum(STATUSES)
          .optional()
          .describe('Keep only decisions with this effective status. Applied after scanning.'),
        context: z
          .string()
          .optional()
          .describe(
            'Keep only decisions whose context mentions this page name, matched ' +
              'case-insensitively. Applied after scanning.',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ from, to, status, context }): Promise<CallToolResult> => {
      try {
        const today = isoDateIn(now(), config.timeZone);

        const last = (to ?? today).trim();
        if (!isIsoDate(last)) {
          return failure(`\`to\` must be a real calendar date in YYYY-MM-DD form, not ${JSON.stringify(to)}.`);
        }
        const first = (from ?? isoDaysBefore(last, DEFAULT_WINDOW_DAYS - 1)).trim();
        if (!isIsoDate(first)) {
          return failure(`\`from\` must be a real calendar date in YYYY-MM-DD form, not ${JSON.stringify(from)}.`);
        }

        const days = isoDateRange(first, last);
        if (days.length === 0) {
          return failure(
            `The range is empty: \`from\` (${first}) is after \`to\` (${last}). ` +
              'Both dates are inclusive.',
          );
        }
        if (days.length > MAX_WINDOW_DAYS) {
          return failure(
            `That range is ${days.length} days, and this tool reads one page per day, ` +
              `so it is capped at ${MAX_WINDOW_DAYS}. Narrow the range and scan in ` +
              'passes. A single query over the whole graph needs the endpoints in M2b.',
          );
        }

        const found: ReadDecision[] = [];
        let daysWithNotes = 0;
        for (const day of days) {
          const title = dailyNoteTitleForIso(day);
          const page = await client.readPath([{ pageTitle: title }]);
          if (page === null) continue;
          daysWithNotes += 1;
          found.push(...extractDecisions(page, title));
        }

        const all = effectiveStatuses(found);
        const matching = all.filter((decision) => {
          if (status !== undefined && decision.effectiveStatus !== status) return false;
          if (context !== undefined) {
            const haystack = (decision.context ?? '').toLowerCase();
            if (!haystack.includes(context.trim().toLowerCase())) return false;
          }
          return true;
        });

        const filters = [
          status !== undefined ? `status ${status}` : null,
          context !== undefined ? `context mentioning "${context}"` : null,
        ].filter((part): part is string => part !== null);

        const scanNote =
          `Scanned ${days.length} daily note(s) from ${first} to ${last} in ` +
          `${config.timeZone}; ${daysWithNotes} existed. Found ${all.length} decision(s)` +
          (filters.length > 0 ? `, ${matching.length} matching ${filters.join(' and ')}` : '') +
          '.';

        const caveat =
          'This is a windowed scan of daily notes, not a graph-wide query, and ' +
          'supersession is only detected among the decisions listed here. Decisions ' +
          'outside this range are not reported. Graph-wide search is M2b.';

        if (matching.length === 0) {
          return textResult([
            scanNote,
            all.length > 0
              ? 'No decision in the window matched the filters. Drop them to see the rest.'
              : 'No decisions were found in this window. Widen `from` and `to` before ' +
                'concluding that none exist — this tool cannot see past the range it scanned.',
            caveat,
          ]);
        }

        return textResult([
          scanNote,
          renderDecisions(matching),
          caveat,
          `Structured (JSON):\n${JSON.stringify(matching, null, 2)}`,
        ]);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}

/** Days scanned when the caller gives no range. */
const DEFAULT_WINDOW_DAYS = 14;

/**
 * Hard cap on the scan. One HTTP round trip per day is the only read primitive
 * available, so an unbounded range would be a slow way to fail.
 */
const MAX_WINDOW_DAYS = 92;

function renderDecisions(decisions: DecisionView[]): string {
  return decisions
    .map((decision) => {
      const lines: string[] = [];
      const stale =
        decision.effectiveStatus !== decision.storedStatus
          ? ` (stored as "${decision.storedStatus}")`
          : '';
      lines.push(`## ${decision.statement}`);
      lines.push(
        `- status: ${decision.effectiveStatus}${stale}` +
          (decision.uid !== undefined ? ` · uid: ${decision.uid}` : ''),
      );
      if (decision.date !== undefined) lines.push(`- decided: ${decision.date}`);
      lines.push(`- filed on: ${decision.foundOn}`);
      if (decision.context !== undefined) lines.push(`- context: ${decision.context}`);
      if (decision.participants !== undefined) {
        lines.push(`- participants: ${decision.participants}`);
      }
      if (decision.question !== undefined) lines.push(`- question: ${decision.question}`);
      if (decision.rationale !== undefined) lines.push(`- rationale: ${decision.rationale}`);
      if (decision.reviewOn !== undefined) lines.push(`- review on: ${decision.reviewOn}`);
      for (const alternative of decision.alternatives) {
        lines.push(`- alternative: ${alternative}`);
      }
      for (const evidence of decision.evidence) {
        lines.push(`- evidence: ${evidence}`);
      }
      for (const uid of decision.supersedes) {
        lines.push(`- supersedes: ((${uid}))`);
      }
      for (const successor of decision.supersededBy) {
        lines.push(
          `- superseded by: ${successor.statement}` +
            (successor.uid !== undefined ? ` (${successor.uid})` : ''),
        );
      }
      return lines.join('\n');
    })
    .join('\n\n');
}
