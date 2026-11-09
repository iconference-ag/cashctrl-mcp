import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolset } from '../../src/toolset.js';
import { kontenListe } from '../helpers/konten.js';
import { orderDraftModule, computeItems, toOrderItems } from '../../src/tools/draft/order.js';
import { heute } from '../../src/tools/result.js';
import type { Config } from '../../src/config/config.js';
/** Argumente fuer commit_* aus einer prepare-Antwort (destrukturiert, wie die uebrigen Tests; der Secret-Scan des Repos schlaegt sonst auf `token: (…)` an). */
const mitTok = (r: { structuredContent?: unknown }) => { const { token } = r.structuredContent as { token: string }; return { token }; };

const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8');

const taxes = [{ id: 9, name: 'UN1', rate: 8.1 }, { id: 13, name: 'VN1', rate: 8.1 }, { id: 12, name: 'V0I', rate: 0 }];
describe('computeItems', () => {
  it('rechnet brutto je Position und die Totale (gemessene Falle: unitPrice ist brutto)', () => {
    const r = computeItems([{ name: 'Beratung', qty: 2, unitPriceNet: 480, taxCode: 'UN1' }, { name: 'Import', qty: 1, unitPriceNet: 100, taxCode: 'V0I' }], taxes);
    expect(r.lines[0]).toMatchObject({ unitPriceGross: 518.88, taxCode: 'UN1', rate: 8.1, totalNet: 960, totalGross: 1037.76 });
    expect(r.lines[1]).toMatchObject({ unitPriceGross: 100, taxCode: 'V0I', rate: 0, totalNet: 100 });
    expect(r).toMatchObject({ totalNet: 1060, totalTax: 77.76, totalGross: 1137.76 });
  });
  it('rundet das Zeilentotal wie CashCtrl: Menge x Bruttopreis, nicht Nettototal x Satz', () => {
    // 1.73 netto zu 2.6 % -> Bruttopreis 1.775. CashCtrl rechnet 1 x 1.775 = 1.78,
    // die alte Formel round2(round2(1 x 1.73) x 1.026) haette 1.77 ergeben (1 Rappen zu wenig).
    const r = computeItems([{ name: 'x', qty: 1, unitPriceNet: 1.73, taxCode: 'T' }], [{ id: 1, name: 'T', rate: 2.6 }]);
    expect(r.lines[0].unitPriceGross).toBe(1.775);   // netToGross rundet auf 4 Dezimalen (src/core/money.ts)
    expect(r.lines[0].totalGross).toBe(1.78);
    expect(r.lines[0].totalNet).toBe(1.73);
    expect(r.lines[0].totalTax).toBe(0.05);
    expect(r).toMatchObject({ totalNet: 1.73, totalGross: 1.78, totalTax: 0.05 });
  });
  it('lehnt unbekannte Steuercodes mit Liste ab', () => {
    expect(() => computeItems([{ name: 'x', qty: 1, unitPriceNet: 1, taxCode: 'XX9' }], taxes)).toThrow(/UN1, VN1, V0I/);
  });
});

describe('computeItems: Steuer der Position (0.3.0, B6; M-1, 17.10.2026)', () => {
  // Gemessen M-1b/M-1b': CashCtrl setzt ueber die API ohne taxId keine Steuer, auch nicht die des Kontos.
  // Darum bestimmt der Server die Steuer und sendet sie ausdruecklich.
  it('ohne taxCode gilt die Steuer des Kontos (taxId 9 -> UN1 8.1 %), Brutto mit diesem Satz', () => {
    const r = computeItems([{ name: 'Beratung', qty: 1, unitPriceNet: 480, accountTaxId: 9, kontoLabel: '3400 Dienstleistungsertrag' }], taxes);
    expect(r.lines[0]).toMatchObject({ taxId: 9, taxCode: 'UN1', rate: 8.1, unitPriceGross: 518.88, taxQuelle: 'konto' });
  });
  it('Konto ohne Steuer (taxId null): keine taxId, Brutto = Netto, MWST 0', () => {
    const r = computeItems([{ name: 'Beratung', qty: 1, unitPriceNet: 480, accountTaxId: null }], taxes);
    expect(r.lines[0].taxId).toBeUndefined();
    expect(r.lines[0]).toMatchObject({ rate: 0, unitPriceGross: 480, taxQuelle: 'keine' });
    expect(r).toMatchObject({ totalNet: 480, totalTax: 0, totalGross: 480 });
  });
  it('ohne Angabe zum Konto (accountTaxId fehlt): ebenfalls keine Steuer, keine feste Vorgabe UN1', () => {
    const r = computeItems([{ name: 'x', qty: 1, unitPriceNet: 100 }], taxes);
    expect(r.lines[0].taxId).toBeUndefined();
    expect(r.lines[0].unitPriceGross).toBe(100);
  });
  it('mit taxCode gilt genau er, auch wenn das Konto eine andere Steuer fuehrt', () => {
    const r = computeItems([{ name: 'x', qty: 1, unitPriceNet: 100, taxCode: 'V0I', accountTaxId: 9 }], taxes);
    expect(r.lines[0]).toMatchObject({ taxId: 12, taxCode: 'V0I', rate: 0, taxQuelle: 'position' });
  });
  it('Konto nennt eine Steuer-ID, die tax/list nicht kennt: validation, nennt das Konto', () => {
    expect(() => computeItems([{ name: 'x', qty: 1, unitPriceNet: 1, accountTaxId: 77, kontoLabel: '3400 Dienstleistungsertrag' }], taxes)).toThrow(/3400.*77/);
  });
});

