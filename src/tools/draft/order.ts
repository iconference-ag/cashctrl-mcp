import { z } from 'zod';
import type { ToolContext } from '../context.js';
import type { ToolModule } from '../def.js';
import type { Rec, OrderItemInput } from '../../core/client.js';
import { CashCtrlError } from '../../core/errors.js';
import { netToGross, round2 } from '../../core/money.js';
import { de, heute, OrgParam, IsoDatum, vorschauText } from '../result.js';
import { resolveAccount } from '../accounts.js';
import { twoPhaseTools } from '../twophase.js';
import { loadCategories, findCategory, type CategoryKey } from '../read/categories.js';
import { angelegteId, nachDemAnlegen } from '../anlegen.js';
import { loeseWaehrungAuf, standardWaehrung, waehrungsCode, type Waehrung } from '../currency.js';
import { istVerkaufssteuer } from '../read/orgs.js';

export interface TaxInfo { id: number; name: string; rate: number }
export interface ItemIn {
  articleId?: number; articleNr?: string; name?: string; qty: number; taxCode?: string;
  /** Nettopreis je Stueck; Pflicht, ausser `unitPriceGross` ist gesetzt. */
  unitPriceNet?: number;
  /** Bruttopreis, der WOERTLICH an CashCtrl geht (Stammpreis eines brutto gefuehrten Artikels). Sticht `unitPriceNet`. */
  unitPriceGross?: number;
  /** `taxId` des Ertragskontos der Position (aus account/list; null = das Konto fuehrt keine Steuer). Gilt, wenn `taxCode` fehlt. */
  accountTaxId?: number | null;
  /** Nur fuer Fehlertexte: Kontonummer und -name. */
  kontoLabel?: string;
}

/**
 * Reine Rechnung ueber die Positionen: Netto -> Brutto je Stueck, Zeilentotale, Belegtotale.
 * CashCtrl erwartet in `order/create` den BRUTTO-Stueckpreis (gemessen 27.08.2026, bestaetigt
 * an tests/fixtures/order-read.json: Artikel A-02 hat salesPrice 890 netto, die Position
 * unitPrice 962.09 bei 8.1 %). Wer hier netto sendet, verrechnet stillschweigend zu wenig.
 *
 * `TaxInfo.name` traegt den Steuercode: `tax/list` hat kein Feld `name`, der Code steht in
 * `code`, der Satz in `currentPercentage` (tests/fixtures/README.md, Abschnitt `tax/list`).
 */
