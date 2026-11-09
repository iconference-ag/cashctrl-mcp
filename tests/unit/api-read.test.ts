import { describe, it, expect, afterAll } from 'vitest';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolset } from '../../src/toolset.js';
import { MAX_ANTWORT, dateiname } from '../../src/tools/api/read.js';
import type { Config, OrgConfig } from '../../src/config/config.js';
import type { UsageState } from '../../src/core/usage.js';

/**
 * api_catalog und api_read (0.4.0, Entscheid 24.10.2026). Keine Live-Aufrufe: jede Antwort
 * kommt aus einer Attrappe. Der Kern der Zusage: jede Abweisung geschieht VOR dem Netzaufruf, also
 * zaehlt die Attrappe die Aufrufe und der Test verlangt null.
 */
const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-api-read.json`);
afterAll(async () => { await rm(usageFile, { force: true }); });
const cfg = (orgs: OrgConfig[], mode: Config['mode'] = 'read'): Config => ({ mode, pdfDir: '/tmp/x', usageFile, source: 'env', orgs });
const NT: OrgConfig = { name: 'nt', subdomain: 'd', 'apiKey': 'k' };
const LOHN: OrgConfig = { name: 'lohn', subdomain: 'd2', 'apiKey': 'k2', salary: true };
const text = (r: { content?: unknown[] }) => {
  const c = r.content?.[0];
  return c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '';
};
const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });

/** Attrappe fuer fetch, PDF-Ablage und Zaehler. `antwort` bestimmt je Aufruf die Antwort. */
function env(antwort: (url: URL) => Response = () => json({ data: [], total: 0 })) {
  const calls: { url: URL; method: string }[] = [];
  const puts: { org: string; name: string; bytes: Uint8Array }[] = [];
  let gezaehlt = 0;
  const fetchImpl = (async (u: string | URL, init?: RequestInit) => { const url = new URL(String(u)); calls.push({ url, method: init?.method ?? 'GET' }); return antwort(url); }) as unknown as typeof fetch;
  const stores = {
    pdf: { put: async (org: string, name: string, bytes: Uint8Array) => { puts.push({ org, name, bytes }); return `ablage:${org}/${name}`; } },
    usage: { state: async () => ({}) as UsageState, record: async () => { gezaehlt++; return {} as UsageState; } },
  };
  return { calls, puts, fetchImpl, stores, gezaehlt: () => gezaehlt };
}
const toolset = (orgs: OrgConfig[], e = env(), mode: Config['mode'] = 'read') => createToolset(cfg(orgs, mode), { fetchImpl: e.fetchImpl, stores: e.stores });

describe('api_catalog', () => {
  it('ohne Filter: hoechstens 100 Treffer, total 376, hasMore, dazu die Bereiche; kein Netzaufruf', async () => {
    const e = env();
    const r = await toolset([NT], e).call('api_catalog', {});
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as { items: unknown[]; total: number; hasMore: boolean; areas: string[] };
    expect(s.items).toHaveLength(100);
    expect(s.total).toBe(376);
    expect(s.hasMore).toBe(true);
    expect(s.areas).toEqual(expect.arrayContaining(['person', 'order', 'salary', 'journal']));
    expect(e.calls).toHaveLength(0);
  });
  it('query und area filtern; kind und gate je Treffer aus dem Katalog', async () => {
    const t = toolset([NT]);
    const r = await t.call('api_catalog', { query: 'delete title', area: 'person' });
    const s = r.structuredContent as { items: { path: string; method: string; title: string; kind: string; gate?: string }[]; total: number };
    expect(s.items.map((x) => x.path)).toContain('person/title/delete.json');
    expect(s.items.find((x) => x.path === 'person/title/delete.json')).toMatchObject({ method: 'POST', kind: 'delete', gate: 'deleteRecords' });
    expect(s.items.every((x) => x.path.startsWith('person/'))).toBe(true);
    const lohn = (await t.call('api_catalog', { area: 'salary' })).structuredContent as { items: { gate?: string }[]; total: number };
    expect(lohn.total).toBe(90);
    expect(lohn.items.every((x) => x.gate === 'salary')).toBe(true);
    const zahl = (await t.call('api_catalog', { query: 'person list' })).structuredContent as { items: { path: string; kind: string; gate?: string }[] };
    expect(zahl.items.find((x) => x.path === 'person/list.json')).toMatchObject({ kind: 'read' });
    expect(zahl.items.find((x) => x.path === 'person/list.json')!.gate).toBeUndefined();
  });
  it('bei Ueberlagerung nennt der Eintrag alle Schalter (gates), gate den ersten', async () => {
    const r = await toolset([NT]).call('api_catalog', { query: 'salary status delete' });
    const s = r.structuredContent as { items: { path: string; gate?: string; gates?: string[] }[] };
    expect(s.items.find((x) => x.path === 'salary/status/delete.json')).toMatchObject({ gate: 'salary', gates: ['salary', 'deleteRecords'] });
  });
  it('ohne Treffer: total 0 und die Liste der Bereiche', async () => {
    const r = await toolset([NT]).call('api_catalog', { query: 'xyzgibtesnicht' });
    expect(r.structuredContent).toMatchObject({ items: [], total: 0 });
    expect((r.structuredContent as { areas: string[] }).areas.length).toBeGreaterThan(10);
  });
  it('mit path: der volle Eintrag mit Parametern (auch ohne .json im Pfad); unbekannter Pfad ist ein Fehler', async () => {
    const t = toolset([NT]);
    const r = await t.call('api_catalog', { path: 'order/create' });
    const s = r.structuredContent as { path: string; method: string; kind: string; params: { name: string; required: boolean; fields?: unknown[] }[] };
    expect(s).toMatchObject({ path: 'order/create.json', method: 'POST', kind: 'write' });
    expect(s.params.find((p) => p.name === 'items')!.fields!.length).toBeGreaterThan(5);
    const x = await t.call('api_catalog', { path: 'order/gibtsnicht.json' });
    expect(x.isError).toBe(true);
    expect(text(x)).toContain('nicht im Katalog');
  });
});

describe('api_read: Abweisung vor dem Netzaufruf', () => {
  async function abgewiesen(orgs: OrgConfig[], args: Record<string, unknown>, muster: RegExp) {
    const e = env();
    const r = await toolset(orgs, e).call('api_read', args);
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(muster);
    expect(r.structuredContent).toMatchObject({ kind: 'validation' });
    expect(e.calls, 'fetch darf nicht aufgerufen worden sein').toHaveLength(0);
    expect(e.gezaehlt(), 'kein Zaehlerstand').toBe(0);
  }
  it('unbekannter Pfad', async () => { await abgewiesen([NT], { path: 'person/gibtsnicht.json' }, /nicht im Katalog/); });
  it('Pfad mit Pfadtricks', async () => { await abgewiesen([NT], { path: '../../etc/passwd' }, /nicht im Katalog/); });
  it('POST-Pfad (schreibend)', async () => { await abgewiesen([NT], { path: 'person/title/create.json', params: { name: 'x' } }, /POST|ändert Daten/); });
  it('Lohn ohne Schalter salary der angesprochenen Organisation (auch wenn eine andere ihn traegt)', async () => {
    await abgewiesen([NT], { path: 'salary/status/list.json' }, /salary/);
    await abgewiesen([NT, LOHN], { org: 'nt', path: 'salary/status/list.json' }, /nt nicht freigeschaltet \(salary\)/);
  });
  it('fehlender Pflichtparameter', async () => { await abgewiesen([NT], { path: 'person/read.json' }, /Pflichtparameter fehlen.*id/); });
  it('unbekannter Parametername (fail-closed)', async () => { await abgewiesen([NT], { path: 'person/read.json', params: { id: 1, lang: 'de' } }, /Unbekannte Parameter.*lang/); });
  it('unbekannte Organisation', async () => { await abgewiesen([NT], { org: 'gibtsnicht', path: 'person/list.json' }, /Organisation unbekannt/); });
});

describe('api_read: JSON-Weg', () => {
  it('ruft die richtige URL mit den Parametern auf (Objekte und Listen als JSON, Wahrheitswerte als Text); Pfad auch ohne .json', async () => {
    const e = env(() => json({ data: [{ id: 1 }], total: 1 }));
    const filter = [{ comparison: 'like', field: 'notes', value: 'abc' }];
    const r = await toolset([NT], e).call('api_read', { path: 'person/list', params: { query: 'Muster', limit: 5, onlyCustomers: true, filter } });
    expect(r.isError, text(r)).toBeFalsy();
    expect(e.calls).toHaveLength(1);
    const u = e.calls[0].url;
    expect(`${u.origin}${u.pathname}`).toBe('https://d.cashctrl.com/api/v1/person/list.json');
    expect(e.calls[0].method).toBe('GET');
    expect(u.searchParams.get('query')).toBe('Muster');
    expect(u.searchParams.get('limit')).toBe('5');
    expect(u.searchParams.get('onlyCustomers')).toBe('true');
    expect(JSON.parse(u.searchParams.get('filter')!)).toEqual(filter);
    expect(JSON.parse(text(r))).toEqual({ data: [{ id: 1 }], total: 1 });
    expect(r.structuredContent).toMatchObject({ path: 'person/list.json', contentType: 'application/json', truncated: false });
    // Claude Desktop gibt dem Modell nur structuredContent weiter, wenn es vorhanden ist (Meldung aus Claude Desktop, 25.10.2026):
    // der Antworttext muss darum auch dort stehen.
    expect((r.structuredContent as { body?: string }).body).toBe(text(r));
  });
  it('derselbe Weg wie die Fachwerkzeuge: Zaehler und Drossel laufen, success:false ist ein validation-Fehler ohne sent', async () => {
    const e = env(() => json({ success: false, errors: [{ field: 'id', message: 'ungueltig' }] }));
    const r = await toolset([NT], e).call('api_read', { path: 'person/read.json', params: { id: 9 } });
    expect(e.gezaehlt()).toBe(1);
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ kind: 'validation' });
    expect(text(r)).toContain('id: ungueltig');
    expect((r.structuredContent as { sent?: boolean }).sent).toBeUndefined();
  });
  it('Lohn-GET mit Schalter salary der angesprochenen Organisation geht durch', async () => {
    const e = env(() => json({ data: [], total: 0 }));
    const r = await toolset([NT, LOHN], e).call('api_read', { org: 'lohn', path: 'salary/status/list.json' });
    expect(r.isError, text(r)).toBeFalsy();
    expect(e.calls[0].url.href).toBe('https://d2.cashctrl.com/api/v1/salary/status/list.json');
  });
  it('403 vom Server: Fehlerart forbidden wie bei den anderen Werkzeugen', async () => {
    const e = env(() => new Response('', { status: 403 }));
    const r = await toolset([NT], e).call('api_read', { path: 'person/list.json' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ kind: 'forbidden' });
  });
});

describe('api_read: Dateien und Text ohne .json', () => {
  it('PDF: Bytes gehen ueber den Store (ctx.pdf.put), Rueckgabe file, bytes, contentType; Liste bei CSV-Parameter wird mit Komma verbunden', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3]);
    const e = env(() => new Response(bytes, { status: 200, headers: { 'content-type': 'application/pdf' } }));
    const r = await toolset([NT], e).call('api_read', { path: 'order/document/read.pdf', params: { ids: [7, 8] } });
    expect(r.isError, text(r)).toBeFalsy();
    expect(e.calls[0].url.pathname).toBe('/api/v1/order/document/read.pdf');
    expect(e.calls[0].url.searchParams.get('ids')).toBe('7,8');
    expect(e.puts).toHaveLength(1);
    expect(e.puts[0].org).toBe('nt');
    expect(e.puts[0].name).toMatch(/^order_document_read-\d{8}T\d{6}-\d{3}Z\.pdf$/);
    expect(Array.from(e.puts[0].bytes)).toEqual(Array.from(bytes));
    expect(r.structuredContent).toEqual({ file: `ablage:nt/${e.puts[0].name}`, bytes: 8, contentType: 'application/pdf' });
  });
  it('Text (text/plain, text/csv) kommt als Text zurueck, nichts wird abgelegt', async () => {
    const e = env(() => new Response('1234.50', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } }));
    const r = await toolset([NT], e).call('api_read', { path: 'account/balance', params: { id: 5, date: '2026-10-24' } });
    expect(text(r)).toBe('1234.50');
    expect(e.calls[0].url.pathname).toBe('/api/v1/account/balance');   // nichts angehaengt
    expect(e.calls[0].url.searchParams.get('date')).toBe('2026-10-24');
    expect(e.puts).toHaveLength(0);
    const csv = env(() => new Response('a;b\n1;2\n', { status: 200, headers: { 'content-type': 'text/csv' } }));
    expect(text(await toolset([NT], csv).call('api_read', { path: 'person/list.csv' }))).toBe('a;b\n1;2\n');
  });
  it('JSON-Antwort ohne Fehler unter einem Endpunkt ohne .json: als Text; mit success:false: Fehler', async () => {
    const gut = env(() => json({ id: 3, name: 'x.pdf' }));
    const r = await toolset([NT], gut).call('api_read', { path: 'file/get', params: { id: 3 } });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toEqual({ id: 3, name: 'x.pdf' });
    expect(gut.puts).toHaveLength(0);
    const schlecht = env(() => json({ success: false, errorMessage: 'Datei existiert nicht.' }));
    const f = await toolset([NT], schlecht).call('api_read', { path: 'file/get', params: { id: 3 } });
    expect(f.isError).toBe(true);
    expect(f.structuredContent).toMatchObject({ kind: 'validation' });
    expect(text(f)).toContain('Datei existiert nicht.');
    expect(schlecht.puts).toHaveLength(0);
  });
  it('404 unter einem Endpunkt ohne .json: not_found, nichts abgelegt', async () => {
    const e = env(() => new Response('<html></html>', { status: 404, headers: { 'content-type': 'text/html' } }));
    const r = await toolset([NT], e).call('api_read', { path: 'file/get', params: { id: 1 } });
    expect(r.structuredContent).toMatchObject({ kind: 'not_found' });
    expect(e.puts).toHaveLength(0);
  });
  it('dateiname: Pfad mit _ statt /, Zeitstempel, Endung aus Pfad, sonst aus dem Inhaltstyp, sonst bin', () => {
    const t = new Date('2026-10-24T22:55:01.234Z');
    expect(dateiname('order/document/read.zip', 'application/zip', t)).toBe('order_document_read-20261024T225501-234Z.zip');
    expect(dateiname('file/get', 'application/pdf', t)).toBe('file_get-20261024T225501-234Z.pdf');
    expect(dateiname('file/get', 'application/octet-stream', t)).toBe('file_get-20261024T225501-234Z.bin');
  });
});

describe('api_read: Kappung', () => {
  it('Antwort ueber 60000 Zeichen wird gekappt und sagt es; structuredContent traegt Metadaten und denselben gekappten Text', async () => {
    const gross = { data: [{ blob: 'x'.repeat(70000) }] };
    const laenge = JSON.stringify(gross).length;
    const e = env(() => json(gross));
    const r = await toolset([NT], e).call('api_read', { path: 'person/list.json', params: { limit: 1 } });
    const t = text(r);
    expect(r.isError).toBeFalsy();
    expect(t).toContain('gekürzt');
    expect(t).toContain(`${MAX_ANTWORT} von ${laenge}`);
    expect(t).toContain('limit');
    expect(t.length).toBeLessThan(MAX_ANTWORT + 300);
    expect(t.length).toBeGreaterThan(MAX_ANTWORT);
    expect(r.structuredContent).toEqual({ path: 'person/list.json', contentType: 'application/json', chars: laenge, truncated: true, body: t });
    // Die Kappung gilt auch in structuredContent (dort steht seit 25.10.2026 derselbe Text als body).
    expect(JSON.stringify(r.structuredContent).length).toBeLessThan(MAX_ANTWORT + 600);
  });
  it('Gegenprobe: genau 60000 Zeichen bleiben ungekuerzt', async () => {
    const roh = 'y'.repeat(MAX_ANTWORT);
    const e = env(() => new Response(roh, { status: 200, headers: { 'content-type': 'text/plain' } }));
    const r = await toolset([NT], e).call('api_read', { path: 'account/balance', params: { id: 1 } });
    expect(text(r)).toBe(roh);
    expect(r.structuredContent).toMatchObject({ truncated: false, chars: MAX_ANTWORT });
  });
});

describe('api_read: Modus und Annotationen', () => {
  it('api_catalog und api_read stehen schon im Modus read; readOnlyHint true; api_catalog ohne openWorld', () => {
    const t = toolset([NT]);
    expect(t.names()).toEqual(expect.arrayContaining(['api_catalog', 'api_read']));
    expect(t.tools.find((x) => x.name === 'api_read')!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(t.tools.find((x) => x.name === 'api_catalog')!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  });
  it('Beschreibungen verweisen auf die Fachwerkzeuge und auf api_catalog zuerst', () => {
    const t = toolset([NT]).tools;
    for (const n of ['api_catalog', 'api_read']) expect(t.find((x) => x.name === n)!.description, n).toMatch(/Fachwerkzeug/);
    // api_read ist seit dem 24.10.2026 live gemessen (Spec, Anhang); experimentell bleibt nur der Schreibweg.
    expect(t.find((x) => x.name === 'api_read')!.description).not.toMatch(/experimentell/i);
    expect(toolset([NT], env(), 'full').tools.find((x) => x.name === 'prepare_api_write')!.description).toMatch(/EXPERIMENTELL/);
  });
});
