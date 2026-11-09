import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { CashCtrlError } from '../../core/errors.js';
import { KATALOG, einordnen, endpunktFinden, ohneJson, paramsPruefen, type KatalogEndpunkt } from '../../catalog/katalog.js';
import type { ToolContext } from '../context.js';
import { tool, type ToolModule } from '../def.js';
import { ok, fail, OrgParam } from '../result.js';
import { pruefeSchalter } from './schalter.js';

/** Obergrenze der Antwort an das Modell (Zeichen). Mehr sprengt den Kontext; der Aufrufer soll eingrenzen. */
export const MAX_ANTWORT = 60000;
const MAX_TREFFER = 100;

/** Ein Parameterwert: Text, Zahl, Wahrheitswert oder ein JSON-Objekt/-Array (so wie die HTTP-Schicht es kodiert). */
export const Wert = z.union([z.string(), z.number(), z.boolean(), z.array(z.unknown()), z.record(z.string(), z.unknown())]);
export const ParamsSchema = z.record(z.string(), Wert);

/** Kurzform eines Katalogeintrags: Einordnung (kind) und Schalter (gate; gates, wenn es mehrere sind). */
function kurz(e: KatalogEndpunkt) {
  const { art, gates } = einordnen(e);
  return { path: e.path, method: e.method, title: e.title, kind: art, ...(gates.length ? { gate: gates[0] } : {}), ...(gates.length > 1 ? { gates } : {}) };
}

const BEKANNT_NICHT = (path: string) => new CashCtrlError('validation', `Pfad nicht im Katalog: ${path}. Mit api_catalog (query oder area) suchen.`);

