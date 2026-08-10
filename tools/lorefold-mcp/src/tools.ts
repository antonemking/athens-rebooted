/**
 * The v0 tool surface (LF-13).
 *
 * Four tools, all built on the two path endpoints that already exist:
 *
 *   lorefold_daily_append  append to today's daily note
 *   lorefold_page_read     read a page or block as IR + markdown
 *   lorefold_page_write    append at an arbitrary path, creating it if missing
 *   lorefold_page_create   create a new page
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
import { dailyNoteTitle, timeZoneMismatchWarning } from './dates.js';

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
  if (error instanceof LorefoldError) {
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
}
