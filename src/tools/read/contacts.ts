import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ToolContext } from '../context.js';
import { tool, type ToolModule } from '../def.js';
import type { Rec } from '../../core/client.js';
import { ok, fail, OrgParam, clampLimit, page } from '../result.js';

const SearchInput = z.object({
  org: OrgParam,
  query: z.string().optional().describe('Volltext: Name, Firma, Nummer, Ort'),
  type: z.enum(['customer', 'vendor', 'employee']).optional().describe('Nur Kunden, Lieferanten oder Mitarbeitende'),
  notes: z.string().optional().describe('Teilstring im Feld Notizen (like), z.B. ein eigener Schlüssel; CashCtrl findet per Filter notes like (M-5, 17.10.2026). Teilstring-Vergleich: jeden Treffer am ausgegebenen Kontakt (get_contact, notes) exakt nachprüfen'),
  limit: z.number().int().min(1).max(200).optional().describe('Standard 50, maximal 200'),
});
// Feldnamen laut tests/fixtures/README.md (person/list): email steht in emailWork, nicht in mail/email.
export function compactPerson(r: Rec) {
  return { id: r.id, nr: r.nr, name: r.name, company: r.company, firstName: r.firstName, lastName: r.lastName, city: r.city, email: r.emailWork, isCustomer: r.isCustomer, isVendor: r.isVendor, isEmployee: r.isEmployee };
}
// Filter `notes like`: M-5 (17.10.2026) hat ihn gegen person/list gemessen (Treffer 1, der angelegte Kontakt). Die Form des Filters
// (Array aus field/comparison/value, JSON) ist die von order/list in search_orders; das Protokoll von M-5 nennt die Form nicht: ungemessen.
export async function searchContacts(ctx: ToolContext, a: z.infer<typeof SearchInput>): Promise<CallToolResult> {
  try {
    const limit = clampLimit(a.limit);
    const r = await ctx.client(a.org).listPersons({ query: a.query, onlyCustomers: a.type === 'customer' || undefined, onlyVendors: a.type === 'vendor' || undefined, onlyEmployees: a.type === 'employee' || undefined, limit, filter: a.notes ? [{ field: 'notes', comparison: 'like', value: a.notes }] : undefined });
    return ok(page(r.data.map(compactPerson), r.total));
  } catch (e) { return fail(e); }
}
export async function getContact(ctx: ToolContext, a: { org?: string; id: number }): Promise<CallToolResult> {
  try {
    const p = await ctx.client(a.org).readPerson(a.id);
    // `notes` (0.3.0, B9): person/read liefert das Feld, wenn es gesetzt ist (M-5, 17.10.2026); ist es leer, fehlt es im Objekt
    // (Aufnahme 28.08.2026) und wird hier null. Nicht in compactPerson: die Liste bleibt kompakt.
    return ok({ ...compactPerson(p), notes: p.notes ?? null, language: p.language, addresses: p.addresses ?? [], contacts: p.contacts ?? [], categoryId: p.categoryId });
  } catch (e) { return fail(e); }
}
export const contactsModule: ToolModule = {
  tools(ctx: ToolContext) { return [
    tool('search_contacts', 'read', { title: 'Kontakte suchen', description: 'Kunden, Lieferanten, Mitarbeitende suchen (Volltext). Kompakte Liste mit id, nr, name, Rollen. Für Details get_contact.', inputSchema: SearchInput, annotations: { readOnlyHint: true, openWorldHint: true } }, async (a) => searchContacts(ctx, a)),
    tool('get_contact', 'read', { title: 'Kontakt lesen', description: 'Ein Kontakt mit Adressen, Kontaktkanälen (E-Mail, Telefon), Notiz (notes) und Kategorie.', inputSchema: z.object({ org: OrgParam, id: z.number().int() }), annotations: { readOnlyHint: true, openWorldHint: true } }, async (a) => getContact(ctx, a)),
  ]; },
};