export function computeItems(items: ItemIn[], taxes: TaxInfo[]) {
  const lines = items.map((i) => {
    // B6 (0.3.0): Hat die Position einen taxCode, gilt genau er. Sonst gilt die Steuer des Ertragskontos der Position
    // (taxId aus account/list; gemessen: Feld `taxId`, null wenn leer). Fuehrt das Konto keine, geht die Position ohne
    // taxId hinaus: MWST 0, unitPrice = netto (M-1b, 17.10.2026). Keine feste Vorgabe: CashCtrl setzt ueber die API
    // ohne taxId keine Steuer, auch nicht die des Kontos (M-1b').
    let t: TaxInfo | undefined;
    let taxQuelle: 'position' | 'konto' | 'keine' = 'keine';
    if (i.taxCode !== undefined) {
      t = taxes.find((x) => x.name.toLowerCase() === i.taxCode!.toLowerCase());
      if (!t) throw new CashCtrlError('validation', `Steuercode «${i.taxCode}» unbekannt. Vorhanden: ${taxes.map((x) => x.name).join(', ')}`);
      taxQuelle = 'position';
    } else if (i.accountTaxId !== undefined && i.accountTaxId !== null) {
      t = taxes.find((x) => x.id === i.accountTaxId);
      if (!t) throw new CashCtrlError('validation', `Das Konto ${i.kontoLabel ? `${i.kontoLabel} ` : ''}führt die Steuer-ID ${i.accountTaxId}, die CashCtrl in der Steuerliste nicht kennt. Steuercode (taxCode) angeben.`);
      taxQuelle = 'konto';
    }
    const rate = t?.rate ?? 0;
    if (i.unitPriceNet === undefined && i.unitPriceGross === undefined) throw new CashCtrlError('validation', `Position «${i.name ?? i.articleNr ?? ''}»: unitPriceNet fehlt.`);
    // Brutto wörtlich: nichts neu rechnen, Netto ist dann nur die Anzeige (Brutto geteilt durch 1 + Satz).
    const wortlich = i.unitPriceGross !== undefined;
    const unitPriceGross = wortlich ? i.unitPriceGross! : netToGross(i.unitPriceNet!, rate);
    const unitPriceNet = wortlich ? round2(unitPriceGross / (1 + rate / 100)) : i.unitPriceNet!;
    // Zeilentotal wie CashCtrl: Menge x BRUTTO-Stueckpreis. Nicht Nettototal x Satz — das weicht
    // um 1–2 Rappen ab (1.73 netto zu 2.6 %: 1 x 1.775 = 1.78, aber round2(1.73 x 1.026) = 1.77).
    // Belegt an tests/fixtures/order-read.json: 205 x 962.09 + 70 x 237.82 = 213875.85 = Feld `total`.
    const totalGross = round2(i.qty * unitPriceGross);
    const totalNet = wortlich ? round2(totalGross / (1 + rate / 100)) : round2(i.qty * unitPriceNet);
    return { articleId: i.articleId, articleNr: i.articleNr, name: i.name ?? i.articleNr ?? '', qty: i.qty, unitPriceNet, unitPriceGross, taxId: t?.id, taxCode: t?.name ?? '', rate, taxQuelle, totalNet, totalGross, totalTax: round2(totalGross - totalNet) };
  });
  const totalNet = round2(lines.reduce((s, l) => s + l.totalNet, 0));
  const totalGross = round2(lines.reduce((s, l) => s + l.totalGross, 0));
  // 0.3.0 (B8): ein negatives Total ist kein Fehler des Servers mehr; CashCtrl nimmt es an (M-1d, 17.10.2026: -100).
  return { lines, totalNet, totalTax: round2(totalGross - totalNet), totalGross };
}

export const ItemSchema = z.object({
  articleId: z.number().int().optional(),
  name: z.string().optional().describe('Positionstext; ohne articleId Pflicht'),
  description: z.string().optional(),
  qty: z.number().positive(),
  unitPriceNet: z.number().describe('Nettopreis; negativ für eine Rabattzeile. Ohne Steuer ist netto = brutto'),
  taxCode: z.string().optional().describe('Steuercode, z.B. UN1 (list_taxes). Fehlt er, gilt die Steuer des Ertragskontos der Position; führt das Konto keine, geht die Position ohne Steuer hinaus'),
  accountNumber: z.string().optional().describe('Ertrags- bzw. Aufwandkonto dieser Position als Kontonummer, z.B. 3000'),
}).strict();   // unbekannte Felder (z.B. unitPriceGross) abweisen statt still verwerfen
const Input = z.object({
  org: OrgParam,
  category: z.enum(['offer', 'order_confirmation', 'invoice', 'purchase_invoice']),
  contactId: z.number().int(),
  date: IsoDatum.optional().describe('Standard: heute'),
  dueDays: z.number().int().min(0).optional(),
  defaultAccountNumber: z.string().optional().describe('Ertrags- bzw. Aufwandkonto für alle Positionen ohne eigenes accountNumber, z.B. 3000'),
  items: z.array(ItemSchema).min(1),
  notes: z.string().optional(),
  previousOrderId: z.number().int().optional().describe('Vorgänger im Dossier, z.B. die Offerte zur Auftragsbestätigung'),
  currency: z.string().optional().describe('Währungscode des Belegs, z.B. EUR (list_currencies). Fehlt er, gilt die Währung des Mandanten. Kein Kurs: den setzt CashCtrl ein'),
});
export type ItemInput = z.infer<typeof ItemSchema>;
interface Payload { order: Parameters<ReturnType<ToolContext['client']>['createOrder']>[0]; warnings: string[] }
/** Was neben der reinen Rechnung an einer Position haengt; gleiche Reihenfolge wie `computeItems`. */
export interface Zusatz { accountId: number; accountNumber?: string; accountLabel: string; unitId?: number; description?: string; stammpreis?: boolean }

export const KONTO_FEHLT = 'Ertrags-/Aufwandkonto fehlt: accountNumber je Position oder defaultAccountNumber angeben (z.B. 3000).';


