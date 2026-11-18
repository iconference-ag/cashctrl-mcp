import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createToolset, type Toolset } from '../../src/toolset.js';
import { MemoryTokenStore } from '../../src/tools/tokens.js';
import { zustandAus } from '../../src/core/usage.js';
import { CashCtrlError } from '../../src/core/errors.js';
import { fail } from '../../src/tools/result.js';
import { nachSchreiben } from '../../src/tools/twophase.js';
import { pruefeWriteUrl } from '../../src/core/objektspeicher.js';
import { loadConfig } from '../../src/config/config.js';
import type { Config, OrgConfig } from '../../src/config/config.js';
import type { TokenStore, UsageStore } from '../../src/core/stores.js';
import type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * prepare_file_upload / commit_file_upload (0.6.0). Alles gegen Attrappen ueber `fetchImpl`, kein Netz. Zusagen:
 * prepare ruft CashCtrl nie auf; die writeUrl steht nirgends (Antwort, Fehlertext, Protokollzeile); der PUT geht ohne
 * Authorization, ohne Umleitung, nur zum erlaubten Host, und gilt nur bei 200 UND gleichem MD5; bei einem Fehler wird nichts
 * festgehalten; bestehende Anhaenge bleiben.
 */
const TOKEN = 'SECRETTOKEN0123456789abcdef';
const URL_OK = `https://objectstorage.eu-zurich-1.oraclecloud.com/p/${TOKEN}/n/ns/b/prod/o/ab/file/ju/kh/rechnung.pdf`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n');
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const md5 = (b: Uint8Array) => createHash('md5').update(b).digest('base64');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
const text = (r: CallToolResult) => String((r.content?.[0] as { text?: unknown } | undefined)?.text ?? '');
/** Alles, was ein Aufrufer von einer Antwort sehen kann. */
const sichtbar = (r: CallToolResult) => JSON.stringify(r);

const ORG = (extra: Partial<OrgConfig> = {}): OrgConfig => ({ name: 'nt', subdomain: 'demo', 'apiKey': 'GEHEIMER-API-SCHLUESSEL', ...extra });
const cfg = (orgs: OrgConfig[] = [ORG()], extra: Partial<Config> = {}, mode: Config['mode'] = 'draft'): Config => ({ mode, pdfDir: '/tmp/x', usageFile: '/nirgends/usage.json', source: 'env', orgs, ...extra });

interface Aufruf { kind: 'prepare' | 'put' | 'persist' | 'order-read' | 'update' | 'sonst'; url: string; method: string; body: string; headers: Record<string, string>; init?: RequestInit; bytes?: Uint8Array }
interface Optionen {
  writeUrl?: unknown; fileId?: number;
  attachments?: unknown;                         // Antwort von order/read; undefined = Feld fehlt
  put?: (b: Uint8Array) => Response | Promise<Response>;
  persist?: () => Response; update?: () => Response; prepare?: () => Response;
}
function env(o: Optionen = {}) {
  const calls: Aufruf[] = [];
  let prepareAntworten = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const a: Aufruf = { kind: 'sonst', url: String(url), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : '', headers, init };
    calls.push(a);
    if (u.hostname.endsWith('.cashctrl.com')) {
      if (u.pathname.endsWith('/file/prepare.json')) { a.kind = 'prepare'; if (o.prepare) return o.prepare(); prepareAntworten++; return json({ success: true, data: [{ fileId: o.fileId ?? 5, writeUrl: 'writeUrl' in o ? o.writeUrl : URL_OK, name: 'rechnung.pdf', mimeType: 'application/pdf' }] }); }
      if (u.pathname.endsWith('/file/persist.json')) { a.kind = 'persist'; return o.persist ? o.persist() : json({ success: true, message: 'Datei gespeichert' }); }
      if (u.pathname.endsWith('/order/read.json')) { a.kind = 'order-read'; return json({ success: true, data: { id: 77, ...('attachments' in o ? (o.attachments === undefined ? {} : { attachments: o.attachments }) : { attachments: [] }) } }); }
      if (u.pathname.endsWith('/order/update_attachments.json')) { a.kind = 'update'; return o.update ? o.update() : json({ success: true, message: 'Anhänge gespeichert' }); }
      return json({ success: true, data: [] });
    }
    // Alles andere ist der Objektspeicher (oder ein falscher Host): der PUT.
    a.kind = 'put'; a.bytes = init?.body as Uint8Array;
    return o.put ? o.put(a.bytes) : new Response(null, { status: 200, headers: { 'opc-content-md5': md5(a.bytes) } });
  }) as unknown as typeof fetch;
  const von = (k: Aufruf['kind']) => calls.filter((c) => c.kind === k);
  return { calls, fetchImpl, von, prepareAntworten: () => prepareAntworten, puts: () => von('put') };
}
/** Zaehlt jeden Aufruf, der ueber den Zaehler von CashCtrl laeuft. */
function zaehler() {
  const n = { v: 0 };
  const s: UsageStore = { async state() { return zustandAus(n.v, '2026-11'); }, async record() { n.v++; return zustandAus(n.v, '2026-11'); } };
  return { n, s };
}
function ts(e = env(), opt: { config?: Config; tokens?: TokenStore; zaehler?: UsageStore; uploadTimeoutMs?: number } = {}): Toolset {
  return createToolset(opt.config ?? cfg(), { fetchImpl: e.fetchImpl, stores: { usage: opt.zaehler ?? zaehler().s, ...(opt.tokens ? { tokens: opt.tokens } : {}) }, uploadTimeoutMs: opt.uploadTimeoutMs });
}
const ARGS = { name: 'rechnung.pdf', inhalt: b64(PDF), anhaengenAn: { art: 'order', id: 77 } };

async function vorbereiten(t: Toolset, args: Record<string, unknown> = ARGS) {
  const r = await t.call('prepare_file_upload', args);
  expect(r.isError, text(r)).toBeFalsy();
  return (r.structuredContent as { token: string; summary: string; warnings: string[] }).token;
}
async function ausfuehren(t: Toolset, args: Record<string, unknown> = ARGS) {
  const token = await vorbereiten(t, args);
  return t.call('commit_file_upload', { token });
}