describe('computeItems mit Rabattzeile (0.2.1)', () => {
  const t81 = [{ id: 9, name: 'UN1', rate: 8.1 }];
  it('negative Position: Brutto und Totale symmetrisch, Total wie CashCtrl', () => {
    const r = computeItems([{ name: 'Beratung', qty: 1, unitPriceNet: 1000, taxCode: 'UN1' }, { name: 'Rabatt', qty: 1, unitPriceNet: -15, taxCode: 'UN1' }], t81);
    expect(r.lines[1].unitPriceGross).toBe(-16.215);
    expect(r.lines[1].totalGross).toBe(-16.22);
    expect(r.totalGross).toBe(1064.78);
    expect(r.totalNet).toBe(985);
  });
  it('Total unter 0 geht durch (0.3.0, B8; M-1d: CashCtrl nimmt -100 an, Total -100)', () => {
    const r = computeItems([{ name: 'Rabatt', qty: 1, unitPriceNet: -100, taxCode: 'UN1' }], t81);
    expect(r.totalGross).toBe(-108.1);
    const ohne = computeItems([{ name: 'plus', qty: 1, unitPriceNet: 100 }, { name: 'minus', qty: 1, unitPriceNet: -200 }], t81);
    expect(ohne.totalGross).toBe(-100);   // M-1d: ohne Steuer, Total -100
  });
});

describe('toOrderItems: Pflichtfelder der API (M-1a)', () => {
  // M-1a: CashCtrl laesst eine Position ohne name/unitPrice still fallen (200, Beleg ohne Positionen).
  const zusatz = [{ accountId: 43, accountLabel: '3400' }];
  const zeile = { articleId: undefined, articleNr: undefined, name: 'x', qty: 1, unitPriceNet: 1, unitPriceGross: 1, taxId: undefined, taxCode: '', rate: 0, totalNet: 1, totalGross: 1, totalTax: 0, taxQuelle: 'keine' as const };
  it('Position mit name und unitPrice geht durch', () => {
    expect(toOrderItems({ lines: [zeile], totalNet: 1, totalTax: 0, totalGross: 1 }, zusatz)[0]).toMatchObject({ name: 'x', unitPrice: 1, accountId: 43 });
  });
  it('ohne name: validation', () => {
    expect(() => toOrderItems({ lines: [{ ...zeile, name: '' }], totalNet: 1, totalTax: 0, totalGross: 1 }, zusatz)).toThrow(/name/);
  });
  it('ohne unitPrice (NaN): validation', () => {
    expect(() => toOrderItems({ lines: [{ ...zeile, unitPriceGross: Number.NaN }], totalNet: 1, totalTax: 0, totalGross: 1 }, zusatz)).toThrow(/unitPrice/);
  });
});

describe('heute', () => {
  it('gibt das lokale Datum als YYYY-MM-DD, auch kurz nach Mitternacht', () => {
    // Lokale Mitternacht am 1. Januar: ueber toISOString() waere das in der Schweiz noch der Vortag.
    expect(heute(new Date(2026, 0, 1, 0, 30))).toBe('2026-01-01');
    expect(heute(new Date(2026, 7, 28, 23, 45))).toBe('2026-08-28');
  });
});

