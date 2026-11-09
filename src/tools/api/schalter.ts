import { CashCtrlError } from '../../core/errors.js';
import type { Gate } from '../../catalog/katalog.js';
import type { ToolContext } from '../context.js';

const MELDUNG: Record<Gate, (org: string) => string> = {
  salary: (org) => `Lohn-Endpunkte sind für ${org} nicht freigeschaltet (salary).`,
  deleteRecords: (org) => `Löschen über den allgemeinen Schreibweg ist für ${org} nicht freigeschaltet (deleteRecords).`,
  sendMail: (org) => `Mailversand ist für ${org} nicht freigeschaltet (sendMail).`,
};

/**
 * Prueft ALLE Schalter, die ein Endpunkt braucht, gegen die angesprochene Organisation (nicht gegen
 * irgendeine): `salary/…/delete.json` braucht `salary` und `deleteRecords`, `salary/…/mail.json`
 * `salary` und `sendMail`. Die Werkzeuge sind ab dem Modus registriert; das Gate liegt hier und
 * wird in `api_read`, `prepare_api_write` und `commit_api_write` jeweils vor dem Netzaufruf geprueft.
 */
export function pruefeSchalter(ctx: ToolContext, org: string, gates: Gate[]): void {
  const o = ctx.config.orgs.find((x) => x.name === org);
  const fehlt = gates.filter((g) => !o?.[g]);
  if (fehlt.length) throw new CashCtrlError('validation', fehlt.map((g) => MELDUNG[g](org)).join(' '));
}
