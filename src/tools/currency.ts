import { CashCtrlError } from '../core/errors.js';
import type { ToolContext } from './context.js';

/** Aufgeloeste Belegwaehrung. `id` ist nur bei einer Fremdwaehrung gesetzt: die Standardwaehrung geht ohne currencyId hinaus. */
export interface Waehrung { code: string; isDefault: boolean; standardCode: string; id?: number }

/**
 * Waehrungscode -> Kennung ueber `currency/list` (Felder gemessen 16.10.2026, Messbericht M-K A5: id, code, isDefault).
 * Gelesen wird nur, wenn ein Code angegeben ist. Die Hauptwaehrung steht am Beleg als `currencyId: null` (gemessen,
 * A5); ob `order/create` mit der Kennung der Standardwaehrung `null` oder die Kennung speichert, ist UNGEMESSEN.
 * Darum geht fuer die Standardwaehrung kein currencyId hinaus. Kein Kurs (`currencyRate` geht nie mit).
 * Ein unbekannter Code ist `validation` mit der Liste des Systems.
 */
export async function loeseWaehrungAuf(c: ToolContext, org: string | undefined, code: string): Promise<Waehrung> {
  const liste = await c.client(org).listCurrencies();
  const treffer = liste.find((x) => String(x.code).toUpperCase() === code.trim().toUpperCase());
  if (!treffer) throw new CashCtrlError('validation', `CashCtrl führt die Währung ${code} nicht. Vorhanden: ${liste.map((x) => String(x.code)).join(', ')}`);
  const standard = liste.find((x) => x.isDefault === true);
  const istStandard = treffer.isDefault === true;
  return { code: String(treffer.code), isDefault: istStandard, standardCode: String(standard?.code ?? ''), ...(istStandard ? {} : { id: Number(treffer.id) }) };
}

/** Code der Standardwaehrung des Mandanten (nur gelesen, wenn ein Artikel eine eigene Waehrung traegt). */
export async function standardWaehrung(c: ToolContext, org: string | undefined): Promise<string> {
  const standard = (await c.client(org).listCurrencies()).find((x) => x.isDefault === true);
  return String(standard?.code ?? '');
}

/** 0.3.2 (PA-37cca969-01): Code einer Waehrungskennung ueber currency/list. Eine Kennung, die die Liste nicht kennt, ist `validation`. */
export async function waehrungsCode(c: ToolContext, org: string | undefined, id: number, wofuer: string): Promise<string> {
  const treffer = (await c.client(org).listCurrencies()).find((x) => Number(x.id) === id);
  if (!treffer) throw new CashCtrlError('validation', `Artikel «${wofuer}»: CashCtrl nennt die Währungs-ID ${id}, die in der Währungsliste fehlt. Preis angeben.`);
  return String(treffer.code).toUpperCase();
}
