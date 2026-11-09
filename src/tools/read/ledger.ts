import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ToolContext } from '../context.js';
import { tool, type ToolModule } from '../def.js';
import type { Rec } from '../../core/client.js';
import { round2 } from '../../core/money.js';
import { HINWEIS_GESCHAEFTSJAHR } from './orders.js';
import { ok, fail, OrgParam, clampLimit, page, de, shiftDay, IsoDatum, isoTag } from '../result.js';

/** Klassierung nach der ersten Ziffer der Kontonummer (Schweizer KMU-Kontenrahmen — Annahme,
 * s. tests/fixtures/README.md): 1 Aktiven, 2 Passiven, 3 Ertrag, 4-8 Aufwand. CashCtrl liefert
 * endAmount je Klasse als positiven Betrag; ein negativer Wert ist ein Gegensaldo (gemessen
 * 09.11.2026: 6961 Rundungsdifferenzen -0.18) und mindert die Klasse. Darum wird mit Vorzeichen
 * summiert und erst die Klassensumme normiert (Math.abs, falls eine ganze Klasse negativ kommt).
 * Bis 0.4.0 wurde je Konto normiert: der Gegensaldo zaehlte doppelt falsch, die Bilanz schloss nicht.
 * An tests/fixtures/account-list.json gemessen: 593321.20 − 404491.21 = 188829.99. */
export function summarize(accounts: { number: unknown; endAmount: unknown }[]) {
  const sum = (pred: (d: string) => boolean) => round2(Math.abs(accounts.filter((a) => pred(String(a.number)[0])).reduce((s, a) => s + Number(a.endAmount ?? 0), 0)));
  const assets = sum((d) => d === '1'), liabilities = sum((d) => d === '2'), revenue = sum((d) => d === '3'), expenses = sum((d) => '45678'.includes(d));
  return { assets, liabilities, revenue, expenses, profit: round2(revenue - expenses) };
}

const JournalInput = z.object({
  org: OrgParam,
  dateFrom: IsoDatum.describe('Buchungsdatum ab diesem Tag, inklusive (YYYY-MM-DD)'),
  dateTo: IsoDatum.describe('Buchungsdatum bis zu diesem Tag, inklusive (YYYY-MM-DD)'),
  accountId: z.number().int().optional(),
  query: z.string().optional(),
  fiscalPeriodId: z.number().int().optional().describe('Geschäftsjahr (id aus list_fiscal_periods). Ohne Angabe liefert CashCtrl nur das aktuelle Geschäftsjahr; für andere Jahre angeben'),
  limit: z.number().int().min(1).max(200).optional(),
});

/**
 * Feldnamen laut tests/fixtures/README.md (journal/list, account/list). `debitName`/`creditName`
 * tragen Kontonummer und mehrsprachiges Fragment in einem String ("5700 <values>…") — de() loest
 * das Fragment auf, der Praefix bleibt. Ohne Namen (leerer Wert) bleibt die ID als Rueckfall.
 */
export function compactEntry(r: Rec) {
  return { id: r.id, date: isoTag(r.dateAdded), title: r.title, debitAccount: r.debitName ? de(r.debitName) : r.debitId, creditAccount: r.creditName ? de(r.creditName) : r.creditId, amount: r.amount, reference: r.reference };
}
export function compactAccount(r: Rec) {
  return { id: r.id, number: r.number, name: de(r.name), category: r.categoryDisplay ? de(r.categoryDisplay) : r.categoryId, endAmount: r.endAmount, currency: r.currencyCode };
}

export async function searchJournal(ctx: ToolContext, a: z.infer<typeof JournalInput>): Promise<CallToolResult> {
  try {
    // Datumsfilter: journal/list filtert ueber das Feld dateAdded (tests/fixtures/README.md).
    // CashCtrls Vergleiche sind eq/like/gt/lt — fuer inklusive Grenzen wird der Randtag verschoben.
    const r = await ctx.client(a.org).listJournal({ accountId: a.accountId, query: a.query, fiscalPeriodId: a.fiscalPeriodId, limit: clampLimit(a.limit), filter: [{ field: 'dateAdded', comparison: 'gt', value: shiftDay(a.dateFrom, -1) }, { field: 'dateAdded', comparison: 'lt', value: shiftDay(a.dateTo, 1) }] });
    // 0.4.0: journal/list liefert ohne fiscalPeriodId nur das aktuelle Geschaeftsjahr (gemessen 24.10.2026); der Datumsbereich ist hier Pflicht.
    return ok({ fiscalPeriodId: a.fiscalPeriodId ?? 'aktuell', ...(a.fiscalPeriodId === undefined ? { hinweis: HINWEIS_GESCHAEFTSJAHR } : {}), ...page(r.data.map(compactEntry), r.total) });
  } catch (e) { return fail(e); }
}

