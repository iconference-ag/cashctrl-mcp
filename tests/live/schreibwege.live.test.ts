/**
 * Vertragstest gegen einen echten Mandanten — schreibend, raeumt hinter sich auf.
 *
 * Lauf (aus dem Paketordner, Mandant und Schluessel wie in `tests/live/mandant.ts`):
 *   CASHCTRL_LIVE=1 CASHCTRL_LIVE_WRITE=1 npx vitest run tests/live/schreibwege.live.test.ts
 *
 * Misst die drei Schreibwege, die bis 0.4.0 nur gegen aufgezeichnete Antworten liefen:
 * `article`, `journal_entry` und `payment` (Teilzahlung und Restzahlung). Jeder Fall liest das
 * Ergebnis in CashCtrl nach und loescht danach, was er angelegt hat: den Beleg ueber
 * `delete_order` (Schalter `deleteOrders`), alles andere ueber den allgemeinen Schreibweg
 * (`prepare_api_write` / `commit_api_write`, Schalter `deleteRecords`). Damit laufen auch vier
 * Loesch-Endpunkte des allgemeinen Wegs einmal gegen die echte API.
 *
 * Alles traegt das Praefix `MCP-TEST`. Scheitert ein Fall mittendrin, stehen die angelegten
 * Kennungen im Protokoll (stderr) und sind von Hand in CashCtrl zu entfernen.
 *
 * Annahmen ueber den Mandanten: Kontenrahmen KMU (1000 Kasse, 1020 Bank, 3000 Ertrag),
 * Steuercode UN1, Rechnung mit Status 16 «Offen» (bucht) und 12 «Entwurf» (bucht nicht).
 *
 * Mandant und Schluessel kommen aus der Umgebung, siehe `tests/live/mandant.ts`
 * (CASHCTRL_LIVE_SUBDOMAIN, dazu CASHCTRL_LIVE_API_KEY oder CASHCTRL_LIVE_KEYCHAIN).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolset, type Toolset } from '../../src/toolset.js';
import { liveOrg } from './mandant.js';

const live = process.env.CASHCTRL_LIVE === '1' && process.env.CASHCTRL_LIVE_WRITE === '1';
const DIR = join(tmpdir(), 'cashctrl-mcp-live');
const STATUS_OFFEN = 16;
const STATUS_ENTWURF = 12;
const heute = new Date().toISOString().slice(0, 10);
const stempel = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
let t: Toolset;

beforeAll(() => {
  if (!live) return;
  t = createToolset({ mode: 'full', pdfDir: DIR, usageFile: join(DIR, 'usage.json'), source: 'env', orgs: [liveOrg({ deleteOrders: true, deleteRecords: true })] });
});

type Antwort = { isError?: boolean; structuredContent?: unknown; content?: unknown };
const log = (s: string) => console.error(`[live] ${s}`);
function daten<T>(r: Antwort): T {
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  return r.structuredContent as T;
}
/** prepare, Vorschau ins Protokoll, commit. Liefert Vorschau und Ergebnis. */
async function zweistufig<T>(art: string, args: Record<string, unknown>): Promise<{ vorschau: { summary: string; warnings: string[]; orgName?: string }; ergebnis: T }> {
  const p = await t.call(`prepare_${art}`, args);
  const vorschau = daten<{ summary: string; warnings: string[]; orgName?: string; token: string }>(p);
  log(`Vorschau ${art}: ${vorschau.summary.replace(/\n/g, ' | ')}${vorschau.warnings.length ? ' — Warnungen: ' + vorschau.warnings.join(' | ') : ''}`);
  const { token } = vorschau;
  const ergebnis = daten<T>(await t.call(`commit_${art}`, { token }));
  return { vorschau, ergebnis };
}
/** Loeschen ueber den allgemeinen Schreibweg. */
async function loeschen(path: string, ids: number[]): Promise<void> {
  const { ergebnis } = await zweistufig<unknown>('api_write', { path, params: { ids: ids.join(',') } });
  log(`geloescht ${path} ${ids.join(',')}: ${JSON.stringify(ergebnis).slice(0, 200)}`);
}
async function lesen<T>(path: string, params: Record<string, unknown>): Promise<T> {
  const r = daten<{ body: string }>(await t.call('api_read', { path, params }));
  return JSON.parse(r.body) as T;
}
interface Kennzahlen { profit: number; assets: number; liabilities: number; openReceivables: { count: number; sum: number } }
const kennzahlen = async () => daten<Kennzahlen>(await t.call('financial_summary', {}));

