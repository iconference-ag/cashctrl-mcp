import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolset } from '../../src/toolset.js';
import { kontenListe } from '../helpers/konten.js';
import { CashCtrlHttp, OFFEN_SATZ } from '../../src/core/http.js';
import { CashCtrlError } from '../../src/core/errors.js';
import type { Config, OrgConfig } from '../../src/config/config.js';

/**
 * Regressionstests aus dem Review von 0.2.0 (12.10.2026, Sonden S1 bis S12). Die Sonden
 * hielten das damalige Fehlverhalten fest; hier steht das Sollverhalten nach der Fixrunde.
 * Alle CashCtrl-Antworten nachgebaut, am Mandanten nicht gemessen.
 */
const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8');
const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-review-0-2.json`);
afterAll(async () => { await rm(usageFile, { force: true }); });
const ORG: OrgConfig = { name: 'nt', subdomain: 'd', 'apiKey': 'k', sendMail: true, deleteOrders: true };
const cfg: Config = { mode: 'full', pdfDir: '/tmp/x', usageFile, source: 'env', orgs: [ORG] };
const json = (x: unknown) => new Response(typeof x === 'string' ? x : JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
const text = (r: { content?: unknown[] }) => { const c = r.content?.[0]; return c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''; };

const quelle = (JSON.parse(fixture('order-read')) as { data: Record<string, unknown> & { items: Record<string, unknown>[] } }).data;
const order82 = (JSON.parse(fixture('order-list-type-PURCHASE-limit-5')) as { data: Record<string, unknown>[] }).data.find((r) => r.id === 82)!;

type Ueber = (u: string, init?: RequestInit) => Response | Promise<Response> | undefined;
interface Env { fetchImpl: typeof fetch; calls: { method: string; url: string; body: string }[]; ueber: Ueber[]; zustand: Record<string, unknown> }
function makeEnv(opts: { quelleBeleg?: unknown; artikel?: Record<string, unknown> } = {}): Env {
  const calls: Env['calls'] = [];
  const ueber: Ueber[] = [];
  const zustand: Record<string, unknown> = { booked: false };
  const artikel = { success: true, data: { id: 2, nr: 'A-02', name: 'Pflanzwand-Modul 120x60 cm', unitId: 4, salesAccountId: 15, salesPrice: 890, isSalesPriceGross: false, ...opts.artikel } };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url: u, body: String(init?.body ?? '') });
    for (const f of ueber) { const r = await f(u, init); if (r) return r; }
    if (method === 'POST') {
      if (u.includes('order/create')) return json({ success: true, insertId: 99 });
      if (u.includes('order/bookentry/create')) { zustand.booked = true; return json({ success: true, insertId: 500 }); }
      return json({ success: true });
    }
    if (u.includes('order/category/list')) return json(fixture(new URL(u).searchParams.get('type') === 'PURCHASE' ? 'order-category-list-type-PURCHASE' : 'order-category-list-type-SALES'));
    if (u.includes('person/read')) return json(fixture('person-read'));
    if (u.includes('tax/list')) return json(fixture('tax-list'));
    if (u.includes('account/bank/list')) return json(fixture('account-bank-list'));
    if (u.includes('account/list')) return json(kontenListe());
    if (u.includes('inventory/article/read')) return json(artikel);
    if (u.includes('location/list')) return json(fixture('location-list'));
    if (u.includes('order/document/read')) return json(fixture('order-document-read'));
    if (u.includes('order/read')) {
      const id = new URL(u).searchParams.get('id');
      if (id === '99') return json({ success: true, data: { ...quelle, id: 99, nr: 'RE-00001', statusId: 16, total: 1924.18, statusName: '<values><de>Offen</de></values>' } });
      if (id === '82') return json({ success: true, data: zustand.booked ? { ...order82, open: 0 } : order82 });
      return json({ success: true, data: opts.quelleBeleg ?? quelle });
    }
    return json('{}');
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, ueber, zustand };
}
const posts = (e: Env, teil?: string) => e.calls.filter((c) => c.method === 'POST' && (!teil || c.url.includes(teil)));
const basis = { category: 'invoice', statusId: 16, contactId: 7, defaultAccountNumber: '3000', items: [{ articleId: 2, qty: 2, unitPriceNet: 890 }] };

async function prepCommit(e: Env, art: string, args: Record<string, unknown>) {
  const t = createToolset(cfg, { fetchImpl: e.fetchImpl });
  const p = await t.call(`prepare_${art}`, args);
  if (p.isError) throw new Error(`prepare_${art} scheiterte: ${text(p)}`);
  const { token, summary } = p.structuredContent as { token: string; summary: string };
  const c = await t.call(`commit_${art}`, { token });
  return { p, c, summary };
}

const copyArgs = { category: 'invoice', statusId: 16, contactId: 12, copyItemsFromOrderId: 55 };
const kopie = (mut: (q: typeof quelle) => void) => { const q = JSON.parse(JSON.stringify(quelle)) as typeof quelle; mut(q); return q; };
async function prep(e: Env, art: string, args: Record<string, unknown>) {
  return createToolset(cfg, { fetchImpl: e.fetchImpl }).call(`prepare_${art}`, args);
}

describe('sent ueber den ganzen commit (S1, S6c)', () => {
  it('S1a commit_payment: Buchung angelegt, dann update_status 403 -> sent:true, Text ohne «erneut versuchen»', async () => {
    const e = makeEnv();
    e.ueber.push((u, i) => (i?.method === 'POST' && u.includes('order/update_status') ? new Response('', { status: 403 }) : undefined));
    const { c } = await prepCommit(e, 'payment', { orderId: 82, date: '2026-08-27' });
    expect(posts(e, 'order/bookentry/create')).toHaveLength(1);
    expect(c.structuredContent).toEqual({ message: expect.any(String), kind: 'forbidden', sent: true });
    expect(text(c)).toContain(OFFEN_SATZ);
  });
  it('S1b commit_payment: Buchung angelegt, dann update_status success:false -> sent:true', async () => {
    const e = makeEnv();
    e.ueber.push((u, i) => (i?.method === 'POST' && u.includes('order/update_status') ? json({ success: false, errors: [{ field: 'statusId', message: 'nicht erlaubt' }] }) : undefined));
    const { c } = await prepCommit(e, 'payment', { orderId: 82, date: '2026-08-27' });
    expect(c.structuredContent).toEqual({ message: expect.any(String), kind: 'validation', sent: true });
  });
  it('S1c commit_order_draft: Beleg angelegt, dann document/update success:false -> sent:true und createdId', async () => {
    const e = makeEnv();
    e.ueber.push((u, i) => (i?.method === 'POST' && u.includes('order/document/update') ? json({ success: false, errors: [{ field: 'orgBankAccountId', message: 'x' }] }) : undefined));
    const { c } = await prepCommit(e, 'order_draft', { category: 'offer', contactId: 7, defaultAccountNumber: '3000', items: [{ articleId: 2, qty: 1, unitPriceNet: 890 }] });
    expect(posts(e, 'order/create')).toHaveLength(1);
    expect(c.structuredContent).toEqual({ message: expect.any(String), kind: 'validation', sent: true, createdId: 99 });
  });
  it('S1d commit_send_order: Mail versandt, dann order/read 502 -> sent:true', async () => {
    const e = makeEnv();
    let versandt = false;
    e.ueber.push((u, i) => { if (i?.method === 'POST' && u.includes('order/document/mail')) { versandt = true; return json({ success: true }); } return undefined; });
    e.ueber.push((u, i) => ((i?.method ?? 'GET') === 'GET' && u.includes('order/read') && versandt ? new Response('', { status: 502 }) : undefined));
    const { c } = await prepCommit(e, 'send_order', { orderId: 55, subject: 'Offerte', message: 'Anbei.' });
    expect(posts(e, 'order/document/mail')).toHaveLength(1);
    expect(c.structuredContent).toEqual({ message: expect.any(String), kind: 'unknown', sent: true });
    expect(text(c)).toContain(OFFEN_SATZ);
  });
  it('S1e commit_payment: Buchung angelegt, dann order/read 502 -> sent:true', async () => {
    const e = makeEnv();
    e.ueber.push((u, i) => ((i?.method ?? 'GET') === 'GET' && u.includes('order/read') && e.zustand.booked ? new Response('', { status: 502 }) : undefined));
    const { c } = await prepCommit(e, 'payment', { orderId: 82, date: '2026-08-27' });
    expect(c.structuredContent).toEqual({ message: expect.any(String), kind: 'unknown', sent: true });
  });
  it('Negativkontrolle: erster POST eindeutig abgelehnt (403) -> sent bleibt false', async () => {
    const e = makeEnv();
    e.ueber.push((u, i) => (i?.method === 'POST' && u.includes('order/bookentry/create') ? new Response('', { status: 403 }) : undefined));
    const { c } = await prepCommit(e, 'payment', { orderId: 82, date: '2026-08-27' });
    expect(c.structuredContent).toEqual({ message: expect.any(String), kind: 'forbidden', sent: false });
  });
  it('S6c commit_order_create: HTTP 200 mit Body null -> unknown, sent:true', async () => {
    const e = makeEnv();
    e.ueber.push((u, i) => (i?.method === 'POST' && u.includes('order/create') ? json('null') : undefined));
    const { c } = await prepCommit(e, 'order_create', basis);
    expect(c.structuredContent).toEqual({ message: expect.any(String), kind: 'unknown', sent: true });
    expect(posts(e, 'order/document/update')).toHaveLength(0);
  });
});

describe('Text bei POST mit sent:true (S2)', () => {
  const mk = (f: typeof fetch, timeoutMs = 30000) => new CashCtrlHttp({ subdomain: 'd', 'apiKey': 'k', org: 'x', fetchImpl: f, usage: null, bucket: null, timeoutMs, sleep: async () => undefined });
  const haengt = ((_u: unknown, init: RequestInit) => new Promise((_r, rej) => { init.signal!.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'TimeoutError' }))); })) as unknown as typeof fetch;
  async function fehler(p: Promise<unknown>): Promise<CashCtrlError> { try { await p; } catch (e) { return e as CashCtrlError; } throw new Error('kein Fehler'); }
  it('S2a Zeitgrenze auf POST: sent:true, Text sagt «nicht erneut ausführen»', async () => {
    const err = await fehler(mk(haengt, 20).post('order/create', {}));
    expect(err.sent).toBe(true);
    expect(err.message).not.toContain('bitte erneut versuchen');
    expect(err.message).toContain(OFFEN_SATZ);
  });
  it('Kontrolle: Zeitgrenze auf GET behaelt «bitte erneut versuchen»', async () => {
    const err = await fehler(mk(haengt, 20).get('order/read', { id: 1 }));
    expect(err.message).toContain('bitte erneut versuchen');
  });
  it('S2a2 Abbruch auf POST ueber das Werkzeug: sent:true mit OFFEN_SATZ', async () => {
    const e = makeEnv();
    e.ueber.push((u, i) => { if (i?.method === 'POST' && u.includes('order/create')) throw Object.assign(new Error('t'), { name: 'TimeoutError' }); return undefined; });
    const { c } = await prepCommit(e, 'order_create', basis);
    expect(c.structuredContent).toEqual({ message: expect.any(String), kind: 'network', sent: true });
    expect(text(c)).toContain(OFFEN_SATZ);
  });
  it('S2b ECONNRESET auf POST: Text ohne «erneut versuchen»', async () => {
    const e = makeEnv();
    e.ueber.push((u, i) => { if (i?.method === 'POST' && u.includes('order/create')) { const t = new TypeError('fetch failed') as TypeError & { cause?: unknown }; t.cause = { code: 'ECONNRESET' }; throw t; } return undefined; });
    const { c } = await prepCommit(e, 'order_create', basis);
    expect(c.structuredContent).toEqual({ message: expect.any(String), kind: 'network', sent: true });
    expect(text(c)).not.toContain('bitte erneut versuchen');
  });
  it('HTTP 5xx auf POST: Text mit OFFEN_SATZ', async () => {
    const err = await fehler(mk((async () => new Response('', { status: 502 })) as unknown as typeof fetch).post('order/create', {}));
    expect(err.sent).toBe(true);
    expect(err.message).toContain(OFFEN_SATZ);
  });
});

describe('copyItemsFromOrderId fail-closed (S3)', () => {
  const abgewiesen = async (q: unknown, muster: RegExp) => {
    const e = makeEnv({ quelleBeleg: q });
    const p = await prep(e, 'order_create', copyArgs);
    expect(p.isError, text(p)).toBe(true);
    expect(text(p)).toMatch(muster);
    expect(posts(e)).toHaveLength(0);
  };
  it('S3a Positionsrabatt -> abgewiesen', () => abgewiesen(kopie((x) => { x.items[0].discountPercentage = 10; }), /Rabatt/));
  it('Rabatt auf dem ganzen Beleg -> abgewiesen', () => abgewiesen(kopie((x) => { x.discountPercentage = 5; }), /Rabatt auf den ganzen Beleg/));
  it('S3b optionale Position -> abgewiesen', () => abgewiesen(kopie((x) => { x.items[1].isOptional = true; }), /optional/));
  it('S3c Einkaufsbeleg als Quelle -> abgewiesen', () => abgewiesen(kopie((x) => { x.type = 'PURCHASE'; x.categoryId = 15; }), /kein Verkaufsbeleg/));
  // 0.3.0 (B4): die Sperre «Quellbeleg in Fremdwaehrung» entfaellt; die Kopie bekommt die Kennung des Quellbelegs.
  it('S3d (0.3.0) Quelle in EUR -> neue Rechnung mit currencyId 2', async () => {
    const e = makeEnv({ quelleBeleg: kopie((x) => { x.currencyCode = 'EUR'; x.currencyId = 2; x.foreignCurrency = true; }) });
    const { c } = await prepCommit(e, 'order_create', copyArgs);
    expect(c.isError, text(c)).toBeFalsy();
    expect(new URLSearchParams(posts(e, 'order/create')[0].body).get('currencyId')).toBe('2');
  });
  it('S3e Zwischensumme (SUBTOTAL) -> abgewiesen', () => abgewiesen(kopie((x) => { x.items.push({ ...x.items[0], type: 'SUBTOTAL', name: 'Zwischensumme' }); }), /keine normale Position/));
  it('S3f Textzeile -> abgewiesen', () => abgewiesen(kopie((x) => { x.items.splice(1, 0, { type: 'TEXT', name: 'Hinweis', accountId: null, unitPrice: null, quantity: null }); }), /keine normale Position/));
  it('Summe weicht vom Quell-Total ab -> Fehler, nicht Warnung', () => abgewiesen(kopie((x) => { x.total = 213875.8; }), /Total 213875\.80, die übernommenen Positionen ergeben 213875\.85/));
  it('Quellbeleg ohne Total -> abgewiesen', () => abgewiesen(kopie((x) => { delete x.total; }), /kein Total/));
  it('Positivkontrolle: Quelle aus der Aufnahme geht durch; Vorschau zeigt Konto und Steuer je Position', async () => {
    const e = makeEnv();
    const p = await prep(e, 'order_create', copyArgs);
    expect(p.isError, text(p)).toBeFalsy();
    const zeilen = (p.structuredContent as { summary: string }).summary.split('\n').filter((z) => z.startsWith('- '));
    expect(zeilen).toHaveLength(2);
    for (const z of zeilen) { expect(z).toMatch(/\(UN1 8\.1 %\)/); expect(z).toMatch(/Konto \d+ /); }
  });
});

describe('Vorschau zeigt dueDays (S4)', () => {
  it('order_create', async () => {
    const p = await prep(makeEnv(), 'order_create', { ...basis, dueDays: 365 });
    expect((p.structuredContent as { summary: string }).summary).toContain('Frist: 365 Tage');
  });
  it('order_draft', async () => {
    const p = await prep(makeEnv(), 'order_draft', { category: 'offer', contactId: 7, defaultAccountNumber: '3000', dueDays: 45, items: [{ articleId: 2, qty: 1, unitPriceNet: 890 }] });
    expect((p.structuredContent as { summary: string }).summary).toContain('Frist: 45 Tage');
  });
});

describe('insertId streng (S5)', () => {
  for (const [name, wert] of [['true', true], ['1e2', '1e2'], ['0x63', '0x63'], ['[99]', [99]], ['" 99 "', ' 99 '], ['99.0', '99.0'], ['0', 0], ['-5', -5], ['1.5', 1.5]] as const) {
    it(`insertId ${name}: unklar, sent:true, nichts weiter geschrieben`, async () => {
      const e = makeEnv();
      e.ueber.push((u, i) => (i?.method === 'POST' && u.includes('order/create') ? json({ success: true, insertId: wert }) : undefined));
      const { c } = await prepCommit(e, 'order_create', basis);
      expect(c.structuredContent).toEqual({ message: expect.any(String), kind: 'unknown', sent: true });
      expect(posts(e, 'order/document/update')).toHaveLength(0);
    });
  }
  for (const [name, wert] of [['99', 99], ['"99"', '99']] as const) {
    it(`Positivkontrolle insertId ${name}`, async () => {
      const e = makeEnv();
      e.ueber.push((u, i) => (i?.method === 'POST' && u.includes('order/create') ? json({ success: true, insertId: wert }) : undefined));
      const { c } = await prepCommit(e, 'order_create', basis);
      expect(c.isError, text(c)).toBeFalsy();
      expect(new URLSearchParams(posts(e, 'order/document/update')[0].body).get('id')).toBe('99');
    });
  }
  it('order_draft prueft insertId ebenso', async () => {
    const e = makeEnv();
    e.ueber.push((u, i) => (i?.method === 'POST' && u.includes('order/create') ? json({ success: true, insertId: '1e2' }) : undefined));
    const { c } = await prepCommit(e, 'order_draft', { category: 'offer', contactId: 7, defaultAccountNumber: '3000', items: [{ articleId: 2, qty: 1, unitPriceNet: 890 }] });
    expect(c.structuredContent).toEqual({ message: expect.any(String), kind: 'unknown', sent: true });
    expect(posts(e, 'order/document/update')).toHaveLength(0);
  });
});

describe('Status nach dem Anlegen abweichend (S9)', () => {
  it('angefordert 16, CashCtrl meldet 12 -> Fehler mit createdId und sent:true', async () => {
    const e = makeEnv();
    e.ueber.push((u, i) => ((i?.method ?? 'GET') === 'GET' && u.includes('order/read') && u.includes('id=99') ? json({ success: true, data: { ...quelle, id: 99, nr: 'RE-00001', statusId: 12, statusName: '<values><de>Entwurf</de></values>' } }) : undefined));
    const { c } = await prepCommit(e, 'order_create', basis);
    expect(c.isError).toBe(true);
    expect(c.structuredContent).toEqual({ message: expect.any(String), kind: 'unknown', sent: true, createdId: 99 });
    expect(text(c)).toContain('Status Entwurf (12) statt 16');
    expect(text(c)).toContain('nicht erneut anlegen');
  });
});

describe('delete_order (S11)', () => {
  function delEnv(nachLoeschen: () => Response) {
    const e = makeEnv();
    const aktuell = { ...quelle, isBook: false };
    const st = { geloescht: false };
    e.ueber.push((u, i) => {
      if (i?.method === 'POST' && u.includes('order/delete')) { st.geloescht = true; return json({ success: true }); }
      if ((i?.method ?? 'GET') === 'GET' && u.includes('order/read')) return st.geloescht ? nachLoeschen() : json({ success: true, data: aktuell });
      return undefined;
    });
    return { e, aktuell };
  }
  it('S11c Nachlesen scheitert mit 502: Ausgang offen (unknown, sent:true), nicht «geloescht»', async () => {
    const { e } = delEnv(() => new Response('', { status: 502 }));
    const { c } = await prepCommit(e, 'delete_order', { orderId: 55 });
    expect(c.structuredContent).toEqual({ message: expect.any(String), kind: 'unknown', sent: true });
    expect(text(c)).toContain(OFFEN_SATZ);
  });
  it('Kontrolle: Nachlesen mit success:false gilt als geloescht', async () => {
    const { e } = delEnv(() => json({ success: false, message: 'Eintrag nicht gefunden.' }));
    const { c } = await prepCommit(e, 'delete_order', { orderId: 55 });
    expect(c.structuredContent).toMatchObject({ deleted: true });
  });
  it('S11d Beleg zwischen prepare und commit geaendert (Total, Nummer): nichts geloescht', async () => {
    for (const aenderung of [{ total: 1 }, { nr: 'AN-99999' }]) {
      const { e, aktuell } = delEnv(() => json({ success: false }));
      const t = createToolset(cfg, { fetchImpl: e.fetchImpl });
      const p = await t.call('prepare_delete_order', { orderId: 55 });
      Object.assign(aktuell, aenderung);
      const { token } = p.structuredContent as { token: string };
      const c = await t.call('commit_delete_order', { token });
      expect(c.isError, JSON.stringify(aenderung)).toBe(true);
      expect(text(c)).toContain('seit der Vorschau geändert');
      expect(posts(e, 'order/delete')).toHaveLength(0);
    }
  });
});

describe('Positionsschema strikt (S12)', () => {
  it('order_create: unitPriceGross an einer Artikelposition wird abgewiesen statt still verworfen', async () => {
    const e = makeEnv();
    const p = await prep(e, 'order_create', { ...basis, items: [{ articleId: 2, qty: 1, unitPriceGross: 100 }] });
    expect(p.isError).toBe(true);
    expect(text(p)).toContain('unitPriceGross');
  });
  it('order_draft: ebenso', async () => {
    const e = makeEnv();
    const p = await prep(e, 'order_draft', { category: 'offer', contactId: 7, defaultAccountNumber: '3000', items: [{ articleId: 2, qty: 1, unitPriceNet: 890, unitPriceGross: 100 }] });
    expect(p.isError).toBe(true);
    expect(text(p)).toContain('unitPriceGross');
  });
});
