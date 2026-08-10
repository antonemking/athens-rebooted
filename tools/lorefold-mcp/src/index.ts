#!/usr/bin/env node
/**
 * Lorefold MCP bridge — entrypoint (LF-9).
 *
 * Speaks MCP over stdio, so nothing here may ever write to stdout: stdout is
 * the protocol channel. Diagnostics go to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { LorefoldClient } from './client.js';
import { loadConfig, LorefoldConfigError } from './config.js';
import { registerTools } from './tools.js';

const VERSION = '0.1.0';

async function main(): Promise<void> {
  const config = loadConfig();

  const server = new McpServer(
    { name: 'lorefold-mcp', version: VERSION },
    {
      instructions:
        'Read and write a self-hosted Lorefold knowledge graph — an outliner where ' +
        'every page is a tree of blocks. Writes append; nothing here edits or ' +
        'deletes existing blocks. There is no search: pages are addressed by exact ' +
        'title, by block uid, or as today\'s daily note.',
    },
  );

  const client = new LorefoldClient(config);
  registerTools(server, client, config);

  await server.connect(new StdioServerTransport());

  process.stderr.write(
    `lorefold-mcp ${VERSION} ready on stdio — ${config.url} ` +
      `as "${config.username}", daily notes in ${config.timeZone}\n`,
  );
}

main().catch((error: unknown) => {
  if (error instanceof LorefoldConfigError) {
    process.stderr.write(`lorefold-mcp: ${error.message}\n`);
  } else {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`lorefold-mcp: failed to start: ${message}\n`);
  }
  process.exit(1);
});
