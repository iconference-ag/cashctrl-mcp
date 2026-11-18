import { CashCtrlError } from './errors.js';

/**
 * Hochladen in den Objektspeicher von CashCtrl (0.6.0, `commit_file_upload`). CashCtrl vergibt mit
 * `file/prepare` eine Adresse (`writeUrl`), unter der die Bytes mit PUT abgelegt werden; sie fuehrt ein Einmal-Token
 * im Pfad. Dieses Modul haengt bewusst NICHT an `CashCtrlHttp`: der API-Schluessel, die Drossel und der
 * Zaehler von CashCtrl gehoeren nicht zu diesem Aufruf, und strukturell kommt der Schluessel hier nie vor.
 *
 * Keine Meldung dieses Moduls nennt die Adresse oder ihren Pfad; hoechstens den Hostnamen. Fremde Fehlertexte
 * (`e.message` einer Ausnahme aus `fetchImpl`) werden nie uebernommen: sie koennten die Adresse tragen.
 */

/** Standard der Regionenliste; ueberschrieben je Organisation oder global in der Konfiguration (`uploadRegions`). */
export const STANDARD_REGIONEN: readonly string[] = ['eu-zurich-1'];
/** Zeitgrenze des PUT, Standard 120 s (bis 10 MB ueber eine langsame Leitung); eigene Grenze, nicht die 30 s der API-Aufrufe. */
export const UPLOAD_TIMEOUT_MS = 120000;
export const HOCHLADEN_ABGEWIESEN = 'Der Upload wurde nicht gesendet.';

/** Erlaubte Hostnamen fuer eine Regionenliste: genau `objectstorage.<region>.oraclecloud.com`, kein Muster. */
export function erlaubteHosts(regionen: readonly string[]): string[] {
  return regionen.map((r) => `objectstorage.${r}.oraclecloud.com`);
}

/**
 * Prueft die `writeUrl` am geparsten Objekt und gibt genau dieses Objekt zurueck: abgerufen wird, was geprueft wurde, nie der
 * Rohtext. Schema `https:`, keine Benutzerangaben, Port leer (443 gilt bei `URL` als leer), Hostname genau aus der Liste
 * (ein Punkt am Ende, Gross-/Kleinschreibung oder Umlenkung ueber `\` und `@` bestehen das nicht), Pfad beginnt mit `/p/`.
 * Die Meldung nennt hoechstens den Hostnamen, nie die Adresse.
 */
export function pruefeWriteUrl(roh: unknown, regionen: readonly string[]): URL {
  const abgewiesen = (grund: string) => new CashCtrlError('validation', `Die Upload-Adresse von CashCtrl wurde abgewiesen (${grund}). ${HOCHLADEN_ABGEWIESEN}`);
  if (typeof roh !== 'string' || roh === '') throw abgewiesen('keine Adresse geliefert');
  let url: URL;
  try { url = new URL(roh); } catch { throw abgewiesen('keine gültige Adresse'); }
  if (url.protocol !== 'https:') throw abgewiesen('Schema nicht https');
  if (url.username !== '' || url.password !== '') throw abgewiesen('Benutzerangaben in der Adresse');
  if (url.port !== '') throw abgewiesen(`Port ${url.port}`);
  if (!erlaubteHosts(regionen).includes(url.hostname)) throw abgewiesen(`Host ${url.hostname} nicht erlaubt; erlaubt: ${erlaubteHosts(regionen).join(', ')}`);
  if (!url.pathname.startsWith('/p/')) throw abgewiesen('Pfad beginnt nicht mit /p/');
  return url;
}

const CODE_FORM = /^[A-Z][A-Z0-9_]{1,39}$/;
const NAME_FORM = /^[A-Za-z]{1,40}$/;
/**
 * Die Kennung einer fremden Ausnahme (`code`, `cause.code`, `name`) kommt von aussen (`fetchImpl` des Aufrufers) und kann Teile der
 * Adresse tragen; das Schwaerzen ganzer Zeichenketten greift dann nicht. Darum nur eine Positivliste: `code` und `cause.code` in der Form
 * von Systemcodes (ECONNRESET, UND_ERR_SOCKET), `name` nur Buchstaben (TypeError). Zusaetzlich nie ein Wert, der ein Stueck der Adresse
 * ist (ein nur aus Buchstaben bestehendes Token bestuende die Formpruefung). Sonst «unbekannt».
 */
