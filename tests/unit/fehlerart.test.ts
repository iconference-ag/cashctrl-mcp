import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CashCtrlHttp } from '../../src/core/http.js';
import { CashCtrlError } from '../../src/core/errors.js';
import { fail } from '../../src/tools/result.js';

/**
 * Fehlerart strukturiert (v0.2.0): `sent` sagt bei POST, ob die Anfrage CashCtrl erreicht
 * haben koennte (Regel «im Zweifel true»). Antworten sind aus der Doku nachgebaut, am Mandanten
 * nicht gemessen (12.10.2026).
 */
const wegwerf = () => join(mkdtempSync(join(tmpdir(), 'fehlerart-')), 'usage.json');
const mk = (f: typeof fetch, extra: { timeoutMs?: number } = {}) => new CashCtrlHttp({ subdomain: 'd', 'apiKey': 'k', org: 'x', fetchImpl: f, usage: null, bucket: null, sleep: async () => undefined, ...extra });
async function fehler(p: Promise<unknown>): Promise<CashCtrlError> {
  try { await p; } catch (e) { return e as CashCtrlError; }
  throw new Error('Erwarteter Fehler blieb aus');
}
const mitCode = (code: string) => (async () => { const e = new Error('x') as Error & { code?: string }; e.code = code; throw e; }) as unknown as typeof fetch;
const status = (s: number, body = '') => (async () => new Response(body, { status: s })) as unknown as typeof fetch;

describe('CashCtrlError.sent bei POST', () => {
  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])('%s: Verbindung kam nicht zustande, sent false', async (code) => {
    const e = await fehler(mk(mitCode(code)).post('order/create', {}));
    expect(e.kind).toBe('network');
    expect(e.sent).toBe(false);
  });
  it('ECONNREFUSED nur in cause.code (so meldet undici): sent false', async () => {
    const f = (async () => { const t = new TypeError('fetch failed') as TypeError & { cause?: unknown }; t.cause = { code: 'ECONNREFUSED' }; throw t; }) as unknown as typeof fetch;
    expect((await fehler(mk(f).post('order/create', {}))).sent).toBe(false);
  });
  it('ECONNRESET und unbekannter Netzfehler: sent true', async () => {
    expect((await fehler(mk(mitCode('ECONNRESET')).post('order/create', {}))).sent).toBe(true);
    const f = (async () => { throw new Error('boese'); }) as unknown as typeof fetch;
    expect((await fehler(mk(f).post('order/create', {}))).sent).toBe(true);
  });
  it('Zeitueberschreitung: sent true', async () => {
    const f = ((_u: unknown, init: RequestInit) => new Promise((_r, rej) => { init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))); })) as unknown as typeof fetch;
    const e = await fehler(mk(f, { timeoutMs: 20 }).post('order/create', {}));
    expect(e.message).toContain('Zeitüberschreitung');
    expect(e.sent).toBe(true);
  });
  it('Abbruch von aussen: sent true', async () => {
    const ab = () => Object.assign(new Error('a'), { name: 'AbortError' });
    const f = ((_u: unknown, init: RequestInit) => new Promise((_r, rej) => { if (init.signal!.aborted) rej(ab()); init.signal!.addEventListener('abort', () => rej(ab())); })) as unknown as typeof fetch;
    const c = new AbortController();
    const h = mk(f) as unknown as { request(p: string, i: RequestInit): Promise<unknown> };
    const p = fehler(h.request('order/create.json', { method: 'POST', signal: c.signal }));
    c.abort();
    const e = await p;
    expect(e.message).toContain('Abbruch');
    expect(e.sent).toBe(true);
  });
  it('Fehler beim Lesen der Antwort: sent true', async () => {
    const f = (async () => ({ status: 200, ok: true, text: async () => { throw new Error('kaputt'); } })) as unknown as typeof fetch;
    expect((await fehler(mk(f).post('order/create', {}))).sent).toBe(true);
  });
  it('HTTP 5xx: sent true', async () => {
    const e = await fehler(mk(status(502)).post('order/create', {}));
    expect(e.kind).toBe('unknown');
    expect(e.sent).toBe(true);
  });
  it('Antwort 200 ohne JSON: sent true', async () => {
    expect((await fehler(mk(status(200, '<html>')).post('order/create', {}))).sent).toBe(true);
  });
  it.each([[401, 'auth'], [403, 'forbidden'], [404, 'not_found'], [429, 'rate_limit']] as const)('HTTP %i: CashCtrl hat geantwortet und abgelehnt, sent false', async (s, kind) => {
    const e = await fehler(mk(status(s)).post('order/create', {}));
    expect(e.kind).toBe(kind);
    expect(e.sent).toBe(false);
  });
  it('success:false (validation): sent false', async () => {
    const f = (async () => new Response(JSON.stringify({ success: false, errors: [{ field: 'a', message: 'b' }] }), { status: 200 })) as unknown as typeof fetch;
    const e = await fehler(mk(f).post('order/create', {}));
    expect(e.kind).toBe('validation');
    expect(e.sent).toBe(false);
  });
  it('bei GET bleibt sent unbestimmt', async () => {
    expect((await fehler(mk(mitCode('ECONNRESET')).get('person/list'))).sent).toBeUndefined();
    expect((await fehler(mk(status(502)).get('person/list'))).sent).toBeUndefined();
  });
  it('wiederholt weiterhin nur 429, nie einen POST nach Netzfehler', async () => {
    let n = 0;
    const f = (async () => { n++; throw Object.assign(new Error('x'), { code: 'ECONNRESET' }); }) as unknown as typeof fetch;
    await fehler(mk(f).post('order/create', {}));
    expect(n).toBe(1);
  });
});

describe('fail(): structuredContent', () => {
  it('liefert kind, sent und createdId; Text bleibt unveraendert', () => {
    const r = fail(new CashCtrlError('network', 'Zeit', { geheim: 1 }, { sent: true, createdId: 5 }));
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: 'text', text: 'Zeit' }]);
    expect(r.structuredContent).toEqual({ message: expect.any(String), kind: 'network', sent: true, createdId: 5 });
    expect(JSON.stringify(r)).not.toContain('geheim');
  });
  it('reason geht als fester Grund mit; nach withCreatedId (geschrieben) nicht mehr (0.2.3)', () => {
    // Seit 0.3.0 gibt es keinen festen Grund mehr (negative_total entfallen, B8); der Mechanismus wird mit einem Platzhalter geprueft.
    const e = new CashCtrlError('validation', 'grund', undefined, { reason: 'platzhalter' as never });
    expect(fail(e).structuredContent).toEqual({ message: expect.any(String), kind: 'validation', reason: 'platzhalter' });   // Positivkontrolle
    expect(fail(e.withCreatedId(7)).structuredContent).toEqual({ message: expect.any(String), kind: 'validation', sent: true, createdId: 7 });
  });
  it('ohne Zusatzangaben nur kind; fremde Fehler sind unknown', () => {
    expect(fail(new CashCtrlError('validation', 'x')).structuredContent).toEqual({ message: expect.any(String), kind: 'validation' });
    const r = fail(new Error('boese'));
    expect(r.structuredContent).toEqual({ message: expect.any(String), kind: 'unknown' });
    expect(r.content).toEqual([{ type: 'text', text: 'Fehler: boese' }]);
    expect(fail('x').structuredContent).toEqual({ message: expect.any(String), kind: 'unknown' });
  });
});
