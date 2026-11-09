import { CashCtrlError } from '../core/errors.js';
import { OFFEN_SATZ } from '../core/http.js';

/**
 * Die ID aus der Antwort von `order/create`, streng: eine ganze Zahl > 0 oder eine Ziffernfolge
 * ohne fuehrende Null. Alles andere (true, '1e2', '0x63', [99], ' 99 ', null-Body) ist «unklar»:
 * eine lockere Umwandlung schriebe danach an einen fremden Beleg. Welche Form CashCtrl sendet,
 * ist am Mandanten nicht gemessen (12.10.2026).
 */
export function angelegteId(r: unknown): number {
  const roh = r && typeof r === 'object' ? (r as { insertId?: unknown }).insertId : undefined;
  if (typeof roh === 'number' && Number.isSafeInteger(roh) && roh > 0) return roh;
  if (typeof roh === 'string' && /^[1-9]\d*$/.test(roh) && Number.isSafeInteger(Number(roh))) return Number(roh);
  throw new CashCtrlError('unknown', `CashCtrl meldet Erfolg ohne gültige insertId: ob der Beleg angelegt wurde, ist unklar. ${OFFEN_SATZ}`, undefined, { sent: true });
}

/**
 * Nach erfolgreichem `order/create` gilt: der Beleg EXISTIERT. Jeder weitere Fehler traegt seine
 * ID (`createdId`), damit der Aufrufer nicht erneut anlegt. Art des Fehlers bleibt erhalten.
 */
export function nachDemAnlegen(e: unknown, id: number): CashCtrlError {
  if (e instanceof CashCtrlError && e.createdId === id) return e;
  const hinweis = `Der Beleg ${id} ist in CashCtrl bereits angelegt (createdId ${id}); nicht erneut anlegen, sondern prüfen.`;
  if (e instanceof CashCtrlError) return e.withCreatedId(id, `${e.message} ${hinweis}`);
  return new CashCtrlError('unknown', `Fehler: ${e instanceof Error ? e.message : 'unbekannt'} ${hinweis}`, undefined, { sent: true, createdId: id });
}
