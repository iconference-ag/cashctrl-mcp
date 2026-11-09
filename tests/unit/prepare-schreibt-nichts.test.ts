import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolset } from '../../src/toolset.js';
import { kontenListe } from '../helpers/konten.js';
import type { Config } from '../../src/config/config.js';

/**
 * B5: «prepare_* schreibt nichts» ist die tragende Zusage des zweistufigen Musters (Spec §7).
 * Bisher war sie nur behauptet: ein versehentlicher POST in einem prepare-Zweig waere durch
 * die ganze Suite gruen durchgelaufen. Hier zaehlt eine Attrappe jeden POST mit — ueber das
 * volle Werkzeugset im Modus `full`, mit allen DEFAULT_MODULES, nicht modulweise.
 */
const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8');
const json = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

// Einkaufsrechnung ER-2026-011 (id 82, Kategorie 15, open 2659.25) aus der Fixture gelesen.
const order82 = (JSON.parse(fixture('order-list-type-PURCHASE-limit-5')) as { data: Record<string, unknown>[] }).data.find((r) => r.id === 82)!;
const artikel = JSON.stringify({ success: true, data: { id: 2, nr: 'A-02', name: 'Pflanzwand-Modul 120x60 cm', unitId: 4, salesAccountId: null } });

function makeEnv() {
  const posts: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
      posts.push(u);
      return json(JSON.stringify({ success: true, insertId: 1 }));
    }
    if (u.includes('order/category/list')) return json(fixture(new URL(u).searchParams.get('type') === 'PURCHASE' ? 'order-category-list-type-PURCHASE' : 'order-category-list-type-SALES'));
    if (u.includes('person/list')) return json(fixture('person-list-limit-5'));
    if (u.includes('person/read')) return json(fixture('person-read'));
    if (u.includes('inventory/unit/list')) return json(fixture('inventory-unit-list'));
    if (u.includes('inventory/article/list')) return json(fixture('inventory-article-list-limit-5'));
    if (u.includes('inventory/article/read')) return json(artikel);
    if (u.includes('tax/list')) return json(fixture('tax-list'));
    if (u.includes('account/bank/list')) return json(fixture('account-bank-list'));
    if (u.includes('account/list')) return json(kontenListe());
    if (u.includes('fiscalperiod/list')) return json(fixture('fiscalperiod-list'));
    if (u.includes('location/list')) return json(fixture('location-list'));
    if (u.includes('order/document/read')) return json(fixture('order-document-read'));
    if (u.includes('order/read')) return json(new URL(u).searchParams.get('id') === '82' ? JSON.stringify({ success: true, data: order82 }) : fixture('order-read'));
    return json('{}');
  }) as unknown as typeof fetch;
  return { posts, fetchImpl };
}

const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-prepare.json`);
// sendMail und deleteOrders: true, sonst fehlen prepare_send_order und prepare_delete_order im
// Werkzeugset — dieser Test prueft alle zehn (0.4.0: prepare_api_write dazu).
const cfg: Config = { mode: 'full', pdfDir: '/tmp/x', usageFile, source: 'env', orgs: [{ name: 'nt', subdomain: 'd', 'apiKey': 'k', sendMail: true, deleteOrders: true }] };
afterAll(async () => { await rm(usageFile, { force: true }); });

/** Je ein gueltiger Aufruf, der bis ans Ende von prepare laeuft — alle Argumente aus den Fixtures. */
const faelle: [string, Record<string, unknown>][] = [
  ['prepare_contact', { company: 'MCP-TEST Pruefstelle AG', city: 'Zug', isCustomer: true }],
  ['prepare_article', { nr: 'MCP-TEST-1', name: 'MCP-TEST Artikel', salesPriceNet: 100 }],
  ['prepare_order_draft', { category: 'offer', contactId: 7, defaultAccountNumber: '3000', items: [{ articleId: 2, qty: 2, unitPriceNet: 890 }] }],
  ['prepare_order_create', { category: 'invoice', statusId: 16, contactId: 7, defaultAccountNumber: '3000', items: [{ articleId: 2, qty: 2, unitPriceNet: 890 }] }],
  ['prepare_order_status', { orderId: 55, status: 'Akzeptiert' }],
  ['prepare_payment', { orderId: 82, date: '2026-08-27' }],
  ['prepare_journal_entry', { date: '2026-08-27', title: 'MCP-TEST Buchung', debitAccount: '4000', creditAccount: '1020', amount: 100 }],
  ['prepare_send_order', { orderId: 55, subject: 'MCP-TEST', message: 'Anbei.' }],
  ['prepare_delete_order', { orderId: 55 }],
  // 0.4.0: der allgemeine Schreibweg; die Zusage gilt dort genauso (prepare ruft CashCtrl gar nicht auf).
  ['prepare_api_write', { path: 'person/title/create.json', params: { name: 'MCP-TEST Titel' } }],
];
/** Weitere Wege durch ein schon genanntes prepare_: Kopie aus einem Quellbeleg. */
const zusatzWege: [string, Record<string, unknown>][] = [
  ['prepare_order_create', { category: 'invoice', statusId: 16, contactId: 7, copyItemsFromOrderId: 55 }],
];

describe('prepare_* schreibt nichts (B5)', () => {
  it('das Werkzeugset im Modus full kennt genau diese zehn prepare_*', () => {
    const namen = createToolset(cfg, { fetchImpl: makeEnv().fetchImpl }).names();
    expect(namen.filter((n) => n.startsWith('prepare_')).sort()).toEqual(faelle.map(([n]) => n).sort());
  });

  it('kein einziger POST ueber alle zehn prepare_* (und den Kopierweg) hinweg', async () => {
    const { posts, fetchImpl } = makeEnv();
    const t = createToolset(cfg, { fetchImpl });
    for (const [name, args] of [...faelle, ...zusatzWege]) {
      const r = await t.call(name, args);
      // Ein prepare, das vorzeitig scheitert, wuerde die Zusage nicht pruefen, sondern umgehen.
      expect(r.isError, `${name}: ${JSON.stringify(r.content)}`).toBeFalsy();
      expect((r.structuredContent as { token?: string }).token, name).toBeTruthy();
      expect(posts, `POST nach ${name}`).toEqual([]);
    }
    expect(posts).toEqual([]);
  });

  it('Positivkontrolle: derselbe Zaehler steigt, sobald ein commit_* laeuft', async () => {
    const { posts, fetchImpl } = makeEnv();
    const t = createToolset(cfg, { fetchImpl });
    const prep = await t.call('prepare_contact', { company: 'MCP-TEST Pruefstelle AG' });
    expect(posts).toEqual([]);
    const { token } = prep.structuredContent as { token: string };
    const commit = await t.call('commit_contact', { token });
    expect(commit.isError).toBeFalsy();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('person/create');
  });
});