export async function catalogTool(a: { query?: string; area?: string; path?: string }): Promise<CallToolResult> {
  try {
    if (a.path !== undefined && a.path.trim() !== '') {
      const e = endpunktFinden(a.path);
      if (!e) throw BEKANNT_NICHT(a.path);
      return ok({ ...kurz(e), area: e.area, params: e.params });
    }
    const worte = (a.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const area = a.area?.trim().toLowerCase();
    const treffer = KATALOG.endpunkte.filter((e) => {
      if (area && e.area !== area) return false;
      const heu = `${e.path} ${e.title}`.toLowerCase();
      return worte.every((w) => heu.includes(w));
    });
    const out: Record<string, unknown> = { items: treffer.slice(0, MAX_TREFFER).map(kurz), total: treffer.length, hasMore: treffer.length > MAX_TREFFER };
    // Ohne Filter oder ohne Treffer hilft die Liste der Bereiche beim naechsten Versuch.
    if ((!area && worte.length === 0) || treffer.length === 0) out.areas = [...new Set(KATALOG.endpunkte.map((e) => e.area))];
    return ok(out);
  } catch (e) { return fail(e); }
}

/** Endung fuer eine abgelegte Datei: die des Katalogpfads, sonst aus dem Inhaltstyp, sonst `bin`. */
function endung(path: string, contentType: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path.split('/').pop() ?? '');
  if (m) return m[1].toLowerCase();
  const typ = contentType.toLowerCase();
  if (typ.includes('pdf')) return 'pdf';
  if (typ.includes('zip')) return 'zip';
  if (typ.includes('png')) return 'png';
  if (typ.includes('jpeg') || typ.includes('jpg')) return 'jpg';
  return 'bin';
}
/** `order/document/read.pdf` → `order_document_read-20261024T225500-123Z.pdf` */
export function dateiname(path: string, contentType: string, jetzt: Date = new Date()): string {
  const e = endung(path, contentType);
  const basis = path.replace(/\.[a-z0-9]+$/i, '').replace(/\//g, '_');
  const zeit = jetzt.toISOString().replace(/[-:]/g, '').replace('.', '-');
  return `${basis}-${zeit}.${e}`;
}

/**
 * Text an das Modell: auf MAX_ANTWORT gekappt, mit Hinweis. Derselbe gekappte Text steht in `content` UND als `body` in
 * structuredContent: Claude Desktop gibt dem Modell nur structuredContent weiter, wenn es vorhanden ist (Meldung aus Claude
 * Desktop, 25.10.2026: «api_read liefert keine Daten zurück»). Die Kappung gilt fuer beide Felder.
 */
function textAntwort(path: string, contentType: string, text: string): CallToolResult {
  const gekappt = text.length > MAX_ANTWORT;
  const hinweis = gekappt ? `[Antwort auf ${MAX_ANTWORT} von ${text.length} Zeichen gekürzt. Mit limit und start blättern oder mit Filtern eingrenzen, soweit der Endpunkt sie kennt.]\n` : '';
  const body = hinweis + (gekappt ? text.slice(0, MAX_ANTWORT) : text);
  return {
    content: [{ type: 'text', text: body }],
    structuredContent: { path, contentType, chars: text.length, truncated: gekappt, body },
  };
}

export async function readTool(ctx: ToolContext, a: { org?: string; path: string; params?: Record<string, unknown> }): Promise<CallToolResult> {
  try {
    const org = ctx.orgName(a.org);
    const e = endpunktFinden(a.path);
    if (!e) throw BEKANNT_NICHT(a.path);
    if (e.method !== 'GET') throw new CashCtrlError('validation', `${e.path} ändert Daten (POST). api_read liest nur; schreiben geht über prepare_api_write und commit_api_write.`);
    pruefeSchalter(ctx, org, einordnen(e).gates);
    const params = paramsPruefen(e, a.params);
    const client = ctx.client(org);
    if (e.path.endsWith('.json')) {
      // Der bestehende JSON-Weg: success:false und die Fehlerarten werden dort gleich behandelt.
      return textAntwort(e.path, 'application/json', JSON.stringify(await client.apiGet(ohneJson(e.path), params)));
    }
    const r = await client.apiGetRaw(e.path, params);
    if ('text' in r) return textAntwort(e.path, r.contentType, r.text);
    const file = await ctx.pdf.put(org, dateiname(e.path, r.contentType), r.bytes);
    return ok({ file, bytes: r.bytes.length, contentType: r.contentType });
  } catch (err) { return fail(err); }
}

export const apiReadModule: ToolModule = {
  tools(ctx: ToolContext) { return [
    tool('api_catalog', 'read', {
      title: 'CashCtrl-API-Katalog',
      description: 'Durchsucht den eingebauten Katalog der CashCtrl-API (376 Endpunkte, Stand 24.10.2026), ohne Netzaufruf. ZUERST hier Pfad und Parameter finden, bevor api_read oder prepare_api_write aufgerufen wird. Mit path: der volle Eintrag samt Parametern (Pflicht, Typ, bei JSON-Parametern die Felder der Elemente). Ohne path: Treffer zu query (Wörter in Pfad oder Titel, englisch) und area (erstes Pfadsegment, z.B. person, order, salary), höchstens 100, dazu total. kind: read (GET), write (POST), delete (POST auf /delete.json, dazu file/empty_archive.json). gate nennt den Schalter der Organisation, den der Endpunkt zusätzlich braucht (salary, deleteRecords, sendMail; gates, wenn es mehrere sind). Wo ein Fachwerkzeug dasselbe leistet (search_contacts, get_order, prepare_order_create usw.), das Fachwerkzeug vorziehen: es prüft mehr.',
      inputSchema: z.object({
        query: z.string().optional().describe('Suchwörter (englisch), alle müssen in Pfad oder Titel vorkommen'),
        area: z.string().optional().describe('Bereich = erstes Pfadsegment, z.B. person, order, salary'),
        path: z.string().optional().describe('Genauer Pfad, z.B. person/list.json; liefert den vollen Eintrag mit Parametern'),
      }),
      // Liest nur den eingebauten Katalog, kein Aufruf nach draussen (wie usage): openWorldHint false.
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async (a) => catalogTool(a)),
    tool('api_read', 'read', {
      title: 'CashCtrl lesen (allgemein)',
      description: 'Liest über einen beliebigen GET-Endpunkt des Katalogs (api_catalog). Fachwerkzeuge (search_contacts, get_order, search_journal usw.) vorziehen, wo es sie gibt; dieser Weg ist für den Rest. params: Name → Wert (Text, Zahl, Wahrheitswert; JSON-Objekt oder Liste bei JSON-Parametern; eine Liste bei einem CSV-Parameter wird mit Komma verbunden). Der Server prüft vor dem Aufruf: Pfad im Katalog, Methode GET, Pflichtparameter, nur bekannte Parameter. Lohn-Endpunkte (salary/…) nur, wenn die Organisation den Schalter salary trägt. Antworten über 60000 Zeichen werden gekürzt: mit limit und start blättern. Text und CSV kommen als Text, Dateien (PDF, Excel, ZIP) werden abgelegt; die Antwort nennt dann file, bytes und contentType.',
      inputSchema: z.object({
        org: OrgParam,
        path: z.string().min(1).describe('Pfad aus api_catalog, z.B. person/list.json'),
        params: ParamsSchema.optional().describe('Parameter des Endpunkts (Name → Wert), siehe api_catalog'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    }, async (a) => readTool(ctx, a)),
  ]; },
};