const spione = () => (['log', 'error', 'warn', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
afterEach(() => { vi.restoreAllMocks(); });

describe('Registrierung und Stufe', () => {
  it('Stufe draft: im Modus read nicht da, in draft und full da; ohne Schalter; Annotationen nicht zerstoerend', () => {
    const e = env();
    expect(createToolset(cfg([ORG()], {}, 'read'), { fetchImpl: e.fetchImpl }).names()).not.toContain('prepare_file_upload');
    for (const m of ['draft', 'full'] as const) {
      const t = createToolset(cfg([ORG()], {}, m), { fetchImpl: e.fetchImpl });
      expect(t.names()).toEqual(expect.arrayContaining(['prepare_file_upload', 'commit_file_upload']));
    }
    const t = createToolset(cfg(), { fetchImpl: e.fetchImpl });
    expect(t.tools.find((x) => x.name === 'prepare_file_upload')!.annotations).toMatchObject({ readOnlyHint: true });
    expect(t.tools.find((x) => x.name === 'commit_file_upload')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
  it('das JSON-Schema fuer MCP kennt inhalt als Text (kein Pfad-Feld)', async () => {
    const { z } = await import('zod');
    const t = createToolset(cfg(), { fetchImpl: env().fetchImpl });
    const schema = z.toJSONSchema(t.tools.find((x) => x.name === 'prepare_file_upload')!.inputSchema, { io: 'input', unrepresentable: 'any' }) as { properties: Record<string, { type?: string }> };
    expect(schema.properties.inhalt.type).toBe('string');
    expect(Object.keys(schema.properties).sort()).toEqual(['anhaengenAn', 'fileId', 'inhalt', 'mimeType', 'name', 'org']);
  });
});

describe('prepare_file_upload', () => {
  it('ruft CashCtrl nie auf; Vorschau nennt Name, Groesse, SHA-256 und Ziel; Token gilt 10 Minuten', async () => {
    const e = env();
    const jetzt = new Date('2026-11-18T10:00:00Z');
    const t = createToolset(cfg(), { fetchImpl: e.fetchImpl, now: () => jetzt, stores: { usage: zaehler().s, tokens: new MemoryTokenStore(undefined, () => jetzt.getTime()) } });
    const r = await t.call('prepare_file_upload', ARGS);
    expect(r.isError, text(r)).toBeFalsy();
    expect(e.calls).toHaveLength(0);
    const s = r.structuredContent as { summary: string; warnings: string[]; token: string; expiresAt: string };
    expect(s.summary).toContain('rechnung.pdf');
    expect(s.summary).toContain(`${PDF.length} Bytes`);
    expect(s.summary).toContain(`SHA-256: ${sha(PDF)}`);
    expect(s.summary).toContain('Beleg 77');
    expect(s.summary).toContain('in nt');
    expect(s.warnings.join(' ')).toContain('objectstorage.eu-zurich-1.oraclecloud.com');
    expect(s.warnings.join(' ')).toContain('bisherigen Anhänge bleiben');
    expect(Date.parse(s.expiresAt) - jetzt.getTime()).toBe(10 * 60 * 1000);
  });
  it('ohne anhaengenAn: nur Dateiablage', async () => {
    const r = await ts().call('prepare_file_upload', { name: 'a.pdf', inhalt: b64(PDF) });
    expect((r.structuredContent as { summary: string }).summary).toContain('nur Dateiablage, kein Anhang');
  });
  it('Uint8Array im Prozess (toolset.call) wie Base64-Text; spaetere Aenderung des Puffers wirkt nicht auf die Vorschau', async () => {
    const e = env();
    const t = ts(e);
    const puffer = new Uint8Array(PDF);
    const token = await vorbereiten(t, { name: 'a.pdf', inhalt: puffer });
    puffer.fill(0x41);   // der Aufrufer ueberschreibt seinen Puffer zwischen prepare und commit
    const r = await t.call('commit_file_upload', { token });
    expect(r.isError, text(r)).toBeFalsy();
    expect(Buffer.from(e.puts()[0].bytes!).equals(PDF)).toBe(true);
  });

  async function abgewiesen(args: Record<string, unknown>, muster: RegExp) {
    const e = env();
    const r = await ts(e).call('prepare_file_upload', args);
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(muster);
    expect(r.structuredContent).not.toHaveProperty('token');
    expect(e.calls).toHaveLength(0);
  }
  it('ein Dateipfad als inhalt wird abgewiesen, in allen Schreibweisen', async () => {
    for (const pfad of ['/Users/x/a.pdf', '~/a.pdf', './a.pdf', '../a.pdf', 'C:\\Users\\x\\a.pdf', 'file:///Users/x/a.pdf', 'a.pdf', '\\\\server\\a.pdf']) {
      await abgewiesen({ name: 'a.pdf', inhalt: pfad }, /Dateipfad|Base64/);
    }
    await abgewiesen({ name: 'a.pdf', inhalt: '/Users/x/a.pdf' }, /Dateipfade werden nie angenommen/);
  });
  it('ein Wert in Base64-Zeichen, der kein PDF ist (auch ein Pfad ohne Sonderzeichen), wird abgewiesen', async () => {
    await abgewiesen({ name: 'a.pdf', inhalt: 'AAAA' }, /Keine PDF-Datei/);
    await abgewiesen({ name: 'a.pdf', inhalt: b64(Buffer.from('Users/georges/a')) }, /Keine PDF-Datei/);
    await abgewiesen({ name: 'a.pdf', inhalt: b64(Buffer.from('GIF89a......')) }, /%PDF-/);
  });
  it('ungueltiges Base64 (falsche Laenge, falsche Zeichen, nicht kanonisch) und leer', async () => {
    await abgewiesen({ name: 'a.pdf', inhalt: b64(PDF).slice(0, -1) }, /kein gültiges Base64/);
    await abgewiesen({ name: 'a.pdf', inhalt: b64(PDF).replace(/.$/, '*') }, /kein gültiges Base64/);
    await abgewiesen({ name: 'a.pdf', inhalt: 'JVBERi0=\u0000' }, /kein gültiges Base64/);
    await abgewiesen({ name: 'a.pdf', inhalt: '' }, /kein gültiges Base64/);
    // nicht kanonisch: dieselben Bytes wie JVBERi0=, aber mit gesetzten Restbits
    expect(Buffer.from('JVBERi1=', 'base64').equals(Buffer.from('JVBERi0=', 'base64'))).toBe(true);
    await abgewiesen({ name: 'a.pdf', inhalt: 'JVBERi1=' }, /kein gültiges Base64/);
    await abgewiesen({ name: 'a.pdf', inhalt: new Uint8Array(0) }, /leer/);
  });
  it('genau 10 MB gehen, ein Byte mehr nicht; Text und Uint8Array', async () => {
    const MB10 = 10 * 1024 * 1024;
    const gross = (n: number) => { const b = new Uint8Array(n); b.set(Buffer.from('%PDF-1.4\n')); return b; };
    const e = env();
    expect((await ts(e).call('prepare_file_upload', { name: 'a.pdf', inhalt: gross(MB10) })).isError).toBeFalsy();
    expect((await ts(e).call('prepare_file_upload', { name: 'a.pdf', inhalt: b64(gross(MB10)) })).isError).toBeFalsy();
    await abgewiesen({ name: 'a.pdf', inhalt: gross(MB10 + 1) }, /zu gross/);
    await abgewiesen({ name: 'a.pdf', inhalt: b64(gross(MB10 + 1)) }, /zu gross/);
    await abgewiesen({ name: 'a.pdf', inhalt: 'A'.repeat(15_000_001) }, /zu gross/);
  });
  it('G1: Base64 von 10 MiB mit CRLF alle 76 Zeichen geht durch (der Zeilenumbruch zaehlt nicht zur Grenze)', async () => {
    const MB10 = 10 * 1024 * 1024;
    const gross = new Uint8Array(MB10); gross.set(Buffer.from('%PDF-1.4\n'));
    const mitCrlf = b64(gross).replace(/(.{76})/g, '$1\r\n');
    expect(mitCrlf.length).toBeGreaterThan(14_300_000);
    const e = env();
    const r = await ts(e).call('prepare_file_upload', { name: 'a.pdf', inhalt: mitCrlf });
    expect(r.isError, text(r)).toBeFalsy();
    expect((r.structuredContent as { summary: string }).summary).toContain(`SHA-256: ${sha(gross)}`);
  });
  it('ohne %PDF- am Anfang', async () => {
    await abgewiesen({ name: 'a.pdf', inhalt: b64(Buffer.from('<html>%PDF-1.4</html>')) }, /Keine PDF-Datei/);
    await abgewiesen({ name: 'a.pdf', inhalt: b64(Buffer.from(' %PDF-1.4')) }, /Keine PDF-Datei/);
  });
  it('name: / und \\ und Steuerzeichen, mehr als 255 Zeichen, leer, fehlend abgewiesen; 255 Zeichen gehen', async () => {
    for (const n of ['.', '..', 'a/b.pdf', '../a.pdf', 'a\\b.pdf', 'a\nb.pdf', 'a\u0000b.pdf', 'a\u007fb.pdf', '']) {
      const e = env();
      const r = await ts(e).call('prepare_file_upload', { name: n, inhalt: b64(PDF) });
      expect(r.isError, JSON.stringify(n)).toBe(true);
      expect(e.calls).toHaveLength(0);
    }
    expect((await ts().call('prepare_file_upload', { name: 'x'.repeat(256), inhalt: b64(PDF) })).isError).toBe(true);
    expect((await ts().call('prepare_file_upload', { name: 'x'.repeat(255), inhalt: b64(PDF) })).isError).toBeFalsy();
    await abgewiesen({ inhalt: b64(PDF) }, /name fehlt/);
  });
  it('mimeType nur application/pdf', async () => {
    expect((await ts().call('prepare_file_upload', { name: 'a.pdf', inhalt: b64(PDF), mimeType: 'image/png' })).isError).toBe(true);
    expect((await ts().call('prepare_file_upload', { name: 'a.pdf', inhalt: b64(PDF), mimeType: 'application/pdf' })).isError).toBeFalsy();
  });
  it('inhalt und fileId zusammen, keines von beiden, fileId ohne Ziel, falsches Ziel', async () => {
    await abgewiesen({ name: 'a.pdf', inhalt: b64(PDF), fileId: 3, anhaengenAn: { art: 'order', id: 77 } }, /nicht beides/);
    await abgewiesen({ name: 'a.pdf' }, /inhalt .* oder fileId/);
    await abgewiesen({ fileId: 3 }, /ohne anhaengenAn/);
    const e = env();
    expect((await ts(e).call('prepare_file_upload', { fileId: 3, anhaengenAn: { art: 'person', id: 1 } })).isError).toBe(true);
    expect((await ts(e).call('prepare_file_upload', { fileId: 3, anhaengenAn: { art: 'order', id: 0 } })).isError).toBe(true);
    expect(e.calls).toHaveLength(0);
  });
});

describe('commit_file_upload: Erfolg', () => {
  it('Ablauf prepare, PUT, persist, order/read, update_attachments; vorhandener Anhang bleibt (fileIds enthaelt beide)', async () => {
    const e = env({ attachments: [{ id: 1, fileId: 3, name: 'alt.pdf' }] });
    const r = await ausfuehren(ts(e));
    expect(r.isError, text(r)).toBeFalsy();
    expect(e.calls.map((c) => c.kind)).toEqual(['order-read', 'prepare', 'put', 'persist', 'order-read', 'update']);
    const prep = e.von('prepare')[0];
    expect(prep.method).toBe('POST');
    expect(JSON.parse(new URLSearchParams(prep.body).get('files')!)).toEqual([{ name: 'rechnung.pdf', mimeType: 'application/pdf', size: PDF.length }]);
    expect(Buffer.from(e.puts()[0].bytes!).equals(PDF)).toBe(true);
    expect(new URLSearchParams(e.von('persist')[0].body).get('ids')).toBe('5');
    const upd = new URLSearchParams(e.von('update')[0].body);
    expect(upd.get('id')).toBe('77');
    expect(upd.get('fileIds')).toBe('3,5');
    expect(r.structuredContent).toMatchObject({ org: 'nt', fileId: 5, name: 'rechnung.pdf', bytes: PDF.length, sha256: sha(PDF), festgehalten: true, angehaengt: true, beleg: 77, fileIds: [3, 5] });
  });
  it('Beleg ohne Anhang: fileIds ist nur die neue Datei; ohne anhaengenAn weder order/read noch update', async () => {
    const e = env();
    await ausfuehren(ts(e));
    expect(new URLSearchParams(e.von('update')[0].body).get('fileIds')).toBe('5');
    const e2 = env();
    const r = await ausfuehren(ts(e2), { name: 'a.pdf', inhalt: b64(PDF) });
    expect(r.isError, text(r)).toBeFalsy();
    expect(e2.calls.map((c) => c.kind)).toEqual(['prepare', 'put', 'persist']);
    expect(r.structuredContent).toMatchObject({ fileId: 5, festgehalten: true, angehaengt: false });
  });
  it('Wiederholung mit fileId: kein zweites file/prepare, kein PUT, kein persist; nur order/read und update', async () => {
    const e = env({ attachments: [{ fileId: 3 }] });
    const r = await ausfuehren(ts(e), { fileId: 5, anhaengenAn: { art: 'order', id: 77 } });
    expect(r.isError, text(r)).toBeFalsy();
    expect(e.calls.map((c) => c.kind)).toEqual(['order-read', 'update']);
    expect(new URLSearchParams(e.von('update')[0].body).get('fileIds')).toBe('3,5');
  });
  it('ist die Datei schon angehaengt, bleibt es bei der Liste und es wird nichts gesendet', async () => {
    const e = env({ attachments: [{ fileId: 3 }, { fileId: 5 }] });
    const r = await ausfuehren(ts(e), { fileId: 5, anhaengenAn: { art: 'order', id: 77 } });
    expect(r.isError, text(r)).toBeFalsy();
    expect(e.calls.map((c) => c.kind)).toEqual(['order-read']);
    expect(r.structuredContent).toMatchObject({ fileIds: [3, 5] });
  });
  it('Erfolg nach Region aus der Konfiguration: je Organisation und global; Port 443 ausdruecklich geht', async () => {
    const frankfurt = URL_OK.replace('eu-zurich-1', 'eu-frankfurt-1');
    expect((await ausfuehren(ts(env({ writeUrl: frankfurt }), { config: cfg([ORG({ uploadRegions: ['eu-zurich-1', 'eu-frankfurt-1'] })]) }))).isError).toBeFalsy();
    expect((await ausfuehren(ts(env({ writeUrl: frankfurt }), { config: cfg([ORG()], { uploadRegions: ['eu-frankfurt-1'] }) }))).isError).toBeFalsy();
    expect((await ausfuehren(ts(env({ writeUrl: frankfurt }), { config: cfg([ORG({ uploadRegions: ['eu-zurich-1'] })], { uploadRegions: ['eu-frankfurt-1'] }) }))).isError).toBe(true);
    expect((await ausfuehren(ts(env({ writeUrl: URL_OK.replace('.com/', '.com:443/') })))).isError).toBeFalsy();
  });
  it('Token gilt 10 Minuten auch bei 10 MB: nach 9:59 geht commit, nach 10:01 nicht', async () => {
    const MB10 = 10 * 1024 * 1024;
    const gross = new Uint8Array(MB10); gross.set(Buffer.from('%PDF-1.4\n'));
    let jetzt = 1_000_000;
    const store = new MemoryTokenStore(undefined, () => jetzt);
    for (const [dauer, ok] of [[9 * 60_000 + 59_000, true], [10 * 60_000 + 1_000, false]] as const) {
      const e = env();
      const t = ts(e, { tokens: store });
      const token = await vorbereiten(t, { name: 'gross.pdf', inhalt: gross });
      jetzt += dauer;
      const r = await t.call('commit_file_upload', { token });
      expect(Boolean(r.isError), text(r)).toBe(!ok);
      if (ok) { expect(e.puts()[0].bytes!.length).toBe(MB10); expect(sha(e.puts()[0].bytes!)).toBe(sha(gross)); } else expect(text(r)).toMatch(/abgelaufen/);
    }
  });
});

describe('commit_file_upload: die Adresse wird geprueft, bevor ein Byte hinausgeht', () => {
  const FAELLE: [string, string][] = [
    ['fremder Host', `https://evil.example.com/p/${TOKEN}/n/x`],
    ['Host als Unterdomain des erlaubten', `https://objectstorage.eu-zurich-1.oraclecloud.com.evil.example.com/p/${TOKEN}/n/x`],
    ['Host mit Punkt am Ende', `https://objectstorage.eu-zurich-1.oraclecloud.com./p/${TOKEN}/n/x`],
    ['andere Region', `https://objectstorage.eu-frankfurt-1.oraclecloud.com/p/${TOKEN}/n/x`],
    ['http statt https', `http://objectstorage.eu-zurich-1.oraclecloud.com/p/${TOKEN}/n/x`],
    ['Port 8443', `https://objectstorage.eu-zurich-1.oraclecloud.com:8443/p/${TOKEN}/n/x`],
    ['Benutzerangaben', `https://user:pw@objectstorage.eu-zurich-1.oraclecloud.com/p/${TOKEN}/n/x`],
    ['nur Benutzername', `https://user@objectstorage.eu-zurich-1.oraclecloud.com/p/${TOKEN}/n/x`],
    ['@ im Pfad zum fremden Host', `https://objectstorage.eu-zurich-1.oraclecloud.com@evil.example.com/p/${TOKEN}/n/x`],
    ['Pfad ohne /p/', `https://objectstorage.eu-zurich-1.oraclecloud.com/n/ns/b/prod/o/${TOKEN}`],
    ['Pfad /pp/', `https://objectstorage.eu-zurich-1.oraclecloud.com/pp/${TOKEN}`],
    ['Rueckstrich-Umlenkung', `https://evil.example.com\\@objectstorage.eu-zurich-1.oraclecloud.com/p/${TOKEN}`],
    ['keine Adresse', `nicht-eine-adresse ${TOKEN}`],
    ['leer', ''],
  ];
  for (const [name, url] of FAELLE) {
    it(`${name}: Abbruch ohne PUT, ohne persist; Datei nicht festgehalten; sent true; die Adresse steht nirgends`, async () => {
      const e = env({ writeUrl: url });
      const r = await ausfuehren(ts(e));
      expect(r.isError, text(r)).toBe(true);
      expect(e.puts()).toHaveLength(0);
      expect(e.von('persist')).toHaveLength(0);
      expect(e.von('update')).toHaveLength(0);
      expect(text(r)).toMatch(/Upload-Adresse|keine Adresse/);
      expect(text(r)).toContain('nicht festgehalten (fileId 5)');
      expect(r.structuredContent).toMatchObject({ kind: 'validation', sent: true });
      expect(sichtbar(r)).not.toContain(TOKEN);
      if (url.length > 8) expect(sichtbar(r)).not.toContain(url);
    });
  }
  it('Positivkontrolle: dieselbe Adresse ohne den Fehler geht durch (die Faelle oben scheitern an der Adresse, nicht an etwas anderem)', async () => {
    const e = env({ writeUrl: URL_OK });
    expect((await ausfuehren(ts(e))).isError).toBeFalsy();
    expect(e.puts()).toHaveLength(1);
    expect(() => pruefeWriteUrl(URL_OK, ['eu-zurich-1'])).not.toThrow();
    expect(() => pruefeWriteUrl(URL_OK, ['eu-frankfurt-1'])).toThrow(CashCtrlError);
  });
  it('Fehlt writeUrl oder fileId in der Antwort von file/prepare, wird nichts hochgeladen', async () => {
    const e = env({ writeUrl: undefined });
    const r = await ausfuehren(ts(e));
    expect(r.isError).toBe(true);
    expect(e.puts()).toHaveLength(0);
    const e2 = env({ fileId: 0 });
    const r2 = await ausfuehren(ts(e2));
    expect(r2.isError).toBe(true);
    expect(e2.puts()).toHaveLength(0);
    expect(text(r2)).toMatch(/keine fileId/);
  });
});

describe('commit_file_upload: der PUT', () => {
  it('Methode PUT, ohne Authorization und ohne Content-Type, redirect manual, eigene Zeitgrenze; die API-Aufrufe tragen Authorization (Positivkontrolle)', async () => {
    const e = env();
    await ausfuehren(ts(e));
    const put = e.puts()[0];
    expect(put.method).toBe('PUT');
    expect(put.url).toBe(URL_OK);
    expect(Object.keys(put.headers)).not.toContain('authorization');
    expect(Object.keys(put.headers)).not.toContain('content-type');
    expect(JSON.stringify(put.init)).not.toContain('GEHEIMER-API-SCHLUESSEL');
    expect(put.init?.redirect).toBe('manual');
    expect(put.init?.signal).toBeInstanceOf(AbortSignal);
    for (const k of ['prepare', 'persist', 'order-read', 'update'] as const) expect(e.von(k)[0].headers.authorization, k).toMatch(/^Basic /);
    // und der Schluessel steht nirgends in dem, was an den Objektspeicher ging
    expect(put.url + JSON.stringify(put.headers)).not.toContain(Buffer.from('GEHEIMER-API-SCHLUESSEL:').toString('base64'));
  });
  it('der PUT geht nicht ueber Drossel und Zaehler von CashCtrl: der Zaehler zaehlt nur die fuenf API-Aufrufe', async () => {
    const z = zaehler();
    const e = env();
    await ausfuehren(ts(e, { zaehler: z.s }));
    expect(e.calls).toHaveLength(6);
    expect(z.n.v).toBe(5);
  });
  it('Umleitung 302: Fehler, nichts festgehalten, Location nicht verfolgt', async () => {
    const e = env({ put: () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/x' } }) });
    const r = await ausfuehren(ts(e));
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/umgeleitet \(HTTP 302\)/);
    expect(text(r)).toContain('nicht festgehalten (fileId 5)');
    expect(e.von('persist')).toHaveLength(0);
    expect(e.calls.some((c) => c.url.includes('evil.example.com'))).toBe(false);
    expect(sichtbar(r)).not.toContain('evil.example.com');
  });
  it('jede andere 3xx und 5xx und 4xx: Fehler, nichts festgehalten', async () => {
    for (const status of [301, 307, 308, 400, 403, 500, 503]) {
      const e = env({ put: () => new Response(null, { status }) });
      const r = await ausfuehren(ts(e));
      expect(r.isError, String(status)).toBe(true);
      expect(e.von('persist'), String(status)).toHaveLength(0);
    }
    const e = env({ put: () => new Response(null, { status: 500 }) });
    const r = await ausfuehren(ts(e));
    expect(text(r)).toMatch(/HTTP 500/);
    expect(r.structuredContent).toMatchObject({ kind: 'unknown', sent: true });
  });
  it('nur 200 gilt: 201 und 204 nicht, auch mit richtigem MD5', async () => {
    for (const status of [201, 204]) {
      const e = env({ put: (b) => new Response(null, { status, headers: { 'opc-content-md5': md5(b) } }) });
      const r = await ausfuehren(ts(e));
      expect(r.isError, String(status)).toBe(true);
      expect(e.von('persist')).toHaveLength(0);
    }
  });
  it('abweichendes MD5: kein file/persist', async () => {
    const e = env({ put: () => new Response(null, { status: 200, headers: { 'opc-content-md5': md5(Buffer.from('etwas anderes')) } }) });
    const r = await ausfuehren(ts(e));
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Prüfsumme \(MD5\).*weicht/);
    expect(e.von('persist')).toHaveLength(0);
    expect(e.von('update')).toHaveLength(0);
    expect(text(r)).toContain('nicht festgehalten (fileId 5)');
  });
  it('fehlender Kopf opc-content-md5: kein file/persist', async () => {
    const e = env({ put: () => new Response(null, { status: 200 }) });
    const r = await ausfuehren(ts(e));
    expect(r.isError).toBe(true);
    expect(e.von('persist')).toHaveLength(0);
  });
  it('Zeitueberschreitung des PUT: Fehler, nichts festgehalten', async () => {
    const e = env({ put: () => new Promise<Response>(() => undefined) });
    const inner = e.fetchImpl;
    // Attrappe, die auf das Signal hoert wie das echte fetch
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('oraclecloud.com')) return new Promise<Response>((_, rej) => init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason)));
      return inner(url, init);
    }) as unknown as typeof fetch;
    const t = createToolset(cfg(), { fetchImpl, stores: { usage: zaehler().s }, uploadTimeoutMs: 20 });
    const r = await ausfuehren(t);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Zeitüberschreitung beim Hochladen.*20 ms/);
    expect(e.von('persist')).toHaveLength(0);
  });
});

