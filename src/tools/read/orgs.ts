import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { hauptfirma, type ToolContext } from '../context.js';
import { tool, type ToolModule } from '../def.js';
import type { Rec } from '../../core/client.js';
import { MONATSLIMIT } from '../../core/usage.js';
import { ok, fail, OrgParam, isoTag, de } from '../result.js';

export async function listOrgs(ctx: ToolContext): Promise<CallToolResult> {
  try {
    const orgs = [];
    for (const o of ctx.config.orgs) {
      // reachable (B-MCP-1): ein Verbraucher erkennt den Ausfall am Feld, nicht am Text in orgName.
      let orgName = ''; let reachable = true;
      try {
        orgName = hauptfirma(await ctx.client(o.name).listLocations());
      } catch (e) { reachable = false; orgName = `(nicht erreichbar: ${(e as Error).message})`; }
      orgs.push({ name: o.name, subdomain: o.subdomain, orgName, reachable, mode: ctx.config.mode, sendMail: o.sendMail, deleteOrders: o.deleteOrders, salary: o.salary, deleteRecords: o.deleteRecords });
    }
    return ok({ orgs });
  } catch (e) { return fail(e); }
}
export async function usageTool(ctx: ToolContext, org?: string): Promise<CallToolResult> {
  try {
    const name = ctx.orgName(org); const st = await ctx.usage.state(name);
    // Das Praefix steht schon in der schluesselfreien Sicht des Kontexts (R8) — hier wird
    // kein Schluessel mehr angefasst.
    const orgSicht = ctx.config.orgs.find((o) => o.name === name)!;
    return ok({ org: name, mode: ctx.config.mode, keyPrefix: orgSicht.keyPrefix, sendMail: orgSicht.sendMail, deleteOrders: orgSicht.deleteOrders, salary: orgSicht.salary, deleteRecords: orgSicht.deleteRecords, ...st });
  } catch (e) { return fail(e); }
}
/** sales (0.3.1): eine Verkaufssteuer, wenn ALLE Komponenten applyRule REVENUE und isInputTax false tragen (Herleitung bei list_taxes).
 *  Gemeinsam fuer list_taxes und die Steuer des Kontos im Verkauf (0.3.2). */
export function istVerkaufssteuer(c: unknown): boolean {
  return Array.isArray(c) && c.length > 0
    && c.every((k) => typeof k === 'object' && k !== null && (k as Rec).applyRule === 'REVENUE' && (k as Rec).isInputTax === false);
}

export const orgsModule: ToolModule = {
  tools(ctx: ToolContext) { return [
    tool('list_orgs', 'read', { title: 'Organisationen', description: 'Konfigurierte CashCtrl-Organisationen mit dem Firmennamen des Hauptstandorts (orgName) und aktivem Modus. Zur Mandantenprüfung vor jeder Schreibaktion.', inputSchema: z.object({}), annotations: { readOnlyHint: true, openWorldHint: true } }, async () => listOrgs(ctx)),
    // `usage` liest nur den lokalen Zaehler und die Konfiguration — kein Aufruf nach draussen,
    // deshalb openWorldHint bewusst false und nicht bloss weggelassen.
    tool('usage', 'read', { title: 'Kontingent', description: `Aktiver Modus (read/draft/full), Monatsverbrauch gegen das Limit von ${MONATSLIMIT} Anfragen, 4 Zeichen des Schlüssels.`, inputSchema: z.object({ org: OrgParam }), annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ org }) => usageTool(ctx, org)),
    tool('list_fiscal_periods', 'read', { title: 'Geschäftsjahre', description: 'Geschäftsjahre der Organisation mit Start, Ende, aktuell/abgeschlossen. Vollständiger Bestand, ohne Paginierung.', inputSchema: z.object({ org: OrgParam }), annotations: { readOnlyHint: true, openWorldHint: true } }, async ({ org }) => {
      try {
        const rows = await ctx.client(org).listFiscalPeriods();
        // Feldnamen laut tests/fixtures/README.md (fiscalperiod/list): id, name, start, end, isCurrent, isClosed.
        // `start`/`end` kommen als "2026-01-01 00:00:00.0" — Spec §4 verlangt ISO YYYY-MM-DD.
        const items = rows.map((r) => ({ id: r.id, name: r.name, start: isoTag(r.start), end: isoTag(r.end), isCurrent: r.isCurrent, isClosed: r.isClosed }));
        // Spec §9, benannte Ausnahme: fiscalperiod/list kennt kein limit — voller Bestand, kein hasMore.
        return ok({ items, total: items.length });
      } catch (e) { return fail(e); }
    }),
    tool('list_taxes', 'read', { title: 'Steuercodes', description: 'Steuercodes der Organisation (z.B. UN1) mit ID, Name und aktuellem Satz in Prozent. Vollständiger Bestand, ohne Paginierung.', inputSchema: z.object({ org: OrgParam }), annotations: { readOnlyHint: true, openWorldHint: true } }, async ({ org }) => {
      try {
        const rows = await ctx.client(org).listTaxes();
        // Feldnamen laut tests/fixtures/README.md (tax/list): `name` gibt es nicht, der Code steht in `code`,
        // der Satz in `currentPercentage`, der Kurzname in `documentName` (mehrsprachig). `inactive` aus `isInactive` (0.2.4).
        // sales (0.3.1): eine Verkaufssteuer, wenn ALLE Komponenten applyRule REVENUE und isInputTax false tragen (gelesen am Demo-Mandanten
        // 17.10.2026, tax/list components[]: UN1/UR1/US1/U0x/SSx REVENUE; Vorsteuer EXPENSE+isInputTax; Bezugsteuer CREDIT/DEBIT). Fehlen
        // components oder sind sie leer, ist sales false: nicht geraten. CashCtrl nimmt eine Bezugsteuer an einer Verkaufsposition still an
        // (Offen != Total, Task 11 Desk), darum braucht der Verbraucher das Merkmal.
        const items = rows.map((r) => ({ id: r.id, code: r.code, name: de(r.name ?? r.documentName ?? r.code), rate: r.currentPercentage ?? 0, inactive: r.isInactive === true, sales: istVerkaufssteuer(r.components) }));
        // Spec §9, benannte Ausnahme: tax/list kennt kein limit, voller Bestand, kein hasMore.
        return ok({ items, total: items.length });
      } catch (e) { return fail(e); }
    }),
    tool('list_currencies', 'read', { title: 'Währungen', description: 'Währungen der Organisation mit Kennung, Code (z.B. EUR) und Kennzeichen der Standardwährung. Vollständiger Bestand, ohne Paginierung. Der Code geht als currency an order_create und order_draft.', inputSchema: z.object({ org: OrgParam }), annotations: { readOnlyHint: true, openWorldHint: true } }, async ({ org }) => {
      try {
        const rows = await ctx.client(org).listCurrencies();
        // Feldnamen laut Messbericht M-K A5 (currency/list, gemessen 16.10.2026): id, code, rate, isDefault, isAuto.
        const items = rows.map((r) => ({ id: r.id, code: r.code, isDefault: r.isDefault === true }));
        // Wie list_taxes: currency/list kennt kein limit, voller Bestand, kein hasMore (Spec §9).
        return ok({ items, total: items.length });
      } catch (e) { return fail(e); }
    }),
  ]; },
};
