import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { LorefoldAuthError, type IRNode, type LorefoldClient } from '../src/client.js';
import type { LorefoldConfig } from '../src/config.js';
import { registerTools } from '../src/tools.js';

const config: LorefoldConfig = {
  url: 'http://lorefold.test:3010',
  username: 'claude',
  password: 'hunter2',
  timeZone: 'America/New_York',
};

/** Fixed so the suite never depends on the wall clock. 12:00 EDT. */
const NOW = new Date('2026-08-10T16:00:00Z');
const TODAY_TITLE = 'August 10, 2026';

interface Registered {
  config: { title?: string; description?: string; inputSchema?: Record<string, unknown> };
  handler: (args: never) => Promise<CallToolResult>;
}

function setup() {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool: (name: string, toolConfig: Registered['config'], handler: Registered['handler']) => {
      tools.set(name, { config: toolConfig, handler });
    },
  } as unknown as McpServer;

  const client = {
    username: config.username,
    baseUrl: config.url,
    readPath: vi.fn<(...args: never[]) => Promise<IRNode | null>>(),
    writePath: vi.fn<(...args: never[]) => Promise<IRNode | null>>(),
  };

  registerTools(server, client as unknown as LorefoldClient, config, { now: () => NOW });

  const call = async (name: string, args: unknown): Promise<CallToolResult> => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`tool ${name} was never registered`);
    return tool.handler(args as never);
  };

  return { tools, client, call };
}

/** All text content of a result, joined — what the model actually sees. */
function textOf(result: CallToolResult): string {
  return (result.content as { type: string; text: string }[])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
}

let harness: ReturnType<typeof setup>;
beforeEach(() => {
  harness = setup();
});

/* ------------------------------------------------------------------ *
 * Registration.
 * ------------------------------------------------------------------ */

describe('registration', () => {
  it('registers exactly the four v0 tools', () => {
    expect([...harness.tools.keys()].sort()).toEqual([
      'lorefold_daily_append',
      'lorefold_page_create',
      'lorefold_page_read',
      'lorefold_page_write',
    ]);
  });

  it('gives every tool a description and an input schema', () => {
    for (const [name, tool] of harness.tools) {
      expect(tool.config.description, name).toBeTruthy();
      expect(tool.config.title, name).toBeTruthy();
      expect(Object.keys(tool.config.inputSchema ?? {}).length, name).toBeGreaterThan(0);
    }
  });

  it('warns in the schema that this is not general markdown', () => {
    const description = JSON.stringify(harness.tools.get('lorefold_daily_append')!.config);
    expect(description).toContain('NOT general markdown');
  });
});

/* ------------------------------------------------------------------ *
 * lorefold_daily_append
 * ------------------------------------------------------------------ */

