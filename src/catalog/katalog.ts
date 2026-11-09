import katalogJson from './endpoints.json' with { type: 'json' };
import { CashCtrlError } from '../core/errors.js';

/**
 * Katalog der CashCtrl-API (376 Endpunkte, Stand 24.10.2026), erzeugt von `scripts/katalog.ts`
 * aus der HTML-Doku. Er liegt als JSON im Paket: zur Laufzeit kein Netz, und ein statischer
 * Import laeuft auch in einem Bundle ohne Dateisystem (Desk-Worker). Die Einordnung
 * (lesend, schreibend, loeschend, Schalter) ist deterministisch aus Methode und Pfad abgeleitet,
 * nie geraten (Spec, Abschnitt «Allgemeine Werkzeuge»).
 */
export interface KatalogParam {
  name: string; required: boolean; type: string | null; max: number | null;
  /** Felder der Elemente eines JSON-Parameters (Untertabelle der Doku), nur wo es sie gibt. */
  fields?: KatalogParam[];
}
export interface KatalogEndpunkt { path: string; method: 'GET' | 'POST'; title: string; area: string; params: KatalogParam[] }
export interface Katalog { stand: string; quelle: string; endpunkte: KatalogEndpunkt[] }

export const KATALOG = katalogJson as unknown as Katalog;

/** Art eines Endpunkts: lesend (GET), schreibend (POST), loeschend (POST auf `/delete.json`). */
export type Art = 'read' | 'write' | 'delete';
/** Opt-in je Organisation, den ein allgemeiner Endpunkt zusaetzlich braucht (Standard aus). */
export type Gate = 'salary' | 'deleteRecords' | 'sendMail';
/** Reihenfolge, in der Schalter genannt werden. */
const GATE_REIHE: Gate[] = ['salary', 'deleteRecords', 'sendMail'];

const NACH_PFAD = new Map(KATALOG.endpunkte.map((e) => [e.path, e]));

/**
 * Sucht den Endpunkt. Erst der genaue Pfad; fehlt er, einmal mit `.json` (der Aufrufer nennt
 * `person/list` statt `person/list.json`). Ein Pfad, den der Katalog auch so nicht fuehrt, gibt es nicht.
 */
export function endpunktFinden(path: string): KatalogEndpunkt | undefined {
  const p = path.trim().replace(/^\/+/, '');
  return NACH_PFAD.get(p) ?? NACH_PFAD.get(`${p}.json`);
}

/** Endpunktname fuer `CashCtrlHttp.get/post`: die Schicht haengt `.json` selbst an. */
export function ohneJson(path: string): string { return path.replace(/\.json$/, ''); }

/** Loescht endgueltig, heisst aber nicht `/delete.json`: leert das Dateiarchiv (24.10.2026, aus der Liste aller POST ohne create/update/delete). */
const LOESCHT_AUCH = new Set(['file/empty_archive.json']);

/** Einordnung aus Methode und Pfad: lesend = GET, schreibend = POST, Loeschen = POST auf `/delete.json` oder in `LOESCHT_AUCH`; Lohn = `salary/…`, Mail = `…/mail.json`. */
export function einordnen(e: Pick<KatalogEndpunkt, 'path' | 'method'>): { art: Art; gates: Gate[] } {
  const loescht = e.path.endsWith('/delete.json') || LOESCHT_AUCH.has(e.path);
  const art: Art = e.method === 'GET' ? 'read' : loescht ? 'delete' : 'write';
  const gates = new Set<Gate>();
  if (e.path.startsWith('salary/')) gates.add('salary');
  if (art === 'delete') gates.add('deleteRecords');
  if (e.path.endsWith('/mail.json')) gates.add('sendMail');
  return { art, gates: GATE_REIHE.filter((g) => gates.has(g)) };
}

export type ParamWert = string | number | boolean | unknown[] | Record<string, unknown>;

const fehlt = (v: unknown): boolean => v === undefined || v === null || v === '';

/**
 * Prueft Parameter gegen den Katalog, fail-closed, vor jedem Netzaufruf: unbekannte Namen werden
 * abgewiesen, Pflichtparameter muessen da sein (`null` und leerer Text gelten als fehlend). Ein
 * Parameter vom Typ CSV darf als Liste kommen und wird mit Komma verbunden: die Kodierung der
 * HTTP-Schicht machte sonst `[7,8]` daraus (Spec, Anhang, Nachtrag 28.08.2026). Alles andere geht
 * unveraendert weiter.
 */
export function paramsPruefen(e: KatalogEndpunkt, params: Record<string, unknown> | undefined): Record<string, ParamWert> {
  const eingabe = params ?? {};
  const bekannt = new Map(e.params.map((p) => [p.name, p]));
  const unbekannt = Object.keys(eingabe).filter((k) => !bekannt.has(k));
  if (unbekannt.length) {
    throw new CashCtrlError('validation', `Unbekannte Parameter für ${e.path}: ${unbekannt.join(', ')}. Bekannt: ${e.params.map((p) => p.name).join(', ') || '(keine)'}.`);
  }
  const fehlend = e.params.filter((p) => p.required && fehlt(eingabe[p.name])).map((p) => p.name);
  if (fehlend.length) throw new CashCtrlError('validation', `Pflichtparameter fehlen für ${e.path}: ${fehlend.join(', ')}.`);
  const aus: Record<string, ParamWert> = {};
  for (const [name, p] of bekannt) {
    let v = eingabe[name];
    if (v === undefined || v === null) continue;
    if (p.type === 'CSV' && Array.isArray(v)) {
      if (!v.every((x) => ['string', 'number', 'boolean'].includes(typeof x))) throw new CashCtrlError('validation', `Parameter ${name} (CSV) von ${e.path}: nur einfache Werte in der Liste.`);
      v = v.join(',');
    }
    aus[name] = v as ParamWert;
  }
  return aus;
}