describe('commit_file_upload: Fehler nach dem Festhalten und beim Anhaengen nennen die fileId', () => {
  it('file/persist abgewiesen: Meldung nennt fileId, «nicht festgehalten»; nicht angehaengt', async () => {
    const e = env({ persist: () => json({ success: false, errors: [{ message: 'Datei unbekannt' }] }) });
    const r = await ausfuehren(ts(e));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Datei unbekannt');
    expect(text(r)).toContain('nicht festgehalten (fileId 5)');
    expect(e.von('order-read')).toHaveLength(1);   // nur die Vorpruefung
  });
  it('file/persist mit unklarem Ausgang (500): fileId und «Ob die Datei festgehalten ist, ist offen»', async () => {
    const e = env({ persist: () => new Response('x', { status: 500 }) });
    const r = await ausfuehren(ts(e));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('fileId 5');
    expect(text(r)).toMatch(/festgehalten ist, ist offen/);
    expect(r.structuredContent).toMatchObject({ sent: true });
  });
  it('Anhaengen scheitert nach dem Festhalten: Meldung nennt die fileId und den Weg «nur noch anhaengen»; sent true', async () => {
    const e = env({ update: () => json({ success: false, errors: [{ message: 'Beleg gesperrt' }] }) });
    const r = await ausfuehren(ts(e));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Beleg gesperrt');
    expect(text(r)).toContain('festgehalten (fileId 5)');
    expect(text(r)).toMatch(/nicht an Beleg 77 angehängt.*fileId 5 und anhaengenAn/);
    expect(r.structuredContent).toMatchObject({ sent: true });
    expect(r.structuredContent).not.toHaveProperty('createdId');
  });
  it('Anhaengen scheitert unklar (500): zusaetzlich «offen: den Beleg pruefen»', async () => {
    const e = env({ update: () => new Response('x', { status: 500 }) });
    const r = await ausfuehren(ts(e));
    expect(text(r)).toContain('fileId 5');
    expect(text(r)).toMatch(/Anhängen ausgeführt wurde, ist offen/);
  });
  it('order/read scheitert erst in Schritt 5 (Vorpruefung ging durch): die Datei ist festgehalten, fileId genannt, kein update', async () => {
    const e = env();
    const inner = e.fetchImpl;
    let reads = 0;
    const fetchImpl = (async (u: string | URL, i?: RequestInit) => String(u).includes('/order/read') && ++reads === 2 ? json({ success: false, errorMessage: 'This document does not exist.' }) : inner(u, i)) as unknown as typeof fetch;
    const r = await ausfuehren(createToolset(cfg(), { fetchImpl, stores: { usage: zaehler().s } }));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('festgehalten (fileId 5)');
    expect(e.von('update')).toHaveLength(0);
    expect(r.structuredContent).toMatchObject({ fileId: 5, festgehalten: 'ja' });
  });
  it('mit fileId: Anhaengen abgewiesen meldet sent false und die fileId, ohne «Datei festgehalten»-Behauptung', async () => {
    const e = env({ update: () => json({ success: false, errors: [{ message: 'Beleg gesperrt' }] }) });
    const r = await ausfuehren(ts(e), { fileId: 5, anhaengenAn: { art: 'order', id: 77 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('fileId 5 wurde nicht an Beleg 77 angehängt');
    expect(r.structuredContent).toMatchObject({ sent: false });
  });
  it('Anhangliste fehlt oder ist nicht lesbar: nichts gesendet, nichts ueberschrieben', async () => {
    for (const attachments of [undefined, 'keine', null, [{ id: 1 }], [{ fileId: 'x' }]]) {
      const e = env({ attachments });
      const r = await ausfuehren(ts(e), { fileId: 5, anhaengenAn: { art: 'order', id: 77 } });
      expect(r.isError, JSON.stringify(attachments)).toBe(true);
      expect(e.von('update'), JSON.stringify(attachments)).toHaveLength(0);
      expect(text(r)).toMatch(/Anhangliste/);
    }
  });
});

describe('commit_file_upload: Vorpruefung des Belegs vor file/prepare (0.6.0)', () => {
  it('Beleg unbekannt: Fehler ohne Upload (kein file/prepare, kein PUT, kein persist), nicht gesendet', async () => {
    const e = env();
    const inner = e.fetchImpl;
    const fetchImpl = (async (u: string | URL, i?: RequestInit) => String(u).includes('/order/read') ? json({ success: false, errorMessage: 'This document does not exist.' }) : inner(u, i)) as unknown as typeof fetch;
    const r = await ausfuehren(createToolset(cfg(), { fetchImpl, stores: { usage: zaehler().s } }));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Nichts hochgeladen');
    expect(e.calls).toHaveLength(0);
    expect(r.structuredContent).not.toHaveProperty('sent');
    expect(r.structuredContent).not.toHaveProperty('fileId');
  });
  it('Anhangliste nicht lesbar: Fehler ohne Upload', async () => {
    for (const attachments of [undefined, 'keine', null, [{ id: 1 }], [{ fileId: 'x' }]]) {
      const e = env({ attachments });
      const r = await ausfuehren(ts(e));
      expect(r.isError, JSON.stringify(attachments)).toBe(true);
      expect(e.calls.map((c) => c.kind), JSON.stringify(attachments)).toEqual(['order-read']);
      expect(text(r)).toMatch(/Anhangliste.*Nichts hochgeladen/);
    }
  });
  it('ohne anhaengenAn keine Vorpruefung; mit fileId genau ein order/read (Schritt 5)', async () => {
    const e = env();
    await ausfuehren(ts(e), { name: 'a.pdf', inhalt: b64(PDF) });
    expect(e.von('order-read')).toHaveLength(0);
    const e2 = env();
    await ausfuehren(ts(e2), { fileId: 5, anhaengenAn: { art: 'order', id: 77 } });
    expect(e2.von('order-read')).toHaveLength(1);
  });
});

describe('Fehler und Erfolg tragen maschinenlesbare Felder (fileId, festgehalten)', () => {
  const FELDER = { fileId: 5 };
  it('Fehler beim PUT (500), bei abgewiesener Adresse, MD5, Zeitgrenze: fileId 5, festgehalten nein', async () => {
    const faelle = [env({ put: () => new Response(null, { status: 500 }) }), env({ writeUrl: 'http://evil.example.com/p/x' }), env({ put: () => new Response(null, { status: 200, headers: { 'opc-content-md5': 'AAAA' } }) }), env({ put: () => new Response(null, { status: 302 }) })];
    for (const e of faelle) {
      const r = await ausfuehren(ts(e));
      expect(r.structuredContent).toMatchObject({ ...FELDER, festgehalten: 'nein', sent: true });
    }
  });
  it('persist abgewiesen: nein; persist mit offenem Ausgang: offen; Anhaengen gescheitert (abgewiesen oder offen): ja', async () => {
    expect((await ausfuehren(ts(env({ persist: () => json({ success: false, errors: [{ message: 'x' }] }) })))).structuredContent).toMatchObject({ ...FELDER, festgehalten: 'nein' });
    expect((await ausfuehren(ts(env({ persist: () => new Response('x', { status: 500 }) })))).structuredContent).toMatchObject({ ...FELDER, festgehalten: 'offen' });
    expect((await ausfuehren(ts(env({ update: () => json({ success: false, errors: [{ message: 'x' }] }) })))).structuredContent).toMatchObject({ ...FELDER, festgehalten: 'ja' });
    expect((await ausfuehren(ts(env({ update: () => new Response('x', { status: 500 }) })))).structuredContent).toMatchObject({ ...FELDER, festgehalten: 'ja' });
  });
  it('mit fileId (Aufrufer haengt nur an): fileId gesetzt, festgehalten nicht behauptet', async () => {
    const r = await ausfuehren(ts(env({ update: () => json({ success: false, errors: [{ message: 'x' }] }) })), { fileId: 5, anhaengenAn: { art: 'order', id: 77 } });
    expect(r.structuredContent).toMatchObject({ fileId: 5 });
    expect(r.structuredContent).not.toHaveProperty('festgehalten');
  });
  it('die Felder bleiben auch dann, wenn der Text von der Adresse bereinigt wird', async () => {
    const r = await ausfuehren(ts(env({ persist: () => json({ success: false, errors: [{ message: `Datei ${URL_OK} unbekannt` }] }) })));
    expect(text(r)).toContain('[Upload-Adresse]');
    expect(r.structuredContent).toMatchObject({ fileId: 5, festgehalten: 'nein' });
  });
  it('Fehler vor jeder Datei (Eingabe, Vorpruefung): keine dieser Felder', async () => {
    const r = await ts(env()).call('prepare_file_upload', { name: 'a.pdf', inhalt: 'AAAA' });
    expect(r.structuredContent).not.toHaveProperty('fileId');
    expect(r.structuredContent).not.toHaveProperty('festgehalten');
  });
  it('Erfolg: genau diese Felder in structuredContent', async () => {
    const r = await ausfuehren(ts(env({ attachments: [{ fileId: 3 }] })));
    expect(r.structuredContent).toEqual({ org: 'nt', fileId: 5, name: 'rechnung.pdf', bytes: PDF.length, sha256: sha(PDF), festgehalten: true, angehaengt: true, beleg: 77, fileIds: [3, 5], message: 'Datei rechnung.pdf festgehalten (fileId 5) und an Beleg 77 angehängt.' });
  });
  it('G3: beim blossen Anhaengen mit fileId steht im Erfolg kein festgehalten (das Werkzeug prueft es dort nicht)', async () => {
    const r = await ausfuehren(ts(env({ attachments: [{ fileId: 3 }] })), { fileId: 5, anhaengenAn: { art: 'order', id: 77 } });
    expect(r.isError, text(r)).toBeFalsy();
    expect(r.structuredContent).toEqual({ org: 'nt', fileId: 5, angehaengt: true, beleg: 77, fileIds: [3, 5], message: 'Datei 5 an Beleg 77 angehängt.' });
  });
});

describe('Token: Einmaligkeit, Bindung, fremder Speicher', () => {
  it('ein zweites commit mit demselben Token geht nicht und sendet nichts', async () => {
    const e = env();
    const t = ts(e);
    const token = await vorbereiten(t);
    expect((await t.call('commit_file_upload', { token })).isError).toBeFalsy();
    const n = e.calls.length;
    const r2 = await t.call('commit_file_upload', { token });
    expect(r2.isError).toBe(true);
    expect(text(r2)).toMatch(/Token unbekannt oder schon verwendet/);
    expect(e.calls).toHaveLength(n);
  });
  it('ein Token von prepare_contact oeffnet commit_file_upload nicht', async () => {
    const e = env();
    const t = ts(e);
    const p = await t.call('prepare_contact', { company: 'X AG' });
    const r = await t.call('commit_file_upload', { token: (p.structuredContent as { token: string }).token });
    expect(r.isError).toBe(true);
    expect(e.von('prepare')).toHaveLength(0);
  });
  it('ein fremder Token-Speicher, der die Nutzlast veraendert: Abbruch vor jedem Aufruf (Grösse und SHA-256 gegen die Vorschau)', async () => {
    const inner = new MemoryTokenStore();
    const manipuliert: TokenStore = {
      issue: (k, o, p) => inner.issue(k, o, p),
      async redeem<T>(k: string, o: string, tok: string) {
        const p = await inner.redeem<{ inhalt: string }>(k, o, tok);
        return { ...p, inhalt: Buffer.from('%PDF-1.4\nANDERER INHALT\n').toString('base64') } as T;
      },
    };
    const e = env();
    const r = await ausfuehren(ts(e, { tokens: manipuliert }));
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/stimmt nicht mit der Vorschau überein/);
    expect(e.calls).toHaveLength(0);
  });
  it('ein serialisierender Token-Speicher (JSON) traegt die Nutzlast: sie ist JSON-tauglich', async () => {
    const inner = new MemoryTokenStore();
    const seri: TokenStore = {
      issue: (k, o, p) => inner.issue(k, o, JSON.parse(JSON.stringify(p))),
      redeem: (k, o, tok) => inner.redeem(k, o, tok),
    };
    const e = env();
    const r = await ausfuehren(ts(e, { tokens: seri }));
    expect(r.isError, text(r)).toBeFalsy();
    expect(Buffer.from(e.puts()[0].bytes!).equals(PDF)).toBe(true);
  });
});

describe('Die Upload-Adresse verlaesst den Prozess nie', () => {
  /** Jede Antwort und jede Protokollzeile eines Laufs. */
  async function lauf(e: ReturnType<typeof env>, args: Record<string, unknown> = ARGS, opt: Parameters<typeof ts>[1] = {}) {
    const sp = spione();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const t = ts(e, opt);
    const p = await t.call('prepare_file_upload', args);
    const c = await t.call('commit_file_upload', { token: (p.structuredContent as { token?: string }).token ?? 'x' });
    const log = [...sp, stderr, stdout].flatMap((s) => s.mock.calls.map((a) => String(a[0])));
    return { p, c, log, alles: sichtbar(p) + sichtbar(c) + log.join('\n') };
  }
  /**
   * Fenster von 8 Zeichen: kein Teilstueck von 8 Zeichen aus dem Token, dem Namespace, dem Bucket und dem Objektpfad der Adresse
   * (ohne den Dateinamen, der in Vorschau und Antwort ohnehin steht) darf irgendwo erscheinen. Ganze Zeichenketten zu suchen
   * uebersaehe eine Kennung, die nur einen Teil der Adresse traegt.
   */
  const GEHEIM = `/p/${TOKEN}/n/ns/b/prod/o/ab/file/ju/kh/`;
  const FENSTER = Array.from({ length: GEHEIM.length - 7 }, (_, i) => GEHEIM.slice(i, i + 8));
  const leckt = (s: string) => FENSTER.some((f) => s.includes(f)) || s.includes(URL_OK);

  it('Erfolg, jeder Fehlerfall und jede Eingabeabweisung: weder Token noch Pfad noch Adresse in Antwort, Fehlertext, Protokoll', async () => {
    const faelle: [string, ReturnType<typeof env>, Record<string, unknown>?][] = [
      ['Erfolg', env()],
      ['Erfolg ohne Ziel', env(), { name: 'a.pdf', inhalt: b64(PDF) }],
      ['PUT 500', env({ put: () => new Response(null, { status: 500 }) })],
      ['PUT 302', env({ put: () => new Response(null, { status: 302, headers: { location: URL_OK } }) })],
      ['MD5', env({ put: () => new Response(null, { status: 200, headers: { 'opc-content-md5': 'AAAA' } }) })],
      ['persist 500', env({ persist: () => new Response('x', { status: 500 }) })],
      ['update abgewiesen', env({ update: () => json({ success: false, errors: [{ message: 'nein' }] }) })],
      ['fremder Host', env({ writeUrl: URL_OK.replace('objectstorage.eu-zurich-1.oraclecloud.com', 'evil.example.com') })],
      ['http', env({ writeUrl: URL_OK.replace('https:', 'http:') })],
      ['Port', env({ writeUrl: URL_OK.replace('.com/', '.com:8443/') })],
      ['Benutzerangaben', env({ writeUrl: URL_OK.replace('https://', 'https://u:p@') })],
      ['Pfad ohne /p/', env({ writeUrl: URL_OK.replace('/p/', '/q/') })],
    ];
    for (const [name, e, args] of faelle) {
      const l = await lauf(e, args);
      // Positivkontrolle: die Attrappe hat die Adresse mit dem Token wirklich ausgeliefert (sonst waere «kein Treffer» wertlos)
      expect(e.von('prepare').length, name).toBeGreaterThan(0);
      expect(leckt(l.alles), name).toBe(false);
    }
  });
  it('Positivkontrolle der Messung: der Pruefer schlaegt an, wenn die Adresse in einem Text steht (z.B. ueber den allgemeinen Fehlerweg von nachSchreiben)', () => {
    const roh = new Error(`fetch failed fuer ${URL_OK}`);
    expect(leckt(JSON.stringify(fail(nachSchreiben(roh, true))))).toBe(true);
    expect(leckt('nichts davon')).toBe(false);
  });
  it('eine fremde fetch-Ausnahme, deren Meldung die Adresse traegt, kommt nicht durch (Name oder Code, nie die Meldung)', async () => {
    const e = env({ put: () => { throw new TypeError(`fetch failed: PUT ${URL_OK}`); } });
    const l = await lauf(e);
    expect(l.c.isError).toBe(true);
    expect(text(l.c)).toMatch(/Netzwerkfehler beim Hochladen.*TypeError/);
    expect(leckt(l.alles)).toBe(false);
    const e2 = env({ put: () => { throw Object.assign(new Error(URL_OK), { code: 'ECONNRESET' }); } });
    const l2 = await lauf(e2);
    expect(text(l2.c)).toContain('ECONNRESET');
    expect(leckt(l2.alles)).toBe(false);
  });
  it('N1: eine Adresse mit ungueltigem UTF-8 in der Prozentkodierung (%C3EN) macht aus einem ECONNRESET keinen unknown-Fehler', async () => {
    const adresse = 'https://objectstorage.eu-zurich-1.oraclecloud.com/p/TOK%C3EN123456/n/ns/b/prod/o/x';
    expect(() => decodeURIComponent(adresse)).toThrow(URIError);   // Voraussetzung: genau diese Adresse bringt decodeURIComponent zum Werfen
    const e = env({ writeUrl: adresse, put: () => { throw Object.assign(new Error('x'), { code: 'ECONNRESET' }); } });
    const r = await ausfuehren(ts(e));
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ kind: 'network', fileId: 5, festgehalten: 'nein' });
    expect(text(r)).toContain('(ECONNRESET)');
    for (let i = 0; i + 8 <= 'TOK%C3EN123456'.length; i++) expect(sichtbar(r)).not.toContain('TOK%C3EN123456'.slice(i, i + 8));
    // und ein hostiler code, der ein Stueck dieser Adresse ist, wird weiter verworfen
    const e2 = env({ writeUrl: adresse, put: () => { throw Object.assign(new Error('x'), { code: 'TOK' }); } });
    expect(text(await ausfuehren(ts(e2)))).toMatch(/\((unbekannt|Error)\)/);
  });
  it('Positivkontrolle der Fenster: schon ein Teilstueck von 8 Zeichen schlaegt an', () => {
    expect(leckt(`x ${TOKEN.slice(5, 13)} y`)).toBe(true);
    expect(leckt(encodeURIComponent(URL_OK.slice(0, 80)))).toBe(true);
    expect(leckt('Netzwerkfehler beim Hochladen zum Objektspeicher objectstorage.eu-zurich-1.oraclecloud.com (ECONNRESET). rechnung.pdf')).toBe(false);
  });
  it('M1: code, name und cause.code einer fremden Ausnahme tragen Teile der Adresse (gemessen vom Pruefer): nur eine Positivliste kommt durch, sonst «unbekannt»', async () => {
    const faelle: [string, () => never][] = [
      ['code = die ersten 80 Zeichen der Adresse', () => { throw Object.assign(new Error('x'), { code: URL_OK.slice(0, 80) }); }],
      ['name = 30 Zeichen des Tokens', () => { const x = new Error('x'); x.name = TOKEN.slice(0, 30); throw x; }],
      ['cause.code = Adresse URL-kodiert', () => { throw new Error('x', { cause: { code: encodeURIComponent(URL_OK) } }); }],
      ['code gross und in Positivlisten-Form, aber ein Stueck der Adresse', () => { throw Object.assign(new Error('x'), { code: TOKEN.slice(0, 11) }); }],
      ['name nur aus Buchstaben, aber ein Stueck der Adresse', () => { const x = new Error('x'); x.name = 'objectstorage'; throw x; }],
      ['code kein String', () => { throw Object.assign(new Error('x'), { code: { url: URL_OK } }); }],
    ];
    for (const [name, wirf] of faelle) {
      const l = await lauf(env({ put: wirf }));
      expect(l.c.isError, name).toBe(true);
      // Die hostile Kennung wird verworfen; es bleibt der unverdaechtige Name «Error» der Attrappe oder «unbekannt» (wenn auch der Name hostil ist).
      expect(text(l.c), name).toMatch(/Netzwerkfehler beim Hochladen zum Objektspeicher [^ ]+ \((unbekannt|Error)\)\./);
      expect(leckt(l.alles), name).toBe(false);
    }
    // Positivkontrolle: echte Kennungen kommen weiter durch
    expect(text((await lauf(env({ put: () => { throw Object.assign(new Error('x'), { code: 'ECONNRESET' }); } }))).c)).toContain('(ECONNRESET)');
    expect(text((await lauf(env({ put: () => { throw new TypeError('x'); } }))).c)).toContain('(TypeError)');
    expect(text((await lauf(env({ put: () => { throw new Error('x', { cause: { code: 'UND_ERR_SOCKET' } }); } }))).c)).toContain('(UND_ERR_SOCKET)');
  });
  it('Fehler aus einer Ausnahme mit der Adresse in cause oder name: ebenfalls nicht', async () => {
    const e = env({ put: () => { const x = new Error('x', { cause: new Error(URL_OK) }); x.name = 'EigenerFehler'; throw x; } });
    const l = await lauf(e);
    expect(l.c.isError).toBe(true);
    expect(leckt(l.alles)).toBe(false);
  });
  it('G2: lehnt file/prepare ab und nennt die Adresse im Text, wird der Text durch einen festen ersetzt', async () => {
    for (const grund of [`Fehler bei ${URL_OK}`, 'siehe https://objectstorage.eu-zurich-1.oraclecloud.com/x', 'Pfad /p/abc fehlt']) {
      const e = env({ prepare: () => json({ success: false, errors: [{ message: grund }] }) });
      const r = await ausfuehren(ts(e));
      expect(r.isError, grund).toBe(true);
      expect(text(r), grund).toMatch(/abgelehnt.*Adresse.*nicht gezeigt/);
      expect(leckt(sichtbar(r))).toBe(false);
      expect(sichtbar(r)).not.toContain('/p/abc');
      expect(r.structuredContent).toMatchObject({ kind: 'validation', sent: false });
      expect(e.puts()).toHaveLength(0);
    }
    // Positivkontrolle: eine Ablehnung ohne Adresse bleibt im Wortlaut
    const r2 = await ausfuehren(ts(env({ prepare: () => json({ success: false, errors: [{ message: 'Dateiname ungültig' }] }) })));
    expect(text(r2)).toContain('Dateiname ungültig');
  });
  it('G5: file/prepare liefert null, kein data-Array oder ein leeres: saubere Meldung mit sent true, kein «Cannot read properties»', async () => {
    for (const antwort of [null, { success: true }, { success: true, data: 'x' }, { success: true, data: [] }, { success: true, data: [null] }]) {
      const e = env({ prepare: () => json(antwort) });
      const r = await ausfuehren(ts(e));
      expect(r.isError, JSON.stringify(antwort)).toBe(true);
      expect(text(r)).toMatch(/file\/prepare hat keine fileId geliefert/);
      expect(text(r)).not.toMatch(/Cannot read|undefined|null/);
      expect(r.structuredContent).toMatchObject({ sent: true });
      expect(e.puts()).toHaveLength(0);
    }
  });
  it('G5: order/read ohne data liefert eine saubere Meldung (Vorpruefung und Schritt 5), nicht «Cannot read properties»', async () => {
    const e = env();
    const inner = e.fetchImpl;
    const fetchImpl = (async (u: string | URL, i?: RequestInit) => String(u).includes('/order/read') ? json({ success: true }) : inner(u, i)) as unknown as typeof fetch;
    const r = await ausfuehren(createToolset(cfg(), { fetchImpl, stores: { usage: zaehler().s } }));
    expect(r.isError).toBe(true);
    expect(text(r)).not.toMatch(/Cannot read|undefined/);
    expect(text(r)).toMatch(/Nichts hochgeladen/);
    const r2 = await ausfuehren(createToolset(cfg(), { fetchImpl, stores: { usage: zaehler().s } }), { fileId: 5, anhaengenAn: { art: 'order', id: 77 } });
    expect(text(r2)).not.toMatch(/Cannot read|undefined/);
  });
  it('persist: eine Ablehnung mit der Adresse in der Meldung wird geschwaerzt', async () => {
    const e = env({ persist: () => json({ success: false, errors: [{ message: `Datei ${URL_OK} unbekannt` }] }) });
    const l = await lauf(e);
    expect(l.c.isError).toBe(true);
    expect(text(l.c)).toContain('[Upload-Adresse]');
    expect(leckt(l.alles)).toBe(false);
  });
  it('die Vorschau (prepare) kennt die Adresse gar nicht: der Token-Speicher haelt sie nie', async () => {
    const gesehen: unknown[] = [];
    const inner = new MemoryTokenStore();
    const spion: TokenStore = { issue: (k, o, p) => { gesehen.push(p); return inner.issue(k, o, p); }, redeem: (k, o, t) => inner.redeem(k, o, t) };
    const e = env();
    await ausfuehren(ts(e, { tokens: spion }));
    expect(JSON.stringify(gesehen)).not.toContain('oraclecloud');
    expect(JSON.stringify(gesehen)).not.toContain(TOKEN);
  });
});

