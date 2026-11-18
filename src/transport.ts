import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

/**
 * Obergrenze einer MCP-Nachricht ueber stdio (0.6.0). Das SDK gibt 10 MiB vor; eine PDF-Datei von 10 MiB ist als Base64 rund 14 MB
 * lang (`prepare_file_upload`), dazu kommt der JSON-Rahmen. Darueber bliebe die Nachricht ohne Antwort (gemessen 18.11.2026 an
 * dist/index.js: 7'863'000 Bytes gingen, 7'864'320 nicht). 16 MiB lassen Platz fuer Base64 von 10 MiB plus Rahmen.
 *
 * Grenze der Grenze: Eine Nachricht ueber 16 MiB wird NICHT mit einem Fehler beantwortet. Das SDK schliesst den Transport, der
 * stdio-Server endet (gemessen mit 17 MiB: Exit 0, danach EPIPE). Das trifft Dateien ab etwa 12 MiB (Base64 = 4/3). Es gibt hier
 * keinen eigenen Transport; im eigenen Prozess (`createToolset(...).call`) gilt die Grenze von 10 MB sauber, mit Fehlermeldung.
 */
export const STDIO_MAX_BYTES = 16 * 1024 * 1024;

/** Der Transport des Servers; Ein- und Ausgabe nur fuer Tests austauschbar. */
export function stdioTransport(stdin?: Readable, stdout?: Writable): StdioServerTransport {
  return new StdioServerTransport(stdin, stdout, { maxBufferSize: STDIO_MAX_BYTES });
}
