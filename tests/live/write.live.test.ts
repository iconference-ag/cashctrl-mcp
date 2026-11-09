/**
 * Vertragstest gegen einen echten Mandanten — schreibend, raeumt hinter sich auf.
 *
 * Lauf (aus dem Paketordner, Mandant und Schluessel wie in `tests/live/mandant.ts`):
 *   CASHCTRL_LIVE=1 CASHCTRL_LIVE_WRITE=1 npx vitest run tests/live/write.live.test.ts
 *
 * **Der Lauf legt echte Datensaetze im Mandanten an**, alle mit dem Praefix `MCP-TEST`, und loescht sie
 * am Ende wieder (Offerte ueber `delete_order`, Kontakt ueber den allgemeinen Schreibweg). Scheitert das
 * Aufraeumen, stehen die Kennungen im Protokoll (stderr) und sind von Hand in CashCtrl zu entfernen.
 *
 * Zweite Position mit Absicht rundungsempfindlich: 1.73 netto zu 8.1 % ergibt brutto 1.87013,
 * vierstellig gerundet 1.8701. Damit misst der Lauf, wie CashCtrl vierstellige Bruttopreise
 * auf das Belegtotal bringt — die Zahlen gehen ins Protokoll, nicht nur in die Zusicherung.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolset, type Toolset } from '../../src/toolset.js';
import { liveOrg } from './mandant.js';

const live = process.env.CASHCTRL_LIVE === '1' && process.env.CASHCTRL_LIVE_WRITE === '1';
const DIR = join(tmpdir(), 'cashctrl-mcp-live');
let t: Toolset;
/** Was der Lauf angelegt hat; afterAll baut es wieder ab. */
const angelegt: { orderId?: number; contactId?: number } = {};

beforeAll(() => {
  if (!live) return;
  t = createToolset({ mode: 'full', pdfDir: DIR, usageFile: join(DIR, 'usage.json'), source: 'env', orgs: [liveOrg({ deleteOrders: true, deleteRecords: true })] });
});

afterAll(async () => {
  if (!live) return;
  console.error(`[live] Abbau: Offerte ${String(angelegt.orderId)}, Kontakt ${String(angelegt.contactId)}`);
  const zweistufig = async (art: string, args: Record<string, unknown>) => {
    const p = await t.call(`prepare_${art}`, args);
    expect(p.isError, JSON.stringify(p.content)).toBeFalsy();
    const { token } = p.structuredContent as { token: string };
    expect((await t.call(`commit_${art}`, { token })).isError).toBeFalsy();
  };
  // Die Offerte bucht nicht, auch im Status Akzeptiert: delete_order nimmt sie ohne Statuswechsel.
  if (angelegt.orderId !== undefined) {
    await zweistufig('delete_order', { orderId: angelegt.orderId });
    expect((await t.call('get_order', { id: angelegt.orderId })).isError, 'Offerte nach dem Loeschen noch lesbar').toBe(true);
  }
  if (angelegt.contactId !== undefined) {
    await zweistufig('api_write', { path: 'person/delete.json', params: { ids: String(angelegt.contactId) } });
    expect((await t.call('get_contact', { id: angelegt.contactId })).isError, 'Kontakt nach dem Loeschen noch lesbar').toBe(true);
  }
});

function daten<T>(r: { isError?: boolean; structuredContent?: unknown; content?: unknown }): T {
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  return r.structuredContent as T;
}
const token = (r: { structuredContent?: unknown }) => (r.structuredContent as { token: string }).token;

interface Position { name: string; qty: number; unitPriceNet: number; unitPriceGross: number; totalNet: number; totalGross: number }

