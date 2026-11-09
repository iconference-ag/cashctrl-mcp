import { z } from 'zod';
import type { ToolContext } from '../context.js';
import type { ToolModule } from '../def.js';
import type { CashCtrlClient, Rec } from '../../core/client.js';
import { CashCtrlError } from '../../core/errors.js';
import { de, OrgParam, vorschauText } from '../result.js';
import { twoPhaseTools } from '../twophase.js';
import { findStatus, type CategoryInfo } from '../read/categories.js';
import { categoryOfOrder } from './status.js';

/**
 * Empfaengeradresse: die uebergebene Adresse gewinnt immer; sonst der erste Kontakt vom Typ
 * EMAIL* (Feld `address`, Vertrag: tests/fixtures/README.md, Abschnitt `person/read`); sonst
 * der Rueckfall `emailWork`. Ohne jede Adresse ein Fehler statt eines stillen leeren Feldes —
 * das ist die einzige Aktion, die den Rechner verlaesst.
 */
export function pickEmail(person: Rec, given?: string): string {
  if (given) return given;
  const contacts = (person.contacts as { type?: string; address?: string }[] | undefined) ?? [];
  const mail = contacts.find((c) => String(c.type ?? '').toUpperCase().startsWith('EMAIL'));
  if (mail?.address) return mail.address;
  if (person.emailWork) return String(person.emailWork);
  throw new CashCtrlError('validation', 'Keine Empfängeradresse: recipientEmail angeben oder eine E-Mail-Kontaktadresse in CashCtrl hinterlegen.');
}

/**
 * Absenderadresse: `from` aus der Eingabe, sonst `email` des Hauptstandorts (`type` `MAIN`),
 * sonst des ersten Standorts (`location/list`, Vertrag: tests/fixtures/README.md,
 * Abschnitt `location/list`).
 * Ohne beides ein Fehler — CashCtrl verlangt `mailFrom` als Pflichtfeld.
 */
async function resolveMailFrom(client: CashCtrlClient, from?: string): Promise<string> {
  if (from) return from;
  const locations = await client.listLocations();
  // Standort vom Typ MAIN bevorzugen (Vertrag: tests/fixtures/README.md, Abschnitt location/list,
  // Feld `type`); ohne MAIN-Eintrag der erste Standort, wie bisher.
  const location = locations.find((l) => l.type === 'MAIN') ?? locations[0];
  const email = location?.email;
  if (email) return String(email);
  throw new CashCtrlError('validation', 'Absenderadresse fehlt: from angeben oder E-Mail am Hauptstandort in CashCtrl hinterlegen.');
}

/**
 * Versandstatus der Kategorie: `cat.sentStatusId` aus dem Kategorie-Kopf zuerst (Vertrag:
 * order/category/list traegt es direkt, z.B. Offerte 2 -> 37 "Offen", Zahlungserinnerung 9 ->
 * 30 "Versandt"); sonst ueber den Namen "Versandt", sonst "Gesendet" gesucht — je in try/catch,
 * `findStatus` wirft, wenn die Kategorie den Namen nicht kennt. Fehlt alles, bleibt der Status
 * beim Commit unveraendert (keine sentStatusId), mit Warnung.
 */
function resolveSentStatusId(cat: CategoryInfo): { sentStatusId?: number; warning?: string } {
  if (typeof cat.sentStatusId === 'number') return { sentStatusId: cat.sentStatusId };
  for (const name of ['Versandt', 'Gesendet']) {
    try { return { sentStatusId: findStatus(cat, name).id }; } catch { /* naechster Name */ }
  }
  return { warning: `Kategorie ${cat.name} kennt keinen Versandstatus — Status bleibt unverändert.` };
}

const Input = z.object({
  org: OrgParam,
  orderId: z.number().int(),
  recipientEmail: z.string().email().optional(),
  subject: z.string().min(1).max(255),
  message: z.string().min(1),
  from: z.string().email().optional(),
});
interface Payload { orderId: number; nr: unknown; mailTo: string; mailFrom: string; subject: string; message: string; sentStatusId?: number }

export const sendModule: ToolModule = {
  tools(ctx: ToolContext) {
    return twoPhaseTools<typeof Input, Payload>(ctx, 'full', {
      kind: 'send_order', title: 'Beleg per Mail versenden', destructive: true, input: Input,
      requires: 'sendMail',
      description: 'Bereitet den Versand eines Belegs (Offerte, Rechnung) per Mail über CashCtrl vor: Empfänger (Standard: E-Mail-Kontakt der Person), Absender (Standard: E-Mail des Hauptstandorts), Betreff, Text; setzt danach ggf. den Status Gesendet. Die einzige Aktion, die den Rechner verlässt. Nur mit dem Opt-in sendMail der Organisation.',
      async prepare(c, a) {
        // Zweiter Riegel neben der Registrierung in createToolset: bei mehreren Organisationen
        // ist das Werkzeug schon registriert, wenn IRGENDEINE sendMail traegt — hier wird die
        // tatsaechlich angesprochene Organisation geprueft, vor jedem Aufruf gegen CashCtrl.
        const orgName = c.orgName(a.org);
        const orgSicht = c.config.orgs.find((o) => o.name === orgName);
        if (!orgSicht?.sendMail) throw new CashCtrlError('validation', `Belegversand ist für ${orgName} nicht freigeschaltet (sendMail).`);
        const client = c.client(a.org);
        const o = await client.readOrder(a.orderId);
        const person = await client.readPerson(Number(o.associateId));
        const mailTo = pickEmail(person as Rec, a.recipientEmail);
        const mailFrom = await resolveMailFrom(client, a.from);
        const cat = await categoryOfOrder(c, a.org, Number(o.categoryId));
        const { sentStatusId, warning } = resolveSentStatusId(cat);
        const warnings: string[] = warning ? [warning] : [];
        const statusLabel = sentStatusId !== undefined ? (cat.statuses.find((s) => s.id === sentStatusId)?.name ?? String(sentStatusId)) : undefined;
        return {
          // Spec §6.3: die Vorschau nennt Empfaenger, Absender, Betreff, TEXT, Belegnummer und Total.
          // Der Text ist das, was beim Empfaenger ankommt — ohne ihn bestaetigt der Mensch etwas Ungesehenes.
          summary: `${cat.name} ${o.nr ?? a.orderId} (Total ${Number(o.total ?? 0).toFixed(2)}) per Mail an ${mailTo} senden, von ${mailFrom}, Betreff «${a.subject}»${statusLabel ? `, danach Status «${statusLabel}»` : ''} — aus ${c.orgName(a.org)}`
            + `\nText: ${vorschauText(a.message, 200)}`,
          warnings,
          payload: { orderId: a.orderId, nr: o.nr, mailTo, mailFrom, subject: a.subject, message: a.message, sentStatusId },
        };
      },
      async commit(c, org, p) {
        const client = c.client(org);
        await client.mailOrderDocument({ orderIds: [p.orderId], mailFrom: p.mailFrom, mailSubject: p.subject, mailText: p.message, mailTo: p.mailTo, sentStatusId: p.sentStatusId });
        const o = await client.readOrder(p.orderId);      // Endzustand nachlesen, nicht dem Rueckgabewert glauben
        return { orderId: p.orderId, nr: p.nr, sentTo: p.mailTo, from: p.mailFrom, status: de(o.statusName), message: `Beleg an ${p.mailTo} gesendet.` };
      },
    });
  },
};
