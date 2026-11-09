import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ToolContext } from '../context.js';
import { tool, type ToolModule } from '../def.js';
import type { Rec } from '../../core/client.js';
import { CashCtrlError } from '../../core/errors.js';
import { pfadsicher } from '../../core/pdfstore.js';
import { ok, fail, OrgParam, clampLimit, page, shiftDay, IsoDatum, isoTag } from '../result.js';
import { loadCategories, findCategory, findStatus, de, type CategoryInfo, type CategoryKey } from './categories.js';

/** Hinweis an das Modell, wenn ein Datumsfilter ohne Geschaeftsjahr kam (search_orders, search_journal). */
export const HINWEIS_GESCHAEFTSJAHR = 'Ohne fiscalPeriodId liefert CashCtrl nur das aktuelle Geschäftsjahr (bei Belegen dazu offene früherer Jahre). Liegt der Zeitraum in einem anderen Jahr: fiscalPeriodId aus list_fiscal_periods angeben, je Jahr eine Abfrage.';

const SearchInput = z.object({
  org: OrgParam,
  type: z.enum(['SALES', 'PURCHASE']).describe('Verkauf (Offerten, Auftragsbestätigungen, Rechnungen) oder Einkauf'),
  category: z.enum(['offer', 'order_confirmation', 'invoice', 'purchase_invoice']).optional(),
  status: z.string().optional().describe('Statusname wie in CashCtrl, z.B. Offen, Bezahlt, Entwurf. Ohne category muss der Name in genau einer Kategorie vorkommen.'),
  contactId: z.number().int().optional(),
  dateFrom: IsoDatum.optional().describe('Belegdatum ab diesem Tag, inklusive (YYYY-MM-DD)'),
  dateTo: IsoDatum.optional().describe('Belegdatum bis zu diesem Tag, inklusive (YYYY-MM-DD)'),
  query: z.string().optional(),
  notes: z.string().optional().describe('Teilstring im Feld Notizen (like), z.B. ein eigener Schlüssel; mit den Datumsfiltern kombinierbar. Notizen sind HTML-escaped gespeichert: Schlüssel nur aus A-Z, a-z, 0-9 und -_:. bilden und jeden Treffer exakt nachprüfen'),
  previousOrderId: z.number().int().optional().describe('Nur Belege mit diesem Vorgänger im Dossier, z.B. Rechnungen zu einer Offerte; Treffer am Feld previousId nachprüfen'),
  onlyOpen: z.boolean().optional().describe('Nur offene (nicht abgeschlossene) Belege'),
  fiscalPeriodId: z.number().int().optional().describe('Geschäftsjahr (id aus list_fiscal_periods). Ohne Angabe liefert CashCtrl nur das aktuelle Geschäftsjahr und offene Belege früherer Jahre; für andere Jahre angeben'),
  limit: z.number().int().min(1).max(200).optional(),
});

/**
 * Feldnamen laut tests/fixtures/README.md (order/list): Kategoriename ist `nameSingular`
 * (in order/read heisst dasselbe Feld zusaetzlich `categoryName`), Kontaktname `associateName`,
 * Faelligkeit `dateDue`. `open` bleibt `null`, wenn der Beleg nicht bucht — nie zu 0 machen.
 */
export function compactOrder(r: Rec) {
  return { id: r.id, nr: r.nr, date: isoTag(r.date), category: de(r.nameSingular ?? r.categoryName), status: de(r.statusName), contactName: r.associateName, total: r.total, open: r.open, currency: r.currencyCode ?? null, currencyId: r.currencyId ?? null, dueDate: isoTag(r.dateDue), previousId: r.previousId ?? null };
}

/**
 * Status ohne Kategorie: derselbe Statusname existiert in mehreren Kategorien mit
 * verschiedenen IDs («Offen» ist in der Offerte 37, in der Auftragsbestaetigung 24).
 * Eine stille Auswahl des ersten Treffers wuerde falsch filtern, ein stilles Weglassen
 * bei unbekanntem Namen den Filter ganz verschwinden lassen — beides wird hier zum Fehler.
 */
