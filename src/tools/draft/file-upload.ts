import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Rec } from '../../core/client.js';
import type { CashCtrlClient } from '../../core/client.js';
import { CashCtrlError } from '../../core/errors.js';
import { erlaubteHosts } from '../../core/objektspeicher.js';
import type { ToolContext } from '../context.js';
import type { ToolModule } from '../def.js';
import { OrgParam } from '../result.js';
import { twoPhaseTools } from '../twophase.js';

/**
 * Datei hochladen und an einen Beleg haengen (0.6.0): `prepare_file_upload` / `commit_file_upload`.
 * Ablauf in CashCtrl (am Demo-Mandanten gemessen, 18.11.2026; das Werkzeug dort ebenfalls, mit Anhang an einen Beleg mit vorhandenem Anhang):
 * file/prepare (fileId + writeUrl), PUT der Bytes in den Objektspeicher, file/persist, order/update_attachments.
 * Die `writeUrl` verlaesst diesen Prozess nie: sie steht in keiner Antwort und keiner Meldung.
 */

/** Hoechstgroesse einer Datei: 10 MiB. Darueber weist schon prepare ab, nichts davon geht ins Netz. */
export const MAX_BYTES = 10 * 1024 * 1024;
const MAX_BASE64 = Math.ceil(MAX_BYTES / 3) * 4;
/** Obergrenze des rohen Textes vor jeder Verarbeitung: Base64 plus Zeilenumbruch (CRLF alle 76 Zeichen braucht rund 2/76, hier 2/64 Reserve). Verhindert, dass ein Riesenwert erst gestrippt wird. */
const MAX_ROH = MAX_BASE64 + 2 * Math.ceil(MAX_BASE64 / 64);
const MAX_NAME = 255;
const PDF_KOPF = '%PDF-';
/** Wie lange CashCtrl eine nicht festgehaltene Datei aufbewahrt (Doku von file/prepare). */
const VERFALL = 'CashCtrl löscht nicht festgehaltene Dateien nach 4 Stunden';

const inValid = (m: string) => new CashCtrlError('validation', m);

/** inhalt: Base64-Text (ueber MCP) oder Uint8Array (nur im Prozess, ueber toolset.call). Das JSON-Schema fuer MCP nennt nur den Text. */
const Inhalt = z.any().refine((v) => v === undefined || typeof v === 'string' || v instanceof Uint8Array, 'inhalt: Base64-Text oder Uint8Array erwartet')
  .meta({ type: 'string', description: 'Der Inhalt der PDF-Datei als Base64-Text. Nie ein Dateipfad: ein Pfad wird abgewiesen, ein Eingabefeld für Pfade gibt es nicht. Entweder inhalt oder fileId.' });

const Input = z.object({
  org: OrgParam,
  name: z.string().max(MAX_NAME).optional().describe('Dateiname, z.B. rechnung-2026-001.pdf; ohne / und \\, ohne Steuerzeichen, höchstens 255 Zeichen. Pflicht bei inhalt.'),
  inhalt: Inhalt.optional(),
  mimeType: z.literal('application/pdf').optional().describe('Nur application/pdf; ohne Angabe gilt es.'),
  fileId: z.number().int().positive().optional().describe('Kennung einer schon festgehaltenen Datei: dann wird nur noch angehängt (nichts hochgeladen). Entweder inhalt oder fileId; mit fileId ist anhaengenAn Pflicht.'),
  anhaengenAn: z.object({ art: z.literal('order'), id: z.number().int().positive() }).optional().describe('Ziel: art order (Beleg) und seine Kennung. Ohne Angabe wird die Datei nur in die Dateiablage von CashCtrl gelegt. Bisherige Anhänge des Belegs bleiben.'),
});
interface Payload {
  /** Die Bytes als Base64-Text: JSON-tauglich, damit auch ein serialisierender Token-Speicher sie traegt. Nur beim Hochladen. */
  inhalt?: string; name?: string; bytes?: number; sha256?: string;
  fileId?: number; ziel?: { art: 'order'; id: number };
}

/** Der Name wird Teil der Adresse und des Dateiarchivs: kein Pfadtrenner, keine Steuerzeichen, hoechstens 255 Zeichen. */
export function pruefeName(name: unknown): string {
  if (typeof name !== 'string' || name === '') throw inValid('name fehlt: der Dateiname ist beim Hochladen Pflicht.');
  if (name === '.' || name === '..') throw inValid('name darf nicht . oder .. sein.');
  if (name.length > MAX_NAME) throw inValid(`name ist zu lang (${name.length} Zeichen, höchstens ${MAX_NAME}).`);
  if (/[/\\]/.test(name)) throw inValid('name darf weder / noch \\ enthalten (nur der Dateiname, kein Pfad).');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) throw inValid('name darf keine Steuerzeichen enthalten.');
  return name;
}