const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-order-draft.json`);
const cfg = (mode: Config['mode']): Config => ({ mode, pdfDir: '/tmp/x', usageFile, source: 'env', orgs: [{ name: 'nt', subdomain: 'd', 'apiKey': 'k' }] });

afterAll(async () => { await rm(usageFile, { force: true }); });

// Entwurfsstatus der Offerte kommt aus der Fixture, nicht aus einer festen Zahl im Test.
const salesCats = (JSON.parse(fixture('order-category-list-type-SALES')) as { data: { id: number; status: { id: number; name: string }[] }[] }).data;
const entwurfOfferte = salesCats.find((c) => c.id === 2)!.status.find((s) => s.name.includes('<de>Entwurf</de>'))!.id;
const doc = (JSON.parse(fixture('order-document-read')) as { data: Record<string, unknown> }).data;

let createBody = '';
let updateBody = '';
const artikel2 = JSON.stringify({ success: true, data: { id: 2, nr: 'A-02', name: 'Pflanzwand-Modul 120x60 cm', description: 'Modul', unitId: 4, salesAccountId: null } });
const json = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.includes('order/category/list')) return json(fixture('order-category-list-type-SALES'));
  if (u.includes('person/read')) return json(fixture('person-read'));
  if (u.includes('tax/list')) return json(fixture('tax-list'));
  if (u.includes('currency/list')) return json(fixture('currency-list'));
  if (u.includes('account/bank/list')) return json(fixture('account-bank-list'));
  if (u.includes('account/list')) return json(kontenListe());
  if (u.includes('inventory/article/read')) return json(artikel2);
  if (u.includes('order/create')) { createBody = String(init?.body ?? ''); return json(JSON.stringify({ success: true, insertId: 99 })); }
  if (u.includes('location/list')) return json(fixture('location-list'));
  if (u.includes('order/document/read')) return json(fixture('order-document-read'));
  if (u.includes('order/document/update')) { updateBody = String(init?.body ?? ''); return json(JSON.stringify({ success: true })); }
  if (u.includes('order/read')) return json(fixture('order-read'));
  return json('{}');
}) as unknown as typeof fetch;

// Derselbe Artikel, aber mit eigenem Ertragskonto (id 15 = 3000) statt salesAccountId null.
const artikelMitKonto = JSON.stringify({ success: true, data: { id: 2, nr: 'A-02', name: 'Pflanzwand-Modul 120x60 cm', unitId: 4, salesAccountId: 15 } });
const fetchArtikelKonto = (async (url: string | URL, init?: RequestInit) => {
  if (String(url).includes('inventory/article/read')) return json(artikelMitKonto);
  return fetchImpl(url as string, init);
}) as unknown as typeof fetch;

/**
 * Zwei Standorte und zwei Bankkonten, der DUPLIZIERTE Eintrag (id 2) steht vorn. So trennt der
 * Test die beiden Regeln: steht im Dokument ein Wert (id 1), muss er gewinnen — nicht der erste
 * Listeneintrag (id 2). Fehlt er, greift der erste Eintrag (id 2).
 */
const zweiVon = (name: string, ersatz: Record<string, unknown>) => {
  const l = JSON.parse(fixture(name)) as { data: Record<string, unknown>[]; total: number };
  l.data = [{ ...l.data[0], ...ersatz }, l.data[0]];
  l.total = 2;
  return JSON.stringify(l);
};
const zweiStandorte = zweiVon('location-list', { id: 2, name: 'Filiale Bern' });
const zweiBanken = zweiVon('account-bank-list', { id: 2, name: 'Zweitbank' });
const dokOhneAbsender = (() => {
  const d = JSON.parse(fixture('order-document-read')) as { data: Record<string, unknown> };
  d.data.orgLocationId = null; d.data.orgBankAccountId = null;
  return JSON.stringify(d);
})();
const fetchMehrere = (dok: string) => (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.includes('location/list')) return json(zweiStandorte);
  if (u.includes('account/bank/list')) return json(zweiBanken);
  if (u.includes('order/document/read')) return json(dok);
  return fetchImpl(url as string, init);
}) as unknown as typeof fetch;

// PURCHASE-Kategorien haben in der Rechnung keinen Entwurfsstatus (Vertrag, tests/fixtures/README.md).
const fetchPurchase = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.includes('order/category/list')) return json(fixture('order-category-list-type-PURCHASE'));
  return fetchImpl(url as string, init);
}) as unknown as typeof fetch;

const text = (r: { content?: unknown[] }) => {
  const c = r.content?.[0];
  return c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '';
};

describe('prepare_order_draft / commit_order_draft (Stufe draft)', () => {
  it('Vorschau nennt Kategorie, Kontakt, Konto je Position, Datum und die Totale netto/MWST/brutto', async () => {
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [orderDraftModule] });
    const r = await t.call('prepare_order_draft', {
      category: 'offer', contactId: 7, defaultAccountNumber: '3000',
      items: [{ articleId: 2, qty: 2, unitPriceNet: 890 }, { name: 'Beratung', qty: 1, unitPriceNet: 100, taxCode: 'V0I' }],
    });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as { summary: string; warnings: string[] };
    expect(s.summary).toContain('Offerte');
    expect(s.summary).toContain('Aare Energie GmbH');
    expect(s.summary).toContain('3000');
    expect(s.summary).toContain('Pflanzwand-Modul 120x60 cm');
    expect(s.summary).toContain(`Datum ${heute()}`);
    // Nachgerechnet: 2 x 890 netto = 1780.00 (brutto 1924.18 bei 8.1 %), + 100.00 zu 0 % ->
    // Total netto 1880.00, MWST 144.18, brutto 2024.18.
    expect(s.summary).toContain('Total netto 1880.00, MWST 144.18, brutto 2024.18');
    expect(s.warnings).toEqual([]);
  });

  it('Vorschau nennt Positionstext und Notizen — das, was commit mitsendet (R7)', async () => {
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [orderDraftModule] });
    const r = await t.call('prepare_order_draft', {
      category: 'offer', contactId: 7, defaultAccountNumber: '3000', notes: 'Lieferung\nab Lager Zug',
      items: [
        { articleId: 2, qty: 2, unitPriceNet: 890 },                                        // erbt «Modul» vom Artikel
        { name: 'Beratung', description: 'Workshop vor Ort, ' + 'y'.repeat(100), qty: 1, unitPriceNet: 100 },
      ],
    });
    expect(r.isError).toBeFalsy();
    const { summary } = r.structuredContent as { summary: string };
    // Position 1: Beschreibung kommt aus dem Artikel und wurde bisher nicht angezeigt.
    expect(summary).toContain('Pflanzwand-Modul 120x60 cm (Modul)');
    // Position 2: eigene Beschreibung, auf 80 Zeichen gekuerzt.
    const zeile = summary.split('\n').find((z) => z.includes('Beratung'))!;
    expect(zeile).toContain('Workshop vor Ort, ');
    expect(zeile).toContain('…');
    expect(/\(.{80}…\)/.test(zeile)).toBe(true);
    // Notizen gehen mit an CashCtrl, Zeilenumbruch einzeilig.
    expect(summary).toContain('Notizen: Lieferung⏎ab Lager Zug');
  });

  it('ohne defaultAccountNumber und ohne accountNumber: isError mit Hinweis auf das fehlende Konto', async () => {
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [orderDraftModule] });
    const r = await t.call('prepare_order_draft', { category: 'offer', contactId: 7, items: [{ name: 'Beratung', qty: 1, unitPriceNet: 100 }] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Ertrags-/Aufwandkonto fehlt');
  });

  it('unbekannter Steuercode: isError mit der Liste der vorhandenen Codes', async () => {
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [orderDraftModule] });
    const r = await t.call('prepare_order_draft', { category: 'offer', contactId: 7, defaultAccountNumber: '3000', items: [{ name: 'Beratung', qty: 1, unitPriceNet: 100, taxCode: 'XX9' }] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('XX9');
    expect(text(r)).toContain('UN1');
    expect(text(r)).toContain('V0I');
  });

  it('commit legt den Beleg an und haengt Standort und Bankkonto ans Dokument; zweiter Aufruf mit demselben Token schlaegt fehl', async () => {
    createBody = ''; updateBody = '';
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [orderDraftModule] });
    const prep = await t.call('prepare_order_draft', {
      category: 'offer', contactId: 7, defaultAccountNumber: '3000',
      items: [{ articleId: 2, qty: 2, unitPriceNet: 890 }, { name: 'Beratung', qty: 1, unitPriceNet: 100, taxCode: 'V0I' }],
    });
    expect(prep.isError).toBeFalsy();
    const { token } = prep.structuredContent as { token: string };

    const commit = await t.call('commit_order_draft', { token });
    expect(commit.isError).toBeFalsy();
    expect((commit.structuredContent as { id: number }).id).toBe(99);

    const p = new URLSearchParams(createBody);
    expect(p.get('categoryId')).toBe('2');
    expect(p.get('associateId')).toBe('7');
    expect(p.get('statusId')).toBe(String(entwurfOfferte));
    expect(p.get('date')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const items = JSON.parse(p.get('items')!) as Record<string, unknown>[];
    // unitPrice ist BRUTTO: 890 netto zu 8.1 % = 962.09.
    expect(items[0]).toMatchObject({ accountId: 15, name: 'Pflanzwand-Modul 120x60 cm', unitPrice: 962.09, quantity: 2, taxId: 9, inventoryId: 2, articleNr: 'A-02', unitId: 4 });
    expect(items[0].type).toBeUndefined();
    // Ohne eigene description erbt die Position die Beschreibung des Artikels.
    expect(items[0].description).toBe('Modul');
    expect(items[1]).toMatchObject({ accountId: 15, name: 'Beratung', unitPrice: 100, quantity: 1, taxId: 12 });
    expect(items[1].description).toBeUndefined();

    const u = new URLSearchParams(updateBody);
    expect(u.get('id')).toBe('99');
    expect(u.get('orgLocationId')).toBe('1');
    expect(u.get('orgBankAccountId')).toBe('1');
    expect(u.get('layoutId')).toBe(String(doc.layoutId));
    expect(u.get('language')).toBe(String(doc.language));
    expect(u.get('recipientAddressId')).toBe(String(doc.recipientAddressId));
    expect(u.get('isDisplayItemGross')).toBe(String(doc.isDisplayItemGross));

    const again = await t.call('commit_order_draft', { token });
    expect(again.isError).toBe(true);
  });

  it('Konto-Reihenfolge: Ertragskonto des Artikels ohne defaultAccountNumber, accountNumber der Position sticht es', async () => {
    createBody = '';
    const t = createToolset(cfg('draft'), { fetchImpl: fetchArtikelKonto, modules: [orderDraftModule] });
    const prep = await t.call('prepare_order_draft', {
      category: 'offer', contactId: 7,
      items: [{ articleId: 2, qty: 1, unitPriceNet: 890 }, { articleId: 2, qty: 1, unitPriceNet: 890, accountNumber: '4200' }],
    });
    expect(prep.isError).toBeFalsy();
    const s = prep.structuredContent as { summary: string; token: string };
    expect(s.summary).toContain('Konto 3000 Produktionsertrag');
    expect(s.summary).toContain('Konto 4200 Warenaufwand');
    const { token } = s;
    const commit = await t.call('commit_order_draft', { token });
    expect(commit.isError).toBeFalsy();
    const items = JSON.parse(new URLSearchParams(createBody).get('items')!) as { accountId: number }[];
    expect(items.map((i) => i.accountId)).toEqual([15, 45]);
  });

  it('mehrere Standorte und Bankkonten: das Dokument behaelt seinen Absender, dazu je eine Warnung', async () => {
    updateBody = '';
    const t = createToolset(cfg('draft'), { fetchImpl: fetchMehrere(fixture('order-document-read')), modules: [orderDraftModule] });
    const prep = await t.call('prepare_order_draft', { category: 'offer', contactId: 7, defaultAccountNumber: '3000', items: [{ name: 'Beratung', qty: 1, unitPriceNet: 100 }] });
    const { token } = prep.structuredContent as { token: string };
    const commit = await t.call('commit_order_draft', { token });
    expect(commit.isError).toBeFalsy();
    const u = new URLSearchParams(updateBody);
    // Im Dokument stehen 1 und 1 — der erste Listeneintrag waere je 2 gewesen.
    expect(u.get('orgLocationId')).toBe('1');
    expect(u.get('orgBankAccountId')).toBe('1');
    const w = (commit.structuredContent as { warnings: string[] }).warnings;
    expect(w).toContain('Mehrere Standorte — gesetzt: Hauptsitz Zug');
    expect(w.some((x) => x.startsWith('Mehrere Bankkonten — gesetzt: Zuger Seeblick'))).toBe(true);
  });

  it('Dokument ohne Absender: erster Standort und erstes Bankkonto', async () => {
    updateBody = '';
    const t = createToolset(cfg('draft'), { fetchImpl: fetchMehrere(dokOhneAbsender), modules: [orderDraftModule] });
    const prep = await t.call('prepare_order_draft', { category: 'offer', contactId: 7, defaultAccountNumber: '3000', items: [{ name: 'Beratung', qty: 1, unitPriceNet: 100 }] });
    const { token } = prep.structuredContent as { token: string };
    const commit = await t.call('commit_order_draft', { token });
    expect(commit.isError).toBeFalsy();
    const u = new URLSearchParams(updateBody);
    expect(u.get('orgLocationId')).toBe('2');
    expect(u.get('orgBankAccountId')).toBe('2');
    expect((commit.structuredContent as { warnings: string[] }).warnings).toContain('Mehrere Standorte — gesetzt: Filiale Bern');
  });

  it('ein Standort und ein Bankkonto: keine Warnung', async () => {
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [orderDraftModule] });
    const prep = await t.call('prepare_order_draft', { category: 'offer', contactId: 7, defaultAccountNumber: '3000', items: [{ name: 'Beratung', qty: 1, unitPriceNet: 100 }] });
    const { token } = prep.structuredContent as { token: string };
    const commit = await t.call('commit_order_draft', { token });
    expect((commit.structuredContent as { warnings: string[] }).warnings).toEqual([]);
  });

  it('Einkaufsrechnung: Warnung, weil die Kategorie keinen Entwurfsstatus kennt', async () => {
    const t = createToolset(cfg('draft'), { fetchImpl: fetchPurchase, modules: [orderDraftModule] });
    const r = await t.call('prepare_order_draft', { category: 'purchase_invoice', contactId: 7, items: [{ name: 'Wareneinkauf', qty: 1, unitPriceNet: 100, accountNumber: '4200' }] });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as { warnings: string[] };
    expect(s.warnings[0]).toContain('keinen Entwurfsstatus');
  });

  it('Steuer (0.3.0, B6): Vorschau nennt die Quelle; Konto ohne Steuer -> «ohne Steuer (Konto führt keine)», keine taxId, Brutto = Netto', async () => {
    createBody = '';
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [orderDraftModule] });
    const mit = await t.call('prepare_order_draft', { category: 'offer', contactId: 7, defaultAccountNumber: '3000', items: [{ name: 'Beratung', qty: 1, unitPriceNet: 480 }] });
    expect((mit.structuredContent as { summary: string }).summary).toContain('Steuer vom Konto 3000');
    const ohne = await t.call('prepare_order_draft', { category: 'offer', contactId: 7, defaultAccountNumber: '3400', items: [{ name: 'Beratung', qty: 1, unitPriceNet: 480 }] });
    const { summary, token } = ohne.structuredContent as { summary: string; token: string };
    expect(summary).toContain('ohne Steuer (Konto führt keine)');
    expect(summary).toContain('Total netto 480.00, MWST 0.00, brutto 480.00');
    await t.call('commit_order_draft', { token });
    const item = (JSON.parse(new URLSearchParams(createBody).get('items')!) as Record<string, unknown>[])[0];
    expect(item.unitPrice).toBe(480);
    expect(item).not.toHaveProperty('taxId');
  });

  it('Waehrung (0.3.0, B1): currency EUR sendet currencyId=2; unbekannter Code XYZ ist validation', async () => {
    createBody = '';
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [orderDraftModule] });
    const args = { category: 'offer', contactId: 7, defaultAccountNumber: '3000', items: [{ name: 'Beratung', qty: 1, unitPriceNet: 100 }] };
    const prep = await t.call('prepare_order_draft', { ...args, currency: 'EUR' });
    expect(prep.isError, JSON.stringify(prep.content)).toBeFalsy();
    expect((prep.structuredContent as { summary: string }).summary).toContain('EUR');
    await t.call('commit_order_draft', mitTok(prep));
    expect(new URLSearchParams(createBody).get('currencyId')).toBe('2');
    const falsch = await t.call('prepare_order_draft', { ...args, currency: 'XYZ' });
    expect(falsch.isError).toBe(true);
    expect(JSON.stringify(falsch.content)).toContain('CashCtrl führt die Währung XYZ nicht');
  });

  it('Modus read: prepare_order_draft/commit_order_draft gibt es nicht', () => {
    expect(createToolset(cfg('read'), { modules: [orderDraftModule] }).names()).toEqual([]);
  });
});
