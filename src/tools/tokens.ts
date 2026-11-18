import { randomBytes } from 'node:crypto';
import { CashCtrlError } from '../core/errors.js';
import type { TokenStore } from '../core/stores.js';

interface Entry { kind: string; org: string; payload: unknown; expires: number }
/**
 * Einmal-Tokens fuer prepare/commit: 10 Minuten, nur im Speicher, gebunden an Art,
 * Organisation und die bei prepare gespeicherte Eingabe. Die Eingabe kommt beim Einloesen
 * aus diesem Speicher, nicht vom Aufrufer — sie kann zwischen prepare und commit nicht getauscht werden.
 * Eingebaute Implementation von `TokenStore` (core/stores.ts); der Desk bringt seine eigene mit.
 */
export class MemoryTokenStore implements TokenStore {
  private readonly entries = new Map<string, Entry>();
  /**
   * Hoechstzahl gleichzeitig offener Tokens je Art (0.6.0): eine Upload-Vorschau haelt die Datei bis zu 10 Minuten im Speicher
   * (bei 10 MB rund 14 MB Text), und ohne Grenze liesse sich der Speicher mit Vorschauen fuellen. Andere Arten sind nicht begrenzt.
   */
  static readonly GRENZEN: Readonly<Record<string, { max: number; text: string; zaehlt: (payload: unknown) => boolean }>> = {
    // Nur Vorschauen mit Datei (inhalt) zaehlen; eine mit blosser fileId haelt nichts im Speicher. Die Grenze gilt ueber alle Organisationen gemeinsam.
    file_upload: { max: 3, text: 'Zu viele offene Upload-Vorschauen; erst ausführen oder 10 Minuten warten.', zaehlt: (p) => (p as { inhalt?: unknown } | null)?.inhalt !== undefined },
  };
  constructor(private readonly ttlMs = 10 * 60 * 1000, private readonly now: () => number = () => Date.now()) {}
  async issue(kind: string, org: string, payload: unknown): Promise<{ token: string; expiresAt: string }> {
    const wert = randomBytes(12).toString('base64url');
    const jetzt = this.now();
    // Abgelaufene Eintraege werden hier weggeraeumt: ein nie eingeloestes prepare_* laesst
    // seine Eingabe sonst bis zum Prozessende im Speicher liegen.
    for (const [k, e] of this.entries) if (e.expires < jetzt) this.entries.delete(k);
    const grenze = MemoryTokenStore.GRENZEN[kind];
    if (grenze?.zaehlt(payload) && [...this.entries.values()].filter((e) => e.kind === kind && grenze.zaehlt(e.payload)).length >= grenze.max) throw new CashCtrlError('validation', grenze.text);
    const expires = jetzt + this.ttlMs;
    this.entries.set(wert, { kind, org, payload, expires });
    return { token: wert, expiresAt: new Date(expires).toISOString() };
  }
  async redeem<T>(kind: string, org: string, token: string): Promise<T> {
    const e = this.entries.get(token);
    if (!e) throw new CashCtrlError('validation', 'Token unbekannt oder schon verwendet — zuerst prepare_* aufrufen und die Vorschau bestätigen lassen.');
    if (e.expires < this.now()) { this.entries.delete(token); throw new CashCtrlError('validation', 'Token abgelaufen (10 Minuten) — prepare_* erneut aufrufen.'); }
    if (e.kind !== kind || e.org !== org) throw new CashCtrlError('validation', 'Token passt nicht zu diesem Werkzeug oder dieser Organisation.');
    this.entries.delete(token);
    return e.payload as T;
  }
}
