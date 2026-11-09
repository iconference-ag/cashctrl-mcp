import { homedir } from 'node:os';
import { join } from 'node:path';
import { CashCtrlError, type ErrorExtra } from './errors.js';
import { TokenBucket } from './ratelimit.js';
import { UsageCounter } from './usage.js';
import type { UsageStore } from './stores.js';

export interface HttpOptions {
  subdomain: string;
  'apiKey': string;
  org: string;
  /** Standard: eigener Bucket (300/30 pro Sekunde). `null` schaltet das Warten bewusst ab. */
  bucket?: TokenBucket | null;
  /** Standard: eigener Zaehler auf `usageFile`. `null` schaltet das Kontingent bewusst ab. */
  usage?: UsageStore | null;
  usageFile?: string;
  /** Zeitgrenze je Versuch, Standard 30 s. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>;
}
const RETRY_WAITS = [2000, 4000, 6000];
const DEFAULT_TIMEOUT_MS = 30000;
/** Fehlercodes, bei denen die Verbindung nicht zustande kam: die Anfrage hat CashCtrl nicht erreicht. */
const KEINE_VERBINDUNG = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'];
/**
 * Satz fuer jeden Fehler, nach dem ein POST CashCtrl erreicht haben koennte (`sent: true`). Nicht
 * «bitte erneut versuchen»: ein zweiter Aufruf legt womoeglich doppelt an oder bucht doppelt.
 */
export const OFFEN_SATZ = 'Ob CashCtrl den Auftrag ausgeführt hat, ist offen; nicht erneut ausführen, erst in CashCtrl nachsehen.';
/** 0.3.2: Ablehnung (success:false) ohne errors, errorMessage und message. Ersetzt «CashCtrl lehnt ab: ohne Begründung». */
export const OHNE_GRUND_SATZ = 'CashCtrl hat abgewiesen und keinen Grund genannt.';
const defaultUsageFile = () => join(homedir(), '.config/cashctrl-mcp/usage.json');

/** «30 s» bei den ueblichen Werten, «20 ms» bei kurzen Testfristen — keine gerundete Null. */
function frist(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

function encodeForm(data: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    p.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return p.toString();
}

/** Alles ausser dem Schluessel — nur das darf am Objekt liegen und serialisiert werden. */
interface Wiring {
  subdomain: string; org: string;
  bucket: TokenBucket | null; usage: UsageStore | null;
  timeoutMs: number;
  fetchImpl: typeof fetch; sleep: (ms: number) => Promise<void>;
}

export class CashCtrlHttp {
  /** Echtes privates Feld: weder aufzaehlbar noch von JSON.stringify oder Fremdcode erreichbar. */
  readonly #auth: string;
  private readonly base: string;
  private readonly o: Wiring;
  /**
   * Der Hinweis, den `UsageCounter.record()` beim Buchen des Aufrufs zurueckgibt (ab 80 %,
   * Spec §9). Er wird hier gemerkt, weil die Werkzeugantwort erst spaeter entsteht —
   * ohne diese Stelle verfiel der Hinweis im Aufrufpfad. Getter, damit er von aussen
   * nur lesbar ist; `toJSON` haelt ihn wie alles andere aus der Serialisierung heraus.
   */
  #warnung: string | undefined;
  get lastWarning(): string | undefined { return this.#warnung; }
  #gesendet = 0;
  /**
   * Zahl der POST, die CashCtrl erreicht haben koennten (Erfolg oder Fehler mit sent:true). Der
   * commit-Weg (twophase) vergleicht den Stand vor und nach `commit`: ist er gestiegen, traegt
   * jeder spaetere Fehler sent:true. Laufen zwei commits derselben Organisation gleichzeitig,
   * kann der eine den anderen hochstufen — das ist die sichere Richtung.
   */
  get gesendet(): number { return this.#gesendet; }
  constructor(opts: HttpOptions) {
    this.base = `https://${opts.subdomain}.cashctrl.com/api/v1/`;
    this.#auth = 'Basic ' + Buffer.from(`${opts['apiKey']}:`).toString('base64');
    this.o = {
      subdomain: opts.subdomain,
      org: opts.org,
      bucket: opts.bucket === undefined ? new TokenBucket(300, 30) : opts.bucket,
      usage: opts.usage === undefined ? new UsageCounter(opts.usageFile ?? defaultUsageFile()) : opts.usage,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetchImpl: opts.fetchImpl ?? fetch,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }
  /** Begrenzt, was eine Serialisierung des Clients je zeigen kann. */
  toJSON(): { subdomain: string; org: string } {
    return { subdomain: this.o.subdomain, org: this.o.org };
  }

  /** Eine Stelle fuer die Abbildung von Abbruch und Netzfehler — Spec 9: nie eine rohe Ausnahme nach aussen. */
  private netzfehler(label: string, e: unknown, art: 'zeit' | 'abbruch' = 'zeit', post = false): CashCtrlError {
    if (e instanceof CashCtrlError) return e;
    const name = (e as Error | undefined)?.name;
    // `sent` nur bei POST. Im Zweifel true: nur ein Fehler, bei dem die Verbindung gar nicht
    // zustande kam, schliesst aus, dass CashCtrl die Anfrage gesehen hat. undici legt den Code
    // in `cause.code` ab, andere Umsetzungen direkt am Fehler — beides wird gelesen.
    const code = (e as { code?: unknown } | undefined)?.code;
    const causeCode = ((e as { cause?: { code?: unknown } } | undefined)?.cause)?.code;
    const nichtVerbunden = [code, causeCode].some((c) => typeof c === 'string' && KEINE_VERBINDUNG.includes(c));
    const extra: ErrorExtra | undefined = post ? { sent: !nichtVerbunden } : undefined;
    // Beim GET darf «bitte erneut versuchen» bleiben; beim POST mit sent:true nicht (OFFEN_SATZ).
    const weiter = extra?.sent ? `. ${OFFEN_SATZ}` : ' — bitte erneut versuchen.';
    if (name === 'AbortError' || name === 'TimeoutError') {
      return art === 'zeit'
        ? new CashCtrlError('network', `Zeitüberschreitung nach ${frist(this.o.timeoutMs)} beim Aufruf von ${label}${weiter}`, undefined, extra)
        : new CashCtrlError('network', `Abbruch beim Aufruf von ${label} — die Anfrage wurde von aussen beendet.${extra?.sent ? ` ${OFFEN_SATZ}` : ''}`, undefined, extra);
    }
    // Bewusst OHNE `e.message`: `fetchImpl` kommt von aussen (Desk, Tests, kuenftige Adapter),
    // und eine fremde Meldung kann den Authorization-Header oder den Schluessel selbst tragen.
    // `code`/`name` sind symbolische Kennungen (ECONNRESET, TypeError), nicht aus der Anfrage gebaut.
    const kennung = String((e as { code?: unknown } | undefined)?.code ?? name ?? 'unbekannt');
    return new CashCtrlError('network', `Netzwerkfehler beim Aufruf von ${label} (${kennung})${weiter}`, undefined, extra);
  }
  /** Auch das Lesen der Antwort steht unter derselben Zeitgrenze und darf nicht roh durchschlagen. */
  private async lies<T>(label: string, fn: () => Promise<T>, post = false): Promise<T> {
    try { return await fn(); } catch (e) { throw this.netzfehler(label, e, 'zeit', post); }
  }

  private async request(path: string, init: RequestInit, query?: Record<string, unknown>, label = path): Promise<Response> {
    const url = new URL(this.base + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    const post = init.method === 'POST';
    // CashCtrl hat geantwortet und abgelehnt: der Beleg ist nicht entstanden. Alles andere bleibt im Zweifel true.
    const abgelehnt: ErrorExtra | undefined = post ? { sent: false } : undefined;
    const unklar: ErrorExtra | undefined = post ? { sent: true } : undefined;
    for (let attempt = 0; ; attempt++) {
      await this.o.bucket?.take();
      this.#warnung = (await this.o.usage?.record(this.o.org))?.warning;
      let res: Response;
      const zeit = AbortSignal.timeout(this.o.timeoutMs);
      try {
        res = await this.o.fetchImpl(url, {
          ...init,
          headers: { ...(init.headers as Record<string, string>), Authorization: this.#auth },
          // Ein mitgegebenes Signal darf die Zeitgrenze nicht verdraengen — beide gelten.
          signal: init.signal ? AbortSignal.any([init.signal, zeit]) : zeit,
        });
      } catch (e) {
        throw this.netzfehler(label, e, zeit.aborted ? 'zeit' : 'abbruch', post);
      }
      if (res.status === 429 && attempt < RETRY_WAITS.length) { await this.o.sleep(RETRY_WAITS[attempt]); continue; }
      if (res.status === 429) throw new CashCtrlError('rate_limit', 'CashCtrl meldet zu viele Anfragen (429), auch nach drei Wiederholungen.', undefined, abgelehnt);
      if (res.status === 401) throw new CashCtrlError('auth', 'Schlüssel ungültig (401).', undefined, abgelehnt);
      if (res.status === 403) throw new CashCtrlError('forbidden', 'Rolle des API-Benutzers erlaubt das nicht (403).', undefined, abgelehnt);
      if (res.status === 404) throw new CashCtrlError('not_found', `Endpunkt oder Organisation falsch (404): ${label}`, undefined, abgelehnt);
      if (!res.ok) throw new CashCtrlError('unknown', `CashCtrl antwortet mit HTTP ${res.status} auf ${label}.${post ? ` ${OFFEN_SATZ}` : ''}`, undefined, unklar);
      return res;
    }
  }

  private async parseJson<T>(res: Response, path: string, post = false): Promise<T> {
    const text = await this.lies(path, () => res.text(), post);
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new CashCtrlError('not_found', `Keine JSON-Antwort von ${path} — Endpunkt oder Organisation falsch.${post ? ` ${OFFEN_SATZ}` : ''}`, undefined, post ? { sent: true } : undefined); }
    this.pruefeAblehnung(body, post);
    return body as T;
  }

  /** Eine JSON-Antwort mit `success: false` ist eine Ablehnung (validation), nie ein Ergebnis. */
  private pruefeAblehnung(body: unknown, post: boolean): void {
    if (body && typeof body === 'object' && (body as { success?: unknown }).success === false) {
      const errors = ((body as { errors?: { field?: string; message?: string }[] }).errors ?? [])
        .map((e) => (e.field ? `${e.field}: ${e.message ?? '?'}` : (e.message ?? '?'))).join('; ');
      // 0.3.2: der Grund steht beim Lesen in `errorMessage` (gemessen 20.10.2026 an order/read, person/read, inventory/article/read einer
      // unbekannten Kennung: «This document does not exist.»; ohne `lang` englisch). Nennt CashCtrl keinen, sagt der Satz genau das.
      const b = body as { message?: string; errorMessage?: string };
      const grund = errors || b.errorMessage || b.message;
      throw new CashCtrlError('validation', grund ? `CashCtrl lehnt ab: ${grund}` : OHNE_GRUND_SATZ, body, post ? { sent: false } : undefined);
    }
  }

  async get<T = unknown>(endpoint: string, params?: Record<string, unknown>): Promise<T> {
    return this.parseJson<T>(await this.request(`${endpoint}.json`, { method: 'GET' }, params, endpoint), endpoint);
  }
  async post<T = unknown>(endpoint: string, data: Record<string, unknown>): Promise<T> {
    try {
      const res = await this.request(`${endpoint}.json`, { method: 'POST', body: encodeForm(data), headers: { 'content-type': 'application/x-www-form-urlencoded' } }, undefined, endpoint);
      const r = await this.parseJson<T>(res, endpoint, true);
      this.#gesendet++;
      return r;
    } catch (e) {
      // Nur ein eindeutig abgelehnter oder gar nicht verbundener POST (sent:false) zaehlt nicht.
      if (!(e instanceof CashCtrlError) || e.sent !== false) this.#gesendet++;
      throw e;
    }
  }
  async getBinary(endpointWithExt: string, params?: Record<string, unknown>, expectType = 'application/pdf'): Promise<Uint8Array> {
    const res = await this.request(endpointWithExt, { method: 'GET' }, params);
    const typ = res.headers.get('content-type') ?? '';
    if (!typ.includes(expectType)) {
      await res.body?.cancel().catch(() => undefined);   // Verbindung freigeben, statt den Body haengen zu lassen
      throw new CashCtrlError('not_found', `Kein ${expectType} erhalten (content-type ${typ || 'fehlt'}) — Beleg-ID prüfen.`);
    }
    return new Uint8Array(await this.lies(endpointWithExt, () => res.arrayBuffer()));
  }
  /**
   * Allgemeiner GET fuer jeden Endpunkt, dessen Antwort nicht JSON sein muss (0.4.0, `api_read`):
   * derselbe Weg wie alle anderen Aufrufe (Drossel, Zaehler, 429-Wiederholung, Fehlerarten). Der Pfad
   * traegt seine Endung selbst (`order/document/read.pdf`) oder keine (`account/balance`); es wird
   * nichts angehaengt. Antwort als Text bei `text/*` und bei JSON, sonst als Bytes. Eine JSON-Antwort
   * mit `success: false` bleibt ein Fehler, auch unter einem Endpunkt, der sonst eine Datei liefert.
   */
  async getRaw(endpointWithExt: string, params?: Record<string, unknown>): Promise<{ contentType: string; text: string } | { contentType: string; bytes: Uint8Array }> {
    const res = await this.request(endpointWithExt, { method: 'GET' }, params, endpointWithExt);
    const contentType = res.headers.get('content-type') ?? '';
    if (/json/i.test(contentType) || /^text\//i.test(contentType)) {
      const text = await this.lies(endpointWithExt, () => res.text());
      if (/json/i.test(contentType)) {
        let body: unknown;
        try { body = JSON.parse(text); } catch { body = undefined; }
        this.pruefeAblehnung(body, false);
      }
      return { contentType, text };
    }
    return { contentType, bytes: new Uint8Array(await this.lies(endpointWithExt, () => res.arrayBuffer())) };
  }
}
