import { describe, it, expect, afterAll } from 'vitest';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolset, type ToolModule } from '../../src/toolset.js';
import { apiModule } from '../../src/tools/api/index.js';
import { MemoryTokenStore } from '../../src/tools/tokens.js';
import type { ToolContext } from '../../src/tools/context.js';
import type { Config, OrgConfig } from '../../src/config/config.js';

/**
 * prepare_api_write / commit_api_write (0.4.0). Keine Live-Aufrufe. Zusagen: prepare ruft CashCtrl nie
 * auf; Schalter (deleteRecords, salary, sendMail) der angesprochenen Organisation werden in prepare UND
 * commit vor dem Netzaufruf geprueft; commit sendet genau einen POST mit der bei prepare gespeicherten
 * Eingabe; das Token loest sich nur einmal ein.
 */
const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-api-write.json`);
afterAll(async () => { await rm(usageFile, { force: true }); });
const cfg = (orgs: OrgConfig[], mode: Config['mode'] = 'full'): Config => ({ mode, pdfDir: '/tmp/x', usageFile, source: 'env', orgs });
const ORG = (extra: Partial<OrgConfig> = {}): OrgConfig => ({ name: 'nt', subdomain: 'd', 'apiKey': 'k', ...extra });
const text = (r: { content?: unknown[] }) => {
  const c = r.content?.[0];
  return c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '';
};
const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });

function env(antwort: () => Response = () => json({ success: true, insertId: 11, message: 'Angelegt' })) {
  const calls: { url: URL; method: string; body: string }[] = [];
  const fetchImpl = (async (u: string | URL, init?: RequestInit) => { calls.push({ url: new URL(String(u)), method: init?.method ?? 'GET', body: String(init?.body ?? '') }); return antwort(); }) as unknown as typeof fetch;
  const posts = () => calls.filter((c) => c.method === 'POST');
  return { calls, posts, fetchImpl };
}
const ts = (orgs: OrgConfig[], e = env(), extra: { tokens?: MemoryTokenStore; modules?: ToolModule[] } = {}) =>
  createToolset(cfg(orgs), { fetchImpl: e.fetchImpl, stores: extra.tokens ? { tokens: extra.tokens } : undefined, modules: extra.modules });

const TITEL = { path: 'person/title/create.json', params: { name: 'MCP-TEST Titel', gender: 'M' } };
const LOESCHEN = { path: 'person/title/delete.json', params: { ids: '5' } };
const LOHN = { path: 'salary/status/create.json', params: { icon: 'BLUE', name: 'MCP-TEST Status' } };
const MAIL = { path: 'order/document/mail.json', params: { orderIds: '55', mailFrom: 'a@example.com', mailSubject: 'S', mailText: 'T' } };

describe('prepare_api_write', () => {
  it('ruft CashCtrl nie auf; Vorschau nennt Titel, Pfad, Organisation und die Felder als name = wert; warnt immer', async () => {
    const e = env();
    const r = await ts([ORG()], e).call('prepare_api_write', TITEL);
    expect(r.isError, text(r)).toBeFalsy();
    expect(e.calls).toHaveLength(0);
    const s = r.structuredContent as { summary: string; warnings: string[]; token: string; expiresAt: string };
    expect(s.summary).toContain('(person/title/create.json) in nt');
    expect(s.summary).toMatch(/^Create title/);
    expect(s.summary).toContain('name = MCP-TEST Titel');
    expect(s.summary).toContain('gender = M');
    expect(s.warnings).toEqual(['Allgemeiner Schreibweg: keine Fachprüfung des Servers (Rundung, Steuer, Dubletten), am Mandanten nicht gemessen.']);
    expect(s.token).toBeTruthy();
    expect(s.expiresAt).toBeTruthy();
  });
  it('Loeschen warnt zusaetzlich «Löschen ist unumkehrbar.»', async () => {
    const r = await ts([ORG({ deleteRecords: true })]).call('prepare_api_write', LOESCHEN);
    expect(r.isError, text(r)).toBeFalsy();
    const w = (r.structuredContent as { warnings: string[] }).warnings;
    expect(w).toHaveLength(2);
    expect(w[0]).toContain('Allgemeiner Schreibweg');
    expect(w[1]).toBe('Löschen ist unumkehrbar.');
  });
  it('jeder Wert in der Vorschau wird auf 200 Zeichen gekuerzt, Zeilenumbrueche einzeilig; Objekte als JSON', async () => {
    const r = await ts([ORG()]).call('prepare_api_write', { path: 'person/title/create.json', params: { name: 'n'.repeat(450), sentence: 'a\nb' } });
    const s = (r.structuredContent as { summary: string }).summary;
    expect(s).toContain(`name = ${'n'.repeat(200)}…`);
    expect(s).not.toContain('n'.repeat(201));
    expect(s).toContain('sentence = a⏎b');
    const o = await ts([ORG()]).call('prepare_api_write', { path: 'order/create.json', params: { associateId: [1, 2], categoryId: 3, date: '2026-10-24', items: [{ accountId: 3000, name: 'X', unitPrice: 1 }] } });
    const so = (o.structuredContent as { summary: string }).summary;
    expect(so).toContain('associateId = 1,2');
    expect(so).toContain('items = [{"accountId":3000,"name":"X","unitPrice":1}]');
  });

  async function abgewiesen(orgs: OrgConfig[], args: Record<string, unknown>, muster: RegExp) {
    const e = env();
    const r = await ts(orgs, e).call('prepare_api_write', args);
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(muster);
    expect(r.structuredContent).toMatchObject({ kind: 'validation' });
    expect(e.calls, 'fetch darf nicht aufgerufen worden sein').toHaveLength(0);
  }
  it('unbekannter Pfad, GET-Pfad, fehlender Pflichtparameter, unbekannter Parameter: abgewiesen, ohne fetch', async () => {
    await abgewiesen([ORG()], { path: 'person/gibtsnicht.json', params: {} }, /nicht im Katalog/);
    await abgewiesen([ORG()], { path: 'person/list.json', params: {} }, /liest nur/);
    await abgewiesen([ORG()], { path: 'person/title/create.json', params: { gender: 'M' } }, /Pflichtparameter fehlen.*name/);
    await abgewiesen([ORG()], { path: 'person/title/create.json' }, /Pflichtparameter fehlen.*name/);
    await abgewiesen([ORG()], { path: 'person/title/create.json', params: { name: 'x', zusatz: 1 } }, /Unbekannte Parameter.*zusatz/);
  });
  it('Loeschen ohne deleteRecords, Lohn ohne salary, Mail ohne sendMail: abgewiesen, ohne fetch', async () => {
    await abgewiesen([ORG()], LOESCHEN, /deleteRecords/);
    await abgewiesen([ORG()], LOHN, /salary/);
    await abgewiesen([ORG()], MAIL, /sendMail/);
  });
  it('deleteOrders schaltet das allgemeine Loeschen nicht frei, sendMail nicht den Lohn: die Schalter sind getrennt', async () => {
    await abgewiesen([ORG({ deleteOrders: true })], { path: 'order/delete.json', params: { ids: '5' } }, /deleteRecords/);
    await abgewiesen([ORG({ sendMail: true, deleteRecords: true })], LOHN, /salary/);
    await abgewiesen([ORG({ salary: true, deleteRecords: true })], MAIL, /sendMail/);
  });
  it('Ueberlagerung: salary/…/delete.json braucht salary UND deleteRecords, salary/…/mail.json salary UND sendMail', async () => {
    const lohnLoeschen = { path: 'salary/status/delete.json', params: { ids: '1' } };
    const lohnMail = { path: 'salary/document/mail.json', params: { statementIds: '1', mailFrom: 'a@example.com', mailSubject: 'S', mailText: 'T' } };
    await abgewiesen([ORG({ salary: true })], lohnLoeschen, /deleteRecords/);
    await abgewiesen([ORG({ deleteRecords: true })], lohnLoeschen, /salary/);
    await abgewiesen([ORG({ salary: true })], lohnMail, /sendMail/);
    await abgewiesen([ORG({ sendMail: true })], lohnMail, /salary/);
    const t = ts([ORG({ salary: true, deleteRecords: true, sendMail: true })]);
    expect((await t.call('prepare_api_write', lohnLoeschen)).isError).toBeFalsy();
    expect((await t.call('prepare_api_write', lohnMail)).isError).toBeFalsy();
  });
  it('zwei Organisationen: der Schalter der ANGESPROCHENEN zaehlt, nicht der irgendeiner', async () => {
    await abgewiesen([ORG({ name: 'mit', deleteRecords: true }), ORG({ name: 'ohne', subdomain: 'd2' })], { org: 'ohne', ...LOESCHEN }, /ohne nicht freigeschaltet \(deleteRecords\)/);
    const r = await ts([ORG({ name: 'mit', deleteRecords: true }), ORG({ name: 'ohne', subdomain: 'd2' })]).call('prepare_api_write', { org: 'mit', ...LOESCHEN });
    expect(r.isError, text(r)).toBeFalsy();
  });
});

describe('commit_api_write', () => {
  it('sendet genau einen POST mit der bei prepare gespeicherten Eingabe (form-encoded) und gibt die Antwort von CashCtrl zurueck', async () => {
    const e = env();
    const t = ts([ORG()], e);
    const { token } = (await t.call('prepare_api_write', TITEL)).structuredContent as { token: string };
    expect(e.calls).toHaveLength(0);
    const r = await t.call('commit_api_write', { token });
    expect(r.isError, text(r)).toBeFalsy();
    expect(e.posts()).toHaveLength(1);
    expect(e.calls).toHaveLength(1);
    const p = e.posts()[0];
    expect(`${p.url.origin}${p.url.pathname}`).toBe('https://d.cashctrl.com/api/v1/person/title/create.json');
    expect(new URLSearchParams(p.body).get('name')).toBe('MCP-TEST Titel');
    expect(new URLSearchParams(p.body).get('gender')).toBe('M');
    expect(r.structuredContent).toEqual({ path: 'person/title/create.json', org: 'nt', response: { success: true, insertId: 11, message: 'Angelegt' } });
  });
  it('CSV-Liste und JSON-Objekt gehen so hinaus, wie CashCtrl sie erwartet (7,8 statt [7,8]; items als JSON)', async () => {
    const e = env();
    const t = ts([ORG({ deleteRecords: true })], e);
    const { token } = (await t.call('prepare_api_write', { path: 'person/title/delete.json', params: { ids: [7, 8] } })).structuredContent as { token: string };
    await t.call('commit_api_write', { token });
    expect(new URLSearchParams(e.posts()[0].body).get('ids')).toBe('7,8');
    const items = [{ accountId: 3000, name: 'X', unitPrice: 1 }];
    const { token: t2 } = (await t.call('prepare_api_write', { path: 'order/create.json', params: { associateId: 1, categoryId: 2, date: '2026-10-24', items } })).structuredContent as { token: string };
    await t.call('commit_api_write', { token: t2 });
    expect(JSON.parse(new URLSearchParams(e.posts()[1].body).get('items')!)).toEqual(items);
  });
  it('das Token loest sich nur einmal ein: der zweite commit sendet nichts', async () => {
    const e = env();
    const t = ts([ORG()], e);
    const { token } = (await t.call('prepare_api_write', TITEL)).structuredContent as { token: string };
    expect((await t.call('commit_api_write', { token })).isError).toBeFalsy();
    const zweiter = await t.call('commit_api_write', { token });
    expect(zweiter.isError).toBe(true);
    expect(text(zweiter)).toContain('Token unbekannt oder schon verwendet');
    expect(e.posts()).toHaveLength(1);
  });
  it('ohne gueltiges Token und mit dem Token einer anderen Art oder Organisation: nichts gesendet', async () => {
    const e = env();
    const t = ts([ORG(), ORG({ name: 'zwei', subdomain: 'd2' })], e);
    expect((await t.call('commit_api_write', { org: 'nt', token: 'nope' })).isError).toBe(true);
    const { token } = (await t.call('prepare_api_write', { org: 'nt', ...TITEL })).structuredContent as { token: string };
    const fremd = await t.call('commit_api_write', { org: 'zwei', token });
    expect(fremd.isError).toBe(true);
    expect(text(fremd)).toContain('passt nicht');
    expect(e.posts()).toHaveLength(0);
  });
  it('success:false von CashCtrl: Fehler validation, sent false (nichts angelegt)', async () => {
    const e = env(() => json({ success: false, errors: [{ field: 'name', message: 'darf nicht leer sein' }] }));
    const t = ts([ORG()], e);
    const { token } = (await t.call('prepare_api_write', TITEL)).structuredContent as { token: string };
    const r = await t.call('commit_api_write', { token });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ kind: 'validation', sent: false });
    expect(text(r)).toContain('name: darf nicht leer sein');
  });
  it('HTTP 500 beim POST: sent true, Hinweis «nicht erneut ausführen», kein zweiter POST', async () => {
    const e = env(() => new Response('', { status: 500 }));
    const t = ts([ORG()], e);
    const { token } = (await t.call('prepare_api_write', TITEL)).structuredContent as { token: string };
    const r = await t.call('commit_api_write', { token });
    expect(r.structuredContent).toMatchObject({ sent: true });
    expect(text(r)).toContain('nicht erneut ausführen');
    expect(e.posts()).toHaveLength(1);
  });

  // Der Schalter wird in commit erneut geprueft: der Token-Speicher ist austauschbar (deps.stores) und die
  // Registrierung gilt fuer alle Organisationen. Der Schalter wird NACH prepare in der Sicht der Werkzeuge
  // entfernt (ctx ueber ein Zusatzmodul erreicht): die Sicht ist eine Kopie, das Config-Objekt zu aendern waere wirkungslos.
  const FAELLE: [string, Partial<OrgConfig>, Record<string, unknown>, 'salary' | 'deleteRecords' | 'sendMail'][] = [
    ['Loeschen', { deleteRecords: true }, LOESCHEN, 'deleteRecords'],
    ['Lohn', { salary: true }, LOHN, 'salary'],
    ['Mail', { sendMail: true }, MAIL, 'sendMail'],
  ];
  for (const [name, schalter, args, gate] of FAELLE) {
    it(`${name}: Schalter nach prepare entfernt, commit weist ab und sendet nichts (Gegenprobe: mit Schalter geht derselbe Token durch)`, async () => {
      const e = env();
      let ctx!: ToolContext;
      const fang: ToolModule = { tools(c) { ctx = c; return []; } };
      const t = ts([ORG(schalter)], e, { modules: [apiModule, fang] });
      const { token } = (await t.call('prepare_api_write', args)).structuredContent as { token: string };
      // Gegenprobe vorab an einem zweiten Token (gleicher Schalter gesetzt): POST geht hinaus.
      const { token: zweiter } = (await t.call('prepare_api_write', args)).structuredContent as { token: string };
      expect((await t.call('commit_api_write', { token: zweiter })).isError).toBeFalsy();
      expect(e.posts()).toHaveLength(1);
      ctx.config.orgs[0][gate] = false;
      const r = await t.call('commit_api_write', { token });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain(`(${gate})`);
      expect(e.posts(), 'kein zweiter POST').toHaveLength(1);
    });
    it(`${name}: geteilter Token-Speicher, zweite Werkzeugschicht ohne Schalter: commit weist ab`, async () => {
      const tokens = new MemoryTokenStore();
      const e = env();
      const mit = ts([ORG(schalter)], e, { tokens });
      const ohne = ts([ORG()], e, { tokens });
      const { token } = (await mit.call('prepare_api_write', args)).structuredContent as { token: string };
      const r = await ohne.call('commit_api_write', { token });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain(`(${gate})`);
      expect(e.calls).toHaveLength(0);
    });
  }
  it('ein Token-Speicher, der Unbekanntes einloest (fremde Eingabe), umgeht den Katalog nicht: unbekannter Pfad und unbekannter Parameter werden in commit abgewiesen', async () => {
    const e = env();
    for (const payload of [{ path: 'person/gibtsnicht.json', params: {} }, { path: 'person/title/create.json', params: { name: 'x', lang: 'de' } }, { path: 'person/list.json', params: {} }]) {
      const tokens = { issue: async () => ({ token: 't', expiresAt: '' }), redeem: async <T>() => payload as T };
      const t = createToolset(cfg([ORG()]), { fetchImpl: e.fetchImpl, stores: { tokens } });
      const r = await t.call('commit_api_write', { token: 't' });
      expect(r.isError, JSON.stringify(payload)).toBe(true);
    }
    expect(e.calls).toHaveLength(0);
  });
});

describe('Modus und Annotationen', () => {
  it('Werkzeugzahlen ohne Schalter: read 17, draft 23, full 33; api_write erst im Modus full', () => {
    const e = env();
    const namen = (m: Config['mode']) => createToolset(cfg([ORG()], m), { fetchImpl: e.fetchImpl }).names();
    expect(namen('read')).toHaveLength(17);
    expect(namen('draft')).toHaveLength(23);
    expect(namen('full')).toHaveLength(33);
    expect(namen('read')).toEqual(expect.arrayContaining(['api_catalog', 'api_read']));
    expect(namen('read')).not.toContain('prepare_api_write');
    expect(namen('draft')).not.toContain('commit_api_write');
    expect(namen('full')).toEqual(expect.arrayContaining(['api_catalog', 'api_read', 'prepare_api_write', 'commit_api_write']));
  });
  it('die vier neuen Werkzeuge stehen am Ende der Liste (DEFAULT_MODULES)', () => {
    expect(createToolset(cfg([ORG()])).names().slice(-4)).toEqual(['api_catalog', 'api_read', 'prepare_api_write', 'commit_api_write']);
  });
  it('commit_api_write traegt destructiveHint true, readOnlyHint false, idempotentHint false; prepare_api_write readOnlyHint true', () => {
    const t = createToolset(cfg([ORG()])).tools;
    expect(t.find((x) => x.name === 'commit_api_write')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    expect(t.find((x) => x.name === 'prepare_api_write')!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });
  it('Beschreibung von prepare_api_write: Fachwerkzeuge vorziehen, api_catalog zuerst, experimentell, Schalter genannt', () => {
    const d = createToolset(cfg([ORG()])).tools.find((x) => x.name === 'prepare_api_write')!.description;
    expect(d).toMatch(/Fachwerkzeuge/);
    expect(d).toMatch(/api_catalog zuerst/);
    expect(d).toMatch(/EXPERIMENTELL/);
    for (const s of ['deleteRecords', 'salary', 'sendMail']) expect(d).toContain(s);
    expect(d).toContain('ausdrückliches Ja');
  });
});
