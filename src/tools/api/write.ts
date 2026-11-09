import { z } from 'zod';
import { CashCtrlError } from '../../core/errors.js';
import { einordnen, endpunktFinden, ohneJson, paramsPruefen, type ParamWert } from '../../catalog/katalog.js';
import type { ToolContext } from '../context.js';
import type { ToolModule } from '../def.js';
import { OrgParam, vorschauText } from '../result.js';
import { twoPhaseTools } from '../twophase.js';
import { ParamsSchema } from './read.js';
import { pruefeSchalter } from './schalter.js';

const Input = z.object({
  org: OrgParam,
  path: z.string().min(1).describe('Pfad eines POST-Endpunkts aus api_catalog, z.B. person/title/create.json'),
  params: ParamsSchema.optional().describe('Parameter des Endpunkts (Name → Wert), siehe api_catalog; alle Pflichtparameter müssen dabei sein'),
});
interface Payload { path: string; params: Record<string, ParamWert> }

/** Wert fuer die Vorschau: JSON bei Objekten und Listen, auf 200 Zeichen gekuerzt. */
const wertText = (v: ParamWert): string => vorschauText(typeof v === 'object' ? JSON.stringify(v) : String(v), 200);

const WARNUNG = 'Allgemeiner Schreibweg: keine Fachprüfung des Servers (Rundung, Steuer, Dubletten), am Mandanten nicht gemessen.';

/**
 * Pfad und Methode gegen den Katalog; die Schalter gegen die angesprochene Organisation. In prepare UND
 * commit, jeweils vor jedem Netzaufruf: der Token-Speicher ist austauschbar (deps.stores) und die
 * Registrierung gilt fuer alle Organisationen (wie bei delete_order).
 */
function pruefen(c: ToolContext, org: string, path: string) {
  const e = endpunktFinden(path);
  if (!e) throw new CashCtrlError('validation', `Pfad nicht im Katalog: ${path}. Mit api_catalog (query oder area) suchen.`);
  if (e.method !== 'POST') throw new CashCtrlError('validation', `${e.path} liest nur (GET). Lesen geht über api_read; prepare_api_write ist für POST-Endpunkte.`);
  const ein = einordnen(e);
  pruefeSchalter(c, org, ein.gates);
  return { e, art: ein.art };
}

export const apiWriteModule: ToolModule = {
  tools(ctx: ToolContext) {
    return twoPhaseTools<typeof Input, Payload>(ctx, 'full', {
      kind: 'api_write', title: 'Allgemeiner Schreibweg', destructive: true, input: Input, ohneNetz: true,
      description: 'Bereitet einen beliebigen schreibenden Aufruf (POST) aus dem Katalog vor (api_catalog zuerst: Pfad und Parameter). Fachwerkzeuge (prepare_contact, prepare_order_create, prepare_payment usw.) vorziehen, wo es sie gibt: sie prüfen Rundung, Steuer und Dubletten, dieser Weg nicht. Der Server prüft Pfad, Methode, Pflichtparameter und nur bekannte Parameter; Löschen (/delete.json) nur mit dem Schalter deleteRecords der Organisation, Lohn-Endpunkte (salary/…) nur mit salary, Mail-Endpunkte nur mit sendMail. prepare ruft CashCtrl nicht auf. EXPERIMENTELL, am Mandanten nicht gemessen.',
      async prepare(c, a) {
        const org = c.orgName(a.org);
        const { e, art } = pruefen(c, org, a.path);
        const params = paramsPruefen(e, a.params);
        const felder = Object.entries(params).map(([k, v]) => `${k} = ${wertText(v)}`);
        const warnings = [WARNUNG];
        if (art === 'delete') warnings.push('Löschen ist unumkehrbar.');
        return {
          summary: [`${e.title} (${e.path}) in ${org}`, ...felder].join('\n'),
          warnings,
          payload: { path: e.path, params },
        };
      },
      async commit(c, org, p) {
        const { e } = pruefen(c, org, p.path);
        // Die Eingabe kommt aus dem Token-Speicher (bei einem fremden Speicher nicht vertrauenswuerdig): erneut gegen den Katalog.
        const params = paramsPruefen(e, p.params);
        const response = await c.client(org).apiPost(ohneJson(e.path), params);
        return { path: e.path, org, response };
      },
    });
  },
};