/**
 * Positionen aufloesen, gemeinsam fuer `order_draft` und `order_create`: Steuercodes und Konten
 * lesen, je Position Artikel, Konto, Einheit und Text bestimmen, Netto -> Brutto rechnen.
 * Ruft `tax/list`, `account/list` und je Position mit `articleId` `inventory/article/read`.
 * `masterPrice` (nur `order_create`): fehlt `unitPriceNet` bei einer Position mit Artikel, gilt der
 * Stammpreis des Artikels; ist er brutto gefuehrt (`isSalesPriceGross`), geht er woertlich als
 * Bruttopreis an CashCtrl.
 * `waehrung` (aufgeloeste Belegwaehrung, fehlt = Mandantenwaehrung): der Stammpreis gilt in der Waehrung des
 * ARTIKELS (eigene `currencyId` am Artikel, sonst Mandantenwaehrung) und wird nur ergaenzt, wenn sie die
 * Belegwaehrung ist; sonst gaelte ein Betrag still in einer anderen Waehrung (Korrektur 10, bexio W4).
 * Ob ein CashCtrl-Artikel eine eigene Waehrung tragen kann, ist UNGEMESSEN (M-2 misst es); die Fixture
 * zeigt `currencyId: null` und `currencyCode: "CHF"` (Mandantenwaehrung).
 */