function kennungVon(e: unknown, url: URL): string {
  const roh = e as { code?: unknown; name?: unknown; cause?: { code?: unknown } } | undefined;
  // Ungueltiges UTF-8 in der Prozentkodierung (%C3EN) laesst decodeURIComponent werfen: dann gilt die Adresse unzerlegt.
  let adresse = url.href.toLowerCase();
  try { adresse = decodeURIComponent(url.href).toLowerCase(); } catch { /* Rueckfall: kodierte Fassung */ }
  const ok = (v: unknown, form: RegExp): v is string => typeof v === 'string' && form.test(v) && !adresse.includes(v.toLowerCase());
  const kandidaten: [unknown, RegExp][] = [[roh?.code, CODE_FORM], [roh?.cause?.code, CODE_FORM], [roh?.name, NAME_FORM]];
  for (const [v, form] of kandidaten) if (ok(v, form)) return v;
  return 'unbekannt';
}

export interface PutOptionen { fetchImpl: typeof fetch; timeoutMs: number }

/**
 * PUT der Bytes, wie am Demo-Mandanten gemessen (18.11.2026): ohne `Authorization`, ohne `Content-Type`, die Laenge setzt fetch
 * aus dem Body; Antwort 200 mit leerem Koerper und `opc-content-md5` (MD5 der Bytes, Base64). `redirect: 'manual'`: jede
 * Umleitung ist ein Fehler, nie ein Hinweis zum Folgen. Erfolg nur bei Status 200 UND gleichem MD5.
 * Jeder Fehler hier ist eine `CashCtrlError` mit festem Text.
 */
export async function putObjekt(url: URL, bytes: Uint8Array, md5Base64: string, o: PutOptionen): Promise<void> {
  const host = url.hostname;
  let res: Response;
  try {
    res = await o.fetchImpl(url.href, { method: 'PUT', body: bytes as BodyInit, redirect: 'manual', signal: AbortSignal.timeout(o.timeoutMs) });
  } catch (e) {
    const name = (e as Error | undefined)?.name;
    if (name === 'AbortError' || name === 'TimeoutError') throw new CashCtrlError('network', `Zeitüberschreitung beim Hochladen zum Objektspeicher ${host} (${o.timeoutMs >= 1000 ? `${Math.round(o.timeoutMs / 1000)} s` : `${o.timeoutMs} ms`}).`);
    // Nur eine symbolische Kennung (ECONNRESET, TypeError), nie die Meldung: sie koennte die Adresse tragen.
    const kennung = kennungVon(e, url);
    throw new CashCtrlError('network', `Netzwerkfehler beim Hochladen zum Objektspeicher ${host} (${kennung}).`);
  }
  // Der Koerper wird nie gelesen oder gezeigt; die Verbindung wird freigegeben.
  await res.body?.cancel().catch(() => undefined);
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw new CashCtrlError('unknown', `Der Objektspeicher ${host} hat auf eine andere Adresse umgeleitet (HTTP ${res.status}); Umleitungen werden nicht verfolgt.`);
  if (res.status !== 200) throw new CashCtrlError('unknown', `Der Objektspeicher ${host} antwortet mit HTTP ${res.status} statt 200.`);
  const md5 = res.headers.get('opc-content-md5');
  if (md5 === null) throw new CashCtrlError('unknown', `Der Objektspeicher ${host} hat die Prüfsumme (opc-content-md5) nicht geliefert; der Upload gilt nicht als bestätigt.`);
  if (md5 !== md5Base64) throw new CashCtrlError('unknown', `Die Prüfsumme (MD5) des Objektspeichers ${host} weicht von der lokalen ab; die Datei kam nicht unverändert an.`);
}