describe.skipIf(!live)('Schreibwege Artikel, Buchung, Zahlung am Mandanten (raeumt hinter sich auf)', () => {
  it('Artikel anlegen, nachlesen, loeschen', async () => {
    const name = `MCP-TEST Artikel ${stempel}`;
    const nr = `MCP-TEST-${stempel}`;
    const { vorschau, ergebnis } = await zweistufig<{ id: number }>('article', { nr, name, salesPriceNet: 12.5, purchasePriceNet: 7.25 });
    // Am echten Mandanten: die Vorschau nennt die Firma aus CashCtrl, nicht nur den Namen aus der Konfiguration.
    const firma = daten<{ orgs: { orgName: string }[] }>(await t.call('list_orgs', {})).orgs[0]!.orgName;
    expect(firma).not.toBe('');
    expect(vorschau.orgName).toBe(firma);
    expect(vorschau.summary).toContain(`Organisation: ${firma} (nt)`);
    const id = ergebnis.id;
    log(`Artikel angelegt: ID ${id}`);
    try {
      const a = daten<Record<string, unknown>>(await t.call('get_article', { id }));
      log(`Artikel gelesen: ${JSON.stringify(a)}`);
      expect(a.name).toBe(name);
      expect(a.nr).toBe(nr);
      expect(Number(a.salesPriceNet)).toBeCloseTo(12.5, 2);
      expect(Number(a.purchasePriceNet)).toBeCloseTo(7.25, 2);
      const roh = await lesen<{ data: Record<string, unknown> }>('inventory/article/read.json', { id });
      log(`Artikel roh: salesPrice ${String(roh.data.salesPrice)}, lastPurchasePrice ${String(roh.data.lastPurchasePrice)}, unitId ${String(roh.data.unitId)}, isStockArticle ${String(roh.data.isStockArticle)}`);
      expect(Number(roh.data.lastPurchasePrice)).toBeCloseTo(7.25, 2);
    } finally {
      await loeschen('inventory/article/delete.json', [id]);
    }
    const weg = await t.call('get_article', { id });
    expect(weg.isError, 'Artikel nach dem Loeschen noch lesbar').toBe(true);
  });

  it('Buchung ohne und mit Steuercode anlegen, nachlesen, loeschen; Kennzahlen danach wie vorher', async () => {
    const vorher = await kennzahlen();
    const ids: number[] = [];
    try {
      // 1. Umbuchung Kasse an Bank, ohne Steuer: beruehrt den Erfolg nicht.
      const b1 = await zweistufig<{ id: number }>('journal_entry', { date: heute, title: `MCP-TEST Umbuchung ${stempel}`, debitAccount: '1000', creditAccount: '1020', amount: 1.23, reference: 'MCP-TEST' });
      ids.push(b1.ergebnis.id);
      const r1 = (await lesen<{ data: Record<string, unknown> }>('journal/read.json', { id: b1.ergebnis.id })).data;
      log(`Buchung 1 roh: dateAdded ${String(r1.dateAdded)}, amount ${String(r1.amount)}, debitId ${String(r1.debitId)}, creditId ${String(r1.creditId)}, taxId ${String(r1.taxId)}, reference ${String(r1.reference)}, title ${String(r1.title)}`);
      expect(Number(r1.amount)).toBeCloseTo(1.23, 2);
      expect(String(r1.dateAdded).slice(0, 10)).toBe(heute);
      expect(r1.reference).toBe('MCP-TEST');

      // 2. Ertragsbuchung Bank an 3000 mit UN1: misst, was CashCtrl aus Betrag und Steuer macht.
      const b2 = await zweistufig<{ id: number }>('journal_entry', { date: heute, title: `MCP-TEST Ertrag ${stempel}`, debitAccount: '1020', creditAccount: '3000', amount: 108.1, taxCode: 'UN1', reference: 'MCP-TEST' });
      ids.push(b2.ergebnis.id);
      const r2 = (await lesen<{ data: Record<string, unknown> }>('journal/read.json', { id: b2.ergebnis.id })).data;
      log(`Buchung 2 roh: amount ${String(r2.amount)}, taxId ${String(r2.taxId)}, taxName ${String(r2.taxName)}, debitId ${String(r2.debitId)}, creditId ${String(r2.creditId)}`);
      expect(Number(r2.amount)).toBeCloseTo(108.1, 2);
      expect(r2.taxId, 'Steuer nicht an der Buchung').toBeTruthy();
      const mitte = await kennzahlen();
      log(`Erfolg vorher ${vorher.profit}, mit Buchung 2 ${mitte.profit}, Differenz ${(mitte.profit - vorher.profit).toFixed(2)} (108.10 brutto zu 8.1 % sind 100.00 netto)`);

      // Die Suche des Servers findet beide.
      const s = daten<{ items: { id: number }[] }>(await t.call('search_journal', { dateFrom: heute, dateTo: heute, query: 'MCP-TEST' }));
      expect(s.items.map((x) => x.id).sort()).toEqual([...ids].sort());
    } finally {
      if (ids.length) await loeschen('journal/delete.json', ids);
    }
    const nachher = await kennzahlen();
    log(`Kennzahlen vorher ${JSON.stringify(vorher)} | nachher ${JSON.stringify(nachher)}`);
    expect(nachher.profit).toBeCloseTo(vorher.profit, 2);
    expect(nachher.assets).toBeCloseTo(vorher.assets, 2);
  });

  it('Zahlung: Teilzahlung laesst den Status, Restzahlung setzt Bezahlt; danach restlos abgebaut', async () => {
    const vorher = await kennzahlen();
    let contactId: number | undefined; let orderId: number | undefined;
    try {
      contactId = (await zweistufig<{ id: number }>('contact', { company: `MCP-TEST Zahlung AG ${stempel}`, city: 'Zug', isCustomer: true })).ergebnis.id;
      const re = await zweistufig<{ id: number; nr: unknown }>('order_create', {
        category: 'invoice', statusId: STATUS_OFFEN, contactId, defaultAccountNumber: '3000', description: 'MCP-TEST Zahlung',
        items: [{ name: 'MCP-TEST Leistung', qty: 1, unitPriceNet: 100, taxCode: 'UN1' }],
      });
      orderId = re.ergebnis.id;
      const o0 = daten<{ total: number; open: number | null; status: string }>(await t.call('get_order', { id: orderId }));
      log(`Rechnung ${orderId} (${String(re.ergebnis.nr)}): total ${o0.total}, open ${String(o0.open)}, status ${o0.status}`);
      expect(o0.total).toBeCloseTo(108.1, 2);
      expect(Number(o0.open)).toBeCloseTo(108.1, 2);

      // 1. Teilzahlung 40.00: Status bleibt, 68.10 offen.
      const z1 = await zweistufig<{ paid: number; open: number; status: string; message: string }>('payment', { orderId, amount: 40, date: heute });
      log(`Teilzahlung: ${JSON.stringify(z1.ergebnis)}`);
      expect(z1.vorschau.warnings.join(' ')).toContain('Teilzahlung');
      expect(z1.ergebnis.open).toBeCloseTo(68.1, 2);
      expect(z1.ergebnis.status).not.toMatch(/Bezahlt/);

      // 2. Restzahlung ohne Betrag: nimmt den offenen Betrag, setzt Bezahlt.
      const z2 = await zweistufig<{ paid: number; open: number; status: string; message: string }>('payment', { orderId, date: heute });
      log(`Restzahlung: ${JSON.stringify(z2.ergebnis)}`);
      expect(z2.ergebnis.paid).toBeCloseTo(68.1, 2);
      expect(z2.ergebnis.open).toBeLessThanOrEqual(0);
      expect(z2.ergebnis.status).toMatch(/Bezahlt/);

      // 3. Nichts mehr offen: eine dritte Zahlung weist der Server schon in der Vorschau ab.
      const z3 = await t.call('prepare_payment', { orderId, date: heute });
      expect(z3.isError).toBe(true);
      expect(JSON.stringify(z3.content)).toContain('nichts offen');
    } finally {
      // Abbau: Zahlungen loeschen, Rechnung auf Entwurf (bucht nicht), loeschen, Kontakt loeschen.
      if (orderId !== undefined) {
        // Nur die Zahlungen (type MANUAL). Die Buchung der Rechnung selbst (type GENERATED) weist CashCtrl ab
        // («Diese Buchung kann nicht direkt gelöscht werden.», gemessen 09.11.2026), und zwar den ganzen Aufruf:
        // sie verschwindet mit dem Wechsel auf Entwurf.
        const buchungen = (await lesen<{ data: { id: number; type: string; amount: number }[] }>('order/bookentry/list.json', { id: orderId })).data;
        log(`Buchungen am Beleg: ${buchungen.map((b) => `${b.id} ${b.type} ${b.amount}`).join(', ')}`);
        const zahlungen = buchungen.filter((b) => b.type === 'MANUAL');
        if (zahlungen.length) await loeschen('order/bookentry/delete.json', zahlungen.map((z) => z.id));
        await zweistufig('order_status', { orderId, statusId: STATUS_ENTWURF });
        await zweistufig('delete_order', { orderId });
        expect((await t.call('get_order', { id: orderId })).isError, 'Rechnung nach dem Loeschen noch lesbar').toBe(true);
      }
      if (contactId !== undefined) {
        await loeschen('person/delete.json', [contactId]);
        expect((await t.call('get_contact', { id: contactId })).isError, 'Kontakt nach dem Loeschen noch lesbar').toBe(true);
      }
    }
    const nachher = await kennzahlen();
    log(`Kennzahlen vorher ${JSON.stringify(vorher)} | nachher ${JSON.stringify(nachher)}`);
    expect(nachher.profit).toBeCloseTo(vorher.profit, 2);
    expect(nachher.assets).toBeCloseTo(vorher.assets, 2);
    expect(nachher.openReceivables.count).toBe(vorher.openReceivables.count);
    expect(nachher.openReceivables.sum).toBeCloseTo(vorher.openReceivables.sum, 2);
  });
});
