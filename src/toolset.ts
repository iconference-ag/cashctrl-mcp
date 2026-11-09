import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Config, Mode } from './config/config.js';
import type { Stores } from './core/stores.js';
import { buildContext, type ToolContext } from './tools/context.js';
import { fail } from './tools/result.js';
import type { ToolDef, ToolModule } from './tools/def.js';
import { orgsModule } from './tools/read/orgs.js';
import { contactsModule } from './tools/read/contacts.js';
import { articlesModule } from './tools/read/articles.js';
import { ordersModule } from './tools/read/orders.js';
import { ledgerModule } from './tools/read/ledger.js';
import { contactDraftModule } from './tools/draft/contact.js';
import { articleDraftModule } from './tools/draft/article.js';
import { orderDraftModule } from './tools/draft/order.js';
import { statusModule } from './tools/full/status.js';
import { orderCreateModule } from './tools/full/create.js';
import { paymentModule } from './tools/full/payment.js';
import { journalModule } from './tools/full/journal.js';
import { sendModule } from './tools/full/send.js';
import { deleteModule } from './tools/full/delete.js';
import { apiModule } from './tools/api/index.js';

// `tool`, `ToolDef` und `ToolModule` leben in `./tools/def.js` (sonst ESM-Zirkel mit den
// Werkzeugmodulen) und werden hier weitergereicht — `src/toolset.js` bleibt die eine Adresse.
export { tool } from './tools/def.js';
export type { ToolDef, ToolModule, Schalter } from './tools/def.js';

export interface Toolset { mode: Mode; tools: ToolDef[]; names(): string[]; call(name: string, args: unknown): Promise<CallToolResult> }

const RANK: Record<Mode, number> = { read: 0, draft: 1, full: 2 };

/**
 * Spec §9: ab 80 % des Monatskontingents haengt JEDE Antwort einen Hinweis an. Der Zaehler
 * laeuft in `core/http`, die Antwort entsteht in den Werkzeugmodulen — hier ist die eine
 * Naht dazwischen. Bewusst am Werkzeug und nicht in `call()`: `server.ts` ruft `t.handler`
 * direkt, der MCP-Weg braucht den Hinweis genauso wie der Desk-Weg.
 */
function mitKontingentHinweis(ctx: ToolContext, t: ToolDef): ToolDef {
  return { ...t, handler: async (args) => {
    const r = await t.handler(args);
    const w = ctx.warnung((args as { org?: string } | undefined)?.org);
    const erste = r.content?.[0];
    if (!w || !erste || erste.type !== 'text' || String(erste.text).includes(w)) return r;
    // Auch in structuredContent: Claude Desktop gibt dem Modell nur dieses weiter, wenn es vorhanden ist (25.10.2026).
    const structuredContent = r.structuredContent ? { ...r.structuredContent, hinweisKontingent: w } : undefined;
    return { ...r, content: [{ ...erste, text: `${w}\n${erste.text}` }, ...r.content.slice(1)], ...(structuredContent ? { structuredContent } : {}) };
  } };
}

/** Werkzeugschicht ohne Transport: Modus-Gate, Kontext, Tokens — dieselbe Liste fuer den Operating Desk und den MCP-Server. */
export function createToolset(config: Config, deps: { fetchImpl?: typeof fetch; now?: () => Date; modules?: ToolModule[]; stores?: Stores } = {}): Toolset {
  const ctx = buildContext(config, { fetchImpl: deps.fetchImpl, now: deps.now, stores: deps.stores });
  const modules = deps.modules ?? DEFAULT_MODULES;
  // requires ist der zweite Gate neben dem Modus-Rang — Opt-in je Organisation, Standard aus
  // (sendMail: 28.08.2026; deleteOrders: 12.10.2026). Es genuegt, wenn IRGENDEINE
  // Organisation den Schalter traegt: bei mehreren Organisationen prueft der Handler zusaetzlich
  // die angesprochene (send_order in prepare, delete_order in prepare und commit).
  const tools = modules.flatMap((m) => m.tools(ctx))
    .filter((t) => RANK[t.level] <= RANK[config.mode])
    .filter((t) => !t.requires || config.orgs.some((o) => Boolean(o[t.requires!])))
    .map((t) => mitKontingentHinweis(ctx, t));
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    mode: config.mode, tools,
    names: () => tools.map((t) => t.name),
    async call(name, args) {
      const t = byName.get(name);
      if (!t) return fail(new Error(`Werkzeug ${name} gibt es im Modus ${config.mode} nicht.`));
      const parsed = t.inputSchema.safeParse(args ?? {});
      if (!parsed.success) return fail(new Error(`Eingabe ungültig: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`));
      // Der Desk-Pfad hat kein SDK um sich herum: eine Ausnahme aus einem Werkzeugmodul
      // muss hier zu isError werden, sonst schlaegt sie roh bis in den Aufrufer durch.
      try { return await t.handler(parsed.data); } catch (e) { return fail(e); }
    },
  };
}
// Die Module haengen die Tasks 9–19 hier an; die Reihenfolge ist die Reihenfolge in der Werkzeugliste.
export const DEFAULT_MODULES: ToolModule[] = [orgsModule, contactsModule, articlesModule, ordersModule, ledgerModule, contactDraftModule, articleDraftModule, orderDraftModule, statusModule, orderCreateModule, paymentModule, journalModule, sendModule, deleteModule, apiModule];
