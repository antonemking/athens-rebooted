/**
 * Markdown outline <-> internal representation codec (LF-11).
 *
 * ## THIS IS NOT A MARKDOWN PARSER. Do not use it as one.
 *
 * It understands exactly one thing: an indented list of `- ` bullets, mapped
 * onto `block/string` and `block/children`. That is the shape a Lorefold page
 * actually has. It is deliberately narrow, and reusing it to round-trip
 * arbitrary markdown files will quietly corrupt a graph:
 *
 *  - `# Heading` is not a heading here. It is a block whose text begins with a
 *    `#`, which the server treats as a hashtag link and which therefore
 *    **creates a new page** named after the rest of the line. The same trap is
 *    documented for `text-to-blocks` in AGENTS.md; this codec inherits it,
 *    because the destination is the same graph.
 *  - Fenced code blocks, tables, block quotes, `[links](…)`, emphasis and
 *    footnotes have no representation. Their raw source survives as block text,
 *    so the characters are not lost, but the structure is.
 *  - Ordered lists are not distinguished from unordered ones.
 *
 * Rendering IR *to* markdown is the primary direction — it is how an agent
 * reads a page. Parsing markdown back is supported only so that an agent can
 * write an outline it composed itself, and only for the narrow shape above.
 *
 * ## Round-trip guarantee, and where it stops
 *
 * `markdownToIr(irToMarkdown(blocks))` reproduces `blocks` — with `uid` and
 * `open` dropped, since markdown cannot carry them — provided every block
 * string is free of newlines. Specifically:
 *
 *  - **uid is lost.** Parsed blocks carry no `uid`, so a markdown round trip
 *    can never address an existing block. This is a feature: `path/write` is
 *    append-only and a supplied uid resolves to a *move* (AGENTS.md, LF-30).
 *  - **`open` (collapse state) is lost.** There is no bullet syntax for it.
 *  - **Properties are not rendered.** `block/properties` has no honest bullet
 *    syntax and inventing one would create ambiguity on the way back, so
 *    `irToMarkdown` skips them. `countProperties` exists so callers can say so
 *    out loud, and the raw IR is always available alongside the markdown.
 *  - **Multi-line block strings do not survive.** A block whose text contains a
 *    newline renders across several lines; re-parsing turns the continuation
 *    lines into child blocks. Nothing else in this codec is lossy.
 *
 * Leading whitespace *inside* a block's text does survive, as does a literal
 * leading `- `, because exactly one bullet marker is stripped per line.
 */

import type { IRBlock, IRNode } from './client.js';
import { isPage } from './client.js';

/** Spaces per nesting level in rendered output. */
const INDENT = '  ';

/** A tab in hand-written input counts as one nesting level. */
const TAB_WIDTH = INDENT.length;

/** The bullet markers accepted on input. Output always uses `-`. */
const BULLET = /^([-*+])([ \t]|$)/;

/* ------------------------------------------------------------------ *
 * IR -> markdown (the primary direction).
 * ------------------------------------------------------------------ */

/** The blocks of any IR node — a page's children, or a block's children. */
export function blocksOf(node: IRNode | null | undefined): IRBlock[] {
  if (!node) return [];
  return node.children ?? [];
}

/**
 * Renders blocks as an indented `- ` outline.
 *
 * Returns an empty string for an empty list, so callers can test it directly
 * rather than checking the array first.
 */
export function irToMarkdown(blocks: IRBlock[]): string {
  const lines: string[] = [];
  renderBlocks(blocks, 0, lines);
  return lines.join('\n');
}

function renderBlocks(blocks: IRBlock[], level: number, lines: string[]): void {
  for (const block of blocks) {
    const indent = INDENT.repeat(level);
    const text = block.string ?? '';
    const [first = '', ...rest] = text.split('\n');
    lines.push(`${indent}- ${first}`);
    // Continuation lines of a multi-line block string. Aligned under the bullet
    // text so it reads correctly; re-parsing will read them as children, which
    // is the one documented lossy case.
    for (const line of rest) {
      lines.push(`${indent}${INDENT}${line}`);
    }
    if (block.children && block.children.length > 0) {
      renderBlocks(block.children, level + 1, lines);
    }
  }
}

