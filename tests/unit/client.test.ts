import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CashCtrlHttp } from '../../src/core/http.js';
import { CashCtrlClient } from '../../src/core/client.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8');
function clientWith(routes: Record<string, string>) {
  const calls: string[] = [];
  const f = (async (url: string | URL) => {
    const u = new URL(String(url)); calls.push(u.pathname + u.search);
    const key = Object.keys(routes).find((k) => u.pathname.endsWith(k));
    if (!key) return new Response('<html>404</html>', { status: 404 });
    return new Response(fixture(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  // usage: null, bucket: null — sonst schreibt ein Test-Client nach ~/.config/cashctrl-mcp/usage.json (Fixwelle 1).
  return { c: new CashCtrlClient(new CashCtrlHttp({ subdomain: 'd', apiKey: 'k', org: 'x', fetchImpl: f, usage: null, bucket: null })), calls };
}

describe('CashCtrlClient (lesend)', () => {
  it('listPersons gibt data und total und setzt query/onlyCustomers', async () => {
    const { c, calls } = clientWith({ 'person/list.json': 'person-list-limit-5' });
    const r = await c.listPersons({ query: 'Muster', onlyCustomers: true, limit: 5 });
    expect(Array.isArray(r.data)).toBe(true);
    expect(typeof r.total).toBe('number');
    expect(calls[0]).toContain('query=Muster');
    expect(calls[0]).toContain('onlyCustomers=true');
  });
  it('listOrders verlangt type und kodiert filter als JSON', async () => {
    const { c, calls } = clientWith({ 'order/list.json': 'order-list-type-SALES-limit-5' });
    await c.listOrders({ type: 'SALES', filter: [{ field: 'date', comparison: 'gt', value: '2026-01-01' }] });
    expect(calls[0]).toContain('type=SALES');
    expect(decodeURIComponent(calls[0])).toContain('"comparison":"gt"');
  });
  it('readArticle ruft inventory/article/read mit id und gibt data', async () => {
    const calls: string[] = [];
    const f = (async (url: string | URL) => {
      const u = new URL(String(url)); calls.push(u.pathname + u.search);
      return new Response(JSON.stringify({ success: true, data: { id: 1, nr: 'A-01', name: 'X' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const c = new CashCtrlClient(new CashCtrlHttp({ subdomain: 'd', 'apiKey': 'k', org: 'x', fetchImpl: f, usage: null, bucket: null }));
    expect(await c.readArticle(1)).toEqual({ id: 1, nr: 'A-01', name: 'X' });
    expect(calls[0]).toContain('inventory/article/read.json?id=1');
  });
  it('readOrderCategory liefert eine Statusliste', async () => {
    const { c } = clientWith({ 'order/category/read.json': 'order-category-read' });
    const cat = await c.readOrderCategory(4);
    expect(Array.isArray((cat as { status?: unknown }).status)).toBe(true);   // Feldname an der Fixture pruefen
  });
});

describe('CashCtrlClient (schreibend)', () => {
  function capture() {
    const bodies: string[] = []; const urls: string[] = [];
    const f = (async (url: string | URL, init: RequestInit = {}) => { urls.push(String(url)); bodies.push(String(init.body ?? '')); return new Response(JSON.stringify({ success: true, insertId: 42 }), { status: 200 }); }) as unknown as typeof fetch;
    return { c: new CashCtrlClient(new CashCtrlHttp({ subdomain: 'd', apiKey: 'k', org: 'x', fetchImpl: f, usage: null, bucket: null })), bodies, urls };
  }
  it('createOrder sendet items als JSON, associateId als CSV, und gibt insertId', async () => {
    const { c, bodies, urls } = capture();
    const r = await c.createOrder({ categoryId: 4, associateId: 9, date: '2026-08-27', items: [{ accountId: 3, name: 'Beratung', quantity: 2, unitPrice: 518.88, taxId: 9 }] });
    expect(r.insertId).toBe(42);
    expect(urls[0]).toMatch(/order\/create\.json$/);
    const p = new URLSearchParams(bodies[0]);
    expect(p.get('associateId')).toBe('9');
    expect(JSON.parse(p.get('items')!)[0]).toMatchObject({ accountId: 3, name: 'Beratung', quantity: 2, unitPrice: 518.88 });
  });
  it('updateOrderStatus sendet ids als CSV', async () => {
    const { c, bodies, urls } = capture();
    await c.updateOrderStatus({ ids: [7], statusId: 18 });
    expect(new URLSearchParams(bodies[0]).get('ids')).toBe('7');
    expect(urls[0]).toMatch(/order\/update_status\.json$/);
  });
  it('mailOrderDocument sendet mailFrom/mailSubject/mailText und orderIds als CSV, ohne subject/message', async () => {
    const { c, bodies, urls } = capture();
    await c.mailOrderDocument({ orderIds: [7], mailFrom: 'buchhaltung@example.ch', mailSubject: 'Ihre Rechnung', mailText: 'Anbei die Rechnung.', mailTo: 'kunde@example.ch', sentStatusId: 5 });
    expect(urls[0]).toMatch(/order\/document\/mail\.json$/);
    const p = new URLSearchParams(bodies[0]);
    expect(p.get('orderIds')).toBe('7');
    expect(p.get('mailFrom')).toBe('buchhaltung@example.ch');
    expect(p.get('mailSubject')).toBe('Ihre Rechnung');
    expect(p.get('mailText')).toBe('Anbei die Rechnung.');
    expect(p.get('mailTo')).toBe('kunde@example.ch');
    expect(p.has('subject')).toBe(false);
    expect(p.has('message')).toBe(false);
  });
  it('createOrderBookEntry sendet orderIds (nicht ids) als CSV', async () => {
    const { c, bodies, urls } = capture();
    await c.createOrderBookEntry({ orderIds: [7, 8], accountId: 3, date: '2026-08-27' });
    expect(new URLSearchParams(bodies[0]).get('orderIds')).toBe('7,8');
    expect(urls[0]).toMatch(/order\/bookentry\/create\.json$/);
  });
});