export async function resolveOrderItems(
  c: ToolContext,
  a: { org?: string; items: { articleId?: number; name?: string; description?: string; qty: number; unitPriceNet?: number; taxCode?: string; accountNumber?: string }[]; defaultAccountNumber?: string },
  type: 'SALES' | 'PURCHASE',
  opts: { masterPrice?: boolean; waehrung?: Waehrung } = {},
): Promise<{ calc: ReturnType<typeof computeItems>; zusatz: Zusatz[] }> {
  const client = c.client(a.org);
  const steuerListe = await client.listTaxes();
  const taxes: TaxInfo[] = steuerListe.map((t: Rec) => ({ id: Number(t.id), name: String(t.code), rate: Number(t.currentPercentage ?? 0) }));
  const verkaufssteuer = new Set(steuerListe.filter((t: Rec) => istVerkaufssteuer(t.components)).map((t: Rec) => Number(t.id)));
  const accounts = (await client.listAccounts({})) as { id: unknown; number: unknown; name: unknown; taxId?: unknown }[];
  // `taxId` am Konto: Feldname gemessen (account/list, Aufnahme 28.08.2026; M-1 17.10.2026: null wenn leer).
  const kontoSteuer = (id: number): number | null => { const k = accounts.find((x) => Number(x.id) === id); return k && k.taxId !== undefined && k.taxId !== null ? Number(k.taxId) : null; };

  /**
   * Konto je Position (B6, 0.3.0), in dieser Reihenfolge: Eingabe der Position (accountNumber), dann das Ertrags-
   * bzw. Aufwandkonto des Artikels, dann die Vorgabe am Beleg. Nie `cat.accountId`:
   * das ist das Debitoren-/Kreditorenkonto der Kategorie (gemessen: Offerte -> 4 = 1100
   * Debitoren, PURCHASE -> 9), nicht das Konto der Position.
   */
  const kontoFuer = (nummer: string | undefined, artikelKonto: number | undefined): { id: number; label: string; nummer?: string } => {
    if (nummer) { const k = resolveAccount(accounts, nummer); return { id: k.id, label: `${k.number} ${k.name}`.trim(), nummer: k.number }; }
    if (artikelKonto !== undefined) {
      const k = accounts.find((x) => Number(x.id) === artikelKonto);
      return { id: artikelKonto, label: k ? `${String(k.number)} ${de(k.name)}`.trim() : `Konto-ID ${artikelKonto}`, nummer: k ? String(k.number) : undefined };
    }
    if (a.defaultAccountNumber) { const k = resolveAccount(accounts, a.defaultAccountNumber); return { id: k.id, label: `${k.number} ${k.name}`.trim(), nummer: k.number }; }
    throw new CashCtrlError('validation', KONTO_FEHLT);
  };

  const items: ItemIn[] = [];
  const zusatz: Zusatz[] = [];
  for (const i of a.items) {
    let articleNr: string | undefined;
    let unitId: number | undefined;
    let artikelKonto: number | undefined;
    let artikelText: string | undefined;
    let name = i.name;
    let netto = i.unitPriceNet;
    let brutto: number | undefined;
    let stammpreis = false;
    if (netto === undefined && !(opts.masterPrice && i.articleId !== undefined)) {
      throw new CashCtrlError('validation', `Position «${i.name ?? i.articleId ?? ''}»: unitPriceNet fehlt${opts.masterPrice ? ' (nur mit articleId darf er fehlen, dann gilt der Stammpreis)' : ''}.`);
    }
    if (i.articleId !== undefined) {
      const art = await client.readArticle(i.articleId);
      if (!art || art.id === undefined || art.id === null) throw new CashCtrlError('validation', `Artikel ${i.articleId} nicht gefunden.`);
      if (art.nr !== undefined && art.nr !== null) articleNr = String(art.nr);
      if (art.unitId !== undefined && art.unitId !== null) unitId = Number(art.unitId);
      const roh = type === 'SALES' ? art.salesAccountId : art.purchaseAccountId;
      if (roh !== undefined && roh !== null) artikelKonto = Number(roh);
      // Beschreibung des Artikels als Rueckfall: eine eingegebene description sticht sie.
      if (art.description !== undefined && art.description !== null && String(art.description) !== '') artikelText = de(art.description);
      name = name ?? (art.name !== undefined && art.name !== null && String(art.name) !== '' ? String(art.name) : undefined);
      if (netto === undefined) {
        // Stammpreis nur in der Belegwaehrung (Korrektur 10): Waehrung des Artikels = eigene currencyId, sonst Mandantenwaehrung.
        const belegFremd = opts.waehrung && !opts.waehrung.isDefault ? opts.waehrung.code : undefined;
        // 0.3.2 (PA-37cca969-01): der Code kommt aus currencyId ueber currency/list, nie aus currencyCode (article/read nennt dort null, M-K A8).
        const artikelEigen = art.currencyId !== undefined && art.currencyId !== null ? await waehrungsCode(c, a.org, Number(art.currencyId), name ?? String(i.articleId)) : undefined;
        const standardCode = artikelEigen !== undefined || belegFremd !== undefined ? (opts.waehrung?.standardCode || await standardWaehrung(c, a.org)) : '';
        const artikelCode = artikelEigen ?? standardCode;
        const belegCode = (belegFremd ?? standardCode).toUpperCase();
        if (artikelEigen !== undefined || belegFremd !== undefined) {
          if (artikelCode.toUpperCase() !== belegCode) {
            throw new CashCtrlError('validation', `Position «${name}»: Preis fehlt. Der Stammpreis gilt in ${artikelCode}, der Beleg ist in ${belegCode}; Preis angeben.`);
          }
        }
        // Stammpreis des Artikels: brutto gefuehrt -> woertlich als Bruttopreis, sonst netto wie bisher.
        const preis = art.salesPrice;
        if (typeof preis !== 'number') throw new CashCtrlError('validation', `Artikel ${i.articleId} hat keinen Stammpreis — unitPriceNet angeben.`);
        stammpreis = true;
        if (art.isSalesPriceGross === true) brutto = preis; else netto = preis;
      }
    }
    if (!name) throw new CashCtrlError('validation', 'Jede Position braucht articleId oder name.');
    const konto = kontoFuer(i.accountNumber, artikelKonto);
    // 0.3.2 (PA-37cca969-03): die Steuer des Kontos gilt im Verkauf nur, wenn sie eine Verkaufssteuer ist (sales wie list_taxes). CashCtrl nimmt eine
    // Bezugsteuer an einer Verkaufsposition still an und zaehlt sie ins Total (Task 11 Desk, M-9); es prueft das also nicht. Die Wahl der Position sticht.
    const kontoSteuerId = kontoSteuer(konto.id);
    if (type === 'SALES' && i.taxCode === undefined && kontoSteuerId !== null && !verkaufssteuer.has(kontoSteuerId)) {
      const t = taxes.find((x) => x.id === kontoSteuerId);
      if (t) throw new CashCtrlError('validation', `Position «${name}»: Das Konto ${konto.label} führt die Steuer ${t.name}, keine Verkaufssteuer. Steuercode (taxCode) je Position angeben.`);
    }
    items.push({ articleId: i.articleId, articleNr, name, qty: i.qty, unitPriceNet: netto, unitPriceGross: brutto, taxCode: i.taxCode, accountTaxId: kontoSteuerId, kontoLabel: konto.label });
    zusatz.push({ accountId: konto.id, accountNumber: konto.nummer, accountLabel: konto.label, unitId, description: i.description ?? artikelText, stammpreis });
  }
  const calc = computeItems(items, taxes);
  return { calc, zusatz };
}

