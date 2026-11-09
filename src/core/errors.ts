export type ErrorKind = 'auth' | 'forbidden' | 'not_found' | 'validation' | 'rate_limit' | 'quota' | 'network' | 'unknown';
/** Fester Grund einer Abweisung, damit Aufrufer ohne Textmuster unterscheiden koennen (geschlossene Liste, ab 0.2.3).
 *  Seit 0.3.0 ist die Liste leer: der einzige Grund (das negative Total) ist mit B8 entfallen, CashCtrl nimmt ein negatives Total an
 *  (M-1d, 17.10.2026). Der Mechanismus bleibt fuer kuenftige Gruende; ein Fehler mit `sent: true` oder `createdId` traegt nie einen reason. */
export type ErrorReason = never;
/** Zusatzangaben, die nach aussen gehen duerfen (structuredContent von `fail()`); `details` nie. */
export interface ErrorExtra {
  /** Nur bei POST: koennte die Anfrage CashCtrl erreicht haben? Im Zweifel true (Ausgang unklar, nie automatisch wiederholen). */
  sent?: boolean;
  /** ID eines Belegs, der bereits angelegt wurde, bevor der Fehler auftrat. */
  createdId?: number;
  /** Fester Grund der Abweisung (siehe ErrorReason). */
  reason?: ErrorReason;
}
export class CashCtrlError extends Error {
  readonly sent?: boolean;
  readonly createdId?: number;
  readonly reason?: ErrorReason;
  constructor(public readonly kind: ErrorKind, message: string, public readonly details?: unknown, extra?: ErrorExtra) {
    super(message);
    this.name = 'CashCtrlError';
    if (extra?.sent !== undefined) this.sent = extra.sent;
    if (extra?.createdId !== undefined) this.createdId = extra.createdId;
    if (extra?.reason !== undefined) this.reason = extra.reason;
  }
  /** Gleicher Fehler, aber mit bekannter Beleg-ID (der POST, der sie lieferte, hat CashCtrl erreicht: sent true). */
  withCreatedId(id: number, message = this.message): CashCtrlError {
    // Ohne reason: nach einem Schreibaufruf gibt es keinen festen Abweisungsgrund mehr (Review 12.10.2026, wie nachSchreiben).
    return new CashCtrlError(this.kind, message, this.details, { sent: true, createdId: id });
  }
}
