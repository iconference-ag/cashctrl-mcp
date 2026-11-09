#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config/config.js';
import { createToolset } from './toolset.js';
import { buildServer } from './server.js';

async function main() {
  const config = await loadConfig();
  const toolset = createToolset(config);
  const server = buildServer(toolset);
  // stdout gehoert dem Protokoll — jede eigene Ausgabe geht auf stderr.
  console.error(`[cashctrl-mcp] Modus ${config.mode}, ${config.orgs.length} Organisation(en), ${toolset.tools.length} Werkzeuge: ${toolset.names().join(', ')}`);
  await server.connect(new StdioServerTransport());
}
main().catch((e) => { console.error(`[cashctrl-mcp] Start fehlgeschlagen: ${e instanceof Error ? e.message : e}`); process.exit(1); });
