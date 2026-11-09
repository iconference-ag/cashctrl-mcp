import { CashCtrlError } from '../core/errors.js';
import { de } from './result.js';

/**
 * Loest ein Konto ueber seine Kontonummer auf — exakter Treffer, kein Praefix.
 * Der Mensch denkt in 3000/1020, nicht in internen IDs; die IDs sind je Mandant anders.
 * Feldname ist `number`, nicht `nr` (tests/fixtures/README.md, Abschnitt `account/list`),
 * der Name ist mehrsprachig und geht durch `de()`.
 *
 * Gemeinsam fuer das Ertrags-/Aufwandkonto je Belegposition (Task 15) und Soll/Haben der
 * manuellen Buchung (Task 18) — deshalb hier und nicht in einem der beiden Module.
 */
export function resolveAccount(accounts: { id: unknown; number: unknown; name: unknown }[], number: string): { id: number; number: string; name: string } {
  const a = accounts.find((x) => String(x.number) === number);
  if (!a) throw new CashCtrlError('validation', `Konto ${number} nicht gefunden.`);
  return { id: Number(a.id), number, name: de(a.name) };
}
