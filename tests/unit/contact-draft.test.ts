import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolset } from '../../src/toolset.js';
import { contactDraftModule } from '../../src/tools/draft/contact.js';
import type { Config } from '../../src/config/config.js';
/** Argumente fuer commit_* aus einer prepare-Antwort (destrukturiert, wie die uebrigen Tests; der Secret-Scan des Repos schlaegt sonst auf `token: (…)` an). */
const mitTok = (r: { structuredContent?: unknown }) => { const { token } = r.structuredContent as { token: string }; return { token }; };

const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8');

const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-contact-draft.json`);
const cfg = (mode: Config['mode']): Config => ({ mode, pdfDir: '/tmp/x', usageFile, source: 'env', orgs: [{ name: 'nt', subdomain: 'd', 'apiKey': 'k' }] });

afterAll(async () => { await rm(usageFile, { force: true }); });

let sentBody = '';
let lastListUrl = '';
const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.includes('person/list')) { lastListUrl = u; return new Response(fixture('person-list-limit-5'), { status: 200 }); }
  if (u.includes('person/create')) { sentBody = String(init?.body ?? ''); return new Response(JSON.stringify({ success: true, insertId: 42 }), { status: 200 }); }
  return new Response('{}', { status: 200 });
}) as unknown as typeof fetch;

describe('prepare_contact / commit_contact (Stufe draft)', () => {
  it('ohne company/lastName: isError', async () => {
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [contactDraftModule] });
    const r = await t.call('prepare_contact', { email: 'a@b.ch' });
    expect(r.isError).toBe(true);
  });

  it('mit company, email, city, isCustomer: Vorschau nennt Firma, Rolle, Ort, Mail; Dubletten-Warnung mit fuenf Eintraegen', async () => {
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [contactDraftModule] });
    const r = await t.call('prepare_contact', { company: 'X AG', email: 'a@b.ch', city: 'Zug', isCustomer: true });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as { summary: string; warnings: string[]; token: string };
    expect(s.summary).toContain('X AG');
    expect(s.summary).toContain('Kunde');
    expect(s.summary).toContain('Zug');
    expect(s.summary).toContain('a@b.ch');
    expect(s.warnings[0]).toMatch(/^Ähnliche Kontakte/);
    // Fixture liefert total 20, aber limit 5 -> alle 5 Nummern aus person-list-limit-5.json in der Warnung.
    for (const nr of ['000011', '000007', '000017', 'L-002', 'INAHV01']) expect(s.warnings[0]).toContain(nr);
  });

  it('commit_contact loest das Token ein, legt an (insertId 42), sendet contacts/addresses; zweiter Aufruf mit demselben Token schlaegt fehl', async () => {
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [contactDraftModule] });
    const prep = await t.call('prepare_contact', { company: 'X AG', email: 'a@b.ch', city: 'Zug', isCustomer: true });
    const { token } = prep.structuredContent as { token: string };

    const commit = await t.call('commit_contact', { token });
    expect(commit.isError).toBeFalsy();
    expect((commit.structuredContent as { id: number }).id).toBe(42);

    const params = new URLSearchParams(sentBody);
    const contacts = JSON.parse(params.get('contacts') ?? '[]');
    const addresses = JSON.parse(params.get('addresses') ?? '[]');
    expect(JSON.stringify(contacts)).toContain('EMAIL_WORK');
    expect(JSON.stringify(contacts)).toContain('a@b.ch');
    expect(JSON.stringify(addresses)).toContain('MAIN');
    expect(JSON.stringify(addresses)).toContain('Zug');

    const again = await t.call('commit_contact', { token });
    expect(again.isError).toBe(true);
  });

  it('notes (0.3.0, B9; M-5): Vorschau nennt sie, commit sendet notes unveraendert (der Schluessel des Desk fuer V2)', async () => {
    sentBody = '';
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [contactDraftModule] });
    const prep = await t.call('prepare_contact', { company: 'X AG', notes: 'desk-kontakt-m5a-202610162255' });
    expect(prep.isError).toBeFalsy();
    expect((prep.structuredContent as { summary: string }).summary).toContain('desk-kontakt-m5a-202610162255');
    await t.call('commit_contact', mitTok(prep));
    expect(new URLSearchParams(sentBody).get('notes')).toBe('desk-kontakt-m5a-202610162255');
  });

  it('ohne notes: kein Feld notes im gesendeten Body', async () => {
    sentBody = '';
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [contactDraftModule] });
    const prep = await t.call('prepare_contact', { company: 'X AG' });
    await t.call('commit_contact', mitTok(prep));
    expect(new URLSearchParams(sentBody).has('notes')).toBe(false);
  });

  it('Land (M-5): CHE und CH gehen unveraendert hinaus (CashCtrl nahm beide an und speicherte CHE); 0.3.2: auch ein Name oder ein anderer Code', async () => {
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [contactDraftModule] });
    for (const land of ['CHE', 'CH']) {
      sentBody = '';
      const p = await t.call('prepare_contact', { company: 'X AG', street: 'Teststrasse 1', zip: '6300', city: 'Zug', country: land });
      expect(p.isError, land).toBeFalsy();
      await t.call('commit_contact', mitTok(p));
      expect((JSON.parse(new URLSearchParams(sentBody).get('addresses')!) as { country: string }[])[0].country).toBe(land);
    }
    // 0.3.2 (Korrektur 17, gemessen 20.10.2026 01:51Z am Demo-Mandanten): «Schweiz» speichert CashCtrl als CHE; das Schema prueft nicht mehr vor.
    for (const land of ['Schweiz', 'C']) {
      sentBody = '';
      const p = await t.call('prepare_contact', { company: 'X AG', city: 'Zug', country: land });
      expect(p.isError, land).toBeFalsy();
      await t.call('commit_contact', mitTok(p));
      expect((JSON.parse(new URLSearchParams(sentBody).get('addresses')!) as { country: string }[])[0].country).toBe(land);
    }
  });

  it('Mail 0.3.2 (Korrektur 17): das Schema prueft das Format nicht vor, CashCtrl entscheidet (Umlaut-Domain gemessen angenommen, «info@neukunde» abgewiesen)', async () => {
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [contactDraftModule] });
    for (const mail of ['info@müller-holz.ch', 'info@neukunde']) {
      sentBody = '';
      const p = await t.call('prepare_contact', { company: 'X AG', email: mail });
      expect(p.isError, mail).toBeFalsy();
      await t.call('commit_contact', mitTok(p));
      expect((JSON.parse(new URLSearchParams(sentBody).get('contacts')!) as { address: string }[])[0].address).toBe(mail);
    }
  });

  it('Modus read: prepare_contact/commit_contact gibt es nicht', () => {
    expect(createToolset(cfg('read'), { modules: [contactDraftModule] }).names()).toEqual([]);
  });

  it('company leer, lastName gesetzt: Dubletten-Suche faellt auf lastName zurueck, nicht auf eine leere Query', async () => {
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [contactDraftModule] });
    const r = await t.call('prepare_contact', { company: '', lastName: 'Muster' });
    expect(r.isError).toBeFalsy();
    const url = new URL(lastListUrl);
    expect(url.searchParams.get('query')).toBe('Muster');
  });

  it('ohne email/phone: gesendeter Body enthaelt kein contacts-Feld', async () => {
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [contactDraftModule] });
    const prep = await t.call('prepare_contact', { company: 'Y AG' });
    expect(prep.isError).toBeFalsy();
    const { token } = prep.structuredContent as { token: string };
    const commit = await t.call('commit_contact', { token });
    expect(commit.isError).toBeFalsy();
    const params = new URLSearchParams(sentBody);
    expect(params.get('contacts')).toBeNull();
  });
});

// 0.3.2: die Adresse geht mit, sobald Strasse, PLZ, Ort oder Land gesetzt ist (gemessen 20.10.2026 02:20Z: CashCtrl nimmt eine Adresse nur mit Land
// (CHE) oder nur mit PLZ an). Bis 0.3.2 ging sie nur mit Strasse oder Ort mit, Land und PLZ allein fielen still weg.
describe('prepare_contact 0.3.2: Adresse ohne Strasse und Ort', () => {
  for (const [fall, args, erwartet] of [
    ['nur Land', { country: 'CHE' }, { type: 'MAIN', country: 'CHE' }],
    ['nur PLZ', { zip: '6300' }, { type: 'MAIN', zip: '6300' }],
  ] as const) {
    it(fall + ': die Adresse geht mit', async () => {
      sentBody = '';
      const t = createToolset(cfg('draft'), { fetchImpl, modules: [contactDraftModule] });
      await t.call('commit_contact', mitTok(await t.call('prepare_contact', { company: 'X AG', ...args })));
      expect(JSON.parse(new URLSearchParams(sentBody).get('addresses') ?? 'null')).toEqual([erwartet]);
    });
  }
  it('ohne jedes Adressfeld: keine Adresse', async () => {
    sentBody = '';
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [contactDraftModule] });
    await t.call('commit_contact', mitTok(await t.call('prepare_contact', { company: 'X AG' })));
    expect(new URLSearchParams(sentBody).has('addresses')).toBe(false);
  });
});

// 0.3.2, Fixrunde L2b (Review A-01, 20.10.2026): commit_contact liest nach dem Anlegen nichts nach. Ob CashCtrl das Land uebernommen hat, liest der
// Aufrufer an dem Kontakt, den er ohnehin liest (get_contact); ein zweites Lesen im MCP lag im Schreib-Zeitlimit des Aufrufers.
describe('commit_contact 0.3.2: kein Nachlesen', () => {
  it('nur person/create, kein person/read; Ergebnis ohne countryNotTaken', async () => {
    const urls: string[] = [];
    const g = (async (url: string | URL, init?: RequestInit) => { urls.push(String(url)); return fetchImpl(url, init); }) as unknown as typeof fetch;
    const t = createToolset(cfg('draft'), { fetchImpl: g, modules: [contactDraftModule] });
    const p = await t.call('prepare_contact', { company: 'X AG', city: 'Zug', country: 'XYZ' });
    urls.length = 0;
    const r = await t.call('commit_contact', mitTok(p));
    expect(urls.filter((u) => u.includes('person/read'))).toEqual([]);
    expect(urls.filter((u) => u.includes('person/create'))).toHaveLength(1);
    expect(r.structuredContent).toEqual({ id: 42, message: 'Kontakt angelegt (ID 42).' });
  });
});