/**
 * Renders a whole node — page or block — as markdown, *without* a title line.
 *
 * The title is returned separately on purpose. Emitting `# August 10, 2026`
 * would produce text that, fed back into a write, creates a page named
 * `August 10, 2026` from the hashtag. Callers should present the title as prose
 * around the outline, never inside it.
 */
export function nodeToMarkdown(node: IRNode | null | undefined): string {
  return irToMarkdown(blocksOf(node));
}

/** The node's own title, if it is a page. */
export function titleOf(node: IRNode | null | undefined): string | null {
  if (!node) return null;
  return isPage(node) ? node.title : null;
}

/* ------------------------------------------------------------------ *
 * markdown -> IR.
 * ------------------------------------------------------------------ */

/**
 * Parses an indented `- ` outline into blocks.
 *
 * Nesting comes from indentation only: any line indented deeper than the
 * previous one becomes its child, regardless of how much deeper, so 2-space and
 * 4-space outlines both work and a ragged one still produces a sensible tree.
 * Blank lines are ignored. A line with no bullet marker is still a block — this
 * lets an agent pass a plain list of lines and get a flat page.
 */
export function markdownToIr(markdown: string): IRBlock[] {
  const roots: IRBlock[] = [];
  const stack: { indent: number; block: IRBlock }[] = [];

  for (const rawLine of markdown.split(/\r?\n/)) {
    if (rawLine.trim() === '') continue;

    const { indent, text } = splitLine(rawLine);

    while (stack.length > 0 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }

    const block: IRBlock = { string: text };
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      roots.push(block);
    } else {
      (parent.block.children ??= []).push(block);
    }
    stack.push({ indent, block });
  }

  return roots;
}

function splitLine(rawLine: string): { indent: number; text: string } {
  let indent = 0;
  let i = 0;
  for (; i < rawLine.length; i++) {
    const ch = rawLine[i];
    if (ch === ' ') indent += 1;
    else if (ch === '\t') indent += TAB_WIDTH;
    else break;
  }

  let text = rawLine.slice(i);
  const bullet = BULLET.exec(text);
  if (bullet) {
    // Strip the marker plus at most one following space, and nothing more —
    // that is what makes a block whose text is itself "- foo" survive.
    text = text.slice(bullet[0].length);
  }
  return { indent, text };
}

/* ------------------------------------------------------------------ *
 * Small helpers used by the tool layer for honest reporting.
 * ------------------------------------------------------------------ */

/** Total blocks in a tree, including nested children. */
export function countBlocks(blocks: IRBlock[]): number {
  let total = 0;
  for (const block of blocks) {
    total += 1 + countBlocks(block.children ?? []);
  }
  return total;
}

/** Property blocks anywhere in a node, which `irToMarkdown` does not render. */
export function countProperties(node: IRNode | null | undefined): number {
  if (!node) return 0;
  let total = Object.keys(node.properties ?? {}).length;
  for (const value of Object.values(node.properties ?? {})) {
    total += countProperties(value);
  }
  for (const child of node.children ?? []) {
    total += countProperties(child);
  }
  return total;
}

/**
 * Block strings that will create a page as a side effect of being written.
 *
 * `#tag` and `[[Page]]` both resolve to page links, and writing one creates the
 * page if it is missing. That is normal Lorefold behaviour, not an error, but a
 * model that pasted a markdown heading deserves to be told what it just did.
 */
export function pageCreatingStrings(blocks: IRBlock[]): string[] {
  const found: string[] = [];
  const walk = (list: IRBlock[]): void => {
    for (const block of list) {
      const text = block.string ?? '';
      if (/(^|\s)#[^\s#]/.test(text) || /\[\[[^\]]+\]\]/.test(text)) {
        found.push(text);
      }
      walk(block.children ?? []);
    }
  };
  walk(blocks);
  return found;
}
