import type { UsageState } from './usage.js';

/**
 * Die Speicherschnittstelle der Werkzeugschicht (Desk-Spec O125). Drei Verträge, damit die
 * Werkzeuge ohne Dateien und ohne Prozessspeicher laufen koennen — in einem Cloudflare Worker ist
 * `node:fs` je Anfrage fluechtig und ein Isolate zwischen prepare und commit nicht garantiert.
 * Fehlt `deps.stores`, gelten die eingebauten Implementationen (Datei-Zaehler, Speicher-Token,
 * PDF-Datei unter `pdfDir`); MCP-Server und Paket bleiben unveraendert.
 */
export interface UsageStore { state(org: string): Promise<UsageState>; record(org: string): Promise<UsageState> }
export interface TokenStore {
  issue(kind: string, org: string, payload: unknown): Promise<{ token: string; expiresAt: string }>;
  redeem<T>(kind: string, org: string, token: string): Promise<T>;
}
/** Legt das PDF ab und liefert eine Ref, die der Aufrufer versteht (Dateipfad, Schluessel, Adresse). */
export interface PdfStore { put(org: string, name: string, bytes: Uint8Array): Promise<string> }
export interface Stores { usage?: UsageStore; tokens?: TokenStore; pdf?: PdfStore }
