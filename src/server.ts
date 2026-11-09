import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import type { Toolset } from './toolset.js';

/**
 * Die Fassung steht nur in package.json (0.4.0: vorher fest «0.2.0» im Quelltext). `../package.json`
 * trifft von `src/` wie von `dist/` aus die Paketwurzel; ein JSON-Import scheitert an `rootDir: src`.
 * Nicht lesbar: «unbekannt», nie eine erfundene Zahl. `server.ts` liegt nicht im lib-Pfad (kein Dateisystem im Desk-Worker noetig).
 */
export function paketVersion(): string {
  try {
    const v = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : 'unbekannt';
  } catch { return 'unbekannt'; }
}

/** Adapter: die schon nach Modus gefilterte Werkzeugliste auf den MCP-Server. Kein Gate hier. */
export function buildServer(toolset: Toolset): McpServer {
  const server = new McpServer({ name: 'cashctrl-mcp', version: paketVersion() });
  for (const t of toolset.tools) {
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }, async (args) => t.handler(args as never));
  }
  return server;
}