describe('Offene Vorschauen sind begrenzt (M3a)', () => {
  it('hoechstens 3 gleichzeitig offene Upload-Vorschauen; die vierte wird abgewiesen, ohne Token', async () => {
    const e = env();
    const t = ts(e);
    const tokens = [await vorbereiten(t), await vorbereiten(t), await vorbereiten(t)];
    const r = await t.call('prepare_file_upload', ARGS);
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('Zu viele offene Upload-Vorschauen; erst ausführen oder 10 Minuten warten.');
    expect(r.structuredContent).toMatchObject({ kind: 'validation' });
    expect(r.structuredContent).not.toHaveProperty('token');
    // ein Einloesen gibt einen Platz frei
    expect((await t.call('commit_file_upload', { token: tokens[0] })).isError).toBeFalsy();
    expect((await t.call('prepare_file_upload', ARGS)).isError).toBeFalsy();
    expect((await t.call('prepare_file_upload', ARGS)).isError).toBe(true);
  });
  it('abgelaufene Vorschauen werden vor dem Zaehlen weggeraeumt', async () => {
    let jetzt = 1_000_000;
    const t = ts(env(), { tokens: new MemoryTokenStore(undefined, () => jetzt) });
    for (let i = 0; i < 3; i++) await vorbereiten(t);
    expect((await t.call('prepare_file_upload', ARGS)).isError).toBe(true);
    jetzt += 10 * 60_000 + 1;
    expect((await t.call('prepare_file_upload', ARGS)).isError).toBeFalsy();
  });
  it('N2: nur Vorschauen mit inhalt zaehlen; mit fileId (haelt keine Datei) geht auch bei 3 offenen noch eine durch und zaehlt nicht mit', async () => {
    const t = ts(env());
    for (let i = 0; i < 3; i++) await vorbereiten(t);
    for (let i = 0; i < 5; i++) expect((await t.call('prepare_file_upload', { fileId: 5, anhaengenAn: { art: 'order', id: 77 } })).isError, String(i)).toBeFalsy();
    expect((await t.call('prepare_file_upload', ARGS)).isError).toBe(true);
  });
  it('die Grenze gilt ueber alle Organisationen gemeinsam', async () => {
    const t = createToolset(cfg([ORG({ name: 'a' }), ORG({ name: 'b', subdomain: 'e' })]), { fetchImpl: env().fetchImpl, stores: { usage: zaehler().s } });
    for (const org of ['a', 'a', 'b']) expect((await t.call('prepare_file_upload', { ...ARGS, org })).isError).toBeFalsy();
    expect((await t.call('prepare_file_upload', { ...ARGS, org: 'b' })).isError).toBe(true);
    expect((await t.call('prepare_file_upload', { ...ARGS, org: 'a' })).isError).toBe(true);
  });
  it('andere Arten sind nicht begrenzt und zaehlen nicht mit', async () => {
    const t = ts(env());
    for (let i = 0; i < 3; i++) await vorbereiten(t);
    for (let i = 0; i < 5; i++) expect((await t.call('prepare_contact', { company: `X${i} AG` })).isError, String(i)).toBeFalsy();
    const store = new MemoryTokenStore();
    for (let i = 0; i < 6; i++) await store.issue('contact', 'nt', {});
  });
});

