import type { Config, Mode } from '../config/config.js';
import { CashCtrlClient } from '../core/client.js';
import { CashCtrlError } from '../core/errors.js';
import { CashCtrlHttp } from '../core/http.js';
import { TokenBucket } from '../core/ratelimit.js';
import { MONATSLIMIT, UsageCounter } from '../core/usage.js';
import type { PdfStore, Stores, TokenStore, UsageStore } from '../core/stores.js';
import { FilePdfStore } from '../core/pdfstore.js';
import { MemoryTokenStore } from './tokens.js';

/**
 * Was die Werkzeuge von einer Organisation wissen duerfen. Der Schluessel steht bewusst NICHT
 * darin: `ToolContext` wandert durch jedes Werkzeugmodul, und ein `JSON.stringify` davon —
 * in einem Log, einer Fehlermeldung, einem fremden Modul — haette ihn sonst mitgenommen.
 * `keyPrefix` sind die ersten vier Zeichen; mehr braucht `usage` nicht.
 */
export interface OrgSicht { name: string; subdomain: string; keyPrefix: string; sendMail: boolean; deleteOrders: boolean; salary: boolean; deleteRecords: boolean }
export interface ConfigSicht { mode: Mode; pdfDir: string; usageFile: string; source: 'file' | 'env'; orgs: OrgSicht[] }

export interface ToolContext {
  config: ConfigSicht; clients: Map<string, CashCtrlClient>; tokens: TokenStore; usage: UsageStore; pdf: PdfStore;
  client(org?: string): CashCtrlClient; orgName(org?: string): string;
  /** Letzter Kontingent-Hinweis dieser Organisation (Spec §9, ab 80 %), sonst `undefined`. */
  warnung(org?: string): string | undefined;
  /** Zahl der POST dieser Organisation, die CashCtrl erreicht haben koennten (CashCtrlHttp.gesendet). */
  gesendet(org: string): number;
  /** Firmenname des Hauptstandorts fuer die Vorschau (B-MCP-3), je Organisation einmal gelesen; `undefined`, wenn CashCtrl ihn nicht liefert. */
  firma(org: string): Promise<string | undefined>;
}
/**
 * Firmenname des Hauptstandorts aus `location/list`: `orgName` (z. B. «Nothing-Toulouse AG»);
 * `name` ist nur die Standortbezeichnung (z. B. «Hauptsitz Zug») und dient als Rueckfall.
 */
export function hauptfirma(locs: unknown[]): string {
  const erster = locs[0] as { orgName?: unknown; name?: unknown } | undefined;
  return String(erster?.orgName ?? erster?.name ?? '');
}
export function buildContext(config: Config, deps: { fetchImpl?: typeof fetch; now?: () => Date; stores?: Stores } = {}): ToolContext {
  // O125: der Aufrufer darf Zaehler, Token und PDF-Ablage mitbringen; sonst die eingebauten.
  const usage: UsageStore = deps.stores?.usage ?? new UsageCounter(config.usageFile, MONATSLIMIT, deps.now);
  const clients = new Map<string, CashCtrlClient>();
  // Die HTTP-Schicht wird zusaetzlich je Organisation gehalten: dort steht nach jedem Aufruf
  // der Kontingent-Hinweis, den die Werkzeugantwort tragen muss.
  const https = new Map<string, CashCtrlHttp>();
  // Spec §9: ein Bucket je CashCtrl-Instanz, also je Subdomain — nicht je Client.
  // Zwei Organisationen auf derselben Subdomain wuerden mit je eigenem Bucket
  // gemeinsam ueber die 300/30-pro-Sekunde-Grenze laufen.
  const buckets = new Map<string, TokenBucket>();
  for (const o of config.orgs) {
    let bucket = buckets.get(o.subdomain);
    if (!bucket) { bucket = new TokenBucket(300, 30); buckets.set(o.subdomain, bucket); }
    const http = new CashCtrlHttp({ subdomain: o.subdomain, 'apiKey': o['apiKey'], org: o.name, bucket, usage, fetchImpl: deps.fetchImpl });
    https.set(o.name, http);
    clients.set(o.name, new CashCtrlClient(http));
  }
  const sicht: ConfigSicht = {
    mode: config.mode, pdfDir: config.pdfDir, usageFile: config.usageFile, source: config.source,
    orgs: config.orgs.map((o) => ({ name: o.name, subdomain: o.subdomain, keyPrefix: o['apiKey'].slice(0, 4), sendMail: Boolean(o.sendMail), deleteOrders: Boolean(o.deleteOrders), salary: Boolean(o.salary), deleteRecords: Boolean(o.deleteRecords) })),
  };
  const orgName = (org?: string): string => {
    if (org) { if (!clients.has(org)) throw new CashCtrlError('validation', `Organisation unbekannt: ${org}. Bekannt: ${[...clients.keys()].join(', ')}`); return org; }
    if (clients.size === 1) return [...clients.keys()][0];
    throw new CashCtrlError('validation', `Mehrere Organisationen konfiguriert — org angeben: ${[...clients.keys()].join(', ')}`);
  };
  // Ein unbekannter oder fehlender Organisationsname ist hier kein Fehler: der Hinweis ist ein
  // Anhang an die Antwort, er darf sie nicht ersetzen. Die eigentliche Meldung kommt aus dem Werkzeug.
  const warnung = (org?: string): string | undefined => {
    try { return https.get(orgName(org))?.lastWarning; } catch { return undefined; }
  };
  // B-MCP-3: Ein Fehlschlag ist kein Fehler der Vorschau und wird nicht gemerkt, der naechste Aufruf versucht es wieder.
  const firmen = new Map<string, string>();
  const firma = async (org: string): Promise<string | undefined> => {
    const bekannt = firmen.get(org);
    if (bekannt !== undefined) return bekannt;
    try {
      const name = hauptfirma(await clients.get(org)!.listLocations());
      if (name === '') return undefined;
      firmen.set(org, name);
      return name;
    } catch { return undefined; }
  };
  return { config: sicht, clients, tokens: deps.stores?.tokens ?? new MemoryTokenStore(), usage, pdf: deps.stores?.pdf ?? new FilePdfStore(config.pdfDir), orgName, warnung, gesendet: (org) => https.get(org)?.gesendet ?? 0, client: (org) => clients.get(orgName(org))!, firma };
}
