import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolset } from '../../src/toolset.js';
import { kontenListe } from '../helpers/konten.js';
import { orderCreateModule, htmlText } from '../../src/tools/full/create.js';
import { resolveOrderItems } from '../../src/tools/draft/order.js';
import { buildContext } from '../../src/tools/context.js';
import type { Config } from '../../src/config/config.js';
/** Argumente fuer commit_* aus einer prepare-Antwort (destrukturiert, wie die uebrigen Tests; der Secret-Scan des Repos schlaegt sonst auf `token: (…)` an). */
const mitTok = (r: { structuredContent?: unknown }) => { const { token } = r.structuredContent as { token: string }; return { token }; };

/**
 * order_create (v0.2.0). Die Antworten von `order/create` (Erfolg, Ablehnung), Zeitueberschreitung,
 * ECONNREFUSED und 5xx sind aus der Doku nachgebaut, am Mandanten nicht gemessen (12.10.2026).
 */
const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8');
const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-order-create.json`);
const cfg = (mode: Config['mode']): Config => ({ mode, pdfDir: '/tmp/x', usageFile, source: 'env', orgs: [{ name: 'nt', subdomain: 'd', 'apiKey': 'k' }] });
afterAll(async () => { await rm(usageFile, { force: true }); });
const json = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

const quelle = (JSON.parse(fixture('order-read')) as { data: Record<string, unknown> & { items: Record<string, unknown>[] } }).data;
// Quellbeleg mit Bruttopreis, der NICHT netto x Satz ist (962.1 statt 962.09): wer neu rechnet, faellt auf.
const quelleKrumm = (() => {
  const q = JSON.parse(JSON.stringify(quelle)) as typeof quelle;
  q.items = [{ ...q.items[0], unitPrice: 962.1, netUnitPrice: 890, quantity: 3, unitId: '4' }, { ...q.items[1], unitPrice: 237.82 }];
  q.total = 19533.7;   // 3 x 962.10 + 70 x 237.82: ein Quellbeleg, dessen Total zu seinen Positionen passt
  return q;
})();

let waehrungsAbrufe = 0;   // Zaehler fuer currency/list (nur mit `currency` darf es gelesen werden)
interface Env { fetchImpl: typeof fetch; posts: { url: string; body: string }[]; ersetze: Record<string, () => Response> }
function makeEnv(opts: { artikel?: Record<string, unknown>; quelleBeleg?: unknown } = {}): Env {
  const posts: { url: string; body: string }[] = [];
  const ersetze: Record<string, () => Response> = {};
  const artikel = JSON.stringify({ success: true, data: { id: 2, nr: 'A-02', name: 'Pflanzwand-Modul 120x60 cm', unitId: 4, salesAccountId: 15, salesPrice: 890, isSalesPriceGross: false, currencyId: null, currencyCode: 'CHF', ...opts.artikel } });
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if ((init?.method ?? 'GET') === 'POST') {
      posts.push({ url: u, body: String(init?.body ?? '') });
      for (const [k, f] of Object.entries(ersetze)) if (u.includes(k)) return f();
      if (u.includes('order/create')) return json(JSON.stringify({ success: true, insertId: 99 }));
      return json(JSON.stringify({ success: true }));
    }
    if (u.includes('order/category/list')) return json(fixture('order-category-list-type-SALES'));
    if (u.includes('person/read')) return json(fixture('person-read'));
    if (u.includes('tax/list')) return json(fixture('tax-list'));
    if (u.includes('currency/list')) { waehrungsAbrufe++; return json(fixture('currency-list')); }
    if (u.includes('account/bank/list')) return json(fixture('account-bank-list'));
    if (u.includes('account/list')) return json(kontenListe());
    if (u.includes('inventory/article/read')) return json(artikel);
    if (u.includes('location/list')) return json(fixture('location-list'));
    if (u.includes('order/document/read')) return json(fixture('order-document-read'));
    if (u.includes('order/read')) {
      const id = new URL(u).searchParams.get('id');
      if (id === '99') return json(JSON.stringify({ success: true, data: { ...quelle, id: 99, nr: 'RE-00001', statusId: 16, total: 1924.18, statusName: '<values><de>Offen</de></values>' } }));
      return json(JSON.stringify({ success: true, data: opts.quelleBeleg ?? quelle }));
    }
    return json('{}');
  }) as unknown as typeof fetch;
  return { fetchImpl, posts, ersetze };
}
const text = (r: { content?: unknown[] }) => { const c = r.content?.[0]; return c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''; };
const creates = (e: Env) => e.posts.filter((p) => p.url.includes('order/create'));
const basis = { category: 'invoice', statusId: 16, contactId: 7, defaultAccountNumber: '3000', items: [{ articleId: 2, qty: 2, unitPriceNet: 890 }] };

describe('prepare_order_create', () => {
  it('Vorschau nennt Statusname und -ID, Kategorie, Kontakt, Totale', async () => {
    const e = makeEnv();
    const r = await createToolset(cfg('full'), { fetchImpl: e.fetchImpl, modules: [orderCreateModule] }).call('prepare_order_create', { ...basis, description: 'Projekt X', notes: 'Schluessel: a<b' });
    expect(r.isError).toBeFalsy();
    const s = (r.structuredContent as { summary: string }).summary;
    expect(s).toContain('Rechnung');
    expect(s).toContain('Status «Offen» (16)');
    expect(s).toContain('Aare Energie GmbH');
    expect(s).toContain('Projekt X');
    expect(s).toContain('Notizen: Schluessel: a<b');
    expect(s).toContain('Total netto 1780.00, MWST 144.18, brutto 1924.18');
    expect(e.posts).toEqual([]);
  });
  it('Status, der nicht zur Kategorie gehoert (Offerte-Status 37 bei Rechnung): validation mit Liste', async () => {
    const r = await createToolset(cfg('full'), { fetchImpl: makeEnv().fetchImpl, modules: [orderCreateModule] }).call('prepare_order_create', { ...basis, statusId: 37 });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ message: expect.any(String), kind: 'validation' });
    expect(text(r)).toContain('Offen (16)');
    expect(text(r)).toContain('Bezahlt (18)');
  });
  it('nur SALES-Kategorien; purchase_invoice wird vom Schema abgelehnt', async () => {
    const r = await createToolset(cfg('full'), { fetchImpl: makeEnv().fetchImpl, modules: [orderCreateModule] }).call('prepare_order_create', { ...basis, category: 'purchase_invoice' });
    expect(r.isError).toBe(true);
  });
  it('genau eines von items und copyItemsFromOrderId', async () => {
    const t = createToolset(cfg('full'), { fetchImpl: makeEnv().fetchImpl, modules: [orderCreateModule] });
    const beide = await t.call('prepare_order_create', { ...basis, copyItemsFromOrderId: 55 });
    expect(beide.isError).toBe(true);
    expect(text(beide)).toContain('genau eines');
    const keins = await t.call('prepare_order_create', { category: 'invoice', statusId: 16, contactId: 7 });
    expect(keins.isError).toBe(true);
    expect(text(keins)).toContain('genau eines');
  });
  it('description ueber 200 Zeichen wird abgelehnt', async () => {
    const r = await createToolset(cfg('full'), { fetchImpl: makeEnv().fetchImpl, modules: [orderCreateModule] }).call('prepare_order_create', { ...basis, description: 'x'.repeat(201) });
    expect(r.isError).toBe(true);
  });
  it('Position ohne articleId braucht unitPriceNet', async () => {
    const r = await createToolset(cfg('full'), { fetchImpl: makeEnv().fetchImpl, modules: [orderCreateModule] }).call('prepare_order_create', { ...basis, items: [{ name: 'Beratung', qty: 1 }] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('unitPriceNet fehlt');
  });
});

describe('Stammpreis des Artikels (unitPriceNet fehlt)', () => {
  it('netto gefuehrt: wie bisher netto -> brutto, Vorschau sagt Stammpreis', async () => {
    const e = makeEnv();
    const t = createToolset(cfg('full'), { fetchImpl: e.fetchImpl, modules: [orderCreateModule] });
    const p = await t.call('prepare_order_create', { ...basis, items: [{ articleId: 2, qty: 2 }] });
    expect(p.isError, text(p)).toBeFalsy();
    const { summary, token } = p.structuredContent as { summary: string; token: string };
    expect(summary).toContain('Stammpreis');
    await t.call('commit_order_create', { token });
    const items = JSON.parse(new URLSearchParams(creates(e)[0].body).get('items')!) as { unitPrice: number }[];
    expect(items[0].unitPrice).toBe(962.09);
  });
  it('brutto gefuehrt: salesPrice geht woertlich als Bruttopreis, nicht erneut aufgeschlagen', async () => {
    const e = makeEnv({ artikel: { salesPrice: 962.1, isSalesPriceGross: true } });
    const t = createToolset(cfg('full'), { fetchImpl: e.fetchImpl, modules: [orderCreateModule] });
    const p = await t.call('prepare_order_create', { ...basis, items: [{ articleId: 2, qty: 2 }] });
    expect(p.isError, text(p)).toBeFalsy();
    const { summary, token } = p.structuredContent as { summary: string; token: string };
    expect(summary).toContain('Stammpreis');
    expect(summary).toContain('brutto 1924.20');
    await t.call('commit_order_create', { token });
    const items = JSON.parse(new URLSearchParams(creates(e)[0].body).get('items')!) as { unitPrice: number }[];
    expect(items[0].unitPrice).toBe(962.1);
  });
  it('ein eingegebener unitPriceNet sticht den Stammpreis', async () => {
    const e = makeEnv({ artikel: { salesPrice: 962.1, isSalesPriceGross: true } });
    const t = createToolset(cfg('full'), { fetchImpl: e.fetchImpl, modules: [orderCreateModule] });
    const p = await t.call('prepare_order_create', { ...basis, items: [{ articleId: 2, qty: 1, unitPriceNet: 100 }] });
    expect((p.structuredContent as { summary: string }).summary).not.toContain('Stammpreis');
  });
});

describe('commit_order_create', () => {
  it('genau EIN order/create mit Status, Titel, Notizen, Faelligkeit, Vorgaenger; header per document/update', async () => {
    const e = makeEnv();
    const t = createToolset(cfg('full'), { fetchImpl: e.fetchImpl, modules: [orderCreateModule] });
    const p = await t.call('prepare_order_create', { ...basis, description: 'Projekt X', notes: 'Key <1> & "2"', dueDays: 30, previousOrderId: 55, header: 'Zeile 1\nZeile <2>' });
    const { token } = p.structuredContent as { token: string };
    const c = await t.call('commit_order_create', { token });
    expect(c.isError, text(c)).toBeFalsy();
    expect(c.structuredContent).toMatchObject({ id: 99, nr: 'RE-00001', status: 'Offen', total: 1924.18, warnings: [] });
    expect(typeof (c.structuredContent as { message: string }).message).toBe('string');
    expect(creates(e)).toHaveLength(1);
    const q = new URLSearchParams(creates(e)[0].body);
    expect(q.get('categoryId')).toBe('4');
    expect(q.get('statusId')).toBe('16');
    expect(q.get('description')).toBe('Projekt X');
    expect(q.get('notes')).toBe('Key &lt;1&gt; &amp; &quot;2&quot;');
    expect(q.get('dueDays')).toBe('30');
    expect(q.get('previousId')).toBe('55');
    const upd = e.posts.filter((x) => x.url.includes('order/document/update'));
    expect(upd).toHaveLength(1);
    const u = new URLSearchParams(upd[0].body);
    expect(u.get('id')).toBe('99');
    expect(u.get('header')).toBe('Zeile 1<br>Zeile &lt;2&gt;');
    expect(u.get('orgLocationId')).toBe('1');
    // Token ist verbraucht, es gibt keinen zweiten Versuch.
    expect((await t.call('commit_order_create', { token })).isError).toBe(true);
    expect(creates(e)).toHaveLength(1);
  });
  it('ohne header bleibt der gelesene Header des Dokuments', async () => {
    const e = makeEnv();
    const t = createToolset(cfg('full'), { fetchImpl: e.fetchImpl, modules: [orderCreateModule] });
    const { token } = (await t.call('prepare_order_create', basis)).structuredContent as { token: string };
    await t.call('commit_order_create', { token });
    const upd = e.posts.find((x) => x.url.includes('order/document/update'))!;
    expect(new URLSearchParams(upd.body).has('header')).toBe(false);   // Dokument-Header der Fixture ist null
  });
  it('Fehler NACH order/create: createdId steht im structuredContent, Art bleibt, genau ein Create', async () => {
    const e = makeEnv();
    e.ersetze['order/document/update'] = () => new Response('', { status: 502 });
    const t = createToolset(cfg('full'), { fetchImpl: e.fetchImpl, modules: [orderCreateModule] });
    const { token } = (await t.call('prepare_order_create', basis)).structuredContent as { token: string };
    const c = await t.call('commit_order_create', { token });
    expect(c.isError).toBe(true);
    expect(c.structuredContent).toEqual({ message: expect.any(String), kind: 'unknown', sent: true, createdId: 99 });
    expect(text(c)).toContain('99');
    expect(creates(e)).toHaveLength(1);
  });
  it('validation-Fehler nach dem Anlegen behaelt seine Art und traegt createdId', async () => {
    const e = makeEnv();
    e.ersetze['order/document/update'] = () => json(JSON.stringify({ success: false, errors: [{ field: 'header', message: 'zu lang' }] }));
    const t = createToolset(cfg('full'), { fetchImpl: e.fetchImpl, modules: [orderCreateModule] });
    const { token } = (await t.call('prepare_order_create', basis)).structuredContent as { token: string };
    const c = await t.call('commit_order_create', { token });
    expect(c.structuredContent).toMatchObject({ kind: 'validation', createdId: 99 });
  });
  it('Fehler IM order/create: ECONNREFUSED -> sent false, ohne createdId; 502 -> sent true; nie ein zweiter POST', async () => {
    for (const [fehler, erwartet] of [['refused', false], ['502', true]] as const) {
      const e = makeEnv();
      e.ersetze['order/create'] = () => { if (fehler === 'refused') throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); return new Response('', { status: 502 }); };
      const t = createToolset(cfg('full'), { fetchImpl: e.fetchImpl, modules: [orderCreateModule] });
      const { token } = (await t.call('prepare_order_create', basis)).structuredContent as { token: string };
      const c = await t.call('commit_order_create', { token });
      expect(c.isError).toBe(true);
      expect(c.structuredContent).toEqual({ message: expect.any(String), kind: fehler === 'refused' ? 'network' : 'unknown', sent: erwartet });
      expect(creates(e)).toHaveLength(1);
    }
  });
  it('Zeitueberschreitung im order/create: sent true, kein zweiter POST', async () => {
    const e = makeEnv();
    e.ersetze['order/create'] = () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); };
    const t = createToolset(cfg('full'), { fetchImpl: e.fetchImpl, modules: [orderCreateModule] });
    const { token } = (await t.call('prepare_order_create', basis)).structuredContent as { token: string };
    const c = await t.call('commit_order_create', { token });
    expect(c.structuredContent).toEqual({ message: expect.any(String), kind: 'network', sent: true });
    expect(creates(e)).toHaveLength(1);
  });
  it('Erfolg ohne insertId: unklarer Ausgang (sent true)', async () => {
    const e = makeEnv();
    e.ersetze['order/create'] = () => json(JSON.stringify({ success: true }));
    const t = createToolset(cfg('full'), { fetchImpl: e.fetchImpl, modules: [orderCreateModule] });
    const { token } = (await t.call('prepare_order_create', basis)).structuredContent as { token: string };
    const c = await t.call('commit_order_create', { token });
    expect(c.isError).toBe(true);
    expect(c.structuredContent).toEqual({ message: expect.any(String), kind: 'unknown', sent: true });
  });
  it('insertId als Ziffernfolge gilt als angelegt (Form am Mandanten nicht gemessen)', async () => {
    const e = makeEnv();
    e.ersetze['order/create'] = () => json(JSON.stringify({ success: true, insertId: '99' }));
    const t = createToolset(cfg('full'), { fetchImpl: e.fetchImpl, modules: [orderCreateModule] });
    const { token } = (await t.call('prepare_order_create', basis)).structuredContent as { token: string };
    const c = await t.call('commit_order_create', { token });
    expect(c.isError, text(c)).toBeFalsy();
    expect((c.structuredContent as { id: number }).id).toBe(99);
  });
});

describe('copyItemsFromOrderId', () => {
  it('uebernimmt Positionen woertlich, ohne den Bruttopreis neu zu rechnen', async () => {
    const e = makeEnv({ quelleBeleg: quelleKrumm });
    const t = createToolset(cfg('full'), { fetchImpl: e.fetchImpl, modules: [orderCreateModule] });
    const p = await t.call('prepare_order_create', { category: 'invoice', statusId: 16, contactId: 12, copyItemsFromOrderId: 55 });
    expect(p.isError, text(p)).toBeFalsy();
    const { summary, token } = p.structuredContent as { summary: string; token: string };
    expect(summary).toContain('962.10');
    await t.call('commit_order_create', { token });
    const items = JSON.parse(new URLSearchParams(creates(e)[0].body).get('items')!) as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    const q0 = quelleKrumm.items[0];
    expect(items[0]).toEqual({ accountId: q0.accountId, name: q0.name, description: q0.description, unitPrice: 962.1, quantity: 3, taxId: q0.taxId, unitId: '4', articleNr: q0.articleNr, inventoryId: q0.inventoryId });
    expect(items[1].unitPrice).toBe(237.82);
  });
  it('Quellposition ohne Konto: validation', async () => {
    const kaputt = JSON.parse(JSON.stringify(quelle)) as typeof quelle;
    kaputt.items[0].accountId = null;
    const t = createToolset(cfg('full'), { fetchImpl: makeEnv({ quelleBeleg: kaputt }).fetchImpl, modules: [orderCreateModule] });
    const p = await t.call('prepare_order_create', { category: 'invoice', statusId: 16, contactId: 12, copyItemsFromOrderId: 55 });
    expect(p.isError).toBe(true);
    expect(text(p)).toContain('accountId');
  });
});

describe('Rabattzeile (negativer Preis, 0.2.1)', () => {
  // Gemessen am Demo-Mandanten 12.10.2026: CashCtrl nimmt negative unitPrice an und rundet das
  // Zeilentotal halbe Rappen vom Nullpunkt weg (-16.215 -> -16.22, Total 1064.78).
  const rabatt = { category: 'offer', statusId: 37, contactId: 7, defaultAccountNumber: '3000' };
  it('items: negative Position geht durch, Brutto -16.215, Total wie CashCtrl 1064.78', async () => {
    const e = makeEnv();
    const t = createToolset(cfg('full'), { fetchImpl: e.fetchImpl, modules: [orderCreateModule] });
    const p = await t.call('prepare_order_create', { ...rabatt, items: [{ name: 'Beratung', qty: 1, unitPriceNet: 1000 }, { name: 'Rabatt', qty: 1, unitPriceNet: -15 }] });
    expect(p.isError, text(p)).toBeFalsy();
    const { summary, token } = p.structuredContent as { summary: string; token: string };
    expect(summary).toContain('brutto 1064.78');
    await t.call('commit_order_create', { token });
    const items = JSON.parse(new URLSearchParams(creates(e)[0].body).get('items')!) as { unitPrice: number }[];
    expect(items.map((i) => i.unitPrice)).toEqual([1081, -16.215]);
  });
  it('items: Total unter 0 geht durch (0.3.0, B8; M-1d: CashCtrl nimmt -100 an)', async () => {
    const e = makeEnv();
    const t = createToolset(cfg('full'), { fetchImpl: e.fetchImpl, modules: [orderCreateModule] });
    const p = await t.call('prepare_order_create', { ...rabatt, items: [{ name: 'Rabatt', qty: 1, unitPriceNet: -100 }] });
    expect(p.isError, text(p)).toBeFalsy();
    expect((p.structuredContent as { summary: string }).summary).toContain('brutto -108.10');
    await t.call('commit_order_create', mitTok(p));
    expect(creates(e)).toHaveLength(1);
  });
  const mitRabatt = (zweite: number, total: number) => {
    const q = JSON.parse(JSON.stringify(quelle)) as typeof quelle;
    q.items = [{ ...q.items[0], unitPrice: 1081, quantity: 1 }, { ...q.items[0], name: 'Rabatt', unitPrice: zweite, quantity: 1 }];
    q.total = total;
    return q;
  };
  it('Stammpreis (Artikel ohne unitPriceNet) plus Rabatt groesser als der Preis: geht durch (B8)', async () => {
    // Artikel 2: Stammpreis 890 netto (Fixture). 890 + (-1000) netto -> Total brutto negativ, jetzt kein Fehler mehr.
    const e = makeEnv();
    const p = await createToolset(cfg('full'), { fetchImpl: e.fetchImpl, modules: [orderCreateModule] })
      .call('prepare_order_create', { ...rabatt, items: [{ articleId: 2, qty: 1 }, { name: 'Rabatt', qty: 1, unitPriceNet: -1000 }] });
    expect(p.isError, text(p)).toBeFalsy();
    expect(e.posts).toEqual([]);   // prepare schreibt nichts
  });
  it('andere Abweisungen tragen keinen reason', async () => {
    const p = await createToolset(cfg('full'), { fetchImpl: makeEnv().fetchImpl, modules: [orderCreateModule] })
      .call('prepare_order_create', { ...rabatt, statusId: 16, items: [{ name: 'Leistung', qty: 1, unitPriceNet: 100 }] });
    expect(p.isError).toBe(true);
    expect(p.structuredContent).toEqual({ message: expect.any(String), kind: 'validation' });
  });
  it('Kopierweg: Quellbeleg mit Rabattzeile -16.215 und Total 1064.78 wird uebernommen', async () => {
    const e = makeEnv({ quelleBeleg: mitRabatt(-16.215, 1064.78) });
    const t = createToolset(cfg('full'), { fetchImpl: e.fetchImpl, modules: [orderCreateModule] });
    const p = await t.call('prepare_order_create', { category: 'invoice', statusId: 16, contactId: 12, copyItemsFromOrderId: 55 });
    expect(p.isError, text(p)).toBeFalsy();
    const { token } = p.structuredContent as { token: string };
    await t.call('commit_order_create', { token });
    const items = JSON.parse(new URLSearchParams(creates(e)[0].body).get('items')!) as { unitPrice: number }[];
    expect(items.map((i) => i.unitPrice)).toEqual([1081, -16.215]);
  });
  it('Kopierweg: 1 x 255.00 zu 8.1 % (Stueckpreis 275.655, CashCtrl-Total 275.66) wird uebernommen', async () => {
    // Gemessen 12.10.2026: CashCtrl rechnet exakt, 275.655 -> 275.66; 0.2.1 rechnete 275.65 und wies die Kopie ab.
    const q = JSON.parse(JSON.stringify(quelle)) as typeof quelle;
    q.items = [{ ...q.items[0], unitPrice: 275.655, quantity: 1 }];
    q.total = 275.66;
    const p = await createToolset(cfg('full'), { fetchImpl: makeEnv({ quelleBeleg: q }).fetchImpl, modules: [orderCreateModule] })
      .call('prepare_order_create', { category: 'invoice', statusId: 16, contactId: 12, copyItemsFromOrderId: 55 });
    expect(p.isError, text(p)).toBeFalsy();
  });
  it('Kopierweg: Quellbeleg mit Total unter 0 wird uebernommen (B8)', async () => {
    const e = makeEnv({ quelleBeleg: mitRabatt(-2000, -919) });
    const p = await createToolset(cfg('full'), { fetchImpl: e.fetchImpl, modules: [orderCreateModule] })
      .call('prepare_order_create', { category: 'invoice', statusId: 16, contactId: 12, copyItemsFromOrderId: 55 });
    expect(p.isError, text(p)).toBeFalsy();
    expect((p.structuredContent as { summary: string }).summary).toContain('-919.00');
    expect(e.posts).toEqual([]);
  });
});

describe('Belegnummer nr (0.3.0, B10)', () => {
  // M-1e (17.10.2026, Demo-Mandant): order/create mit nr uebernimmt die Nummer (DESK-TEST-M1E); dieselbe nr ein zweites Mal ->
  // HTTP 200, success false, errors [{ field: 'nr', message: 'Die Nr. wird schon von einem anderen Dokument verwendet.' }].
  const SATZ = 'Die Nr. wird schon von einem anderen Dokument verwendet.';
  const lauf = async (e: Env, args: Record<string, unknown>) => {
    const t = createToolset(cfg('full'), { fetchImpl: e.fetchImpl, modules: [orderCreateModule] });
    const p = await t.call('prepare_order_create', args);
    if (p.isError) return { p, c: undefined };
    return { p, c: await t.call('commit_order_create', mitTok(p)) };
  };
  it('nr geht im Formular woertlich hinaus (neu)', async () => {
    const e = makeEnv();
    const { p } = await lauf(e, { ...basis, nr: 'DESK-TEST-M1E' });
    expect(new URLSearchParams(creates(e)[0].body).get('nr')).toBe('DESK-TEST-M1E');
    expect((p.structuredContent as { summary: string }).summary).toContain('DESK-TEST-M1E');
  });
  it('nr geht auch im Kopierweg hinaus', async () => {
    const e = makeEnv();
    await lauf(e, { category: 'invoice', statusId: 16, contactId: 12, copyItemsFromOrderId: 55, nr: 'R-2026-7' });
    expect(new URLSearchParams(creates(e)[0].body).get('nr')).toBe('R-2026-7');
  });
  it('ohne nr kein Feld nr (CashCtrl nummeriert selbst)', async () => {
    const e = makeEnv();
    await lauf(e, basis);
    expect(new URLSearchParams(creates(e)[0].body).has('nr')).toBe(false);
  });
  it('leere nr wird vom Schema abgewiesen', async () => {
    const e = makeEnv();
    const { p } = await lauf(e, { ...basis, nr: '' });
    expect(p.isError).toBe(true);
    expect(e.posts).toEqual([]);
  });
  it('doppelte nr: Antwort von CashCtrl (M-1e) kommt als validation mit dem Satz von CashCtrl, nichts weiter geschrieben', async () => {
    const e = makeEnv();
    e.ersetze['order/create'] = () => json(JSON.stringify({ success: false, message: null, errors: [{ field: 'nr', message: SATZ }] }));
    const { c } = await lauf(e, { ...basis, nr: 'DESK-TEST-M1E' });
    expect(c!.isError).toBe(true);
    expect((c!.structuredContent as { kind: string }).kind).toBe('validation');
    expect(text(c!)).toContain(SATZ);
    expect(creates(e)).toHaveLength(1);
    expect(e.posts.filter((x) => x.url.includes('order/document/update'))).toHaveLength(0);
    // Gemessener Wert von `sent` (Abweisung success:false: nichts angelegt): false, ohne createdId.
    expect(c!.structuredContent).toEqual({ message: expect.any(String), kind: 'validation', sent: false });
  });
});

describe('Steuer und Preis (0.3.0, B6, B7)', () => {
  // M-1 (17.10.2026, Demo-Mandant): ohne taxId setzt CashCtrl keine Steuer, auch nicht die des Kontos (M-1b/M-1b');
  // eine Position ohne name/unitPrice faellt still weg (M-1a); ein Nettofeld gibt es nicht (M-1c).
  // Konten der Tests: 3000 (id 15) fuehrt UN1 (taxId 9), 3400 (id 43) keine Steuer (kontenListe()).
  const anlegen = async (e: Env, args: Record<string, unknown>) => {
    const t = createToolset(cfg('full'), { fetchImpl: e.fetchImpl, modules: [orderCreateModule] });
    const p = await t.call('prepare_order_create', args);
    if (p.isError) return { p, items: [] as Record<string, unknown>[] };
    await t.call('commit_order_create', mitTok(p));
    return { p, items: JSON.parse(new URLSearchParams(creates(e)[0].body).get('items')!) as Record<string, unknown>[] };
  };
  const pos = { name: 'Beratung', qty: 1, unitPriceNet: 480 };
  it('ohne taxCode, Konto mit taxId 9: taxId 9, Brutto mit 8.1 %', async () => {
    const { items, p } = await anlegen(makeEnv(), { ...basis, defaultAccountNumber: '3000', items: [pos] });
    expect(items[0]).toMatchObject({ taxId: 9, unitPrice: 518.88 });
    expect((p.structuredContent as { summary: string }).summary).toContain('Steuer vom Konto 3000');
  });
  it('ohne taxCode, Konto ohne Steuer: keine taxId, unitPrice = netto, Vorschau sagt es', async () => {
    const { items, p } = await anlegen(makeEnv(), { ...basis, defaultAccountNumber: '3400', items: [pos] });
    expect(items[0].unitPrice).toBe(480);
    expect(items[0]).not.toHaveProperty('taxId');
    const s = (p.structuredContent as { summary: string }).summary;
    expect(s).toContain('ohne Steuer (Konto führt keine)');
    expect(s).toContain('Total netto 480.00, MWST 0.00, brutto 480.00');
  });
  it('mit taxCode genau er, auch auf einem Konto ohne Steuer', async () => {
    const { items } = await anlegen(makeEnv(), { ...basis, defaultAccountNumber: '3400', items: [{ ...pos, taxCode: 'UN1' }] });
    expect(items[0]).toMatchObject({ taxId: 9, unitPrice: 518.88 });
  });
  it('mit taxCode V0I auf Konto mit UN1: V0I (0 %), nicht die Steuer des Kontos', async () => {
    const { items } = await anlegen(makeEnv(), { ...basis, defaultAccountNumber: '3000', items: [{ ...pos, taxCode: 'V0I' }] });
    expect(items[0]).toMatchObject({ taxId: 12, unitPrice: 480 });
  });
  it('letzte Stufe: Artikel ohne salesAccountId, Konto aus defaultAccountNumber mit taxId 9 -> taxId 9, Brutto mit 8.1 %', async () => {
    const e = makeEnv({ artikel: { salesAccountId: null } });
    const { items } = await anlegen(e, { ...basis, defaultAccountNumber: '3000', items: [{ articleId: 2, qty: 1, unitPriceNet: 480 }] });
    expect(items[0]).toMatchObject({ accountId: 15, taxId: 9, unitPrice: 518.88 });
  });
  it('letzte Stufe, Gegenprobe gegen die alte Vorgabe UN1: Konto mit taxId 11 (US1, 3.8 %) -> taxId 11, Brutto mit 3.8 %', async () => {
    const e = makeEnv({ artikel: { salesAccountId: null } });
    const base = e.fetchImpl;
    e.fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('account/list')) return json(kontenListe({ '3000': 11 }));
      return base(url, init);
    }) as unknown as typeof fetch;
    const { items } = await anlegen(e, { ...basis, defaultAccountNumber: '3000', items: [{ articleId: 2, qty: 1, unitPriceNet: 480 }] });
    expect(items[0]).toMatchObject({ accountId: 15, taxId: 11, unitPrice: 498.24 });
  });
  it('Reihenfolge des Kontos: accountNumber der Position sticht salesAccountId des Artikels sticht defaultAccountNumber; die Steuer folgt diesem Konto', async () => {
    // Artikel fuehrt salesAccountId 43 (3400, ohne Steuer); Beleg-Vorgabe 3000 (UN1).
    const e = makeEnv({ artikel: { salesAccountId: 43 } });
    const a = await anlegen(e, { ...basis, defaultAccountNumber: '3000', items: [{ articleId: 2, qty: 1, unitPriceNet: 480 }] });
    expect(a.items[0]).toMatchObject({ accountId: 43, unitPrice: 480 });
    expect(a.items[0]).not.toHaveProperty('taxId');
    const e2 = makeEnv({ artikel: { salesAccountId: 43 } });
    const b = await anlegen(e2, { ...basis, defaultAccountNumber: '3400', items: [{ articleId: 2, qty: 1, unitPriceNet: 480, accountNumber: '3000' }] });
    expect(b.items[0]).toMatchObject({ accountId: 15, taxId: 9, unitPrice: 518.88 });
  });
  it('Artikel ohne Stammpreis und ohne Preis des Menschen: validation, nichts gesendet', async () => {
    const e = makeEnv({ artikel: { salesPrice: null } });
    const { p } = await anlegen(e, { ...basis, items: [{ articleId: 2, qty: 1 }] });
    expect(p.isError).toBe(true);
    expect(p.structuredContent).toEqual({ message: expect.any(String), kind: 'validation' });
    expect(text(p)).toContain('Stammpreis');
    expect(e.posts).toEqual([]);
  });
  it('Artikel ohne Namen und Position ohne name: validation, nichts gesendet', async () => {
    const e = makeEnv({ artikel: { name: null } });
    const { p } = await anlegen(e, { ...basis, items: [{ articleId: 2, qty: 1, unitPriceNet: 10 }] });
    expect(p.isError).toBe(true);
    expect(text(p)).toContain('name');
    expect(e.posts).toEqual([]);
  });
  it('Steuer-ID des Kontos fehlt in tax/list: validation', async () => {
    const e = makeEnv();
    const base = e.fetchImpl;
    e.fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('account/list')) return json(kontenListe({ '3000': 77 }));
      return base(url, init);
    }) as unknown as typeof fetch;
    const { p } = await anlegen(e, { ...basis, defaultAccountNumber: '3000', items: [pos] });
    expect(p.isError).toBe(true);
    expect(text(p)).toContain('77');
    expect(e.posts).toEqual([]);
  });
  it('kein fester Standard UN1 mehr: Konto 3400 ohne Steuer, Position ohne taxCode -> keine taxId (Gegenprobe zum frueheren Verhalten)', async () => {
    const { items } = await anlegen(makeEnv(), { ...basis, defaultAccountNumber: '3400', items: [{ name: 'x', qty: 2, unitPriceNet: 10 }] });
    expect(items[0]).not.toHaveProperty('taxId');
  });
});

describe('Währung (0.3.0, B1)', () => {
  // Gemessen 16.10.2026 (Messbericht M-K, A5): currency/list liefert CHF id 1 (isDefault), EUR id 2, USD id 3;
  // die Hauptwaehrung heisst am Beleg currencyId null. Ob order/create mit currencyId=1 null oder 1 speichert,
  // ist ungemessen: der Server sendet fuer die Standardwaehrung gar kein currencyId.
  const eur = { ...basis, currency: 'EUR' };
  const formular = (e: Env) => new URLSearchParams(creates(e)[0].body);
  const anlegen = async (e: Env, args: Record<string, unknown>) => {
    const t = createToolset(cfg('full'), { fetchImpl: e.fetchImpl, modules: [orderCreateModule] });
    const p = await t.call('prepare_order_create', args);
    if (p.isError) return { p, c: undefined };
    const c = await t.call('commit_order_create', mitTok(p));
    return { p, c };
  };
  it('currency EUR sendet currencyId=2, Vorschau nennt EUR', async () => {
    const e = makeEnv();
    const { p, c } = await anlegen(e, eur);
    expect(p.isError, text(p)).toBeFalsy();
    expect(c!.isError, text(c!)).toBeFalsy();
    expect(formular(e).get('currencyId')).toBe('2');
    expect((p.structuredContent as { summary: string }).summary).toContain('EUR');
  });
  it('unbekannter Code XYZ: validation «CashCtrl führt die Währung XYZ nicht» mit Liste, nichts gesendet', async () => {
    const e = makeEnv();
    const { p } = await anlegen(e, { ...basis, currency: 'XYZ' });
    expect(p.isError).toBe(true);
    expect(p.structuredContent).toEqual({ message: expect.any(String), kind: 'validation' });
    expect(text(p)).toContain('CashCtrl führt die Währung XYZ nicht');
    expect(text(p)).toContain('CHF, EUR, USD');
    expect(e.posts).toEqual([]);
  });
  it('ohne currency: kein currencyId und kein Abruf von currency/list', async () => {
    waehrungsAbrufe = 0;
    const e = makeEnv();
    await anlegen(e, basis);
    expect(formular(e).has('currencyId')).toBe(false);
    expect(waehrungsAbrufe).toBe(0);
  });
  it('currency CHF (Standardwaehrung): kein currencyId, Hauptwaehrung bleibt null am Beleg', async () => {
    const e = makeEnv();
    await anlegen(e, { ...basis, currency: 'CHF' });
    expect(formular(e).has('currencyId')).toBe(false);
  });
  it('Code in Kleinschrift wird erkannt', async () => {
    const e = makeEnv();
    await anlegen(e, { ...basis, currency: 'eur' });
    expect(formular(e).get('currencyId')).toBe('2');
  });
  // Nachtrag (Korrektur 10): der Stammpreis des Artikels gilt nur in seiner eigenen Waehrung.
  it('N1 EUR-Beleg, Artikel ohne Preis des Menschen: validation, Preis fehlt, beide Codes, nichts gesendet', async () => {
    const e = makeEnv();
    const { p } = await anlegen(e, { ...eur, items: [{ articleId: 2, qty: 1 }] });
    expect(p.isError).toBe(true);
    expect(p.structuredContent).toEqual({ message: expect.any(String), kind: 'validation' });
    expect(text(p)).toContain('Preis fehlt');
    expect(text(p)).toContain('CHF');
    expect(text(p)).toContain('EUR');
    expect(e.posts).toEqual([]);
  });
  it('N2 EUR-Beleg, Artikel mit Preis des Menschen: geht hinaus, currencyId 2', async () => {
    const e = makeEnv();
    const { c } = await anlegen(e, { ...eur, items: [{ articleId: 2, qty: 1, unitPriceNet: 100 }] });
    expect(c!.isError, text(c!)).toBeFalsy();
    expect(formular(e).get('currencyId')).toBe('2');
  });
  it('N3 Beleg ohne currency, Artikel ohne Preis: Stammpreis wie bisher', async () => {
    const e = makeEnv();
    const { c } = await anlegen(e, { ...basis, items: [{ articleId: 2, qty: 1 }] });
    expect(c!.isError, text(c!)).toBeFalsy();
    const items = JSON.parse(formular(e).get('items')!) as { unitPrice: number }[];
    expect(items[0].unitPrice).toBe(962.09);
  });
  it('N4 currency CHF (Standard), Artikel ohne Preis: Stammpreis wie bisher', async () => {
    const e = makeEnv();
    const { c } = await anlegen(e, { ...basis, currency: 'CHF', items: [{ articleId: 2, qty: 1 }] });
    expect(c!.isError, text(c!)).toBeFalsy();
    const items = JSON.parse(formular(e).get('items')!) as { unitPrice: number }[];
    expect(items[0].unitPrice).toBe(962.09);
  });
  it('N5 Artikel mit eigener Waehrung EUR (UNGEMESSEN: ob CashCtrl-Artikel eine eigene Waehrung tragen, misst M-2), EUR-Beleg: Stammpreis wird ergaenzt', async () => {
    const e = makeEnv({ artikel: { currencyId: 2, currencyCode: 'EUR' } });
    const { c } = await anlegen(e, { ...eur, items: [{ articleId: 2, qty: 1 }] });
    expect(c!.isError, text(c!)).toBeFalsy();
    const items = JSON.parse(formular(e).get('items')!) as { unitPrice: number }[];
    expect(items[0].unitPrice).toBe(962.09);
    expect(formular(e).get('currencyId')).toBe('2');
  });
  it('N6 Artikel mit eigener Waehrung EUR (ungemessen), Beleg in der Mandantenwaehrung: kein Stammpreis, Preis fehlt', async () => {
    const e = makeEnv({ artikel: { currencyId: 2, currencyCode: 'EUR' } });
    const { p } = await anlegen(e, { ...basis, items: [{ articleId: 2, qty: 1 }] });
    expect(p.isError).toBe(true);
    expect(text(p)).toContain('Preis fehlt');
    expect(text(p)).toContain('EUR');
    expect(text(p)).toContain('CHF');
    expect(e.posts).toEqual([]);
  });
  it('Kopierweg: Quelle in CHF (currencyId null) sendet kein currencyId', async () => {
    const e = makeEnv();
    await anlegen(e, { category: 'invoice', statusId: 16, contactId: 12, copyItemsFromOrderId: 55 });
    expect(formular(e).has('currencyId')).toBe(false);
  });
  it('Kopierweg: abweichende currency zur Quelle wird abgewiesen, nichts gesendet', async () => {
    const e = makeEnv();   // Quelle in CHF
    const { p } = await anlegen(e, { category: 'invoice', statusId: 16, contactId: 12, copyItemsFromOrderId: 55, currency: 'EUR' });
    expect(p.isError).toBe(true);
    expect(p.structuredContent).toEqual({ message: expect.any(String), kind: 'validation' });
    expect(text(p)).toContain('EUR');
    expect(e.posts).toEqual([]);
  });
});

describe('0.3.2: Währung des Artikels aus currencyId (PA-37cca969-01), Steuer des Kontos nur als Verkaufssteuer (PA-37cca969-03)', () => {
  const eur = { ...basis, currency: 'EUR' };
  const formular = (e: Env) => new URLSearchParams(creates(e)[0].body);
  const anlegen = async (e: Env, args: Record<string, unknown>) => {
    const t = createToolset(cfg('full'), { fetchImpl: e.fetchImpl, modules: [orderCreateModule] });
    const p = await t.call('prepare_order_create', args);
    if (p.isError) return { p, c: undefined };
    return { p, c: await t.call('commit_order_create', mitTok(p)) };
  };
  // Gemessen M-K A8 (16.10.2026, Demo-Mandant): inventory/article/read nennt bei eigener Waehrung currencyId 2 und currencyCode null.
  it('EUR-Artikel (currencyId 2, currencyCode null wie gemessen), EUR-Beleg ohne Preis: Stammpreis geht hinaus', async () => {
    const e = makeEnv({ artikel: { currencyId: 2, currencyCode: null } });
    const { c } = await anlegen(e, { ...eur, items: [{ articleId: 2, qty: 1 }] });
    expect(c?.isError, c ? text(c) : 'prepare scheiterte').toBeFalsy();
    expect((JSON.parse(formular(e).get('items')!) as { unitPrice: number }[])[0].unitPrice).toBe(962.09);
  });
  it('EUR-Artikel (currencyCode null), CHF-Beleg ohne Preis: Preis fehlt, der Satz nennt EUR und CHF, nichts gesendet', async () => {
    const e = makeEnv({ artikel: { currencyId: 2, currencyCode: null } });
    const { p } = await anlegen(e, { ...basis, items: [{ articleId: 2, qty: 1 }] });
    expect(p.isError).toBe(true);
    expect(text(p)).toContain('Der Stammpreis gilt in EUR, der Beleg ist in CHF');
    expect(e.posts).toEqual([]);
  });
  it('currencyCode sticht nicht: currencyId 2 (EUR) mit falschem currencyCode CHF gilt als EUR', async () => {
    const e = makeEnv({ artikel: { currencyId: 2, currencyCode: 'CHF' } });
    const { c } = await anlegen(e, { ...eur, items: [{ articleId: 2, qty: 1 }] });
    expect(c?.isError, c ? text(c) : 'prepare scheiterte').toBeFalsy();
  });
  it('currencyId, die currency/list nicht kennt: validation mit der Kennung, nichts gesendet', async () => {
    const e = makeEnv({ artikel: { currencyId: 7, currencyCode: null } });
    const { p } = await anlegen(e, { ...eur, items: [{ articleId: 2, qty: 1 }] });
    expect(p.isError).toBe(true);
    expect(p.structuredContent).toEqual({ message: expect.any(String), kind: 'validation' });
    expect(text(p)).toContain('7');
    expect(e.posts).toEqual([]);
  });
  const mitKonto = (e: Env, steuer: Record<string, number | null>) => {
    const base = e.fetchImpl;
    e.fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('account/list')) return json(kontenListe(steuer));
      return base(url, init);
    }) as unknown as typeof fetch;
    return e;
  };
  it('Verkauf: Konto führt die Bezugsteuer BN1 (id 1), Position ohne taxCode: validation nennt Konto und Steuer, nichts gesendet', async () => {
    const e = mitKonto(makeEnv({ artikel: { salesAccountId: null } }), { '3000': 1 });
    const { p } = await anlegen(e, { ...basis, defaultAccountNumber: '3000', items: [{ name: 'Montage', qty: 1, unitPriceNet: 100 }] });
    expect(p.isError).toBe(true);
    expect(p.structuredContent).toEqual({ message: expect.any(String), kind: 'validation' });
    expect(text(p)).toContain('3000');
    expect(text(p)).toContain('BN1');
    expect(text(p)).toContain('taxCode');
    expect(e.posts).toEqual([]);
  });
  it('Verkauf: Konto führt die Vorsteuer VN1 (id 13): ebenso abgewiesen', async () => {
    const e = mitKonto(makeEnv(), { '3000': 13 });
    const { p } = await anlegen(e, { ...basis, defaultAccountNumber: '3000', items: [{ name: 'Montage', qty: 1, unitPriceNet: 100 }] });
    expect(p.isError).toBe(true);
    expect(text(p)).toContain('VN1');
    expect(e.posts).toEqual([]);
  });
  it('Gegenprobe Verkauf: Konto mit UN1 (Verkaufssteuer) geht hinaus; taxCode der Position sticht ein Konto mit BN1', async () => {
    const a = mitKonto(makeEnv(), { '3000': 9 });
    expect((await anlegen(a, { ...basis, defaultAccountNumber: '3000', items: [{ name: 'Montage', qty: 1, unitPriceNet: 100 }] })).c?.isError).toBeFalsy();
    const b = mitKonto(makeEnv(), { '3000': 1 });
    const { c } = await anlegen(b, { ...basis, defaultAccountNumber: '3000', items: [{ name: 'Montage', qty: 1, unitPriceNet: 100, taxCode: 'UN1' }] });
    expect(c?.isError).toBeFalsy();
    expect((JSON.parse(formular(b).get('items')!) as { taxId: number }[])[0].taxId).toBe(9);
  });
  it('Gegenprobe Einkauf: Einkaufsrechnung auf Konto mit Vorsteuer VN1 geht hinaus (die Prüfung gilt nur im Verkauf)', async () => {
    const e = mitKonto(makeEnv(), { '3000': 13 });
    const { calc } = await resolveOrderItems(buildContext(cfg('draft'), { fetchImpl: e.fetchImpl }), { org: 'nt', defaultAccountNumber: '3000', items: [{ name: 'Material', qty: 1, unitPriceNet: 100 }] }, 'PURCHASE');
    expect(calc.lines[0].taxCode).toBe('VN1');
  });
});

describe('htmlText', () => {
  it('escaped HTML und macht Zeilenumbrueche zu <br>', () => {
    expect(htmlText('a & <b>\r\n"c"\n\'d\'')).toBe('a &amp; &lt;b&gt;<br>&quot;c&quot;<br>&#39;d&#39;');
  });
});

describe('Stufe', () => {
  it('nur im Modus full, mit passenden Annotationen', () => {
    expect(createToolset(cfg('draft'), { modules: [orderCreateModule] }).names()).toEqual([]);
    const t = createToolset(cfg('full'), { modules: [orderCreateModule] });
    expect(t.names()).toEqual(['prepare_order_create', 'commit_order_create']);
    expect(t.tools[1].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
  });
});
