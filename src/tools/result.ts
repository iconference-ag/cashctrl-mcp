import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { CashCtrlError } from '../core/errors.js';

export const OrgParam = z.string().optional().describe('Name der Organisation aus der Konfiguration; bei genau einer Organisation optional');
export function clampLimit(n?: number): number { return Math.min(200, Math.max(1, n ?? 50)); }

const ISO_MUSTER = /^\d{4}-\d{2}-\d{2}$/;
const DATUM_UNGUELTIG = 'Datum ungültig (YYYY-MM-DD)';
/**
 * Ein Tag als UTC-Zeitpunkt. Bewusst `new Date(0)` + `setUTCFullYear` statt `Date.UTC`:
 * `Date.UTC` bildet Jahre unter 100 auf 19xx ab, `0050-01-01` waere sonst 1950.
 * Ein Tagesanteil ausserhalb des Monats wird normiert — genau das braucht `shiftDay`.
 */
function utcTag(y: number, m: number, d: number): Date {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t;
}
/**
 * Gibt es diesen Tag im Kalender? Die reine Regex laesst `2026-02-30` und `2026-13-45` durch;
 * die Bestandteile werden deshalb nach der Normierung zurueckverglichen.
 */
export function kalendergueltig(iso: string): boolean {
  if (!ISO_MUSTER.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const t = utcTag(y, m, d);
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
/**
 * Das eine Datumsschema fuer alle Werkzeuge (Spec §4: Daten ISO `YYYY-MM-DD`). Prueft Form
 * UND Kalender: ein Datum, das es nicht gibt, wuerde sonst still zu einem anderen Filtertag.
 */
export const IsoDatum = z.string().regex(ISO_MUSTER, DATUM_UNGUELTIG).refine(kalendergueltig, DATUM_UNGUELTIG);
/**
 * CashCtrl liefert Datumsfelder als `"2026-07-10 00:00:00.0"`; Spec §4 verlangt in den
 * Ausgaben ISO `YYYY-MM-DD`. Was kein String ist (haeufig `null`), bleibt `null`.
 */
export function isoTag(v: unknown): string | null {
  return typeof v === 'string' ? v.slice(0, 10) : null;
}
/**
 * Freitext fuer eine Vorschauzeile: Zeilenumbrueche werden zu ⏎, damit die Zusammenfassung
 * einzeilig bleibt, und der Text wird auf `max` Zeichen gekuerzt. Die Vorschau muss zeigen,
 * was commit ausfuehrt — aber nicht den ganzen Brief.
 */
export function vorschauText(s: string, max: number): string {
  const einzeilig = s.replace(/\r\n|[\r\n]/g, '⏎');
  return einzeilig.length > max ? einzeilig.slice(0, max) + '…' : einzeilig;
}
export function ok(data: unknown, note?: string): CallToolResult {
  const text = (note ? note + '\n' : '') + JSON.stringify(data, null, 1);
  return { content: [{ type: 'text', text }], structuredContent: data as Record<string, unknown> };
}
/** Nur die Meldung geht nach aussen — nie `details` einer CashCtrlError und nie der Schluessel. */
export function fail(err: unknown): CallToolResult {
  const msg = err instanceof CashCtrlError ? err.message : err instanceof Error ? `Fehler: ${err.message}` : 'Unbekannter Fehler';
  // Maschinenlesbare Fehlerart fuer Aufrufer ohne Textmuster: `sent` (nur POST), `createdId` und `reason` nur, wenn gesetzt.
  // `message` steht auch hier: Claude Desktop gibt dem Modell nur structuredContent weiter, wenn es vorhanden ist (25.10.2026).
  const structured: Record<string, unknown> = { kind: err instanceof CashCtrlError ? err.kind : 'unknown', message: msg };
  if (err instanceof CashCtrlError) {
    if (err.sent !== undefined) structured.sent = err.sent;
    if (err.createdId !== undefined) structured.createdId = err.createdId;
    if (err.reason !== undefined) structured.reason = err.reason;
  }
  return { content: [{ type: 'text', text: msg }], isError: true, structuredContent: structured };
}
export function page<T>(data: T[], total: number): { items: T[]; total: number; hasMore: boolean } {
  return { items: data, total, hasMore: total > data.length };
}
/**
 * Verschiebt ein Datum `YYYY-MM-DD` um `delta` Tage und gibt wieder `YYYY-MM-DD` zurueck.
 * Rechnet in UTC, damit keine Zeitzone und keine Sommerzeit hineinspielt.
 * Gebraucht fuer inklusive Bereichsgrenzen: CashCtrls Filter kennt nur `eq, like, gt, lt`,
 * eine inklusive Untergrenze ist also `gt (dateFrom − 1 Tag)`.
 * Prueft die Eingabe selbst: die Funktion ist auch ausserhalb der zod-Schemas erreichbar,
 * und ein Datum wie `2026-02-30` wuerde sonst still zu einem Filter auf den 3. Maerz.
 */
export function shiftDay(iso: string, delta: number): string {
  if (!kalendergueltig(iso)) throw new CashCtrlError('validation', `${DATUM_UNGUELTIG}: ${iso}`);
  const [y, m, d] = iso.split('-').map(Number);
  return utcTag(y, m, d + delta).toISOString().slice(0, 10);
}
/**
 * Heutiges Datum als `YYYY-MM-DD`. `date` ist bei `order/create` ein Pflichtfeld; fehlt es in
 * der Eingabe, gilt der heutige Tag. Bewusst aus den lokalen Feldern gebaut und nicht ueber
 * `toISOString()`: das rechnet nach UTC und liefert in der Schweiz kurz nach Mitternacht noch
 * den Vortag. `now` ist Parameter, damit die Funktion mit festem Datum pruefbar bleibt.
 */
export function heute(now: Date = new Date()): string {
  const zwei = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${zwei(now.getMonth() + 1)}-${zwei(now.getDate())}`;
}
/**
 * Loest ein mehrsprachiges XML-Fragment (`<values><de>…</de>…</values>`) zu seinem
 * `<de>`-Text auf, umgebender Text (Praefix wie bei `accountName`/`creditName`) bleibt
 * erhalten. Ohne Fragment oder ohne `<de>` bleibt der Eingabewert unveraendert.
 * Vertrag: tests/fixtures/README.md, Abschnitt "Mehrsprachige Werte".
 */
export function de(s: unknown): string {
  if (s === null || s === undefined) return '';
  const str = String(s);
  const m = /<values>[\s\S]*?<de>([\s\S]*?)<\/de>[\s\S]*?<\/values>/.exec(str);
  if (!m) return str;
  return str.slice(0, m.index) + m[1] + str.slice(m.index + m[0].length);
}
