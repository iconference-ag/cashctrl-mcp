import { z } from 'zod';
import type { ToolContext } from '../context.js';
import type { ToolModule } from '../def.js';
import type { Rec, OrderItemInput } from '../../core/client.js';
import { CashCtrlError } from '../../core/errors.js';
import { round2 } from '../../core/money.js';
import { de, heute, OrgParam, IsoDatum, vorschauText } from '../result.js';
import { twoPhaseTools } from '../twophase.js';
import { loadCategories, findCategory, type CategoryKey } from '../read/categories.js';
import { ItemSchema, resolveOrderItems, toOrderItems, setzeAbsender, steuerHinweis } from '../draft/order.js';
import { angelegteId, nachDemAnlegen } from '../anlegen.js';
import { loeseWaehrungAuf, type Waehrung } from '../currency.js';

/** Klartext fuer ein HTML-Feld: escapen, Zeilenumbrueche zu `<br>`. */
export function htmlText(s: string): string {
  return htmlEscape(s.replace(/\r\n?/g, '\n')).replace(/\n/g, '<br>');
}
function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const Input = z.object({
  org: OrgParam,
  category: z.enum(['offer', 'order_confirmation', 'invoice']),
  statusId: z.number().int().describe('Status-ID aus der Statusliste der Kategorie (z.B. Rechnung Offen 16, Offerte Offen 37); der Beleg wird gleich mit diesem Status angelegt'),
  contactId: z.number().int(),
  date: IsoDatum.optional().describe('Standard: heute'),
  dueDays: z.number().int().min(0).optional(),
  description: z.string().max(200).optional().describe('Titel des Belegs, höchstens 200 Zeichen'),
  header: z.string().optional().describe('Einleitungstext des Belegs, Klartext (wird HTML-escaped, Zeilenumbruch wird <br>)'),
  notes: z.string().optional().describe('Interne Notizen, Klartext; gespeichert wird HTML-escaped. Ein eigener Schlüssel, den search_orders mit notes wiederfinden soll, besteht nur aus A-Z, a-z, 0-9 und -_:. ; die Suche ist ein Teilstring-Vergleich (like), den Treffer exakt nachprüfen'),
  previousOrderId: z.number().int().optional().describe('Vorgänger im Dossier, z.B. die Offerte zur Rechnung'),
  defaultAccountNumber: z.string().optional().describe('Ertragskonto für alle Positionen ohne eigenes accountNumber, z.B. 3000'),
  nr: z.string().min(1).optional().describe('Belegnummer, geht unverändert an CashCtrl (M-1e: CashCtrl übernimmt sie, eine vergebene Nummer weist es mit «Die Nr. wird schon von einem anderen Dokument verwendet.» ab). Fehlt sie, nummeriert CashCtrl selbst'),
  currency: z.string().optional().describe('Währungscode des Belegs, z.B. EUR (list_currencies). Fehlt er, gilt die Währung des Mandanten; mit copyItemsFromOrderId gilt die Währung des Quellbelegs (ein abweichender Code wird abgewiesen). Kein Kurs: den setzt CashCtrl ein'),
  items: z.array(ItemSchema.extend({
    unitPriceNet: z.number().optional().describe('Nettopreis, negativ für eine Rabattzeile (das Total des Belegs darf nicht negativ werden); fehlt er bei einer Position mit articleId, gilt der Stammpreis des Artikels (brutto geführt: wörtlich als Bruttopreis)'),
  }).strict()).min(1).optional().describe('Positionen; genau eines von items und copyItemsFromOrderId'),
  copyItemsFromOrderId: z.number().int().optional().describe('Positionen wörtlich (Bruttopreise unverändert) aus diesem Beleg übernehmen, z.B. Rechnung aus der Offerte; genau eines von items und copyItemsFromOrderId'),
});
interface Payload { order: Parameters<ReturnType<ToolContext['client']>['createOrder']>[0]; header?: string; statusId: number; warnings: string[] }

