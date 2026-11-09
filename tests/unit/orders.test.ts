import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildContext } from '../../src/tools/context.js';
import { createToolset } from '../../src/toolset.js';
import { searchOrders, getOrder, getOrderPdf } from '../../src/tools/read/orders.js';
import { de, loadCategories, findCategory, findStatus } from '../../src/tools/read/categories.js';
import { shiftDay } from '../../src/tools/result.js';
import type { Config } from '../../src/config/config.js';

const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8');
/** Jede angefragte URL wird mitgeschrieben — die Filterparameter sind Teil des Vertrags. */
const urls: string[] = [];
/** order/document/read.pdf braucht den Content-Type, sonst wirft getBinary (Vertrag: expectType application/pdf). */
const f = (async (url: string | URL) => {
  const u = String(url);
  urls.push(u);
  if (u.includes('order/document/read.pdf')) return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), { status: 200, headers: { 'content-type': 'application/pdf' } });
  if (u.includes('order/category/list')) return new Response(fixture('order-category-list-type-SALES'), { status: 200 });
  if (u.includes('order/category/read')) return new Response(fixture('order-category-read'), { status: 200 });
  if (u.includes('order/read')) return new Response(fixture('order-read'), { status: 200 });
  return new Response(fixture('order-list-type-SALES-limit-5'), { status: 200 });
}) as unknown as typeof fetch;
/** Letzte Anfrage an einen Endpunkt, als URL-Objekt — fuer die Prüfung der gesendeten Parameter. */
const letzte = (teil: string) => new URL(urls.filter((u) => u.includes(teil)).at(-1)!);

