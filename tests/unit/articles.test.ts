import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext } from '../../src/tools/context.js';
import { searchArticles } from '../../src/tools/read/articles.js';
import { createToolset } from '../../src/toolset.js';
import type { Config } from '../../src/config/config.js';

const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8');
const f = (async (url: string | URL) => {
  const u = String(url);
  const body = u.includes('inventory/article/list') ? fixture('inventory-article-list-limit-5') : '{}';
  return new Response(body, { status: 200 });
}) as unknown as typeof fetch;
const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-a.json`);
const cfg: Config = { mode: 'read', pdfDir: '/tmp/x', usageFile, source: 'env', orgs: [{ name: 'nt', subdomain: 'd', 'apiKey': 'k' }] };

afterAll(async () => { await rm(usageFile, { force: true }); });

describe('search_articles', () => {
  it('gibt kompakte Eintraege mit aufgeloester Einheit, Preisen und Seiteninfo', async () => {
    const r = await searchArticles(buildContext(cfg, { fetchImpl: f }), { query: 'a', limit: 5 });
    const s = r.structuredContent as { items: Record<string, unknown>[]; total: number; hasMore: boolean };
    expect(s.items.length).toBeGreaterThan(0);
    // Feldsatz muss genau dem von compactArticle entsprechen — kein zusaetzliches, kein fehlendes Feld.
    expect(Object.keys(s.items[0])).toEqual(['id', 'nr', 'name', 'unit', 'salesPriceNet', 'purchasePriceNet', 'stock', 'categoryId', 'salesPriceIsGross', 'salesAccountId', 'currencyId', 'currency']);
    expect(typeof s.total).toBe('number');
    expect(typeof s.hasMore).toBe('boolean');
    // Erster Artikel der Fixture (id 1, unitId 4): unitName traegt <values><de>Stk.</de>...</values> — de() muss es aufloesen.
    expect(s.items[0]).toMatchObject({ id: 1, nr: 'A-01', name: 'Pflanzwand-Modul 60x60 cm', unit: 'Stk.', salesPriceNet: 480, purchasePriceNet: 265, stock: 24, categoryId: null, salesPriceIsGross: false, salesAccountId: null });
    expect(JSON.stringify(s.items[0]).length).toBeLessThan(600);   // kompakt, keine Rohantwort
  });
});

// 0.2.4 (MWST-Konfiguration Desk): einen Artikel nach Kennung lesen. Fetch-Attrappe: id 1 liefert den ersten Artikel der Aufnahme,
// 999 antwortet in der gemessenen Form auf eine unbekannte Kennung, 998 mit HTTP 404.
// Form von 999 wie gemessen 14.10.2026 am Demo-Mandanten (M-F, Desk-Plan 2026-10-14 Task 0 Step 5): HTTP 200, success:false,
// Felder success, errorMessage, data, data ohne Artikel; der MCP meldet isError, kind validation, ohne sent, Praefix «CashCtrl lehnt ab:».
describe('get_article', () => {
  const aufrufe: { pfad: string; params: Record<string, string> }[] = [];
  const g = (async (url: string | URL) => {
    const u = new URL(String(url));
    const pfad = u.pathname.replace(/^\/api\/v1\//, '');
    const params = Object.fromEntries(u.searchParams.entries());
    aufrufe.push({ pfad, params });
    if (pfad === 'inventory/article/read.json') {
      if (params.id === '998') return new Response('', { status: 404 });
      if (params.id === '999') return new Response(JSON.stringify({ success: false, errorMessage: 'nicht gefunden', data: null }), { status: 200 });
      const erster = (JSON.parse(fixture('inventory-article-list-limit-5')) as { data: Record<string, unknown>[] }).data[0];
      return new Response(JSON.stringify({ data: { ...erster, nr: 'A-1', id: Number(params.id) } }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const call = (name: string, args: Record<string, unknown>) => createToolset(cfg, { fetchImpl: g }).call(name, args);

  it('get_article liest einen Artikel nach Kennung (inventory/article/read)', async () => {
    const r = await call('get_article', { org: 'nt', id: 1 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ id: 1, nr: 'A-1', salesPriceIsGross: false });
    expect(Object.keys(r.structuredContent as object)).toEqual(['id', 'nr', 'name', 'unit', 'salesPriceNet', 'purchasePriceNet', 'stock', 'categoryId', 'salesPriceIsGross', 'salesAccountId', 'currencyId', 'currency']);
    expect(aufrufe.at(-1)).toMatchObject({ pfad: 'inventory/article/read.json', params: { id: '1' } });
  });
  it('get_article: unbekannte Kennung (CashCtrl success:false) ist validation, kein Wurf (Form gemessen M-F, RM-06)', async () => {
    const r = await call('get_article', { org: 'nt', id: 999 });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ kind: 'validation' });
  });
  it('get_article: HTTP 404 ist not_found (der Desk bildet das als nicht erreichbar ab, B7)', async () => {
    const r = await call('get_article', { org: 'nt', id: 998 });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ kind: 'not_found' });
  });
});

// Gemessen 09.11.2026 am Demo-Mandanten: inventory/article/read traegt `unitId`, aber kein `unitName` (die Liste traegt beides).
// Die Attrappe oben antwortet mit der Listenform und verdeckte das: get_article lieferte live `unit: ""`.
describe('get_article: Einheit aus inventory/unit/list, wenn read nur unitId liefert', () => {
  let einheitenAbrufe = 0;
  const g = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('inventory/unit/list')) { einheitenAbrufe++; return new Response(fixture('inventory-unit-list'), { status: 200 }); }
    if (u.includes('inventory/article/read')) return new Response(JSON.stringify({ data: { id: 1, nr: 'A-01', name: 'Pflanzwand-Modul', unitId: 4, salesPrice: 480, lastPurchasePrice: 265, currencyId: null } }), { status: 200 });
    if (u.includes('inventory/article/list')) return new Response(fixture('inventory-article-list-limit-5'), { status: 200 });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const call = (name: string, args: Record<string, unknown>) => createToolset(cfg, { fetchImpl: g }).call(name, args);
  it('get_article nennt die Einheit beim Namen', async () => {
    const r = await call('get_article', { org: 'nt', id: 1 });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { unit: string }).unit).toBe('Stk.');
    expect(einheitenAbrufe).toBe(1);
  });
  it('search_articles liest die Einheiten nicht nach: die Liste traegt unitName schon', async () => {
    const vorher = einheitenAbrufe;
    const r = await call('search_articles', { org: 'nt' });
    expect((r.structuredContent as { items: { unit: string }[] }).items[0]!.unit).toBe('Stk.');
    expect(einheitenAbrufe).toBe(vorher);
  });
});

// 0.3.2 (PA-37cca969-02): die Waehrung des Artikels. Gemessen M-K A8 (16.10.2026): article/list -> currencyId 2, currencyCode "EUR";
// article/read -> currencyId 2, currencyCode null. Massgebend ist currencyId; ohne eigene Waehrung (currencyId null) ist `currency` null
// (= Waehrung des Mandanten, die der Aufrufer kennt).
describe('Artikel 0.3.2: currencyId und currency', () => {
  const liste = [
    { id: 1, nr: 'S-01', name: 'Beratung', salesPrice: 180, isSalesPriceGross: false, currencyId: null, currencyCode: 'CHF' },
    { id: 11, nr: 'DT-MK-A8', name: 'Artikel in EUR', salesPrice: 100, isSalesPriceGross: false, currencyId: 2, currencyCode: 'EUR' },
  ];
  let waehrungsAbrufe = 0;
  const g = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('currency/list')) { waehrungsAbrufe++; return new Response(fixture('currency-list'), { status: 200 }); }
    if (u.includes('inventory/article/list')) return new Response(JSON.stringify({ data: liste, total: 2 }), { status: 200 });
    if (u.includes('inventory/article/read')) return new Response(JSON.stringify({ data: { ...liste[1], currencyCode: null } }), { status: 200 });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const call = (name: string, args: Record<string, unknown>) => createToolset(cfg, { fetchImpl: g }).call(name, args);
  it('search_articles: EUR-Artikel trägt currencyId 2 und currency EUR, der andere null/null', async () => {
    const r = await call('search_articles', { org: 'nt' });
    const items = (r.structuredContent as { items: Record<string, unknown>[] }).items;
    expect(items.map((a) => [a.id, a.currencyId, a.currency])).toEqual([[1, null, null], [11, 2, 'EUR']]);
  });
  it('get_article: currencyCode null wie gemessen, currency aus currency/list (EUR)', async () => {
    const vorher = waehrungsAbrufe;
    const r = await call('get_article', { org: 'nt', id: 11 });
    expect(r.structuredContent).toMatchObject({ id: 11, currencyId: 2, currency: 'EUR' });
    expect(waehrungsAbrufe).toBe(vorher + 1);
  });
});
