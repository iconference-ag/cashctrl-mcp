import { z } from 'zod';
import type { ToolContext } from '../context.js';
import type { ToolModule } from '../def.js';
import { OrgParam, vorschauText } from '../result.js';
import { twoPhaseTools } from '../twophase.js';
import { CashCtrlError } from '../../core/errors.js';

const Input = z.object({
  org: OrgParam,
  company: z.string().optional(), firstName: z.string().optional(), lastName: z.string().optional(),
  // 0.3.2 (Korrektur 17): kein Format vorgeprueft, CashCtrl entscheidet. Gemessen 20.10.2026 am Demo-Mandanten: Umlaut-Domain angenommen und
  // lesbar gespeichert; «info@neukunde» mit eigenem Satz abgewiesen («Contact #1: Address: Invalid format …»).
  email: z.string().optional(), phone: z.string().optional(),
  street: z.string().optional(), zip: z.string().optional(), city: z.string().optional(),
  country: z.string().optional().describe('Land, geht unverändert an CashCtrl: ISO-3 (CHE), ISO-2 (CH) oder der Name (Schweiz); CashCtrl speichert CHE (M-5, 17.10.2026; Name gemessen 20.10.2026). Ein Land, das CashCtrl nicht kennt, übernimmt es nicht'),
  notes: z.string().optional().describe('Interne Notiz am Kontakt, geht unverändert an CashCtrl; mit search_contacts (notes) wiederzufinden'),
  isCustomer: z.boolean().optional(), isVendor: z.boolean().optional(),
  language: z.enum(['DE', 'EN', 'FR', 'IT']).optional(),
});
// Signatur laut src/core/client.ts createPerson (Task 8).
type Payload = Parameters<ReturnType<ToolContext['client']>['createPerson']>[0];

/**
 * addresses[].type = 'MAIN' und contacts[].type = 'EMAIL_WORK' sind an
 * tests/fixtures/person-read.json gemessen (Abschnitt person/read, tests/fixtures/README.md).
 * 'PHONE_WORK' ist im Mandanten nicht belegt und daher ungeprueft bis zum Live-Test.
 */
export const contactDraftModule: ToolModule = {
  tools(ctx: ToolContext) {
    return twoPhaseTools<typeof Input, Payload>(ctx, 'draft', {
      kind: 'contact', title: 'Kontakt anlegen', destructive: false, input: Input,
      description: 'Bereitet einen neuen Kontakt (Kunde/Lieferant) vor: prüft Pflichtfelder und Dubletten, gibt Vorschau und Token.',
      async prepare(c, a) {
        if (!a.company && !a.lastName) throw new CashCtrlError('validation', 'company oder lastName ist nötig.');
        const warnings: string[] = [];
        const q = a.company || a.lastName!;
        const dup = await c.client(a.org).listPersons({ query: q, limit: 5 });
        if (dup.total > 0) warnings.push(`Ähnliche Kontakte vorhanden: ${dup.data.map((p) => `${p.nr} ${p.name}`).join(', ')}`);
        const contacts = [a.email && { type: 'EMAIL_WORK', address: a.email }, a.phone && { type: 'PHONE_WORK', address: a.phone }].filter(Boolean);
        const payload: Payload = {
          company: a.company, firstName: a.firstName, lastName: a.lastName, isCustomer: a.isCustomer, isVendor: a.isVendor, language: a.language, notes: a.notes,
          // 0.3.2: die Adresse geht mit, sobald eines der Felder gesetzt ist (gemessen 20.10.2026: CashCtrl nimmt eine Adresse nur mit Land oder nur mit PLZ an);
          // bis 0.3.2 nur mit Strasse oder Ort, Land und PLZ allein fielen still weg.
          addresses: a.street || a.zip || a.city || a.country ? [{ type: 'MAIN', address: a.street, zip: a.zip, city: a.city, country: a.country }] : undefined,
          contacts: contacts.length ? contacts : undefined,
        };
        const name = [a.company, [a.firstName, a.lastName].filter(Boolean).join(' ')].filter(Boolean).join(' — ');
        const roles = [a.isCustomer && 'Kunde', a.isVendor && 'Lieferant'].filter(Boolean).join(', ') || 'ohne Rolle';
        return { summary: `Kontakt anlegen in ${c.orgName(a.org)}: ${name} (${roles})${a.city ? ', ' + [a.zip, a.city].filter(Boolean).join(' ') : ''}${a.email ? ', ' + a.email : ''}${a.notes ? ', Notiz: ' + vorschauText(a.notes, 200) : ''}`, warnings, payload };
      },
      async commit(c, org, payload) { const r = await c.client(org).createPerson(payload); return { id: r.insertId, message: `Kontakt angelegt (ID ${r.insertId}).` }; },
    });
  },
};
