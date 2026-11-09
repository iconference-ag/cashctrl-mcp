import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext } from '../../src/tools/context.js';
import { summarize, searchJournal, listAccounts, financialSummary } from '../../src/tools/read/ledger.js';
import type { Config } from '../../src/config/config.js';

const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8');
/** Jede angefragte URL wird mitgeschrieben — die Filterparameter sind Teil des Vertrags. */
const urls: string[] = [];
const f = (async (url: string | URL) => {
  const u = String(url);
  urls.push(u);
  if (u.includes('account/list')) return new Response(fixture('account-list'), { status: 200 });
  return new Response(fixture('journal-list-limit-5'), { status: 200 });
}) as unknown as typeof fetch;
/** Letzte Anfrage an einen Endpunkt, als URL-Objekt — fuer die Pruefung der gesendeten Parameter. */
const letzte = (teil: string) => new URL(urls.filter((u) => u.includes(teil)).at(-1)!);
/** Eigener fetchImpl fuer financial_summary: account/list plus zwei order/list-Aufrufe (SALES/PURCHASE). */
const fFin = (async (url: string | URL) => {
  const u = String(url);
  urls.push(u);
  if (u.includes('account/list')) return new Response(fixture('account-list'), { status: 200 });
  if (u.includes('order/list') && u.includes('type=SALES')) return new Response(fixture('order-list-type-SALES-onlyOpen-true-limit-5'), { status: 200 });
  if (u.includes('order/list') && u.includes('type=PURCHASE')) return new Response(fixture('order-list-type-PURCHASE-limit-5'), { status: 200 });
  return new Response('{}', { status: 200 });
}) as unknown as typeof fetch;