/** Steuerhinweis hinter dem Nettopreis in der Vorschau: woher die Steuer der Position kommt (B6). */
export function steuerHinweis(l: { taxCode: string; rate: number; taxQuelle: 'position' | 'konto' | 'keine' }, z: { accountNumber?: string }): string {
  if (l.taxQuelle === 'keine') return ', ohne Steuer (Konto führt keine)';
  return l.taxQuelle === 'konto' ? ` (${l.taxCode} ${l.rate} %, Steuer vom Konto ${z.accountNumber ?? '?'})` : ` (${l.taxCode} ${l.rate} %)`;
}

/**
 * Positionsform fuer `order/create`: accountId, name und unitPrice (brutto) sind Pflicht; kein `type`, CashCtrl setzt ARTICLE selbst.
 * Vor dem Senden muss jede Position `name` und `unitPrice` tragen: CashCtrl laesst sonst die Position still fallen und antwortet
 * trotzdem mit Erfolg (M-1a, 17.10.2026: Beleg gespeichert, `items` leer). Das ist eine technische Pflicht der API, kein Fachwissen.
 */
export function toOrderItems(calc: ReturnType<typeof computeItems>, zusatz: Zusatz[]): OrderItemInput[] {
  return calc.lines.map((l, n) => {
    if (typeof l.name !== 'string' || l.name.trim() === '') throw new CashCtrlError('validation', `Position ${n + 1}: name fehlt. CashCtrl würde die Position sonst still verwerfen.`);
    if (typeof l.unitPriceGross !== 'number' || !Number.isFinite(l.unitPriceGross)) throw new CashCtrlError('validation', `Position «${l.name}»: unitPrice fehlt. CashCtrl würde die Position sonst still verwerfen.`);
    return {
      accountId: zusatz[n].accountId, name: l.name, description: zusatz[n].description,
      unitPrice: l.unitPriceGross, quantity: l.qty, taxId: l.taxId,
      unitId: zusatz[n].unitId, articleNr: l.articleNr, inventoryId: l.articleId,
    };
  });
}

/**
 * Gemessene Eigenheit (docs/cashctrl-api-eigenheiten.md, Belege): Standort und Bankkonto haengen nur ueber
 * order/document/update am Beleg — sonst steht im Absender «Adresse wählen» und die
 * IBAN fehlt. layoutId/language/header/footer/isDisplayItemGross/recipientAddressId
 * werden aus dem gelesenen Dokument mitgeschickt, sonst gehen sie beim Update verloren.
 * `header` (Einleitungstext, schon als HTML) ersetzt den gelesenen, wenn er gesetzt ist.
 * Warnungen werden an `warnings` angehaengt.
 */
export async function setzeAbsender(client: ReturnType<ToolContext['client']>, id: number, warnings: string[], header?: string): Promise<void> {
  const doc = await client.readOrderDocument(id);
  /**
   * Was am Dokument schon steht, gewinnt — der erste Listeneintrag ist nur der Rueckfall.
   * Sonst ueberschriebe das Update stumm den Absender, den CashCtrl selbst gesetzt hat.
   * Bei mehr als einem Eintrag sagt eine Warnung, welcher gesetzt wurde.
   */
  const absender = (vorhanden: unknown, liste: Rec[], was: string): number | undefined => {
    const id2 = vorhanden !== undefined && vorhanden !== null ? Number(vorhanden) : (liste[0] ? Number(liste[0].id) : undefined);
    if (id2 === undefined) return undefined;
    if (liste.length > 1) {
      const treffer = liste.find((x) => Number(x.id) === id2);
      warnings.push(`${was} — gesetzt: ${treffer ? String(treffer.name) : id2}`);
    }
    return id2;
  };
  const orgLocationId = absender(doc.orgLocationId, await client.listLocations(), 'Mehrere Standorte');
  const orgBankAccountId = absender(doc.orgBankAccountId, await client.listBankAccounts(), 'Mehrere Bankkonten');
  await client.updateOrderDocument({
    id,
    orgLocationId,
    orgBankAccountId,
    layoutId: doc.layoutId as number | undefined,
    language: doc.language as string | undefined,
    header: header ?? (doc.header as string | undefined),
    footer: doc.footer as string | undefined,
    isDisplayItemGross: doc.isDisplayItemGross as boolean | undefined,
    recipientAddressId: doc.recipientAddressId as number | undefined,
  });
}

