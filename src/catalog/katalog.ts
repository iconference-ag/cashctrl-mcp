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
export interface KatalogEndpunkt {
  path: string; method: 'GET' | 'POST'; title: string; area: string; params: KatalogParam[];
  /**
   * Regel «eines von» (0.6.0), nur an der Sicht von `endpunktFinden`, nie im erzeugten JSON: aus jeder Gruppe muss
   * mindestens ein Parameter gesetzt sein. Die Mitglieder einer Gruppe tragen dort `required: false`.
   */
  einesVon?: string[][];
}
export interface Katalog { stand: string; quelle: string; endpunkte: KatalogEndpunkt[] }

export const KATALOG = katalogJson as unknown as Katalog;

/** Art eines Endpunkts: lesend (GET), schreibend (POST), loeschend (POST auf `/delete.json`). */
export type Art = 'read' | 'write' | 'delete';
/** Opt-in je Organisation, den ein allgemeiner Endpunkt zusaetzlich braucht (Standard aus). */
export type Gate = 'salary' | 'deleteRecords' | 'sendMail';
/** Reihenfolge, in der Schalter genannt werden. */
const GATE_REIHE: Gate[] = ['salary', 'deleteRecords', 'sendMail'];

/**
 * Regel «eines von» (0.6.0): Die Doku fuehrt bei `person/create.json` und `person/update.json` company, firstName
 * und lastName alle drei als Pflicht; CashCtrl verlangt nur eines davon (Vorgabe des Auftrags 0.6.0; in diesem Repo nicht nachgemessen).
 * Die Regel liegt hier und nicht in `endpoints.json`: das ist ein Generat aus der Doku (`scripts/katalog.ts`) und wuerde
 * beim naechsten Erzeugen ueberschrieben. Je Pfad eine Liste von Gruppen; aus jeder Gruppe muss mindestens ein Parameter gesetzt sein.
 */
export const EINES_VON: Readonly<Record<string, readonly (readonly string[])[]>> = {
  'person/create.json': [['company', 'firstName', 'lastName']],
  'person/update.json': [['company', 'firstName', 'lastName']],
};

/** Der Eintrag, wie `endpunktFinden` ihn zeigt: Mitglieder einer Gruppe sind nicht mehr einzeln Pflicht, dafuer steht `einesVon` am Eintrag. */
function mitRegel(e: KatalogEndpunkt): KatalogEndpunkt {
  const gruppen = EINES_VON[e.path];
  if (!gruppen) return e;
  const mitglieder = new Set(gruppen.flat());
  return { ...e, params: e.params.map((p) => (mitglieder.has(p.name) ? { ...p, required: false } : p)), einesVon: gruppen.map((g) => [...g]) };
}

const NACH_PFAD = new Map(KATALOG.endpunkte.map((e) => [e.path, mitRegel(e)]));

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
/** In einer «eines von»-Gruppe zaehlt auch ein Wert nur aus Leerzeichen als nicht gesetzt. */
const fehltGruppe = (v: unknown): boolean => fehlt(v) || (typeof v === 'string' && v.trim() === '');

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
  // «Eines von»: eine Gruppe ohne jeden gesetzten Parameter fehlt wie ein Pflichtparameter.
  const gruppenFehlt = (e.einesVon ?? []).filter((g) => g.every((n) => fehltGruppe(eingabe[n]))).map((g) => `mindestens eines von ${g.join(', ')}`);
  if (fehlend.length || gruppenFehlt.length) throw new CashCtrlError('validation', `Pflichtparameter fehlen für ${e.path}: ${[...fehlend, ...gruppenFehlt].join('; ')}.`);
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