describe('lorefold_daily_append', () => {
  it('writes the parsed outline to @today and reports the page it landed on', async () => {
    harness.client.writePath.mockResolvedValue({
      title: TODAY_TITLE,
      children: [{ uid: 'a1', string: 'parent', children: [{ uid: 'a2', string: 'child' }] }],
    } as never);

    const result = await harness.call('lorefold_daily_append', {
      markdown: '- parent\n  - child',
    });

    expect(result.isError).toBeFalsy();
    expect(harness.client.writePath).toHaveBeenCalledWith(
      [{ pageQuery: '@today' }],
      [{ string: 'parent', children: [{ string: 'child' }] }],
    );

    const text = textOf(result);
    expect(text).toContain('Appended 2 block(s)');
    expect(text).toContain(`page "${TODAY_TITLE}"`);
    expect(text).toContain('attributed to "claude"');
    // Both representations, as LF-13 requires.
    expect(text).toContain('- parent\n  - child');
    expect(text).toContain('Internal representation (JSON)');
  });

  it('descends through `under`, creating the selector blocks', async () => {
    harness.client.writePath.mockResolvedValue({ uid: 'sec', string: 'Log' } as never);
    harness.client.readPath.mockResolvedValue({ title: TODAY_TITLE } as never);

    const result = await harness.call('lorefold_daily_append', {
      markdown: '- something',
      under: ['Log'],
    });

    expect(harness.client.writePath).toHaveBeenCalledWith(
      [{ pageQuery: '@today' }, { blockString: 'Log' }],
      [{ string: 'something' }],
    );
    // The page title is fetched separately so the timezone check still runs.
    expect(harness.client.readPath).toHaveBeenCalledWith([{ pageQuery: '@today' }]);
    expect(textOf(result)).toContain('under "Log"');
  });

  it('shouts when the server\'s day disagrees with the configured timezone', async () => {
    harness.client.writePath.mockResolvedValue({ title: 'August 11, 2026' } as never);

    const text = textOf(await harness.call('lorefold_daily_append', { markdown: '- x' }));
    expect(text).toContain('TIMEZONE MISMATCH');
    expect(text).toContain('August 11, 2026');
    expect(text).toContain(TODAY_TITLE);
  });

  it('stays quiet when the server agrees', async () => {
    harness.client.writePath.mockResolvedValue({ title: TODAY_TITLE } as never);
    expect(textOf(await harness.call('lorefold_daily_append', { markdown: '- x' }))).not.toContain(
      'TIMEZONE MISMATCH',
    );
  });

  it('flags block text that will create pages as a side effect', async () => {
    harness.client.writePath.mockResolvedValue({ title: TODAY_TITLE } as never);
    const text = textOf(
      await harness.call('lorefold_daily_append', { markdown: '- shipped [[LF-13]]' }),
    );
    expect(text).toContain('page link');
    expect(text).toContain('[[LF-13]]');
  });

  it('refuses empty content without touching the server', async () => {
    const result = await harness.call('lorefold_daily_append', { markdown: '   \n\n' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('no blocks');
    expect(harness.client.writePath).not.toHaveBeenCalled();
  });

  it("passes the server's rejection reason through", async () => {
    harness.client.writePath.mockRejectedValue(
      new LorefoldAuthError(401, '/api/path/write', 'access denied', 'check LOREFOLD_PASSWORD'),
    );
    const result = await harness.call('lorefold_daily_append', { markdown: '- x' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('check LOREFOLD_PASSWORD');
  });
});

/* ------------------------------------------------------------------ *
 * lorefold_page_read
 * ------------------------------------------------------------------ */

describe('lorefold_page_read', () => {
  it('reads by exact title and returns markdown alongside the IR', async () => {
    harness.client.readPath.mockResolvedValue({
      title: 'Some Page',
      children: [{ uid: 'b1', string: 'one', children: [{ uid: 'b2', string: 'two' }] }],
    } as never);

    const result = await harness.call('lorefold_page_read', { title: 'Some Page' });

    expect(harness.client.readPath).toHaveBeenCalledWith([{ pageTitle: 'Some Page' }]);
    const text = textOf(result);
    expect(text).toContain('Read page "Some Page" — 2 block(s)');
    expect(text).toContain('- one\n  - two');
    expect(text).toContain('"uid": "b1"');
  });

  it('reads by uid and by today', async () => {
    harness.client.readPath.mockResolvedValue({ uid: 'b1', string: 'x' } as never);
    await harness.call('lorefold_page_read', { uid: 'b1' });
    expect(harness.client.readPath).toHaveBeenCalledWith([{ blockUid: 'b1' }]);

    harness.client.readPath.mockResolvedValue({ title: TODAY_TITLE } as never);
    await harness.call('lorefold_page_read', { today: true });
    expect(harness.client.readPath).toHaveBeenCalledWith([{ pageQuery: '@today' }]);
  });

  it('explains the zero-padded title format when a page is missing', async () => {
    harness.client.readPath.mockResolvedValue(null);
    const result = await harness.call('lorefold_page_read', { title: 'August 9, 2026' });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('No page titled "August 9, 2026" exists');
    expect(text).toContain('August 09, 2026');
    expect(text).toContain('lorefold_page_create');
  });

  it('requires exactly one way of addressing the page', async () => {
    const none = await harness.call('lorefold_page_read', {});
    expect(none.isError).toBe(true);
    expect(textOf(none)).toContain('exactly one');

    const both = await harness.call('lorefold_page_read', { title: 'p', uid: 'b1' });
    expect(both.isError).toBe(true);
    expect(textOf(both)).toContain('exactly one');
  });

  it('says when properties exist but are not in the outline', async () => {
    harness.client.readPath.mockResolvedValue({
      title: 'Decision 1',
      children: [{ uid: 'b1', string: 'body' }],
      properties: { status: { uid: 'p1', string: 'accepted' } },
    } as never);

    const text = textOf(await harness.call('lorefold_page_read', { title: 'Decision 1' }));
    expect(text).toContain('1 property block(s)');
    expect(text).toContain('"status"');
  });
});

/* ------------------------------------------------------------------ *
 * lorefold_page_write
 * ------------------------------------------------------------------ */

describe('lorefold_page_write', () => {
  it('builds a full path from root and selectors', async () => {
    harness.client.writePath.mockResolvedValue({ uid: 'sec', string: 'Section A' } as never);

    const result = await harness.call('lorefold_page_write', {
      root: { pageTitle: 'Some Page' },
      selectors: [{ blockString: 'Section A' }],
      markdown: '- note',
    });

    expect(harness.client.writePath).toHaveBeenCalledWith(
      [{ pageTitle: 'Some Page' }, { blockString: 'Section A' }],
      [{ string: 'note' }],
    );
    expect(textOf(result)).toContain('Appended 1 block(s) to block sec');
  });

  it('supports every root form', async () => {
    harness.client.writePath.mockResolvedValue({ title: 'p' } as never);

    await harness.call('lorefold_page_write', { root: { pageQuery: '@today' }, markdown: '- a' });
    expect(harness.client.writePath).toHaveBeenLastCalledWith([{ pageQuery: '@today' }], [{ string: 'a' }]);

    await harness.call('lorefold_page_write', { root: { blockUid: 'b1' }, markdown: '- a' });
    expect(harness.client.writePath).toHaveBeenLastCalledWith([{ blockUid: 'b1' }], [{ string: 'a' }]);
  });

  it('rejects an ambiguous or empty root before calling the server', async () => {
    const empty = await harness.call('lorefold_page_write', { root: {}, markdown: '- a' });
    expect(empty.isError).toBe(true);
    expect(textOf(empty)).toContain('exactly one');

    const ambiguous = await harness.call('lorefold_page_write', {
      root: { pageTitle: 'p', blockUid: 'b1' },
      markdown: '- a',
    });
    expect(ambiguous.isError).toBe(true);
    expect(textOf(ambiguous)).toContain('pageTitle and blockUid');
    expect(harness.client.writePath).not.toHaveBeenCalled();
  });

  it('rejects a selector that sets both or neither field', async () => {
    const result = await harness.call('lorefold_page_write', {
      root: { pageTitle: 'p' },
      selectors: [{}],
      markdown: '- a',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Selector 1');
  });
});

/* ------------------------------------------------------------------ *
 * lorefold_page_create
 * ------------------------------------------------------------------ */

describe('lorefold_page_create', () => {
  it('creates an empty page with a bare page/title payload', async () => {
    harness.client.readPath.mockResolvedValue(null);
    harness.client.writePath.mockResolvedValue({ title: 'New Page' } as never);

    const result = await harness.call('lorefold_page_create', { title: 'New Page' });

    expect(harness.client.writePath).toHaveBeenCalledWith(
      [{ pageTitle: 'New Page' }],
      [{ title: 'New Page' }],
    );
    expect(textOf(result)).toContain('Created page "New Page" (empty)');
  });

  it('creates a page with starting content, which pulls the page into existence', async () => {
    harness.client.readPath.mockResolvedValue(null);
    harness.client.writePath.mockResolvedValue({
      title: 'New Page',
      children: [{ uid: 'c1', string: 'first' }],
    } as never);

    const result = await harness.call('lorefold_page_create', {
      title: 'New Page',
      markdown: '- first\n  - nested',
    });

    expect(harness.client.writePath).toHaveBeenCalledWith(
      [{ pageTitle: 'New Page' }],
      [{ string: 'first', children: [{ string: 'nested' }] }],
    );
    expect(textOf(result)).toContain('with 2 block(s)');
  });

  it('refuses to create over an existing page and names the tool to use instead', async () => {
    harness.client.readPath.mockResolvedValue({
      title: 'New Page',
      children: [{ uid: 'c1', string: 'already here' }],
    } as never);

    const result = await harness.call('lorefold_page_create', { title: 'New Page' });

    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('already exists (1 block(s))');
    expect(text).toContain('lorefold_page_write');
    expect(harness.client.writePath).not.toHaveBeenCalled();
  });
});