export const orderDraftModule: ToolModule = {
  tools(ctx: ToolContext) {
    return twoPhaseTools<typeof Input, Payload>(ctx, 'draft', {
      kind: 'order_draft', title: 'Beleg als Entwurf anlegen', destructive: false, input: Input,
      description: 'Bereitet eine Offerte, Auftragsbestätigung, Rechnung oder Einkaufsrechnung als ENTWURF vor: löst Kontakt, Artikel, Steuercodes, Konten und Status auf, rechnet Netto/Brutto/Total, gibt Vorschau und Token. Preise netto angeben.',
      async prepare(c, a) {
        const client = c.client(a.org);
        const warnings: string[] = [];
        const type = a.category === 'purchase_invoice' ? 'PURCHASE' : 'SALES';
        const cat = findCategory(await loadCategories(c, a.org, type), a.category as CategoryKey);
        const draft = cat.statuses.find((s) => s.name.toLowerCase().startsWith('entwurf'));
        if (!draft) warnings.push(`Kategorie ${cat.name} kennt keinen Entwurfsstatus — CashCtrl setzt den ersten Status.`);
        const person = await client.readPerson(a.contactId);
        const waehrung = a.currency !== undefined ? await loeseWaehrungAuf(c, a.org, a.currency) : undefined;
        const { calc, zusatz } = await resolveOrderItems(c, a, type, { waehrung });
        const date = a.date ?? heute();
        const order: Payload['order'] = {
          categoryId: cat.id, associateId: a.contactId, date, dueDays: a.dueDays, statusId: draft?.id, previousId: a.previousOrderId, notes: a.notes, currencyId: waehrung?.id,
          // Positionsform aus der API-Doku, am Mandanten bestaetigt: siehe toOrderItems.
          items: toOrderItems(calc, zusatz),
        };
        const wer = String(person.name ?? person.company ?? a.contactId);
        // Spec §6.3: die Vorschau muss zeigen, was commit sendet. `description` (eingegeben oder
        // vom Artikel geerbt) und `notes` stehen im Beleg beim Kunden — sie gehoeren hierher.
        const summary = [
          `${cat.name} als Entwurf anlegen in ${c.orgName(a.org)} für ${wer}, Datum ${date}${waehrung ? `, Währung ${waehrung.code}` : ''}`,
          ...(a.dueDays !== undefined ? [`Frist: ${a.dueDays} Tage (dueDays)`] : []),
          ...calc.lines.map((l, n) => {
            const text = zusatz[n].description;
            return `- ${l.qty} x ${l.name}${text ? ` (${vorschauText(text, 80)})` : ''} @ ${l.unitPriceNet.toFixed(2)} netto${steuerHinweis(l, zusatz[n])} = ${l.totalNet.toFixed(2)} netto, Konto ${zusatz[n].accountLabel}`;
          }),
          `Total netto ${calc.totalNet.toFixed(2)}, MWST ${calc.totalTax.toFixed(2)}, brutto ${calc.totalGross.toFixed(2)}`,
          ...(a.notes ? [`Notizen: ${vorschauText(a.notes, 200)}`] : []),
        ].join('\n');
        return { summary, warnings, payload: { order, warnings } };
      },
      async commit(c, org, p) {
        const client = c.client(org);
        const id = angelegteId(await client.createOrder(p.order));
        try {
          const warnings = [...p.warnings];
          await setzeAbsender(client, id, warnings);
          const o = await client.readOrder(id);
          return { id, nr: o.nr, message: `Entwurf angelegt: ${String(o.nr ?? id)}. In CashCtrl prüfen und freigeben.`, warnings };
        } catch (e) { throw nachDemAnlegen(e, id); }
      },
    });
  },
};
