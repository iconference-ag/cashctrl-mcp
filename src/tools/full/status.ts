import { z } from 'zod';
import type { ToolContext } from '../context.js';
import type { ToolModule } from '../def.js';
import { CashCtrlError } from '../../core/errors.js';
import { de, OrgParam } from '../result.js';
import { twoPhaseTools } from '../twophase.js';
import { loadCategories, findStatus, type CategoryInfo } from '../read/categories.js';

/**
 * Kategorie eines Belegs ueber seine `categoryId`: erst in den SALES-Kategorien suchen, dann in
 * PURCHASE — `order/read` selbst nennt den Typ nicht direkt genug (nur `type`, aber Kategorie-ID
 * ist eindeutig nur ueber die Liste aufloesbar). Exportiert, weil Task 17 (Beleg buchen) und
 * Task 19 (Beleg stornieren/Zahlungserinnerung o.ae.) dieselbe Zuordnung brauchen.
 */
export async function categoryOfOrder(ctx: ToolContext, org: string | undefined, categoryId: number): Promise<CategoryInfo> {
  for (const type of ['SALES', 'PURCHASE'] as const) {
    const hit = (await loadCategories(ctx, org, type)).find((c) => c.id === categoryId);
    if (hit) return hit;
  }
  throw new CashCtrlError('validation', `Belegkategorie ${categoryId} nicht gefunden.`);
}

const Input = z.object({ org: OrgParam, orderId: z.number().int(), status: z.string().min(1).optional().describe('Statusname der Kategorie, z.B. Gesendet, Akzeptiert, Abgelehnt, Bezahlt; genau eines von status und statusId'), statusId: z.number().int().optional().describe('Status-ID aus der Statusliste der Kategorie des Belegs; genau eines von status und statusId (IDs sind je Mandant fest, Namen mehrsprachig)') });
interface Payload { orderId: number; statusId: number; statusName: string; nr: unknown }

export const statusModule: ToolModule = {
  tools(ctx: ToolContext) {
    return twoPhaseTools<typeof Input, Payload>(ctx, 'full', {
      kind: 'order_status', title: 'Belegstatus setzen', destructive: true, input: Input,
      description: 'Bereitet einen Statuswechsel vor (z.B. Offerte akzeptiert/abgelehnt, Rechnung gesendet): löst den Status in der Kategorie des Belegs auf, zeigt alten und neuen Status.',
      async prepare(c, a) {
        const o = await c.client(a.org).readOrder(a.orderId);
        const cat = await categoryOfOrder(c, a.org, Number(o.categoryId));
        if ((a.status === undefined) === (a.statusId === undefined)) throw new CashCtrlError('validation', 'Status: genau eines von status (Name) und statusId angeben.');
        let st;
        if (a.statusId !== undefined) {
          st = cat.statuses.find((x) => x.id === a.statusId);
          if (!st) throw new CashCtrlError('validation', `Status-ID ${a.statusId} gehört nicht zur Kategorie ${cat.name}. Vorhanden: ${cat.statuses.map((x) => `${x.name} (${x.id})`).join(', ')}`);
        } else st = findStatus(cat, a.status!);
        return { summary: `Status von ${cat.name} ${o.nr ?? a.orderId} (${de(o.statusName)}) auf «${st.name}» setzen in ${c.orgName(a.org)}`, warnings: [], payload: { orderId: a.orderId, statusId: st.id, statusName: st.name, nr: o.nr } };
      },
      async commit(c, org, p) {
        await c.client(org).updateOrderStatus({ ids: [p.orderId], statusId: p.statusId });
        const o = await c.client(org).readOrder(p.orderId);      // Endzustand nachlesen, nicht dem Rueckgabewert glauben
        return { orderId: p.orderId, nr: p.nr, status: de(o.statusName), message: `Status gesetzt: ${de(o.statusName)}.` };
      },
    });
  },
};