const PFAD_BEGINN = /^(?:~|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/]|\\\\|file:)/i;
const PFAD_HINWEIS = 'Dateipfade werden nie angenommen: der Inhalt der Datei muss als Base64-Text übergeben werden.';

/**
 * Die Bytes aus der Eingabe, streng geprueft: Base64 nur im Standardalphabet und kanonisch (`Buffer.from` schluckt sonst
 * ungueltige Zeichen still), Laenge vor dem Dekodieren, hoechstens 10 MiB, Anfang `%PDF-`. Ein Pfad wird abgewiesen; ein Wert
 * mit `/` am Anfang kann kein Base64 eines PDF sein (`%PDF` kodiert zu `JVBE…`).
 */
export function bytesAusEingabe(inhalt: unknown): Uint8Array {
  let bytes: Uint8Array;
  if (inhalt instanceof Uint8Array) {
    if (inhalt.length > MAX_BYTES) throw inValid(`Die Datei ist zu gross (${inhalt.length} Bytes, höchstens ${MAX_BYTES} = 10 MB).`);
    bytes = new Uint8Array(inhalt);   // Kopie: der Aufrufer darf seinen Puffer zwischen prepare und commit nicht mehr aendern koennen
  } else if (typeof inhalt === 'string') {
    if (PFAD_BEGINN.test(inhalt)) throw inValid(`inhalt sieht wie ein Dateipfad aus. ${PFAD_HINWEIS}`);
    if (inhalt.length > MAX_ROH) throw inValid(`Die Datei ist zu gross (höchstens ${MAX_BYTES} Bytes = 10 MB).`);
    const b64 = inhalt.replace(/\s+/g, '');
    if (b64 === '' || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw inValid(`inhalt ist kein gültiges Base64. ${PFAD_HINWEIS}`);
    if (b64.length > MAX_BASE64) throw inValid(`Die Datei ist zu gross (höchstens ${MAX_BYTES} Bytes = 10 MB).`);
    const roh = Buffer.from(b64, 'base64');
    if (roh.toString('base64') !== b64) throw inValid(`inhalt ist kein gültiges Base64. ${PFAD_HINWEIS}`);
    if (roh.length > MAX_BYTES) throw inValid(`Die Datei ist zu gross (${roh.length} Bytes, höchstens ${MAX_BYTES} = 10 MB).`);
    bytes = new Uint8Array(roh.buffer, roh.byteOffset, roh.length);
  } else throw inValid('inhalt fehlt oder hat die falsche Form (Base64-Text erwartet).');
  if (bytes.length === 0) throw inValid('Die Datei ist leer.');
  if (Buffer.from(bytes.subarray(0, PDF_KOPF.length)).toString('latin1') !== PDF_KOPF) throw inValid(`Keine PDF-Datei: die ersten Bytes sind nicht ${PDF_KOPF}. ${PFAD_HINWEIS}`);
  return bytes;
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const ohneWiederholen = (m: string): string => m.replace(/ — bitte erneut versuchen\.$/, '.');
const msgVon = (e: unknown): string => (e instanceof CashCtrlError ? ohneWiederholen(e.message) : 'Unerwarteter Fehler.');
const kindVon = (e: unknown) => (e instanceof CashCtrlError ? e.kind : 'unknown' as const);

/** Alles, was an der Adresse geheim ist: der ganze Text, die geparste Fassung, ihr Pfad und das Token darin. */
function geheimnisse(writeUrl: unknown): string[] {
  if (typeof writeUrl !== 'string' || writeUrl === '') return [];
  const g = [writeUrl];
  try { const u = new URL(writeUrl); g.push(u.href, u.pathname, u.pathname + u.search); const token = u.pathname.split('/')[2]; if (token && token.length >= 8) g.push(token); } catch { /* keine gueltige Adresse: der Rohtext genuegt */ }
  return g.filter((x) => x.length >= 8).sort((a, b) => b.length - a.length);
}
/** Letzte Sicherung: kein Fehler verlaesst den Ablauf mit einem Stueck der Adresse im Text, auch nicht aus einer fremden Ausnahme. */
function ohneAdresse(e: unknown, geheim: string[]): unknown {
  if (geheim.length === 0) return e;
  // Eine fremde Ausnahme (kein CashCtrlError) bekommt einen festen Text: ihre Meldung koennte die Adresse tragen.
  if (!(e instanceof CashCtrlError)) return new CashCtrlError('unknown', 'Unerwarteter Fehler beim Hochladen; die Upload-Adresse wird nicht gezeigt. Ob CashCtrl eine Datei angelegt hat, ist offen: in CashCtrl nachsehen.', undefined, { sent: true });
  let text = e.message;
  for (const g of geheim) text = text.split(g).join('[Upload-Adresse]');
  if (text === e.message) return e;
  return new CashCtrlError(e.kind, text, undefined, { ...(e.sent !== undefined ? { sent: e.sent } : {}), ...(e.createdId !== undefined ? { createdId: e.createdId } : {}), ...(e.fileId !== undefined ? { fileId: e.fileId } : {}), ...(e.festgehalten !== undefined ? { festgehalten: e.festgehalten } : {}) });
}

/** Fehler nach `file/prepare`, vor dem Festhalten: ab hier hat CashCtrl eine Datei angelegt (sent: true), der Text nennt den bekannten Zustand statt des allgemeinen «Ausgang offen». */
function vorFesthalten(e: unknown, fileId: number): CashCtrlError {
  return new CashCtrlError(kindVon(e), `${msgVon(e)} Die Datei ist nicht festgehalten (fileId ${fileId}); ${VERFALL}. Zum Wiederholen prepare_file_upload neu aufrufen.`, undefined, { sent: true, fileId, festgehalten: 'nein' });
}
function beimFesthalten(e: unknown, fileId: number): CashCtrlError {
  const abgewiesen = e instanceof CashCtrlError && e.sent === false;
  const satz = abgewiesen
    ? `Die Datei ist hochgeladen, aber nicht festgehalten (fileId ${fileId}); ${VERFALL}. Zum Wiederholen prepare_file_upload neu aufrufen.`
    : `Ob die Datei festgehalten ist, ist offen (fileId ${fileId}): in CashCtrl nachsehen. Ist sie festgehalten, nur noch anhängen (prepare_file_upload mit fileId ${fileId} und anhaengenAn).`;
  return new CashCtrlError(kindVon(e), `${msgVon(e)} ${satz}`, undefined, { sent: true, fileId, festgehalten: abgewiesen ? 'nein' : 'offen' });
}

/**
 * Die bisherigen Anhaenge eines Belegs (`attachments[].fileId` aus `order/read`). Ist die Liste nicht eindeutig lesbar, wirft sie:
 * `fileIds` ersetzt bei `order/update_attachments` sonst alle bisherigen Anhaenge (leer = alle entfernen).
 */
async function anhangliste(client: CashCtrlClient, orderId: number): Promise<number[]> {
  const o = await client.readOrder(orderId);
  if (!o || typeof o !== 'object') throw new CashCtrlError('unknown', `order/read liefert für Beleg ${orderId} keinen Beleg; um keinen Anhang zu überschreiben, wird nichts gesendet.`);
  const att = (o as Rec).attachments;
  if (!Array.isArray(att)) throw new CashCtrlError('unknown', `order/read liefert für Beleg ${orderId} keine Anhangliste; um keinen Anhang zu überschreiben, wird nichts gesendet.`);
  const vorhanden = att.map((x) => Number((x as Rec | null)?.fileId));
  if (vorhanden.some((n) => !Number.isInteger(n) || n <= 0)) throw new CashCtrlError('unknown', `Die Anhangliste von Beleg ${orderId} ist nicht eindeutig lesbar; um keinen Anhang zu überschreiben, wird nichts gesendet.`);
  return vorhanden;
}

/**
 * Schritt 5: die Anhangliste frisch lesen, die neue Kennung anfuegen, die GANZE Liste senden. Eine schon angehaengte Datei bleibt,
 * ohne zweiten POST (Wiederholung ist harmlos).
 */
async function anhaengen(client: CashCtrlClient, ziel: { id: number }, fileId: number, nachUpload: boolean): Promise<number[]> {
  let gepostet = false;
  try {
    const vorhanden = await anhangliste(client, ziel.id);
    if (vorhanden.includes(fileId)) return vorhanden;
    const ids = [...vorhanden, fileId];
    gepostet = true;
    await client.updateOrderAttachments({ id: ziel.id, fileIds: ids });
    return ids;
  } catch (e) {
    const offen = gepostet && !(e instanceof CashCtrlError && e.sent === false);
    const kopf = nachUpload
      ? `Die Datei ist festgehalten (fileId ${fileId}), aber nicht an Beleg ${ziel.id} angehängt. Nur noch anhängen: prepare_file_upload mit fileId ${fileId} und anhaengenAn.`
      : `fileId ${fileId} wurde nicht an Beleg ${ziel.id} angehängt.`;
    const satz = offen ? ' Ob das Anhängen ausgeführt wurde, ist offen: den Beleg in CashCtrl prüfen, bevor man es wiederholt.' : '';
    const sent = nachUpload || offen ? true : (e instanceof CashCtrlError ? e.sent : undefined);
    // Mit Upload ist die Datei festgehalten ('ja'); beim blossen Anhaengen weiss das Werkzeug es nicht und behauptet es nicht.
    throw new CashCtrlError(kindVon(e), `${msgVon(e)} ${kopf}${satz}`, undefined, { ...(sent === undefined ? {} : { sent }), fileId, ...(nachUpload ? { festgehalten: 'ja' as const } : {}) });
  }
}

export const fileUploadModule: ToolModule = {
  tools(ctx: ToolContext) {
    return twoPhaseTools<typeof Input, Payload>(ctx, 'draft', {
      kind: 'file_upload', title: 'PDF hochladen und anhängen', destructive: false, input: Input, ohneNetz: true,
      description: 'Legt eine PDF-Datei (höchstens 10 MB) in der Dateiablage von CashCtrl ab und hängt sie auf Wunsch an einen Beleg (anhaengenAn: art order, id). inhalt ist der Base64-Text der Datei, nie ein Dateipfad; name ist der Dateiname ohne / und \\. Oder fileId einer schon festgehaltenen Datei: dann wird nur angehängt. Die bisherigen Anhänge des Belegs bleiben. prepare ruft CashCtrl nicht auf und zeigt Name, Grösse, SHA-256 und Ziel. commit lädt zum Objektspeicher von CashCtrl hoch (Oracle Cloud, Region aus der Konfiguration, Standard eu-zurich-1) und prüft die Prüfsumme. Löscht nichts. Am Demo-Mandanten gemessen (18.11.2026).',
      async prepare(c, a) {
        const org = c.orgName(a.org);
        if (a.inhalt !== undefined && a.fileId !== undefined) throw inValid('Entweder inhalt oder fileId angeben, nicht beides.');
        if (a.inhalt === undefined && a.fileId === undefined) throw inValid('inhalt (Base64 der PDF-Datei) oder fileId (schon festgehaltene Datei) angeben.');
        const ziel = a.anhaengenAn ? { art: 'order' as const, id: a.anhaengenAn.id } : undefined;
        if (a.fileId !== undefined) {
          if (!ziel) throw inValid('fileId ohne anhaengenAn: es gäbe nichts zu tun. Ziel angeben (anhaengenAn: art order, id).');
          return {
            summary: `Datei fileId ${a.fileId} an Beleg ${ziel.id} in ${org} anhängen (nichts wird hochgeladen; bisherige Anhänge bleiben)`,
            warnings: [`fileId ${a.fileId} wird vor dem Anhängen nicht geprüft; sie muss eine in CashCtrl festgehaltene Datei dieser Organisation sein.`],
            payload: { fileId: a.fileId, ziel },
          };
        }
        const name = pruefeName(a.name);
        const bytes = bytesAusEingabe(a.inhalt);
        const hash = sha256(bytes);
        const regionen = c.config.orgs.find((o) => o.name === org)?.uploadRegions ?? [];
        const warnings = [`Die Datei wird zum Objektspeicher von CashCtrl (${erlaubteHosts(regionen).join(' oder ')}) übertragen und danach in CashCtrl festgehalten. Dieses Werkzeug löscht nichts.`];
        if (ziel) warnings.push(`Beleg ${ziel.id} bekommt die Datei zusätzlich: die bisherigen Anhänge bleiben (der Server liest sie vorher und sendet die ganze Liste).`);
        return {
          summary: [
            `PDF «${name}» (${bytes.length} Bytes, ${(bytes.length / 1024).toFixed(1)} KB) in der Dateiablage von CashCtrl ablegen in ${org}`,
            `SHA-256: ${hash}`,
            ziel ? `Ziel: Beleg ${ziel.id} anhängen` : 'Ziel: nur Dateiablage, kein Anhang',
          ].join('\n'),
          warnings,
          // Base64 statt Uint8Array: JSON-tauglich fuer einen serialisierenden Token-Speicher, und eine Kopie, die der Aufrufer nicht mehr aendert.
          payload: { inhalt: Buffer.from(bytes).toString('base64'), name, bytes: bytes.length, sha256: hash, ...(ziel ? { ziel } : {}) },
        };
      },
      async commit(c, org, p) {
        const client = c.client(org);
        // Fremder Token-Speicher (nicht vertrauenswuerdig, wie bei api_write): Ziel und Form erneut pruefen.
        if (p.ziel && (p.ziel.art !== 'order' || !Number.isInteger(p.ziel.id) || p.ziel.id <= 0)) throw inValid('Ziel ungültig: nur art order mit ganzer positiver id.');
        if (p.inhalt === undefined) {
          if (!Number.isInteger(p.fileId) || !p.fileId || !p.ziel) throw inValid('Token enthält weder Datei noch fileId mit Ziel.');
          const ids = await anhaengen(client, p.ziel, p.fileId, false);
          // Beim blossen Anhaengen prueft das Werkzeug nicht, ob die Datei festgehalten ist: kein Feld `festgehalten`.
          return { org, fileId: p.fileId, angehaengt: true, beleg: p.ziel.id, fileIds: ids, message: `Datei ${p.fileId} an Beleg ${p.ziel.id} angehängt.` };
        }
        const name = pruefeName(p.name);
        const bytes = bytesAusEingabe(p.inhalt);
        if (bytes.length !== p.bytes || sha256(bytes) !== p.sha256) throw inValid('Die Datei im Token stimmt nicht mit der Vorschau überein (Grösse oder SHA-256). Nichts gesendet; prepare_file_upload neu aufrufen.');
        // Vorpruefung: gibt es den Beleg, und ist seine Anhangliste lesbar? Sonst Fehler ohne Upload, statt einer Datei ohne Beleg.
        if (p.ziel) {
          try { await anhangliste(client, p.ziel.id); } catch (e) { throw new CashCtrlError(kindVon(e), `${msgVon(e)} Nichts hochgeladen.`); }
        }
        let geheim: string[] = [];
        try {
          // 1. file/prepare: ab hier hat CashCtrl (womoeglich) eine Datei angelegt; der Aufruf traegt `sent` selbst (CashCtrlHttp.post).
          // Eine Ablehnung von file/prepare, deren Begruendung eine Adresse nennt, wird nicht gezeigt (die Adresse ist noch nicht bekannt, ohneAdresse greift nicht).
          let r: { data?: unknown } | null;
          try { r = await client.prepareFiles([{ name, mimeType: 'application/pdf', size: bytes.length }]); } catch (e) {
            if (e instanceof CashCtrlError && /https?:\/\/objectstorage|\/p\//i.test(e.message)) throw new CashCtrlError(e.kind, 'CashCtrl hat file/prepare abgelehnt; die Begründung enthielt eine Adresse und wird nicht gezeigt.', undefined, e.sent === undefined ? undefined : { sent: e.sent });
            throw e;
          }
          const eintrag = (r && typeof r === 'object' && Array.isArray(r.data) ? r.data[0] : undefined) as Rec | null | undefined;
          const fileId = Number(eintrag?.fileId);
          const writeUrl = eintrag?.writeUrl;
          geheim = geheimnisse(writeUrl);
          if (!Number.isInteger(fileId) || fileId <= 0) throw new CashCtrlError('unknown', 'file/prepare hat keine fileId geliefert; nichts hochgeladen. Ob CashCtrl eine Datei angelegt hat, ist offen: in CashCtrl nachsehen.', undefined, { sent: true });
          // 2. + 3. Adresse pruefen und PUT; ein Fehler hier laesst die Datei unfestgehalten (CashCtrl raeumt sie nach 4 Stunden ab).
          try { await c.hochladen(org, writeUrl, bytes); } catch (e) { throw vorFesthalten(ohneAdresse(e, geheim), fileId); }
          // 4. file/persist
          try { await client.persistFiles([fileId]); } catch (e) { throw beimFesthalten(e, fileId); }
          // 5. optional anhaengen
          const ziel = p.ziel;
          const ids = ziel ? await anhaengen(client, ziel, fileId, true) : undefined;
          return {
            org, fileId, name, bytes: bytes.length, sha256: p.sha256, festgehalten: true, angehaengt: Boolean(ziel),
            ...(ziel ? { beleg: ziel.id, fileIds: ids } : {}),
            message: ziel ? `Datei ${name} festgehalten (fileId ${fileId}) und an Beleg ${ziel.id} angehängt.` : `Datei ${name} festgehalten (fileId ${fileId}); nicht angehängt.`,
          };
        } catch (e) { throw ohneAdresse(e, geheim); }
      },
    });
  },
};
