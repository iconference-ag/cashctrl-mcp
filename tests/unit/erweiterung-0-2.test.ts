import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolset } from '../../src/toolset.js';
import type { Config } from '../../src/config/config.js';

/** Kleine Erweiterungen von v0.2.0: get_order/search_orders, list_taxes, search_articles, prepare_order_status. */
const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8');
const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-erw.json`);
const cfg = (mode: Config['mode']): Config => ({ mode, pdfDir: '/tmp/x', usageFile, source: 'env', orgs: [{ name: 'nt', subdomain: 'd', 'apiKey': 'k' }] });
afterAll(async () => { await rm(usageFile, { force: true }); });
const urls: string[] = [];
const order = (JSON.parse(fixture('order-read')) as { data: Record<string, unknown> }).data;
const mitNotes = JSON.stringify({ success: true, data: { ...order, notes: 'KEY-1', custom: '<values><f1>x</f1></values>' } });
const f = (async (url: string | URL) => {
  const u = String(url);
  urls.push(u);
  const j = (b: string) => new Response(b, { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.includes('order/category/list')) return j(fixture('order-category-list-type-SALES'));
  if (u.includes('order/read')) return j(new URL(u).searchParams.get('id') === '7' ? mitNotes : fixture('order-read'));
  if (u.includes('order/list')) return j(fixture('order-list-type-SALES-limit-5'));
  if (u.includes('tax/list')) return j(fixture('tax-list'));
  if (u.includes('inventory/article/list')) return j(fixture('inventory-article-list-limit-5'));
  return j('{}');
}) as unknown as typeof fetch;
const text = (r: { content?: unknown[] }) => { const c = r.content?.[0]; return c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''; };

describe('get_order: notes, custom und IDs', () => {
  it('gibt notes und custom roh aus, dazu categoryId, statusId, associateId als Zahlen', async () => {
    const r = await createToolset(cfg('read'), { fetchImpl: f }).call('get_order', { id: 7 });
    expect(r.structuredContent).toMatchObject({ notes: 'KEY-1', custom: '<values><f1>x</f1></values>', categoryId: 2, statusId: 37, associateId: 12 });
  });
  it('ohne Notizen: notes null', async () => {
    const r = await createToolset(cfg('read'), { fetchImpl: f }).call('get_order', { id: 55 });
    expect((r.structuredContent as { notes: unknown }).notes).toBeNull();
  });
});

describe('search_orders: notes-Filter', () => {
  it('sendet like auf notes zusammen mit den Datumsfiltern', async () => {
    urls.length = 0;
    const r = await createToolset(cfg('read'), { fetchImpl: f }).call('search_orders', { type: 'SALES', notes: 'KEY-1', dateFrom: '2026-07-10' });
    expect(r.isError).toBeFalsy();
    const filter = JSON.parse(new URL(urls.filter((u) => u.includes('order/list')).at(-1)!).searchParams.get('filter')!);
    expect(filter).toEqual([{ field: 'date', comparison: 'gt', value: '2026-07-09' }, { field: 'notes', comparison: 'like', value: 'KEY-1' }]);
  });
  it('ohne notes kein notes-Filter', async () => {
    urls.length = 0;
    await createToolset(cfg('read'), { fetchImpl: f }).call('search_orders', { type: 'SALES' });
    expect(urls.filter((u) => u.includes('order/list')).at(-1)).not.toContain('notes');
  });
});

describe('search_orders: previousOrderId-Filter', () => {
  it('sendet eq auf previousId, und jeder Treffer traegt previousId zum Nachpruefen', async () => {
    urls.length = 0;
    const r = await createToolset(cfg('read'), { fetchImpl: f }).call('search_orders', { type: 'SALES', previousOrderId: 55 });
    expect(r.isError).toBeFalsy();
    const filter = JSON.parse(new URL(urls.filter((u) => u.includes('order/list')).at(-1)!).searchParams.get('filter')!);
    expect(filter).toEqual([{ field: 'previousId', comparison: 'eq', value: 55 }]);
    const items = (r.structuredContent as { items: Record<string, unknown>[] }).items;
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) expect(i).toHaveProperty('previousId');
  });
  it('ohne previousOrderId kein previousId-Filter', async () => {
    urls.length = 0;
    await createToolset(cfg('read'), { fetchImpl: f }).call('search_orders', { type: 'SALES' });
    expect(urls.filter((u) => u.includes('order/list')).at(-1)).not.toContain('previousId');
  });
});

describe('list_taxes', () => {
  it('liefert id, code, name, rate, inactive (0.2.4) aus tax/list, ohne Paginierung', async () => {
    const r = await createToolset(cfg('read'), { fetchImpl: f }).call('list_taxes', {});
    const s = r.structuredContent as { items: Record<string, unknown>[]; total: number };
    expect(s.total).toBe(20);
    expect(s).not.toHaveProperty('hasMore');
    expect(Object.keys(s.items[0])).toEqual(['id', 'code', 'name', 'rate', 'inactive', 'sales']);
    expect(s.items[0]).toEqual({ id: 1, code: 'BN1', name: 'Bezugsteuer', rate: 8.1, inactive: false, sales: false });
    expect(s.items.find((i) => i.code === 'UN1')).toMatchObject({ id: 9, rate: 8.1 });
  });
});

describe('search_articles: Preisart und Ertragskonto', () => {
  it('gibt salesPriceIsGross (boolean) und salesAccountId aus', async () => {
    const r = await createToolset(cfg('read'), { fetchImpl: f }).call('search_articles', {});
    const it0 = (r.structuredContent as { items: Record<string, unknown>[] }).items[0];
    expect(it0.salesPriceIsGross).toBe(false);
    expect(it0).toHaveProperty('salesAccountId', null);
  });
  it('ein brutto gefuehrter Artikel meldet true', async () => {
    const roh = JSON.parse(fixture('inventory-article-list-limit-5')) as { data: Record<string, unknown>[] };
    roh.data[0].isSalesPriceGross = true; roh.data[0].salesAccountId = 15;
    const g = (async () => new Response(JSON.stringify(roh), { status: 200 })) as unknown as typeof fetch;
    const r = await createToolset(cfg('read'), { fetchImpl: g }).call('search_articles', {});
    expect((r.structuredContent as { items: Record<string, unknown>[] }).items[0]).toMatchObject({ salesPriceIsGross: true, salesAccountId: 15 });
  });
});

describe('prepare_order_status mit statusId', () => {
  const t = () => createToolset(cfg('full'), { fetchImpl: f });
  it('statusId aus der Kategorie des Belegs (Offerte): Vorschau nennt den Namen', async () => {
    const r = await t().call('prepare_order_status', { orderId: 55, statusId: 39 });
    expect(r.isError, text(r)).toBeFalsy();
    expect((r.structuredContent as { summary: string }).summary).toContain('«Akzeptiert»');
  });
  it('statusId einer fremden Kategorie: validation mit Liste', async () => {
    const r = await t().call('prepare_order_status', { orderId: 55, statusId: 16 });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ message: expect.any(String), kind: 'validation' });
    expect(text(r)).toContain('Akzeptiert (39)');
  });
  it('genau eines von status und statusId', async () => {
    const beide = await t().call('prepare_order_status', { orderId: 55, status: 'Akzeptiert', statusId: 39 });
    expect(beide.isError).toBe(true);
    expect(text(beide)).toContain('genau eines');
    const keins = await t().call('prepare_order_status', { orderId: 55 });
    expect(keins.isError).toBe(true);
  });
  it('der Weg ueber den Namen funktioniert weiter', async () => {
    expect((await t().call('prepare_order_status', { orderId: 55, status: 'Akzeptiert' })).isError).toBeFalsy();
  });
});