function statusIdOverAll(cats: CategoryInfo[], wanted: string): number {
  const w = wanted.toLowerCase();
  const treffer = cats.filter((c) => c.statuses.some((s) => s.name.toLowerCase() === w));
  if (treffer.length === 0) {
    const vorhanden = cats.map((c) => `${c.name}: ${c.statuses.map((s) => s.name).join(', ')}`).join('; ');
    throw new CashCtrlError('validation', `Status «${wanted}» gibt es nicht. Vorhanden: ${vorhanden}`);
  }
  if (treffer.length > 1) throw new CashCtrlError('validation', `Status «${wanted}» gibt es in mehreren Kategorien — category angeben: ${treffer.map((c) => c.name).join(', ')}`);
  return findStatus(treffer[0], wanted).id;
}

export async function searchOrders(ctx: ToolContext, a: z.infer<typeof SearchInput>): Promise<CallToolResult> {
  try {
    let categoryId: number | undefined;
    let statusId: number | undefined;
    if (a.category || a.status) {
      const cats = await loadCategories(ctx, a.org, a.type);
      if (a.category) {
        const cat = findCategory(cats, a.category as CategoryKey);
        categoryId = cat.id;
        if (a.status) statusId = findStatus(cat, a.status).id;
      } else if (a.status) {
        statusId = statusIdOverAll(cats, a.status);
      }
    }
    // Datumsfilter: order/list filtert ueber das Feld `date` (tests/fixtures/README.md).
    // CashCtrls Vergleiche sind `eq, like, gt, lt` — kein `ge`/`le`. Fuer inklusive Grenzen
    // wird der Randtag deshalb um einen Tag nach aussen geschoben.
    const filter: unknown[] = [];
    if (a.dateFrom) filter.push({ field: 'date', comparison: 'gt', value: shiftDay(a.dateFrom, -1) });
    if (a.dateTo) filter.push({ field: 'date', comparison: 'lt', value: shiftDay(a.dateTo, 1) });
    // Filterfeld `notes`: laut Doku-Muster angenommen (wie `date`), am Mandanten NICHT gemessen (12.10.2026).
    // Der Wert wird roh gesendet; im Beleg steht `notes` HTML-escaped (order_create), ein Schluessel
    // sollte deshalb nur aus Buchstaben, Ziffern und -_:. bestehen.
    if (a.notes) filter.push({ field: 'notes', comparison: 'like', value: a.notes });
    // Filterfeld `previousId`: ebenso angenommen, NICHT gemessen (12.10.2026). Uebergeht CashCtrl ein
    // unbekanntes Filterfeld, kaemen alle Belege zurueck — darum traegt jeder Treffer `previousId`,
    // und der Aufrufer prueft daran nach.
    if (a.previousOrderId !== undefined) filter.push({ field: 'previousId', comparison: 'eq', value: a.previousOrderId });
    const r = await ctx.client(a.org).listOrders({ type: a.type, categoryId, statusId, personId: a.contactId, onlyOpen: a.onlyOpen, query: a.query, fiscalPeriodId: a.fiscalPeriodId, limit: clampLimit(a.limit), filter: filter.length ? filter : undefined });
    // 0.4.0: order/list liefert ohne fiscalPeriodId nur das aktuelle Geschaeftsjahr plus offene Belege frueherer Jahre (gemessen
    // beim Datenbau 24.10.2026). Mit Datumsfilter ohne Geschaeftsjahr sagt die Antwort das, sonst kaeme eine Frage nach 2024 still leer zurueck.
    const hinweis = a.fiscalPeriodId === undefined && (a.dateFrom || a.dateTo) ? HINWEIS_GESCHAEFTSJAHR : undefined;
    return ok({ fiscalPeriodId: a.fiscalPeriodId ?? 'aktuell', ...(hinweis ? { hinweis } : {}), ...page(r.data.map(compactOrder), r.total) });
  } catch (e) { return fail(e); }
}

