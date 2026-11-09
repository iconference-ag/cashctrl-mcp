/**
 * Vertragstest gegen einen echten Mandanten — nur lesend.
 *
 * Lauf (aus dem Paketordner):
 *   CASHCTRL_LIVE=1 CASHCTRL_LIVE_SUBDOMAIN=… CASHCTRL_LIVE_API_KEY=… npx vitest run tests/live/read.live.test.ts
 *
 * Ohne `CASHCTRL_LIVE=1` wird die ganze Datei uebersprungen; `npm test` laeuft ohnehin nur
 * `tests/unit`. Ein Lauf kostet rund 15 Aufrufe vom Monatskontingent (30'000, AGB Ziffer 6) —
 * nicht in Schleifen messen.
 *
 * Mandant und Schluessel kommen aus der Umgebung, siehe `tests/live/mandant.ts`
 * (CASHCTRL_LIVE_SUBDOMAIN, dazu CASHCTRL_LIVE_API_KEY oder CASHCTRL_LIVE_KEYCHAIN).
 *
 * Kennzahlen: bis 0.4.0 standen hier die festen Zahlen der Aufnahme vom 28.08.2026. Der Mandant
 * lebt (am 09.11.2026 waren es 109 statt 9 Rechnungen), feste Zahlen messen darum den Mandanten
 * und nicht den Server. Geprueft wird seither, was unabhaengig vom Bestand gelten muss: die
 * Bilanzidentitaet Aktiven − Passiven = Gewinn in jedem Geschaeftsjahr.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolset, type Toolset } from '../../src/toolset.js';
import { liveOrg } from './mandant.js';

const live = process.env.CASHCTRL_LIVE === '1';
const DIR = join(tmpdir(), 'cashctrl-mcp-live');
let t: Toolset;

beforeAll(() => {
  if (!live) return;
  t = createToolset({ mode: 'read', pdfDir: DIR, usageFile: join(DIR, 'usage.json'), source: 'env', orgs: [liveOrg()] });
});

/** Ergebnis auspacken und dabei `isError` scharf pruefen — sonst laeuft ein Fehlertext als Erfolg durch. */
function daten<T>(r: { isError?: boolean; structuredContent?: unknown; content?: unknown }): T {
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  return r.structuredContent as T;
}

