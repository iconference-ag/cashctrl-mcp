import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ToolContext } from '../context.js';
import { tool, type ToolModule } from '../def.js';
import type { Rec } from '../../core/client.js';
import { CashCtrlError } from '../../core/errors.js';
import { ok, fail, OrgParam, clampLimit, page, de } from '../result.js';

const Input = z.object({ org: OrgParam, query: z.string().optional().describe('Volltext: Nummer, Name, Beschreibung'), limit: z.number().int().min(1).max(200).optional() });
// Feldnamen laut tests/fixtures/README.md (inventory/article/list): unitName mehrsprachig -> de();
// salesPriceIsGross aus isSalesPriceGross: ein brutto gefuehrter Preis steht in salesPriceNet und ist NICHT netto.
// purchasePriceNet aus lastPurchasePrice, ein Feld `purchasePrice` gibt es nicht; categoryId vorhanden (auch wenn null).
// 0.3.2 (PA-37cca969-02): currencyId und currency. Gemessen M-K A8 (16.10.2026): article/list nennt currencyId 2 und currencyCode «EUR»,
// article/read currencyId 2 und currencyCode null. Ohne eigene Waehrung (currencyId null) ist currency null: es gilt die des Mandanten.
// Fehlt der Code bei gesetzter currencyId, kommt er aus currency/list (`codes`); ohne Liste bleibt er null.
// Einheit: article/list traegt unitName, article/read nur unitId (gemessen 09.11.2026); dann kommt der Name aus inventory/unit/list (`units`).
export function compactArticle(r: Rec, codes?: Map<number, string>, units?: Map<number, string>) {
  const currencyId = r.currencyId === undefined || r.currencyId === null ? null : Number(r.currencyId);
  const geliefert = typeof r.currencyCode === 'string' && r.currencyCode !== '' ? r.currencyCode : null;
  const currency = currencyId === null ? null : (codes?.get(currencyId) ?? geliefert);
  const unit = de(r.unitName) || (units?.get(Number(r.unitId)) ?? '');
  return { id: r.id, nr: r.nr, name: r.name, unit, salesPriceNet: r.salesPrice, purchasePriceNet: r.lastPurchasePrice, stock: r.stock, categoryId: r.categoryId, salesPriceIsGross: r.isSalesPriceGross === true, salesAccountId: r.salesAccountId ?? null, currencyId, currency };
}
/** Codes aus currency/list, nur gelesen, wenn ein Artikel eine eigene Waehrung ohne Code traegt. */
async function codesFuer(ctx: ToolContext, org: string | undefined, rows: Rec[]): Promise<Map<number, string> | undefined> {
  if (!rows.some((r) => r.currencyId !== undefined && r.currencyId !== null && !(typeof r.currencyCode === 'string' && r.currencyCode !== ''))) return undefined;
  return new Map((await ctx.client(org).listCurrencies()).map((x) => [Number(x.id), String(x.code)]));
}
export async function searchArticles(ctx: ToolContext, a: z.infer<typeof Input>): Promise<CallToolResult> {
  try { const r = await ctx.client(a.org).listArticles({ query: a.query, limit: clampLimit(a.limit) }); const codes = await codesFuer(ctx, a.org, r.data); return ok(page(r.data.map((x) => compactArticle(x, codes)), r.total)); }
  catch (e) { return fail(e); }
}
const GetInput = z.object({ org: OrgParam, id: z.number().int().positive() });
/** 0.2.4: einen Artikel nach Kennung lesen (inventory/article/read). Eine unbekannte Kennung beantwortet CashCtrl wie order/read mit
 *  success:false (gemessen 14.10.2026 am Demo-Mandanten: HTTP 200, success:false, ohne data): das ist `validation`. Kommt stattdessen
 *  200 ohne `data`, gilt dieselbe Form. `not_found` bleibt fuer 404 und 200 ohne JSON wie in den uebrigen Lesewerkzeugen. */
export async function getArticle(ctx: ToolContext, a: z.infer<typeof GetInput>): Promise<CallToolResult> {
  try {
    const r = await ctx.client(a.org).readArticle(a.id);
    if (r === null || r === undefined) throw new CashCtrlError('validation', `Artikel ${a.id} nicht gefunden.`);
    // Einheitenliste nur lesen, wenn read den Namen schuldig bleibt und eine Einheit gesetzt ist.
    const ohneName = de(r.unitName) === '' && r.unitId !== undefined && r.unitId !== null;
    const units = ohneName ? new Map((await ctx.client(a.org).listUnits()).map((x) => [Number(x.id), de(x.name)])) : undefined;
    return ok(compactArticle(r, await codesFuer(ctx, a.org, [r]), units));
  } catch (e) { return fail(e); }
}
export const articlesModule: ToolModule = {
  tools(ctx: ToolContext) { return [
    tool('search_articles', 'read', { title: 'Artikel suchen', description: 'Artikelstamm durchsuchen: Nummer, Name, Einheit, Verkaufs- und Einkaufspreis (netto), Bestand, eigene Währung (currency, null = Währung des Mandanten).', inputSchema: Input, annotations: { readOnlyHint: true, openWorldHint: true } }, async (a) => searchArticles(ctx, a)),
    tool('get_article', 'read', { title: 'Artikel lesen', description: 'Einen Artikel nach Kennung lesen: Nummer, Name, Einheit, Verkaufspreis (netto oder brutto geführt), Konto, eigene Währung (currency, null = Währung des Mandanten).', inputSchema: GetInput, annotations: { readOnlyHint: true, openWorldHint: true } }, async (a) => getArticle(ctx, a)),
  ]; },
};
