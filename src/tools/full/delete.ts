import { z } from 'zod';
import type { ToolContext } from '../context.js';
import type { ToolModule } from '../def.js';
import type { Rec } from '../../core/client.js';
import { CashCtrlError } from '../../core/errors.js';
import { OFFEN_SATZ } from '../../core/http.js';
import { de, OrgParam } from '../result.js';
import { twoPhaseTools } from '../twophase.js';
import { categoryOfOrder } from './status.js';

/**
 * Riegel 1 des Werkzeugs: die angesprochene Organisation traegt `deleteOrders`. Registriert ist
 * das Werkzeug schon, wenn IRGENDEINE Organisation den Schalter traegt (createToolset) — deshalb
 * prueft der Handler selbst, in prepare UND commit, jeweils vor jedem Aufruf gegen CashCtrl.
 */
function pruefeSchalter(c: ToolContext, org?: string): string {
  const name = c.orgName(org);
  if (!c.config.orgs.find((o) => o.name === name)?.deleteOrders) throw new CashCtrlError('validation', `Löschen ist für ${name} nicht freigeschaltet (deleteOrders).`);
  return name;
}

/**
 * Riegel 2: nur ungebuchte Belege. Ungebucht heisst, BEIDE Quellen sagen es ausdruecklich:
 * `isBook` des Belegs (order/read) und `isBook` seines Status in der Kategorie (Feldnamen:
 * tests/fixtures/order-read.json, order-category-list-type-SALES.json). Fehlt eine Angabe,
 * wird abgewiesen statt geraten.
 */
async function pruefeUngebucht(c: ToolContext, org: string, o: Rec): Promise<{ kategorie: string; status: string }> {
  const cat = await categoryOfOrder(c, org, Number(o.categoryId));
  const st = cat.statuses.find((s) => s.id === Number(o.statusId));
  const bezeichnung = `${cat.name} ${o.nr ?? o.id}`;
  if (o.isBook === true || st?.raw.isBook === true) throw new CashCtrlError('validation', `${bezeichnung} ist gebucht (Status ${st?.name ?? o.statusId}) und wird nicht gelöscht. Gebuchte Belege bleiben beim Menschen in CashCtrl.`);
  if (o.isBook !== false || st?.raw.isBook !== false) throw new CashCtrlError('validation', `${bezeichnung}: Buchungsstand nicht feststellbar, Löschen abgewiesen.`);
  return { kategorie: cat.name, status: st.name };
}

const Input = z.object({ org: OrgParam, orderId: z.number().int() });
interface Payload { orderId: number; nr: unknown; total: unknown }

export const deleteModule: ToolModule = {
  tools(ctx: ToolContext) {
    return twoPhaseTools<typeof Input, Payload>(ctx, 'full', {
      kind: 'delete_order', title: 'Beleg löschen', destructive: true, input: Input,
      requires: 'deleteOrders',
      description: 'Bereitet das endgültige Löschen eines ungebuchten Belegs vor (z.B. Offerte, Rechnungsentwurf). Gebuchte Belege und Belege mit unklarem Buchungsstand weist der Server ab. Nur mit dem Opt-in deleteOrders der Organisation.',
      async prepare(c, a) {
        const org = pruefeSchalter(c, a.org);
        const o = await c.client(org).readOrder(a.orderId);
        const { kategorie, status } = await pruefeUngebucht(c, org, o);
        return {
          summary: `${kategorie} ${o.nr ?? a.orderId} (Status ${status}, Total ${Number(o.total ?? 0).toFixed(2)}) endgültig löschen in ${org}`,
          warnings: ['Löschen ist unumkehrbar; der MCP kann den Beleg nicht wiederherstellen.'],
          payload: { orderId: a.orderId, nr: o.nr, total: o.total },
        };
      },
      async commit(c, org, p) {
        pruefeSchalter(c, org);
        const client = c.client(org);
        // Neu lesen: in den 10 Minuten seit prepare kann der Beleg gebucht oder geaendert worden sein.
        const jetzt = await client.readOrder(p.orderId);
        if (String(jetzt.nr) !== String(p.nr) || Number(jetzt.total) !== Number(p.total)) {
          throw new CashCtrlError('validation', `Beleg ${p.orderId} hat sich seit der Vorschau geändert (jetzt ${String(jetzt.nr)}, Total ${String(jetzt.total)}; Vorschau ${String(p.nr)}, Total ${String(p.total)}). Nichts gelöscht; neu vorbereiten.`);
        }
        await pruefeUngebucht(c, org, jetzt);
        await client.deleteOrders([p.orderId]);
        // Endzustand nachlesen. Als «weg» gilt nur eine eindeutige Antwort von CashCtrl: not_found
        // oder eine Ablehnung ueber success:false (kind validation). Wie order/read eine geloeschte ID
        // beantwortet, ist am Mandanten nicht gemessen (12.10.2026). 5xx, Netz, 401/403/429 beim
        // Nachlesen lassen den Ausgang offen.
        let nochDa: boolean;
        try { nochDa = Number((await client.readOrder(p.orderId))?.id) === p.orderId; } catch (e) {
          const eindeutig = e instanceof CashCtrlError && (e.kind === 'not_found' || e.kind === 'validation');
          if (!eindeutig) throw new CashCtrlError('unknown', `Löschen von ${String(p.nr ?? p.orderId)} gesendet, Nachlesen gescheitert (${e instanceof Error ? e.message : 'unbekannt'}). ${OFFEN_SATZ}`, undefined, { sent: true });
          nochDa = false;
        }
        if (nochDa) throw new CashCtrlError('unknown', `Beleg ${p.nr ?? p.orderId} ist nach dem Löschen noch lesbar. In CashCtrl prüfen.`, undefined, { sent: true });
        return { orderId: p.orderId, nr: p.nr, deleted: true, message: `Beleg ${p.nr ?? p.orderId} gelöscht.` };
      },
    });
  },
};