describe.skipIf(!live)('Lesewerkzeuge am Mandanten', () => {
  it('list_orgs nennt den Firmennamen des Hauptstandorts', async () => {
    const d = daten<{ orgs: { name: string; orgName: string; reachable: boolean; mode: string }[] }>(await t.call('list_orgs', {}));
    expect(d.orgs).toHaveLength(1);
    expect(d.orgs[0].orgName).not.toBe('');
    expect(d.orgs[0].orgName).not.toContain('nicht erreichbar');
    expect(d.orgs[0].reachable).toBe(true);
    expect(d.orgs[0].mode).toBe('read');
  });

  it('usage meldet Modus read und das Monatslimit 30000', async () => {
    const d = daten<{ mode: string; limit: number; calls: number; blocked: boolean }>(await t.call('usage', {}));
    expect(d.mode).toBe('read');
    expect(d.limit).toBe(30000);
    expect(d.blocked).toBe(false);
  });

  it('list_fiscal_periods liefert ein laufendes Geschaeftsjahr', async () => {
    const d = daten<{ items: { id: number; name: string; isCurrent: boolean; isClosed: boolean }[] }>(await t.call('list_fiscal_periods', {}));
    expect(d.items.length).toBeGreaterThan(0);
    expect(d.items.some((p) => p.isCurrent && !p.isClosed)).toBe(true);
  });

  it('search_contacts liefert Kunden, get_contact die Kontaktkanaele', async () => {
    const l = daten<{ items: { id: number; nr: string; name: string; isCustomer: boolean }[]; total: number }>(await t.call('search_contacts', { type: 'customer', limit: 5 }));
    expect(l.total).toBeGreaterThan(0);
    expect(l.items[0].isCustomer).toBe(true);
    const c = daten<{ id: number; addresses: unknown[]; contacts: unknown[] }>(await t.call('get_contact', { id: l.items[0].id }));
    expect(c.id).toBe(l.items[0].id);
    expect(Array.isArray(c.contacts)).toBe(true);
  });

  it('search_articles liefert Nettopreise und aufgeloeste Einheiten', async () => {
    const d = daten<{ items: { id: number; nr: string; unit: string; salesPriceNet: number }[]; total: number }>(await t.call('search_articles', { limit: 5 }));
    expect(d.total).toBeGreaterThan(0);
    // Einheiten sind mehrsprachige XML-Fragmente — hier muss der aufgeloeste deutsche Text stehen.
    expect(d.items[0].unit).not.toContain('<values>');
    expect(typeof d.items[0].salesPriceNet).toBe('number');
  });

  it('financial_summary: in jedem Geschaeftsjahr gilt Aktiven − Passiven = Gewinn = Ertrag − Aufwand = Ergebnis laut CashCtrl', async () => {
    type Kennzahlen = { assets: number; liabilities: number; revenue: number; expenses: number; profit: number; openReceivables: { count: number; sum: number }; openPayables: { count: number; sum: number } };
    const jahre = daten<{ items: { id: number; name: string; isCurrent: boolean }[] }>(await t.call('list_fiscal_periods', {})).items;
    for (const j of jahre) {
      const s = daten<Kennzahlen>(await t.call('financial_summary', j.isCurrent ? {} : { fiscalPeriodId: j.id }));
      console.error(`[live] financial_summary ${j.name}: Aktiven ${s.assets}, Passiven ${s.liabilities}, Ertrag ${s.revenue}, Aufwand ${s.expenses}, Gewinn ${s.profit}, offene Debitoren ${s.openReceivables.count}/${s.openReceivables.sum}, offene Kreditoren ${s.openPayables.count}/${s.openPayables.sum}`);
      expect(s.assets, `${j.name}: keine Aktiven`).toBeGreaterThan(0);
      // Die Identitaet bindet die Werte aneinander. Am 09.11.2026 wich sie um 0.36 ab: ein Aufwandkonto
      // mit Habensaldo (6961, -0.18) wurde betragsweise gezaehlt (Fix in summarize).
      expect(s.assets - s.liabilities, `${j.name}: Bilanz schliesst nicht`).toBeCloseTo(s.profit, 2);
      expect(s.revenue - s.expenses).toBeCloseTo(s.profit, 2);
      // Gegenprobe an CashCtrl selbst: fiscalperiod/result nennt das Ergebnis des Jahres als blosse Zahl.
      const ergebnis = Number(daten<{ body: string }>(await t.call('api_read', { path: 'fiscalperiod/result', params: { id: j.id } })).body);
      expect(s.profit, `${j.name}: Gewinn weicht von fiscalperiod/result ab`).toBeCloseTo(ergebnis, 2);
    }
  });

  it('search_orders findet Rechnungen, get_order die Positionen, get_order_pdf legt ein PDF ab', async () => {
    const l = daten<{ items: { id: number; nr: string; status: string }[]; total: number }>(await t.call('search_orders', { type: 'SALES', category: 'invoice', limit: 50 }));
    console.error(`[live] search_orders SALES/invoice: total ${l.total}, erster Beleg ${l.items[0]?.nr}`);
    expect(l.total).toBeGreaterThan(0);

    const o = daten<{ id: number; total: number; items: { name: string; qty: number; unitPriceNet: number; unitPriceGross: number }[] }>(await t.call('get_order', { id: l.items[0].id }));
    expect(o.items.length).toBeGreaterThan(0);
    expect(typeof o.items[0].unitPriceGross).toBe('number');

    const pdf = daten<{ path: string; bytes: number }>(await t.call('get_order_pdf', { id: l.items[0].id }));
    console.error(`[live] get_order_pdf: ${pdf.bytes} Bytes nach ${pdf.path}`);
    expect(pdf.bytes).toBeGreaterThan(1000);
    // Spec Abschnitt 12, Annahme 2: das PDF kommt binaer. Am abgelegten Artefakt pruefen, nicht am Rueckgabewert.
    expect(readFileSync(pdf.path).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('search_journal liefert Buchungen mit aufgeloesten Kontonamen', async () => {
    const d = daten<{ items: { id: number; date: string; debitAccount: string; creditAccount: string; amount: number }[]; total: number }>(await t.call('search_journal', { dateFrom: '2026-01-01', dateTo: '2026-12-31', limit: 5 }));
    expect(d.total).toBeGreaterThan(0);
    expect(String(d.items[0].debitAccount)).not.toContain('<values>');
  });

  it('list_accounts enthaelt das Ertragskonto 3000', async () => {
    const d = daten<{ items: { number: string; name: string; endAmount: number }[]; total: number }>(await t.call('list_accounts', {}));
    const k = d.items.find((a) => String(a.number) === '3000');
    expect(k, 'Konto 3000 fehlt im Kontenplan').toBeTruthy();
    expect(k!.name).not.toContain('<values>');
  });

  // 0.3.0: die Liste mit Namen statt nur der Zahl (stand seit 0.2.x auf 12, 0.2.4 hatte 14; gemessen 17.10.2026).
  // 0.4.0 brachte api_catalog und api_read; die Liste hier blieb bis 09.11.2026 auf 15 stehen.
  it('im Modus read gibt es genau die 17 Lesewerkzeuge und kein prepare_/commit_', () => {
    const namen = t.names();
    expect(namen.filter((n) => n.startsWith('prepare_') || n.startsWith('commit_'))).toEqual([]);
    expect([...namen].sort()).toEqual(['api_catalog', 'api_read', 'financial_summary', 'get_article', 'get_contact', 'get_order', 'get_order_pdf', 'list_accounts',
      'list_currencies', 'list_fiscal_periods', 'list_orgs', 'list_taxes', 'search_articles', 'search_contacts', 'search_journal', 'search_orders', 'usage']);
  });

  it('Negativkontrolle: ein Werkzeug oberhalb des Modus meldet einen Fehler statt zu schreiben', async () => {
    const r = await t.call('prepare_contact', { company: 'MCP-TEST darf nicht entstehen' });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('read');
  });
});
