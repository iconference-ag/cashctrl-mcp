import { z } from 'zod';
import type { ToolContext } from '../context.js';
import type { ToolModule } from '../def.js';
import type { Rec } from '../../core/client.js';
import { CashCtrlError } from '../../core/errors.js';
import { de, OrgParam } from '../result.js';
import { twoPhaseTools } from '../twophase.js';

const norm = (s: string) => s.toLowerCase().replace(/\./g, '').replace('stück', 'stk').trim();
/**
 * Loest einen Einheitennamen ueber `listUnits()` auf. Einheiten sind entweder mehrsprachig
 * (`<values><de>Stk.</de>…</values>`, die 5 System-Einheiten) oder ein einfacher String
 * (selbst angelegte, z.B. `m²`, `Mt.`) — `de()` deckt beides ab, siehe tests/fixtures/README.md.
 * Nie `unit/create`: eine unbekannte Einheit ist ein Fehler mit der vorhandenen Liste, kein Anlass
 * zum Anlegen (gemessene Falle: Duplikat).
 */
export function resolveUnit(units: { id: unknown; name: unknown }[], wanted: string): number {
  const u = units.find((x) => norm(de(x.name)) === norm(wanted));
  if (!u) throw new CashCtrlError('validation', `Einheit «${wanted}» unbekannt. Vorhanden: ${units.map((x) => de(x.name)).join(', ')}`);
  return Number(u.id);
}
const Input = z.object({
  // nr ist Pflicht: ohne sie weist CashCtrl ab («nr: Dieses Feld darf nicht leer sein.», gemessen 09.11.2026 am Demo-Mandanten).
  org: OrgParam, nr: z.string().min(1).max(50).describe('Artikelnummer, Pflicht: ohne sie weist CashCtrl den Artikel ab. Das Schema des Mandanten zeigt search_articles (z.B. A-07)'), name: z.string().min(1),
  unit: z.string().optional().describe('Standard Stk.'), salesPriceNet: z.number().nonnegative(), purchasePriceNet: z.number().nonnegative().optional(), description: z.string().optional(),
});
// Signatur laut src/core/client.ts createArticle (Task 8) — isStockArticle/stock werden nicht ergaenzt.
type Payload = Parameters<ReturnType<ToolContext['client']>['createArticle']>[0];

export const articleDraftModule: ToolModule = {
  tools(ctx: ToolContext) {
    return twoPhaseTools<typeof Input, Payload>(ctx, 'draft', {
      kind: 'article', title: 'Artikel anlegen', destructive: false, input: Input,
      description: 'Bereitet einen neuen Artikel vor: löst die Einheit auf, prüft die Nummer auf Dubletten, gibt Vorschau und Token. Preise netto.',
      async prepare(c, a) {
        const client = c.client(a.org);
        const warnings: string[] = [];
        const unitId = resolveUnit((await client.listUnits()) as { id: unknown; name: unknown }[], a.unit ?? 'Stk.');
        const d = await client.listArticles({ query: a.nr, limit: 5 });
        if (d.data.some((r: Rec) => r.nr === a.nr)) warnings.push(`Artikelnummer ${a.nr} existiert schon.`);
        const payload: Payload = { nr: a.nr, name: a.name, unitId, salesPrice: a.salesPriceNet, lastPurchasePrice: a.purchasePriceNet, description: a.description };
        const summary = `Artikel anlegen in ${c.orgName(a.org)}: ${a.nr} ${a.name}, Einheit ${a.unit ?? 'Stk.'}, VK ${a.salesPriceNet.toFixed(2)} netto${a.purchasePriceNet !== undefined ? `, EK ${a.purchasePriceNet.toFixed(2)} netto` : ''}`;
        return { summary, warnings, payload };
      },
      async commit(c, org, payload) {
        const r = await c.client(org).createArticle(payload);
        return { id: r.insertId, message: `Artikel angelegt (ID ${r.insertId}).` };
      },
    });
  },
};