const pdfDir = mkdtempSync(join(tmpdir(), 'cashctrl-pdf-'));
const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-o.json`);
const cfg: Config = { mode: 'read', pdfDir, usageFile, source: 'env', orgs: [{ name: 'nt', subdomain: 'd', 'apiKey': 'k' }] };

// Eigene Organisation fuer die Kategorie-Tests, damit die Zaehler unabhaengig von den uebrigen Tests sind.
let catListCalls = 0;
let catReadCalls = 0;
const fCat = (async (url: string | URL) => {
  const u = String(url);
  if (u.includes('order/category/read')) { catReadCalls++; return new Response(fixture('order-category-read'), { status: 200 }); }
  if (u.includes('order/category/list')) { catListCalls++; return new Response(fixture('order-category-list-type-SALES'), { status: 200 }); }
  return new Response('{}', { status: 200 });
}) as unknown as typeof fetch;
const cfgCat: Config = { ...cfg, orgs: [{ name: 'ntcat', subdomain: 'd', 'apiKey': 'k' }] };

afterAll(async () => {
  await rm(usageFile, { force: true });
  await rm(pdfDir, { recursive: true, force: true });
});

describe('Belege', () => {
  it('de() holt den deutschen Text aus dem values-XML', () => {
    expect(de('<values><de>Rechnung</de><en>Invoice</en></values>')).toBe('Rechnung');
    expect(de('Offerte')).toBe('Offerte');
  });

  it('search_orders gibt kompakte Belege mit Total und offenem Betrag', async () => {
    const r = await searchOrders(buildContext(cfg, { fetchImpl: f }), { type: 'SALES', limit: 5 });
    // 0.4.0: ohne Datumsfilter und ohne fiscalPeriodId kein Hinweis, aber die Angabe des Geschaeftsjahrs.
    expect((r.structuredContent as Record<string, unknown>).fiscalPeriodId).toBe('aktuell');
    expect((r.structuredContent as Record<string, unknown>).hinweis).toBeUndefined();
    expect(r.isError).toBeUndefined();
    const s = r.structuredContent as { items: Record<string, unknown>[]; total: number; hasMore: boolean };
    expect(Object.keys(s.items[0])).toEqual(expect.arrayContaining(['id', 'nr', 'date', 'status', 'contactName', 'total', 'open']));
    // Erste Zeile der Fixture order-list-type-SALES-limit-5.json: Kategoriename kommt aus `nameSingular`
    // (ein Feld `categoryName` gibt es in order/list nicht), `open` ist null — Offerte, Status bucht nicht.
    // date/dueDate stehen roh als "2026-07-10 00:00:00.0" in der Fixture; Spec §4 verlangt ISO (B3).
    expect(s.items[0]).toMatchObject({ id: 55, nr: 'AN-00012', date: '2026-07-10', category: 'Offerte', status: 'Offen', contactName: 'Winterthur Maschinen AG', total: 213875.85, open: null, currency: 'CHF', currencyId: null, dueDate: '2026-07-24' });
    expect(s.total).toBe(27);
    expect(s.hasMore).toBe(true);
  });

  it('get_order liefert Positionen', async () => {
    const r = await getOrder(buildContext(cfg, { fetchImpl: f }), { id: 1 });
    expect(r.isError).toBeUndefined();
    const s = r.structuredContent as { items: Record<string, unknown>[]; currency: unknown; description: unknown; groupId: unknown };
    expect(Array.isArray(s.items)).toBe(true);
    expect(s.items).toHaveLength(2);
    expect(Object.keys(s.items[0])).toEqual(['articleNr', 'name', 'description', 'qty', 'unitPriceNet', 'unitPriceGross', 'taxCode', 'taxRate', 'totalNet', 'totalGross']);
    // Position 1 der Fixture order-read.json: unitPrice ist brutto (962.09), netUnitPrice netto (890).
    expect(s.items[0]).toMatchObject({ articleNr: 'A-02', name: 'Pflanzwand-Modul 120x60 cm', qty: 205, unitPriceNet: 890, unitPriceGross: 962.09, taxCode: 'UN1', taxRate: 8.1, totalNet: 182450, totalGross: 197228.45 });
    // order/read liefert currencyCode null — der Rueckfall auf die Mandantenwaehrung kommt spaeter.
    expect(s.currency).toBeNull();
    // B3 (0.3.0): die Kennung der Belegwaehrung steht zusaetzlich zum Code; Hauptwaehrung = null (gemessen 16.10.2026).
    expect((s as unknown as { currencyId: unknown }).currencyId).toBeNull();
    expect(s.groupId).toBe(51);
  });

  it('get_order_pdf legt die Datei unter pdfDir/org ab und prueft den PDF-Kopf', async () => {
    const r = await getOrderPdf(buildContext(cfg, { fetchImpl: f }), { id: 1 });
    expect(r.isError).toBeUndefined();
    const s = r.structuredContent as { path: string; bytes: number };
    expect(s.path.startsWith(join(pdfDir, 'nt'))).toBe(true);
    expect(s.path.endsWith('AN-00012.pdf')).toBe(true);
    expect(existsSync(s.path)).toBe(true);
    expect(s.bytes).toBe(6);
    // Ein Beleg-PDF gehoert nicht der ganzen Maschine: Datei 0600, Verzeichnis 0700 (Minor).
    expect((statSync(s.path).mode & 0o777).toString(8)).toBe('600');
    expect((statSync(dirname(s.path)).mode & 0o777).toString(8)).toBe('700');
  });

  it('get_order_pdf filtert auch den Organisationsnamen aus der Konfiguration', async () => {
    // Ein Organisationsname aus der Konfigurationsdatei darf nicht aus pdfDir herausfuehren.
    // '..' und '.' bestehen den Zeichenfilter und muessen als ganzes Segment ersetzt werden.
    const faelle: [string, string][] = [['../x', '.._x'], ['..', '_'], ['.', '_'], ['../..', '.._..']];
    for (const [name, segment] of faelle) {
      const boese: Config = { ...cfg, orgs: [{ name, subdomain: 'd', 'apiKey': 'k' }] };
      const r = await getOrderPdf(buildContext(boese, { fetchImpl: f }), { id: 1 });
      expect(r.isError).toBeUndefined();
      const s = r.structuredContent as { path: string };
      expect(s.path).toBe(join(pdfDir, segment, 'AN-00012.pdf'));
      expect(s.path.startsWith(pdfDir + '/')).toBe(true);
      expect(existsSync(s.path)).toBe(true);
    }
  });

  it('get_order_pdf erzeugt bei leerer Belegnummer keine versteckte Datei', async () => {
    // Belegnummer '' wuerde sonst zu '.pdf' — im Verzeichnis unsichtbar und beim naechsten
    // Beleg ohne Nummer stillschweigend ueberschrieben.
    const fLeer = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('order/document/read.pdf')) return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), { status: 200, headers: { 'content-type': 'application/pdf' } });
      return new Response(JSON.stringify({ success: true, data: { id: 1, nr: '', items: [] } }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await getOrderPdf(buildContext(cfg, { fetchImpl: fLeer }), { id: 1 });
    expect(r.isError).toBeUndefined();
    const s = r.structuredContent as { path: string };
    expect(s.path).toBe(join(pdfDir, 'nt', '_.pdf'));
    expect(existsSync(s.path)).toBe(true);
  });
});

describe('search_orders — Statusfilter ohne Kategorie', () => {
  it('meldet einen mehrdeutigen Statusnamen, statt still die erste Kategorie zu nehmen', async () => {
    const r = await searchOrders(buildContext(cfg, { fetchImpl: f }), { type: 'SALES', status: 'Offen' });
    expect(r.isError).toBe(true);
    const text = (r.content as { text: string }[])[0].text;
    // «Offen» steckt in fuenf SALES-Kategorien mit fuenf verschiedenen IDs: Offerte 37,
    // Auftragsbestaetigung 24, Lieferschein 28, Rechnung 16, Gutschrift 58.
    expect(text).toMatch(/mehreren Kategorien/);
    expect(text).toMatch(/Offerte, Auftragsbestätigung, Lieferschein, Rechnung, Gutschrift/);
  });

  it('meldet einen unbekannten Statusnamen, statt den Filter fallen zu lassen', async () => {
    urls.length = 0;
    const r = await searchOrders(buildContext(cfg, { fetchImpl: f }), { type: 'SALES', status: 'Gibtsnicht' });
    expect(r.isError).toBe(true);
    const text = (r.content as { text: string }[])[0].text;
    expect(text).toMatch(/gibt es nicht/);
    expect(text).toMatch(/Rechnung: Entwurf, Offen, Erinnert 1, Erinnert 2, Bezahlt, Storniert/);
    // Kein order/list-Aufruf: lieber gar keine Suche als eine ungefilterte.
    expect(urls.some((u) => u.includes('order/list'))).toBe(false);
  });

  it('sendet die statusId, wenn der Name in genau einer Kategorie vorkommt', async () => {
    urls.length = 0;
    const r = await searchOrders(buildContext(cfg, { fetchImpl: f }), { type: 'SALES', status: 'Akzeptiert' });
    expect(r.isError).toBeUndefined();
    // «Akzeptiert» gibt es nur in der Offerte, Status-ID 39 (Fixture order-category-list-type-SALES.json).
    expect(letzte('order/list').searchParams.get('statusId')).toBe('39');
    expect(letzte('order/list').searchParams.get('categoryId')).toBeNull();
  });
});

describe('search_orders — Datumsfilter', () => {
  it('shiftDay rechnet ueber Monats- und Jahresgrenzen', () => {
    expect(shiftDay('2026-07-01', -1)).toBe('2026-06-30');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('lehnt kalendarisch unmoegliche Daten ab, statt still zu filtern (B1)', async () => {
    // Gemessen vor dem Fix: search_orders({ dateFrom: '2026-13-45', dateTo: '2026-02-30' })
    // lief ohne Fehler durch und schickte gt 2027-02-13 / lt 2026-03-03 an CashCtrl.
    urls.length = 0;
    const t = createToolset(cfg, { fetchImpl: f });
    const r = await t.call('search_orders', { type: 'SALES', dateFrom: '2026-13-45', dateTo: '2026-02-30' });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0].text).toContain('YYYY-MM-DD');
    expect(urls.some((u) => u.includes('order/list'))).toBe(false);   // lieber keine Suche als eine falsche
    // Ein echtes Schaltjahrdatum geht weiter durch.
    const gut = await t.call('search_orders', { type: 'SALES', dateFrom: '2024-02-29', dateTo: '2024-03-01' });
    expect(gut.isError).toBeUndefined();
  });

  it('sendet inklusive Grenzen als gt/lt mit verschobenem Randtag', async () => {
    urls.length = 0;
    const r = await searchOrders(buildContext(cfg, { fetchImpl: f }), { type: 'SALES', dateFrom: '2026-07-10', dateTo: '2026-07-31' });
    expect(r.isError).toBeUndefined();
    // CashCtrl kennt nur eq/like/gt/lt — die Randtage 10.07. und 31.07. gehoeren in die Treffermenge.
    expect(JSON.parse(letzte('order/list').searchParams.get('filter')!)).toEqual([
      { field: 'date', comparison: 'gt', value: '2026-07-09' },
      { field: 'date', comparison: 'lt', value: '2026-08-01' },
    ]);
  });
});

describe('Kategorien und Status', () => {
  it('loadCategories nimmt status[] aus der Liste, ohne order/category/read zu rufen', async () => {
    const ctx = buildContext(cfgCat, { fetchImpl: fCat });
    const cats = await loadCategories(ctx, undefined, 'SALES');
    expect(catListCalls).toBe(1);
    expect(catReadCalls).toBe(0);   // status[] steht bereits in order/category/list (Vertrag)
    expect(cats.map((c) => c.name)).toEqual(['Offerte', 'Auftragsbestätigung', 'Lieferschein', 'Rechnung', 'Zahlungserinnerung', 'Gutschrift']);
    const rechnung = findCategory(cats, 'invoice');
    expect(rechnung.id).toBe(4);
    expect(findStatus(rechnung, 'Bezahlt').id).toBe(18);
    expect(findCategory(cats, 'offer').id).toBe(2);
    expect(findCategory(cats, 'order_confirmation').id).toBe(3);
    // sentStatusId steht im Kategorie-Kopf, nicht in status[] (Vertrag: order/category/list, Task 19).
    expect(cats.find((c) => c.id === 2)!.sentStatusId).toBe(37);
    // Zweiter Aufruf auf demselben Kontext kommt aus dem Cache (5 Minuten je Organisation und Typ).
    await loadCategories(ctx, undefined, 'SALES');
    expect(catListCalls).toBe(1);
  });

  it('zwei Kontexte teilen den Cache nicht, auch nicht bei gleichem Organisationsnamen', async () => {
    // Gleicher Name, verschiedene Antworten: ein Cache am Modul wuerde dem zweiten Kontext die
    // Kategorien und Status-IDs des ersten liefern — daraus schreiben die Tasks 15–19.
    const fSales = (async () => new Response(fixture('order-category-list-type-SALES'), { status: 200 })) as unknown as typeof fetch;
    const fPurchase = (async () => new Response(fixture('order-category-list-type-PURCHASE'), { status: 200 })) as unknown as typeof fetch;
    const a = await loadCategories(buildContext(cfgCat, { fetchImpl: fSales }), undefined, 'SALES');
    const b = await loadCategories(buildContext(cfgCat, { fetchImpl: fPurchase }), undefined, 'SALES');
    expect(a.map((c) => c.name)).toContain('Offerte');
    expect(b.map((c) => c.name)).toContain('Anfrage');
    expect(b.map((c) => c.name)).not.toContain('Offerte');
    expect(findCategory(a, 'invoice').id).toBe(4);
    expect(findCategory(b, 'invoice').id).toBe(15);
  });

  it('findCategory und findStatus werfen validation mit der Liste des Vorhandenen', async () => {
    const cats = await loadCategories(buildContext(cfgCat, { fetchImpl: fCat }), undefined, 'SALES');
    expect(() => findCategory(cats, 'purchase_invoice')).toThrow(/Offerte, Auftragsbestätigung/);
    expect(() => findStatus(findCategory(cats, 'offer'), 'Bezahlt')).toThrow(/Entwurf, Offen, Akzeptiert, Abgelehnt/);
    expect(findStatus(findCategory(cats, 'offer'), 'akzept').id).toBe(39);   // ohne Gross/Klein, als Praefix
  });

  it('findStatus meldet einen mehrdeutigen Praefix, statt still den ersten zu nehmen (Minor)', async () => {
    const cats = await loadCategories(buildContext(cfgCat, { fetchImpl: fCat }), undefined, 'SALES');
    const rechnung = findCategory(cats, 'invoice');
    // Die Rechnung kennt «Erinnert 1» UND «Erinnert 2» (Fixture order-category-list-type-SALES.json).
    // «Erinnert» traf bisher stillschweigend die erste — ein falscher Statusfilter ohne Meldung.
    expect(rechnung.statuses.filter((s) => s.name.startsWith('Erinnert')).map((s) => s.name)).toEqual(['Erinnert 1', 'Erinnert 2']);
    expect(() => findStatus(rechnung, 'Erinnert')).toThrow(/mehrdeutig/);
    expect(() => findStatus(rechnung, 'Erinnert')).toThrow(/Erinnert 1, Erinnert 2/);
    // Eindeutiger Praefix geht weiter durch.
    expect(findStatus(rechnung, 'Erinnert 2').name).toBe('Erinnert 2');
  });

  it('findStatus nimmt den exakten Treffer, auch wenn er Praefix eines anderen ist (Minor)', () => {
    const cat = { id: 1, name: 'Test', type: 'SALES' as const, statuses: [
      { id: 10, name: 'Offen lang', raw: {} },
      { id: 11, name: 'Offen', raw: {} },
    ] };
    expect(findStatus(cat, 'Offen').id).toBe(11);
    expect(findStatus(cat, 'offen').id).toBe(11);
  });
});

// 0.3.2: order/read fuehrt kein dateDue, aber dueDays (gemessen 19.10.2026, M3: an allen 20 Belegen mit dueDays ist dateDue aus order/list =
// Datum + dueDays Kalendertage; ohne dueDays kein dateDue). get_order rechnet dueDate daraus.
describe('get_order 0.3.2: dueDate aus date + dueDays', () => {
  const lesen = async (feld: Record<string, unknown>) => {
    const q = JSON.parse(fixture('order-read')) as { data: Record<string, unknown> };
    const g = (async () => new Response(JSON.stringify({ ...q, data: { ...q.data, ...feld } }), { status: 200 })) as unknown as typeof fetch;
    const r = await getOrder(buildContext(cfg, { fetchImpl: g }), { org: 'nt', id: 55 });
    return (r.structuredContent as { dueDate: string | null }).dueDate;
  };
  it('ohne dateDue, dueDays 14 ab 2026-07-10: 2026-07-24', async () => { expect(await lesen({ dateDue: undefined, dueDays: 14 })).toBe('2026-07-24'); });
  it('über das Monatsende: 2026-07-25 + 10 = 2026-08-04', async () => { expect(await lesen({ date: '2026-07-25 00:00:00.0', dueDays: 10 })).toBe('2026-08-04'); });
  it('ohne dueDays: null', async () => { expect(await lesen({ dueDays: null })).toBeNull(); });
  it('dateDue vorhanden: es gilt', async () => { expect(await lesen({ dateDue: '2026-09-01 00:00:00.0', dueDays: 14 })).toBe('2026-09-01'); });
});

// 0.4.0 (24.10.2026): order/list liefert ohne fiscalPeriodId nur das aktuelle Geschaeftsjahr und offene Belege frueherer
// Jahre (gemessen beim Datenbau 2024 bis 2026). Eine Frage nach dem Umsatz 2024 kaeme sonst still fast leer zurueck.
describe('search_orders: Geschaeftsjahr', () => {
  it('reicht fiscalPeriodId durch und nennt es in der Antwort', async () => {
    urls.length = 0;
    const r = await searchOrders(buildContext(cfg, { fetchImpl: f }), { type: 'SALES', dateFrom: '2024-01-01', dateTo: '2024-12-31', fiscalPeriodId: 3 });
    expect(letzte('order/list').searchParams.get('fiscalPeriodId')).toBe('3');
    const s = r.structuredContent as Record<string, unknown>;
    expect(s.fiscalPeriodId).toBe(3);
    expect(s.hinweis).toBeUndefined();
  });
  it('mit Datumsfilter, aber ohne fiscalPeriodId: Hinweis auf list_fiscal_periods', async () => {
    urls.length = 0;
    const r = await searchOrders(buildContext(cfg, { fetchImpl: f }), { type: 'SALES', dateFrom: '2024-01-01' });
    expect(letzte('order/list').searchParams.has('fiscalPeriodId')).toBe(false);
    expect(String((r.structuredContent as Record<string, unknown>).hinweis)).toMatch(/list_fiscal_periods/);
  });
});