const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-l.json`);
const cfg: Config = { mode: 'read', pdfDir: '/tmp/x', usageFile, source: 'env', orgs: [{ name: 'nt', subdomain: 'd', 'apiKey': 'k' }] };

afterAll(async () => {
  await rm(usageFile, { force: true });
});

describe('financial_summary — Klassierung nach Kontonummer', () => {
  it('summiert Aktiven, Passiven, Ertrag, Aufwand und rechnet den Gewinn', () => {
    const s = summarize([
      { number: '1020', endAmount: 100 }, { number: '1100', endAmount: 50 },
      { number: '2000', endAmount: 30 }, { number: '2800', endAmount: 120 },
      { number: '3000', endAmount: 500 }, { number: '4000', endAmount: 200 }, { number: '6500', endAmount: 100 },
      { number: '9100', endAmount: 999 },
    ]);
    expect(s).toEqual({ assets: 150, liabilities: 150, revenue: 500, expenses: 300, profit: 200 });
  });

  it('ein Konto mit Gegensaldo mindert seine Klasse, statt sie zu erhoehen; die Bilanz schliesst', () => {
    // Gemessen 09.11.2026 am Demo-Mandanten: 6961 Rundungsdifferenzen stand auf -0.18 (Habensaldo auf einem Aufwandkonto).
    // Betragsweise gezaehlt war der Aufwand 0.36 zu hoch, und Aktiven - Passiven wich um 0.36 vom Gewinn ab.
    const s = summarize([
      { number: '1020', endAmount: 1000 }, { number: '1109', endAmount: -50 },
      { number: '2000', endAmount: 449.82 },
      { number: '3000', endAmount: 800 }, { number: '6500', endAmount: 300 }, { number: '6961', endAmount: -0.18 },
    ]);
    expect(s).toEqual({ assets: 950, liabilities: 449.82, revenue: 800, expenses: 299.82, profit: 500.18 });
    expect(s.assets - s.liabilities).toBeCloseTo(s.profit, 2);
  });

  it('liefert CashCtrl eine ganze Klasse negativ, bleibt die Summe positiv', () => {
    const s = summarize([{ number: '1020', endAmount: 300 }, { number: '2000', endAmount: -100 }, { number: '3000', endAmount: -500 }, { number: '4000', endAmount: 300 }]);
    expect(s).toEqual({ assets: 300, liabilities: 100, revenue: 500, expenses: 300, profit: 200 });
  });

  it('rechnet auf der echten Fixture account-list.json die Kontrollzahlen des Mandanten', () => {
    const accounts = (JSON.parse(fixture('account-list')) as { data: { number: unknown; endAmount: unknown }[] }).data;
    const s = summarize(accounts);
    // Kontrollzahlen vorab gegen tests/fixtures/account-list.json gemessen (140 Konten, kein
    // negativer endAmount): Bilanz schliesst (assets = liabilities + profit).
    expect(s.assets).toBeCloseTo(593321.2, 2);
    expect(s.liabilities).toBeCloseTo(404491.21, 2);
    expect(s.revenue).toBeCloseTo(999160, 2);
    expect(s.expenses).toBeCloseTo(810330.01, 2);
    expect(s.profit).toBeCloseTo(188829.99, 2);
  });
});

describe('search_journal', () => {
  it('gibt kompakte Buchungen mit aufgeloesten Kontonamen und sendet den verschobenen Datumsfilter', async () => {
    urls.length = 0;
    const r = await searchJournal(buildContext(cfg, { fetchImpl: f }), { dateFrom: '2026-08-01', dateTo: '2026-08-28' });
    expect(r.isError).toBeUndefined();
    const s = r.structuredContent as { items: Record<string, unknown>[]; total: number; hasMore: boolean };
    // Erste Zeile der Fixture journal-list-limit-5.json: debitName/creditName tragen Kontonummer
    // und mehrsprachiges Fragment in einem String — de() loest das Fragment auf, der Praefix bleibt.
    // date steht roh als "2026-08-28 00:00:00.0" in der Fixture; Spec §4 verlangt ISO (B3).
    expect(s.items[0]).toMatchObject({ id: 139, date: '2026-08-28', title: 'Pensionskasse BVG und UVG/KTG August 2026', debitAccount: '5700 Sozialleistungen', creditAccount: '1020 Bank', amount: 2100, reference: '74' });
    expect(s.total).toBe(128);
    expect(s.hasMore).toBe(true);
    // Inklusive Grenzen: CashCtrl kennt nur eq/like/gt/lt, der Randtag wird deshalb verschoben.
    expect(JSON.parse(letzte('journal/list').searchParams.get('filter')!)).toEqual([
      { field: 'dateAdded', comparison: 'gt', value: '2026-07-31' },
      { field: 'dateAdded', comparison: 'lt', value: '2026-08-29' },
    ]);
  });

  // 0.4.0 (24.10.2026): journal/list liefert ohne fiscalPeriodId nur das aktuelle Geschaeftsjahr (gemessen beim Datenbau
  // 2024 bis 2026). Ohne Parameter wuerde eine Frage nach 2024 still leer beantwortet.
  it('reicht fiscalPeriodId durch und nennt das Geschaeftsjahr in der Antwort', async () => {
    urls.length = 0;
    const r = await searchJournal(buildContext(cfg, { fetchImpl: f }), { dateFrom: '2024-01-01', dateTo: '2024-12-31', fiscalPeriodId: 3 });
    expect(letzte('journal/list').searchParams.get('fiscalPeriodId')).toBe('3');
    const s = r.structuredContent as Record<string, unknown>;
    expect(s.fiscalPeriodId).toBe(3);
    expect(s.hinweis).toBeUndefined();
  });
  it('ohne fiscalPeriodId: kein Parameter, Antwort sagt «aktuell» und weist auf frühere Jahre hin', async () => {
    urls.length = 0;
    const r = await searchJournal(buildContext(cfg, { fetchImpl: f }), { dateFrom: '2024-01-01', dateTo: '2024-12-31' });
    expect(letzte('journal/list').searchParams.has('fiscalPeriodId')).toBe(false);
    const s = r.structuredContent as Record<string, unknown>;
    expect(s.fiscalPeriodId).toBe('aktuell');
    expect(String(s.hinweis)).toMatch(/list_fiscal_periods/);
  });
});

describe('list_accounts', () => {
  it('gibt den Kontenplan mit aufgeloestem Namen', async () => {
    const r = await listAccounts(buildContext(cfg, { fetchImpl: f }), {});
    expect(r.isError).toBeUndefined();
    const s = r.structuredContent as { items: Record<string, unknown>[]; total: number };
    // Erste Zeile der Fixture account-list.json: name traegt ein reines <values>-Fragment ohne Praefix.
    expect(s.items[0].name).toBe('Kasse');
    expect(s.total).toBe(140);
  });
  it('liefert den vollstaendigen Bestand mit total, ohne Paginierung (B4)', async () => {
    const r = await listAccounts(buildContext(cfg, { fetchImpl: f }), {});
    const s = r.structuredContent as { items: unknown[]; total: number };
    // Spec §9, benannte Ausnahme: account/list kennt kein limit — voller Bestand, kein hasMore.
    expect(Object.keys(s)).toEqual(['items', 'total']);
    expect(s.total).toBe(s.items.length);
  });
});

describe('financial_summary', () => {
  it('komponiert Bilanzsummen aus account/list mit offenen Debitoren und Kreditoren aus order/list', async () => {
    urls.length = 0;
    const r = await financialSummary(buildContext(cfg, { fetchImpl: fFin }), {});
    expect(r.isError).toBeUndefined();
    const s = r.structuredContent as { profit: number; openReceivables: { sum: number; count: number; hasMore: boolean }; openPayables: { sum: number; count: number; hasMore: boolean } };
    // profit wie in der Fixture-Kontrollzahl oben (account-list.json).
    expect(s.profit).toBeCloseTo(188829.99, 2);
    // order-list-type-SALES-onlyOpen-true-limit-5.json: alle fuenf Zeilen open=null (Offerten/AB, bucht nicht) — zaehlt als 0.
    // count zaehlt nur Belege mit offenem Betrag. Bis 0.4.0 stand hier das total von CashCtrl (17): onlyOpen liefert auch
    // offene Offerten, gemessen 09.11.2026 am Geschaeftsjahr 2024 als «8 offene Debitoren, Summe 0».
    expect(s.openReceivables.sum).toBe(0);
    expect(s.openReceivables.count).toBe(0);
    expect(s.openReceivables.hasMore).toBe(true);
    // order-list-type-PURCHASE-limit-5.json: open-Werte 2659.25, 53900, 0, 0, 0 -> Summe 56559.25, zwei Belege mit offenem Betrag (total 11).
    expect(s.openPayables.sum).toBeCloseTo(56559.25, 2);
    expect(s.openPayables.count).toBe(2);
    expect(s.openPayables.hasMore).toBe(true);
    // Gesendete Parameter: onlyOpen=true, limit=200 bei beiden Aufrufen.
    expect(letzte('type=SALES').searchParams.get('onlyOpen')).toBe('true');
    expect(letzte('type=SALES').searchParams.get('limit')).toBe('200');
    expect(letzte('type=PURCHASE').searchParams.get('onlyOpen')).toBe('true');
    expect(letzte('type=PURCHASE').searchParams.get('limit')).toBe('200');
    // Minor-Befund: bei hasMore in Debitoren oder Kreditoren traegt der Hinweistext den Mindestwert-Zusatz.
    const text = (r.content as { text: string }[])[0].text;
    expect(text).toMatch(/Offene Posten: mehr als 200 Belege — Anzahl und Summe sind Mindestwerte\./);
  });
});
