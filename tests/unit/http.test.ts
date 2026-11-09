import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CashCtrlHttp } from '../../src/core/http.js';
import { CashCtrlError } from '../../src/core/errors.js';
import type { TokenBucket } from '../../src/core/ratelimit.js';
import type { UsageCounter } from '../../src/core/usage.js';

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL, init: RequestInit = {}) => { calls.push({ url: String(url), init }); return handler(String(url), init); }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** Wegwerf-Zaehlerdatei: ohne sie schreibt der Standard-Zaehler nach ~/.config des Entwicklers. */
const wegwerf = () => join(mkdtempSync(join(tmpdir(), 'http-')), 'usage.json');
const b64 = Buffer.from('SECRT:').toString('base64');
/** Gibt den geworfenen Fehler zurueck — und scheitert, wenn keiner kommt. */
async function fehler(p: Promise<unknown>): Promise<CashCtrlError> {
  try { await p; } catch (e) { return e as CashCtrlError; }
  throw new Error('Erwarteter Fehler blieb aus');
}

describe('CashCtrlHttp', () => {
  it('haengt .json an, setzt Basic Auth und kodiert POST als Formular mit JSON-Feldern', async () => {
    const { f, calls } = fakeFetch(() => json({ success: true, insertId: 7 }));
    const h = new CashCtrlHttp({ subdomain: 'demo', apiKey: 'ab12', org: 'x', fetchImpl: f, usageFile: wegwerf() });
    const r = await h.post<{ insertId: number }>('person/create', { company: 'Muster AG', items: [{ a: 1 }], skip: undefined });
    expect(r.insertId).toBe(7);
    expect(calls[0].url).toBe('https://demo.cashctrl.com/api/v1/person/create.json');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Basic ' + Buffer.from('ab12:').toString('base64'));
    expect(String(calls[0].init.body)).toBe('company=Muster+AG&items=%5B%7B%22a%22%3A1%7D%5D');
  });
  it('bildet success:false auf validation ab und nennt die Feldfehler', async () => {
    const { f } = fakeFetch(() => json({ success: false, errors: [{ field: 'name', message: 'darf nicht leer sein' }] }));
    const h = new CashCtrlHttp({ subdomain: 'demo', apiKey: 'k', org: 'x', fetchImpl: f, usageFile: wegwerf() });
    await expect(h.post('person/create', {})).rejects.toMatchObject({ kind: 'validation', message: expect.stringContaining('name: darf nicht leer sein') });
  });
  it('bildet 401/403/404 und HTML-404 ab', async () => {
    for (const [status, kind] of [[401, 'auth'], [403, 'forbidden'], [404, 'not_found']] as const) {
      const { f } = fakeFetch(() => new Response('<html>404</html>', { status, headers: { 'content-type': 'text/html' } }));
      await expect(new CashCtrlHttp({ subdomain: 'd', apiKey: 'k', org: 'x', fetchImpl: f, usageFile: wegwerf() }).get('person/list')).rejects.toMatchObject({ kind });
    }
  });
  it('wiederholt 429 dreimal mit 2/4/6 s, dann rate_limit — Bucket und Zaehler je Versuch (T4)', async () => {
    const ablauf: string[] = [];
    const waits: number[] = [];
    const { f, calls } = fakeFetch(() => { ablauf.push('fetch'); return new Response('', { status: 429 }); });
    const bucket = { take: async () => { ablauf.push('take'); } } as unknown as TokenBucket;
    const usage = { record: async () => { ablauf.push('record'); } } as unknown as UsageCounter;
    const h = new CashCtrlHttp({ subdomain: 'd', apiKey: 'k', org: 'x', fetchImpl: f, sleep: async (ms) => { waits.push(ms); }, bucket, usage });
    await expect(h.get('person/list')).rejects.toMatchObject({ kind: 'rate_limit' });
    expect(calls.length).toBe(4);
    expect(waits).toEqual([2000, 4000, 6000]);
    expect(ablauf).toEqual(['take', 'record', 'fetch', 'take', 'record', 'fetch', 'take', 'record', 'fetch', 'take', 'record', 'fetch']);
  });
  it('gibt den Schluessel nie in einer Fehlermeldung preis', async () => {
    const { f } = fakeFetch(() => { throw new Error('ECONNRESET'); });
    const h = new CashCtrlHttp({ subdomain: 'd', apiKey: 'SECRT', org: 'x', fetchImpl: f, usageFile: wegwerf() });
    const err = await fehler(h.get('person/list'));
    expect(err.kind).toBe('network');
    expect(JSON.stringify(err)).not.toContain('SECRT');
    expect(err.message).not.toContain('SECRT');
  });

  it('haelt Schluessel und Basic-Auth aus jeder Serialisierung heraus (I1)', async () => {
    const { f } = fakeFetch(() => json({ success: true }));
    const h = new CashCtrlHttp({ subdomain: 'd', apiKey: 'SECRT', org: 'x', fetchImpl: f, usageFile: wegwerf() });
    expect(JSON.stringify(h)).not.toContain('SECRT');
    expect(JSON.stringify(h)).not.toContain(b64);
    expect(JSON.parse(JSON.stringify(h))).toEqual({ subdomain: 'd', org: 'x' });
    expect(JSON.stringify({ client: h })).not.toContain(b64);
    // Positivkontrolle: dieselbe Pruefung schlaegt bei einem Objekt mit Auth-Feld an.
    expect(JSON.stringify({ auth: 'Basic ' + b64 })).toContain(b64);
  });

  it('bricht einen Versuch nach timeoutMs ab und meldet Zeitueberschreitung (I2)', async () => {
    const f = ((_url: string | URL, init: RequestInit = {}) => new Promise<Response>((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(new DOMException('The operation was aborted.', 'AbortError')));
    })) as unknown as typeof fetch;
    const h = new CashCtrlHttp({ subdomain: 'd', apiKey: 'k', org: 'x', fetchImpl: f, timeoutMs: 20, usageFile: wegwerf() });
    const err = await fehler(h.get('person/list'));
    expect(err.kind).toBe('network');
    expect(err.message).toContain('Zeitüberschreitung');
    expect(err.message).toContain('person/list');
  });

  it('bildet auch einen Abbruch beim Lesen der Antwort ab, nicht nur beim Aufruf (I2)', async () => {
    const abgebrochen = {
      status: 200, ok: true, headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    } as unknown as Response;
    const { f } = fakeFetch(() => abgebrochen);
    const h = new CashCtrlHttp({ subdomain: 'd', apiKey: 'k', org: 'x', fetchImpl: f, timeoutMs: 20, usageFile: wegwerf() });
    const err = await fehler(h.get('person/list'));
    expect(err).toBeInstanceOf(CashCtrlError);
    expect(err.kind).toBe('network');
    expect(err.message).toContain('Zeitüberschreitung');
  });

  it('legt ohne Angabe Bucket und Zaehler selbst an, Opt-out nur mit null (I4)', async () => {
    const mit = wegwerf();
    const { f } = fakeFetch(() => json({ success: true }));
    await new CashCtrlHttp({ subdomain: 'd', apiKey: 'k', org: 'nt', fetchImpl: f, usageFile: mit }).get('person/list');
    expect(JSON.parse(readFileSync(mit, 'utf8')).nt.calls).toBe(1);
    const ohne = wegwerf();
    const h2 = new CashCtrlHttp({ subdomain: 'd', apiKey: 'k', org: 'nt', fetchImpl: f, usageFile: ohne, bucket: null, usage: null });
    await h2.get('person/list');
    expect(existsSync(ohne)).toBe(false);
  });

  it('nimmt fuer getBinary nur PDF-Antworten (M9)', async () => {
    const htm = fakeFetch(() => new Response('<html>Anmeldung</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(new CashCtrlHttp({ subdomain: 'd', apiKey: 'k', org: 'x', fetchImpl: htm.f, usageFile: wegwerf() }).getBinary('order/read.pdf'))
      .rejects.toMatchObject({ kind: 'not_found', message: expect.stringContaining('Kein application/pdf erhalten') });
    const pdf = fakeFetch(() => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { 'content-type': 'application/pdf' } }));
    const bytes = await new CashCtrlHttp({ subdomain: 'd', apiKey: 'k', org: 'x', fetchImpl: pdf.f, usageFile: wegwerf() }).getBinary('order/read.pdf');
    expect(Array.from(bytes)).toEqual([37, 80, 68, 70]);
  });

  it('nennt in Meldungen den Endpunkt ohne .json (Minor)', async () => {
    const { f } = fakeFetch(() => { throw new Error('ECONNRESET'); });
    const h = new CashCtrlHttp({ subdomain: 'd', apiKey: 'k', org: 'x', fetchImpl: f, usageFile: wegwerf() });
    const err = await fehler(h.get('person/list'));
    expect(err.message).toContain('person/list');
    expect(err.message).not.toContain('.json');
  });

  it('kombiniert ein mitgegebenes Signal mit der Zeitgrenze (Minor)', async () => {
    const f = ((_url: string | URL, init: RequestInit = {}) => new Promise<Response>((_res, rej) => {
      const brich = () => rej(new DOMException('abgebrochen', 'AbortError'));
      if (init.signal?.aborted) { brich(); return; }
      init.signal?.addEventListener('abort', brich);
    })) as unknown as typeof fetch;
    const h = new CashCtrlHttp({ subdomain: 'd', apiKey: 'k', org: 'x', fetchImpl: f, timeoutMs: 60000, usageFile: wegwerf() });
    const intern = h as unknown as { request: (p: string, i: RequestInit) => Promise<Response> };
    const err = await fehler(intern.request('person/list.json', { signal: AbortSignal.abort() }));
    expect(err.kind).toBe('network');
    expect(err.message).not.toContain('Zeit\u00fcberschreitung');   // abgebrochen, nicht abgelaufen
  });

  it('verwirft den Body, wenn der content-type nicht passt (Minor)', async () => {
    let verworfen = false;
    const res = {
      status: 200, ok: true, headers: new Headers({ 'content-type': 'text/html' }),
      body: { cancel: async () => { verworfen = true; } },
    } as unknown as Response;
    const { f } = fakeFetch(() => res);
    const h = new CashCtrlHttp({ subdomain: 'd', apiKey: 'k', org: 'x', fetchImpl: f, usageFile: wegwerf() });
    await expect(h.getBinary('order/read.pdf')).rejects.toMatchObject({ kind: 'not_found' });
    expect(verworfen).toBe(true);
  });

  it('gibt den Schluessel in keiner Fehlerart preis (M12)', async () => {
    const faelle: { name: string; handler: () => Response }[] = [
      { name: '401', handler: () => new Response('', { status: 401 }) },
      { name: '403', handler: () => new Response('', { status: 403 }) },
      { name: '404', handler: () => new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } }) },
      { name: '429', handler: () => new Response('', { status: 429 }) },
      { name: '500', handler: () => new Response('', { status: 500 }) },
      { name: 'success:false', handler: () => json({ success: false, errors: [{ field: 'name', message: 'leer' }] }) },
      { name: 'kein JSON', handler: () => new Response('<html>Anmeldung</html>', { status: 200, headers: { 'content-type': 'text/html' } }) },
    ];
    for (const fall of faelle) {
      const { f } = fakeFetch(fall.handler);
      const h = new CashCtrlHttp({ subdomain: 'd', apiKey: 'SECRT', org: 'x', fetchImpl: f, sleep: async () => {}, usageFile: wegwerf() });
      const err = await fehler(h.get('person/list'));
      expect(err, fall.name).toBeInstanceOf(CashCtrlError);
      for (const text of [err.message, JSON.stringify(err), JSON.stringify(err.details ?? null)]) {
        expect(text, fall.name).not.toContain('SECRT');
        expect(text, fall.name).not.toContain(b64);
      }
    }
    const netz = fakeFetch(() => { throw new Error('ECONNRESET'); });
    const err = await fehler(new CashCtrlHttp({ subdomain: 'd', apiKey: 'SECRT', org: 'x', fetchImpl: netz.f, usageFile: wegwerf() }).get('person/list'));
    expect(err.message).not.toContain('SECRT');
    expect(JSON.stringify(err)).not.toContain(b64);
    // Positivkontrolle: die Pruefung beisst, wenn wirklich etwas durchsickert.
    const leck = new CashCtrlError('unknown', 'Aufruf mit SECRT gescheitert', { header: 'Basic ' + b64 });
    expect(leck.message).toContain('SECRT');
    expect(JSON.stringify(leck.details)).toContain(b64);
  });
});

