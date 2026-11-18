import { describe, it, expect } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { STDIO_MAX_BYTES, stdioTransport } from '../../src/transport.js';

/**
 * Ueber stdio gilt je Nachricht eine Obergrenze des SDK (Standard 10 MiB). Eine PDF-Datei von 10 MiB ist als Base64 rund 14 MB lang;
 * ohne eigene Grenze bliebe `prepare_file_upload` darueber ohne Antwort (gemessen 18.11.2026 an dist/index.js).
 */
async function sende(zeile: string) {
  const stdin = new PassThrough();
  const stdout = new Writable({ write(_c, _e, cb) { cb(); } });
  const t = stdioTransport(stdin, stdout);
  const empfangen: unknown[] = []; const fehler: Error[] = []; let geschlossen = false;
  t.onmessage = (m) => empfangen.push(m); t.onerror = (e) => fehler.push(e); t.onclose = () => { geschlossen = true; };
  await t.start();
  stdin.write(zeile + '\n');
  await new Promise((r) => setTimeout(r, 200));
  const vorClose = geschlossen;
  await t.close();
  return { empfangen, fehler, vorClose };
}
const nachricht = (n: number) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'prepare_file_upload', arguments: { name: 'a.pdf', inhalt: 'A'.repeat(n) } } });

describe('stdio-Transport (0.6.0)', () => {
  it('die Grenze ist 16 MiB', () => { expect(STDIO_MAX_BYTES).toBe(16 * 1024 * 1024); });
  it('eine Nachricht mit dem Base64 einer 10-MiB-Datei (rund 14 MB) kommt an', async () => {
    const b64 = Math.ceil((10 * 1024 * 1024) / 3) * 4;
    const { empfangen, fehler } = await sende(nachricht(b64));
    expect(fehler).toEqual([]);
    expect(empfangen).toHaveLength(1);
  });
  it('eine Nachricht ueber 16 MiB wird nicht abgewiesen, sondern beendet die Verbindung: das SDK schliesst den Transport (gemessen 17 MiB: Exit 0, danach EPIPE; betrifft PDF ab etwa 12 MiB)', async () => {
    const { empfangen, fehler, vorClose } = await sende(nachricht(16 * 1024 * 1024));
    expect(empfangen).toHaveLength(0);
    expect(fehler[0]?.message).toMatch(/exceeded maximum size/);
    expect(vorClose).toBe(true);
  });
});