describe.skipIf(!live)('Schreibwerkzeuge am Mandanten (Testdaten mit Praefix MCP-TEST, raeumt hinter sich auf)', () => {
  it('Kontakt anlegen, Offerte als Entwurf, Status auf Akzeptiert', async () => {
    // 1. Kontakt --------------------------------------------------------------
    const p1 = await t.call('prepare_contact', { company: 'MCP-TEST Muster AG', city: 'Zug', isCustomer: true });
    const v1 = daten<{ summary: string; warnings: string[] }>(p1);
    expect(v1.summary).toContain('MCP-TEST Muster AG');
    const c1 = daten<{ id: number }>(await t.call('commit_contact', { token: token(p1) }));
    const contactId = c1.id;
    angelegt.contactId = contactId;
    expect(contactId).toBeGreaterThan(0);
    console.error(`[live] Kontakt angelegt: ID ${contactId}`);

    // 2. Offerte als Entwurf ---------------------------------------------------
    // defaultAccountNumber ist Pflicht: die Positionen haben keinen Artikel, und ein Artikel
    // traegt im Mandanten ohnehin kein salesAccountId. 3000 = Produktionsertrag.
    const p2 = await t.call('prepare_order_draft', {
      category: 'offer', contactId, defaultAccountNumber: '3000',
      items: [
        { name: 'MCP-TEST Beratung', qty: 2, unitPriceNet: 480, taxCode: 'UN1' },
        { name: 'MCP-TEST Rundung', qty: 1, unitPriceNet: 1.73, taxCode: 'UN1' },
      ],
    });
    const v2 = daten<{ summary: string; warnings: string[] }>(p2);
    console.error(`[live] Vorschau prepare_order_draft:\n${v2.summary}`);
    // 2 x 518.88 = 1037.76 und 1 x 1.8701 = 1.87 ergeben nach unserer Regel 1039.63 brutto.
    expect(v2.summary).toContain('Total netto 961.73, MWST 77.90, brutto 1039.63');

    const c2 = daten<{ id: number; nr: unknown; warnings: string[] }>(await t.call('commit_order_draft', { token: token(p2) }));
    const orderId = c2.id;
    angelegt.orderId = orderId;
    console.error(`[live] Offerte angelegt: ID ${orderId}, Nummer ${String(c2.nr)}`);

    // 3. Rundungsmessung am angelegten Beleg ----------------------------------
    const o = daten<{ status: string; total: number; items: Position[] }>(await t.call('get_order', { id: orderId }));
    for (const i of o.items) {
      console.error(`[live] Position «${i.name}»: qty ${i.qty}, netto ${i.unitPriceNet}, brutto/Stueck ${i.unitPriceGross}, Zeilentotal brutto ${i.totalGross}`);
    }
    console.error(`[live] Belegtotal laut CashCtrl: ${o.total} (Vorschau des Servers: 1039.63)`);

    const beratung = o.items.find((i) => i.name === 'MCP-TEST Beratung');
    expect(beratung, 'Position «MCP-TEST Beratung» fehlt am Beleg').toBeTruthy();
    expect(beratung!.unitPriceNet).toBeCloseTo(480, 2);      // Brutto-Falle geloest: netto bleibt netto
    expect(beratung!.unitPriceGross).toBeCloseTo(518.88, 2);
    // Vertrag «Belegtotal = Summe aus Menge x Bruttostueckpreis». Schlaegt das fehl, rundet
    // CashCtrl vierstellige Bruttopreise anders als der Server — das ist der Befund, nicht der Test.
    expect(o.total, 'Belegtotal weicht von der Vorschau ab — Rundung vierstelliger Bruttopreise pruefen').toBeCloseTo(1039.63, 2);
    expect(o.status).toMatch(/Entwurf/);

    // 4. Status auf Akzeptiert -------------------------------------------------
    const p3 = await t.call('prepare_order_status', { orderId, status: 'Akzeptiert' });
    const v3 = daten<{ summary: string }>(p3);
    expect(v3.summary).toContain('Akzeptiert');
    const c3 = daten<{ status: string }>(await t.call('commit_order_status', { token: token(p3) }));
    expect(c3.status).toMatch(/Akzeptiert/);

  });

  it('commit ohne gueltiges Token schlaegt fehl', async () => {
    // Attrappe absichtlich kurz: ein laengerer Wert nach `token:` schlaegt im Secret-Scan an.
    const r = await t.call('commit_contact', { token: 'nix' });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('Token');
  });
});