/** Felder einer Quellposition, die woertlich uebernommen werden (Namen: tests/fixtures/order-read.json, Positionen). */
function kopiere(i: Rec, n: number): OrderItemInput {
  const fehlt = (f: string) => new CashCtrlError('validation', `Position ${n + 1} des Quellbelegs hat kein ${f} und lässt sich nicht übernehmen.`);
  const nicht = (grund: string) => new CashCtrlError('validation', `Position ${n + 1} des Quellbelegs ${grund}; sie käme nicht wörtlich mit, Kopie abgewiesen.`);
  // Fail-closed: was nicht woertlich mitkommt, weist ab, statt still einen anderen Beleg zu erzeugen.
  if (i.type !== 'ARTICLE') throw nicht(`ist keine normale Position (type ${String(i.type)})`);
  if (i.discountPercentage !== undefined && i.discountPercentage !== null && Number(i.discountPercentage) !== 0) throw nicht(`hat ${String(i.discountPercentage)} % Rabatt`);
  if (i.isOptional === true || i.optional === true) throw nicht('ist optional');
  if (typeof i.accountId !== 'number') throw fehlt('accountId');
  if (typeof i.unitPrice !== 'number') throw fehlt('unitPrice');
  if (typeof i.quantity !== 'number') throw fehlt('quantity');
  if (typeof i.name !== 'string' || i.name === '') throw fehlt('name');
  const out: Record<string, unknown> = { accountId: i.accountId, name: i.name, unitPrice: i.unitPrice, quantity: i.quantity };
  for (const f of ['description', 'taxId', 'unitId', 'articleNr', 'inventoryId']) if (i[f] !== undefined && i[f] !== null) out[f] = i[f];
  return out as unknown as OrderItemInput;
}