// 0.3.2: CashCtrl nennt den Grund einer Ablehnung beim Lesen in `errorMessage` (gemessen 20.10.2026 01:46Z am Demo-Mandanten: order/read einer
// unbekannten Kennung -> {"success":false,"errorMessage":"This document does not exist.","data":null}; ohne `lang` englisch).
describe('CashCtrlHttp 0.3.2: Grund der Ablehnung', () => {
  const ablehnung = async (body: unknown) => {
    const { f } = fakeFetch(() => json(body));
    return fehler(new CashCtrlHttp({ subdomain: 'demo', apiKey: 'k', org: 'x', fetchImpl: f, usageFile: wegwerf() }).get('order/read', { id: 9 }));
  };
  it('liest errorMessage (gemessene Form)', async () => {
    const e = await ablehnung({ success: false, errorMessage: 'This document does not exist.', data: null });
    expect(e.kind).toBe('validation');
    expect(e.message).toBe('CashCtrl lehnt ab: This document does not exist.');
  });
  it('errors[] sticht errorMessage', async () => {
    const e = await ablehnung({ success: false, errorMessage: 'allgemein', errors: [{ field: 'nr', message: 'doppelt' }] });
    expect(e.message).toBe('CashCtrl lehnt ab: nr: doppelt');
  });
  it('errors[] ohne field (gemessen 20.10.2026 an person/create mit «info@neukunde»): nur der Satz, kein «?: »', async () => {
    const e = await ablehnung({ success: false, message: null, errors: [{ field: null, message: 'Contact #1: Address: Invalid format. Please enter as follows: john@doe.com' }] });
    expect(e.message).toBe('CashCtrl lehnt ab: Contact #1: Address: Invalid format. Please enter as follows: john@doe.com');
  });
  it('ohne jeden Grund: ein Satz, der das sagt, kein «ohne Begründung»', async () => {
    const e = await ablehnung({ success: false, data: null });
    expect(e.kind).toBe('validation');
    expect(e.message).toBe('CashCtrl hat abgewiesen und keinen Grund genannt.');
  });
});