describe('Konfiguration uploadRegions', () => {
  it('G6: eine ungueltige Region ueber das Config-Objekt (Bibliotheksweg) wird beim Bau abgewiesen, global und je Organisation', () => {
    for (const regionen of [['evil'], ['eu-zurich-1.evil.com'], ['EU-ZURICH-1'], ['eu-zurich-1:443'], []]) {
      expect(() => createToolset(cfg([ORG({ uploadRegions: regionen })]), { fetchImpl: env().fetchImpl }), JSON.stringify(regionen)).toThrow(/uploadRegions|Region/);
      expect(() => createToolset(cfg([ORG()], { uploadRegions: regionen }), { fetchImpl: env().fetchImpl }), JSON.stringify(regionen)).toThrow(/uploadRegions|Region/);
    }
    expect(() => createToolset(cfg([ORG({ uploadRegions: ['eu-zurich-1', 'eu-frankfurt-1'] })]), { fetchImpl: env().fetchImpl })).not.toThrow();
  });
  it('Datei: global und je Organisation; Umgebung: CASHCTRL_UPLOAD_REGIONS kommagetrennt; ungueltige Region abgewiesen', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, chmodSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = (c?: unknown) => { const h = mkdtempSync(join(tmpdir(), 'home-')); if (c === undefined) return h; mkdirSync(join(h, '.config/cashctrl-mcp'), { recursive: true }); const f = join(h, '.config/cashctrl-mcp/config.json'); writeFileSync(f, JSON.stringify(c)); chmodSync(f, 0o600); return h; };
    const c = await loadConfig({ home: home({ uploadRegions: ['eu-frankfurt-1'], orgs: [{ name: 'a', subdomain: 'a', apiKey: 'k' }, { name: 'b', subdomain: 'b', apiKey: 'k', uploadRegions: ['eu-zurich-1', 'eu-amsterdam-1'] }] }), env: {} });
    expect(c.uploadRegions).toEqual(['eu-frankfurt-1']);
    expect(c.orgs[1].uploadRegions).toEqual(['eu-zurich-1', 'eu-amsterdam-1']);
    const sichtOrgs = (await import('../../src/tools/context.js')).buildContext(c).config.orgs;
    expect(sichtOrgs.map((o) => o.uploadRegions)).toEqual([['eu-frankfurt-1'], ['eu-zurich-1', 'eu-amsterdam-1']]);
    const standard = (await import('../../src/tools/context.js')).buildContext(await loadConfig({ home: home({ orgs: [{ name: 'a', subdomain: 'a', apiKey: 'k' }] }), env: {} }));
    expect(standard.config.orgs[0].uploadRegions).toEqual(['eu-zurich-1']);
    const ev = await loadConfig({ home: home(), env: { CASHCTRL_SUBDOMAIN: 'demo', CASHCTRL_API_KEY: 'k', CASHCTRL_UPLOAD_REGIONS: 'eu-zurich-1, eu-frankfurt-1' } });
    expect(ev.orgs[0].uploadRegions).toEqual(['eu-zurich-1', 'eu-frankfurt-1']);
    for (const schlecht of ['evil.com/x', 'EU-ZURICH-1', 'zurich', 'eu-zurich-1.evil.com', 'eu-zurich-1:443', '']) {
      await expect(loadConfig({ home: home({ orgs: [{ name: 'a', subdomain: 'a', apiKey: 'k', uploadRegions: [schlecht] }] }), env: {} }), schlecht).rejects.toThrow(/uploadRegions|Region/);
    }
    await expect(loadConfig({ home: home({ orgs: [{ name: 'a', subdomain: 'a', apiKey: 'k', uploadRegions: [] }] }), env: {} })).rejects.toThrow();
  });
});