export const orderCreateModule: ToolModule = {
  tools(ctx: ToolContext) {
    return twoPhaseTools<typeof Input, Payload>(ctx, 'full', {
      kind: 'order_create', title: 'Beleg mit Status anlegen', destructive: true, input: Input,
      description: 'Bereitet Offerte, Auftragsbestätigung oder Rechnung (Verkauf) vor, die in EINEM Schreibaufruf gleich mit dem gewählten Status angelegt wird (eine Rechnung mit Status «Offen» ist sofort gebucht). Positionen entweder neu (items, Preise netto oder Stammpreis des Artikels) oder wörtlich aus einem Quellbeleg (copyItemsFromOrderId). Bei einem Fehler zeigt structuredContent kind, sent (Anfrage könnte CashCtrl erreicht haben) und createdId; bei sent true oder createdId nie automatisch erneut anlegen.',
      async prepare(c, a) {
        if ((a.items === undefined) === (a.copyItemsFromOrderId === undefined)) {
          throw new CashCtrlError('validation', 'Positionen: genau eines von items und copyItemsFromOrderId angeben.');
        }
        const client = c.client(a.org);
        const verkauf = await loadCategories(c, a.org, 'SALES');
        const cat = findCategory(verkauf, a.category as CategoryKey);
        const status = cat.statuses.find((s) => s.id === a.statusId);
        if (!status) {
          throw new CashCtrlError('validation', `Status-ID ${a.statusId} gehört nicht zur Kategorie ${cat.name}. Vorhanden: ${cat.statuses.map((s) => `${s.name} (${s.id})`).join(', ')}`);
        }
        const person = await client.readPerson(a.contactId);
        const warnings: string[] = [];
        let items: OrderItemInput[];
        let zeilen: string[];
        let summe: string;
        // Belegwaehrung: nur lesen, wenn ein Code angegeben ist. Kopierweg: siehe dort.
        const waehrung: Waehrung | undefined = a.currency !== undefined ? await loeseWaehrungAuf(c, a.org, a.currency) : undefined;
        let currencyId: number | undefined = waehrung?.id;
        let kopfWaehrung: string | undefined = waehrung?.code;
        if (a.copyItemsFromOrderId !== undefined) {
          const src = await client.readOrder(a.copyItemsFromOrderId);
          const quelle = String(src.nr ?? a.copyItemsFromOrderId);
          const abgewiesen = (grund: string) => new CashCtrlError('validation', `Quellbeleg ${quelle} ${grund}; Kopie abgewiesen.`);
          if (!verkauf.some((k) => k.id === Number(src.categoryId))) throw abgewiesen('ist kein Verkaufsbeleg');
          // Waehrung (0.3.0, B4): der neue Beleg bekommt die Waehrung des Quellbelegs. Hauptwaehrung = currencyId null
          // (gemessen 16.10.2026, Messbericht M-K A5): dann geht kein currencyId hinaus. Eine Fremdwaehrung geht mit der
          // Kennung des Quellbelegs hinaus. Ein `currency`, das davon abweicht, wuerde die woertlichen Betraege
          // umdeuten und wird abgewiesen.
          if (src.foreignCurrency === true && (src.currencyId === undefined || src.currencyId === null)) throw abgewiesen('steht in einer anderen Währung als der des Mandanten, nennt aber keine currencyId');
          const quellId = src.currencyId !== undefined && src.currencyId !== null ? Number(src.currencyId) : undefined;
          if (waehrung && waehrung.id !== quellId) throw abgewiesen(`ist in ${quellId === undefined ? 'der Währung des Mandanten' : String(src.currencyCode ?? quellId)}, nicht in ${waehrung.code}; Positionen werden wörtlich übernommen`);
          currencyId = quellId;
          if (quellId !== undefined) kopfWaehrung = String(src.currencyCode ?? quellId);
          if (src.discountPercentage !== undefined && src.discountPercentage !== null && Number(src.discountPercentage) !== 0) throw abgewiesen(`hat ${String(src.discountPercentage)} % Rabatt auf den ganzen Beleg`);
          const roh = (src.items as Rec[] | undefined) ?? [];
          if (roh.length === 0) throw new CashCtrlError('validation', `Quellbeleg ${a.copyItemsFromOrderId} hat keine Positionen.`);
          items = roh.map(kopiere);
          const brutto = round2(items.reduce((s, i) => s + round2(i.quantity * i.unitPrice), 0));
          // Die Summe muss das Total des Quellbelegs treffen, sonst kaeme ein anderer Beleg heraus.
          // Rappenrundung: ob `total` die `roundingDifference` enthaelt, ist nicht gemessen (in der
          // Aufnahme 0) — darum gilt auch Total minus Rundungsdifferenz als Treffer.
          if (typeof src.total !== 'number') throw abgewiesen('nennt kein Total');
          const rundung = typeof src.roundingDifference === 'number' ? src.roundingDifference : 0;
          if (brutto !== round2(src.total) && brutto !== round2(src.total - rundung)) throw abgewiesen(`hat Total ${src.total.toFixed(2)}, die übernommenen Positionen ergeben ${brutto.toFixed(2)}`);
          // Vorschau wie beim Netto-Weg: Konto und Steuer je Position.
          const [konten, steuern] = await Promise.all([client.listAccounts(), client.listTaxes()]);
          zeilen = items.map((i, n) => {
            const konto = konten.find((k) => Number(k.id) === i.accountId);
            if (!konto) throw abgewiesen(`nennt an Position ${n + 1} ein unbekanntes Konto (${i.accountId})`);
            const steuer = i.taxId === undefined ? undefined : steuern.find((t) => Number(t.id) === i.taxId);
            if (i.taxId !== undefined && !steuer) throw abgewiesen(`nennt an Position ${n + 1} einen unbekannten Steuercode (${i.taxId})`);
            const st = steuer ? `${String(steuer.code)} ${String(steuer.currentPercentage)} %` : 'ohne Steuercode';
            return `- ${i.quantity} x ${i.name}${i.description ? ` (${vorschauText(String(i.description), 80)})` : ''} @ ${i.unitPrice.toFixed(2)} brutto (${st}), Konto ${String(konto.number)} ${de(konto.name)} (aus Beleg ${quelle}, unverändert)`;
          });
          summe = `Total brutto ${brutto.toFixed(2)} (Positionen wörtlich aus ${quelle}, dort Total ${src.total.toFixed(2)})`;
        } else {
          const { calc, zusatz } = await resolveOrderItems(c, { org: a.org, items: a.items!, defaultAccountNumber: a.defaultAccountNumber }, 'SALES', { masterPrice: true, waehrung });
          items = toOrderItems(calc, zusatz);
          zeilen = calc.lines.map((l, n) => {
            const text = zusatz[n].description;
            const preis = zusatz[n].stammpreis ? 'Stammpreis ' : '';
            return `- ${l.qty} x ${l.name}${text ? ` (${vorschauText(text, 80)})` : ''} @ ${preis}${l.unitPriceNet.toFixed(2)} netto${steuerHinweis(l, zusatz[n])} = ${l.totalNet.toFixed(2)} netto, Konto ${zusatz[n].accountLabel}`;
          });
          summe = `Total netto ${calc.totalNet.toFixed(2)}, MWST ${calc.totalTax.toFixed(2)}, brutto ${calc.totalGross.toFixed(2)}`;
        }
        const date = a.date ?? heute();
        const notes = a.notes !== undefined ? htmlEscape(a.notes) : undefined;
        const order: Payload['order'] = {
          categoryId: cat.id, associateId: a.contactId, date, nr: a.nr, dueDays: a.dueDays, statusId: a.statusId, previousId: a.previousOrderId,
          description: a.description, notes, items, currencyId,
        };
        const wer = String(person.name ?? person.company ?? a.contactId);
        const summary = [
          `${cat.name} anlegen mit Status «${status.name}» (${status.id}) in ${c.orgName(a.org)} für ${wer}, Datum ${date}${kopfWaehrung ? `, Währung ${kopfWaehrung}` : ''}`,
          ...(a.nr ? [`Nummer: ${a.nr}`] : []),
          ...(a.description ? [`Titel: ${vorschauText(a.description, 200)}`] : []),
          ...(a.dueDays !== undefined ? [`Frist: ${a.dueDays} Tage (dueDays)`] : []),
          ...zeilen,
          summe,
          ...(a.header ? [`Einleitung: ${vorschauText(a.header, 200)}`] : []),
          ...(a.notes ? [`Notizen: ${vorschauText(a.notes, 200)}`] : []),
          ...(a.previousOrderId !== undefined ? [`Vorgänger: Beleg ${a.previousOrderId}`] : []),
        ].join('\n');
        return { summary, warnings, payload: { order, header: a.header !== undefined ? htmlText(a.header) : undefined, statusId: a.statusId, warnings } };
      },
      async commit(c, org, p) {
        const client = c.client(org);
        // Genau EIN Anlegen, nie eine Wiederholung. Scheitert es selbst, traegt der Fehler `sent` aus http.ts.
        const id = angelegteId(await client.createOrder(p.order));
        const warnings = [...p.warnings];
        let o: Rec;
        try {
          await setzeAbsender(client, id, warnings, p.header);
          o = await client.readOrder(id);
        } catch (e) { throw nachDemAnlegen(e, id); }
        // Ein anderer Status als angefordert ist ein Fehler, keine Warnung: der Beleg existiert, steht
        // aber nicht dort, wo der Aufrufer ihn erwartet (etwa eine Rechnung ungebucht im Entwurf).
        if (Number(o.statusId) !== p.statusId) {
          throw new CashCtrlError('unknown', `Beleg ${String(o.nr ?? id)} angelegt, aber Status ${de(o.statusName)} (${String(o.statusId)}) statt ${p.statusId}; nicht erneut anlegen, in CashCtrl prüfen (createdId ${id}).`, undefined, { sent: true, createdId: id });
        }
        return { id, nr: o.nr, status: de(o.statusName), total: o.total, message: `Beleg angelegt: ${String(o.nr ?? id)}, Status ${de(o.statusName)}.`, warnings };
      },
    });
  },
};