export async function listAccounts(ctx: ToolContext, a: { org?: string; fiscalPeriodId?: number; query?: string }): Promise<CallToolResult> {
  try {
    const rows = await ctx.client(a.org).listAccounts({ fiscalPeriodId: a.fiscalPeriodId, query: a.query });
    return ok({ items: rows.map(compactAccount), total: rows.length });
  } catch (e) { return fail(e); }
}

export async function financialSummary(ctx: ToolContext, a: { org?: string; fiscalPeriodId?: number }): Promise<CallToolResult> {
  try {
    const c = ctx.client(a.org);
    const accounts = await c.listAccounts({ fiscalPeriodId: a.fiscalPeriodId });
    // order/list open: null bei nicht buchenden Belegen (Offerten) — zaehlt nicht mit (tests/fixtures/README.md),
    // weder in der Summe noch in count: onlyOpen liefert auch offene Offerten (gemessen 09.11.2026).
    const open = async (type: 'SALES' | 'PURCHASE') => {
      const r = await c.listOrders({ type, onlyOpen: true, limit: 200, fiscalPeriodId: a.fiscalPeriodId });
      const offen = r.data.map((o) => Number(o.open ?? 0)).filter((b) => b > 0);
      return { count: offen.length, sum: round2(offen.reduce((s, b) => s + b, 0)), hasMore: r.total > r.data.length };
    };
    const openReceivables = await open('SALES');
    const openPayables = await open('PURCHASE');
    // Minor-Befund Fixrunde 1: bei mehr als 200 offenen Belegen ist die Summe nur ein Mindestwert — das muss im Text stehen, nicht nur im hasMore-Flag.
    const note = 'Klassierung nach erster Ziffer der Kontonummer (Schweizer KMU-Kontenrahmen). open ist bei nicht buchenden Belegen (Offerten) null und zählt nicht.'
      + (openReceivables.hasMore || openPayables.hasMore ? ' Offene Posten: mehr als 200 Belege — Anzahl und Summe sind Mindestwerte.' : '');
    return ok({ fiscalPeriodId: a.fiscalPeriodId ?? 'aktuell', ...summarize(accounts as { number: unknown; endAmount: unknown }[]), openReceivables, openPayables }, note);
  } catch (e) { return fail(e); }
}

export const ledgerModule: ToolModule = {
  tools(ctx: ToolContext) { return [
    tool('search_journal', 'read', { title: 'Journal suchen', description: 'Buchungen in einem Datumsbereich (Randtage inklusive), optional je Konto und Volltext.', inputSchema: JournalInput, annotations: { readOnlyHint: true, openWorldHint: true } }, async (a) => searchJournal(ctx, a)),
    tool('list_accounts', 'read', { title: 'Konten', description: 'Kontenplan mit Endsaldo im Geschäftsjahr (Standard: aktuelles).', inputSchema: z.object({ org: OrgParam, fiscalPeriodId: z.number().int().optional(), query: z.string().optional() }), annotations: { readOnlyHint: true, openWorldHint: true } }, async (a) => listAccounts(ctx, a)),
    tool('financial_summary', 'read', { title: 'Kennzahlen', description: 'Bilanz- und Erfolgssummen (Aktiven, Passiven, Ertrag, Aufwand, Gewinn) nach Schweizer KMU-Kontenrahmen sowie offene Debitoren und Kreditoren. open ist bei nicht buchenden Belegen (Offerten) null und zählt nicht.', inputSchema: z.object({ org: OrgParam, fiscalPeriodId: z.number().int().optional() }), annotations: { readOnlyHint: true, openWorldHint: true } }, async (a) => financialSummary(ctx, a)),
  ]; },
};