export async function getOrder(ctx: ToolContext, a: { org?: string; id: number }): Promise<CallToolResult> {
  try {
    const o = await ctx.client(a.org).readOrder(a.id);
    // Positionsfelder laut tests/fixtures/README.md (order/read — Positionen): `unitPrice` ist
    // brutto, netto steht in `netUnitPrice`; Totale in `netTotal` / `grossTotal`.
    const items = ((o.items as Rec[] | undefined) ?? []).map((i) => ({ articleNr: i.articleNr, name: i.name, description: i.description, qty: i.quantity, unitPriceNet: i.netUnitPrice, unitPriceGross: i.unitPrice, taxCode: i.taxCode, taxRate: i.taxRate, totalNet: i.netTotal, totalGross: i.grossTotal }));
    // 0.3.2: order/read fuehrt kein dateDue, nur dueDays (M3, 19.10.2026: an 20 von 20 Belegen ist dateDue aus order/list = Datum + dueDays
    // Kalendertage). Ohne dueDays bleibt dueDate null; ein geliefertes dateDue gilt.
    const kompakt = compactOrder(o);
    const tage = typeof o.dueDays === 'number' && Number.isInteger(o.dueDays) ? o.dueDays : null;
    const dueDate = kompakt.dueDate ?? (tage !== null && kompakt.date !== null ? shiftDay(kompakt.date, tage) : null);
    return ok({ ...kompakt, dueDate, categoryId: o.categoryId, statusId: o.statusId, associateId: o.associateId, description: o.description, previousId: o.previousId, groupId: o.groupId, notes: o.notes, custom: o.custom, items });
  } catch (e) { return fail(e); }
}

export async function getOrderPdf(ctx: ToolContext, a: { org?: string; id: number }): Promise<CallToolResult> {
  try {
    const orgNameGeprueft = ctx.orgName(a.org);
    const c = ctx.client(orgNameGeprueft);
    const o = await c.readOrder(a.id);
    const bytes = await c.readOrderPdf(a.id);
    if (Buffer.from(bytes.slice(0, 5)).toString() !== '%PDF-') return fail(new Error('CashCtrl hat kein PDF geliefert (Kopf fehlt) — Beleg-ID prüfen.'));
    // Der Dateiname wird HIER gebaut, damit eine leere Belegnummer `_.pdf` ergibt und nie `.pdf`
    // (eine versteckte Datei). Die Ablage (Datei, Datenbank, Durchreiche) bestimmt der Aufrufer (O125).
    const name = `${pfadsicher(String(o.nr ?? a.id))}.pdf`;
    const path = await ctx.pdf.put(orgNameGeprueft, name, bytes);
    return ok({ path, bytes: bytes.length, nr: o.nr }, `PDF abgelegt: ${path}`);
  } catch (e) { return fail(e); }
}

export const ordersModule: ToolModule = {
  tools(ctx: ToolContext) { return [
    tool('search_orders', 'read', { title: 'Belege suchen', description: 'Offerten, Auftragsbestätigungen, Rechnungen (SALES) oder Einkaufsrechnungen (PURCHASE) suchen — nach Kategorie, Status, Kontakt, Datum, Volltext. Kompakte Liste mit Total und offenem Betrag; open ist null, wenn der Beleg nicht bucht (Offerte, Auftragsbestätigung).', inputSchema: SearchInput, annotations: { readOnlyHint: true, openWorldHint: true } }, async (a) => searchOrders(ctx, a)),
    tool('get_order', 'read', { title: 'Beleg lesen', description: 'Ein Beleg mit Positionen (Menge, Netto- und Bruttopreis, Steuercode, Totale) und Dossier-Verweisen.', inputSchema: z.object({ org: OrgParam, id: z.number().int() }), annotations: { readOnlyHint: true, openWorldHint: true } }, async (a) => getOrder(ctx, a)),
    tool('get_order_pdf', 'read', { title: 'Beleg-PDF holen', description: 'Legt das PDF des Belegs ab (Standard: lokal unter pdfDir) und gibt die Ref zurück, beim Server der Dateipfad.', inputSchema: z.object({ org: OrgParam, id: z.number().int() }), annotations: { readOnlyHint: true, openWorldHint: true } }, async (a) => getOrderPdf(ctx, a)),
  ]; },
};
