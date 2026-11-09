import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolset } from '../../src/toolset.js';
import { pickEmail, sendModule } from '../../src/tools/full/send.js';
import type { Config } from '../../src/config/config.js';

const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8');

describe('pickEmail', () => {
  const person = {
    contacts: [
      { type: 'PHONE_WORK', address: '+41 79 000 00 00' },
      { type: 'EMAIL_WORK', address: 'a@b.ch' },
    ],
    emailWork: 'fallback@b.ch',
  };
  it('nimmt die uebergebene Adresse, auch wenn der Kontakt eine eigene E-Mail hat', () => {
    expect(pickEmail(person, 'x@y.ch')).toBe('x@y.ch');
  });
  it('sonst den ersten Kontakt vom Typ EMAIL*', () => {
    expect(pickEmail(person, undefined)).toBe('a@b.ch');
  });
  it('sonst den Rueckfall emailWork, wenn kein EMAIL-Kontakt vorhanden ist', () => {
    expect(pickEmail({ contacts: [{ type: 'PHONE_WORK', address: '+41…' }], emailWork: 'fallback@b.ch' }, undefined)).toBe('fallback@b.ch');
  });
  it('ganz ohne Adresse: Fehler', () => {
    expect(() => pickEmail({ contacts: [] }, undefined)).toThrow(/Empfängeradresse/);
  });
});

const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-send.json`);
// sendMail: true, damit die Funktionstests unten (Versandlogik) den Schalter nicht extra setzen
// muessen — die Gate-Tests am Dateiende bauen ihre eigene Konfiguration ohne den Schalter.
const cfg = (mode: Config['mode']): Config => ({ mode, pdfDir: '/tmp/x', usageFile, source: 'env', orgs: [{ name: 'nt', subdomain: 'd', 'apiKey': 'k', sendMail: true }] });

afterAll(async () => { await rm(usageFile, { force: true }); });

const json = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
const text = (r: { content?: unknown[] }) => {
  const c = r.content?.[0];
  return c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '';
};

// Beleg 55 (AN-00012, Offerte Kat 2, associateId 12, total 213875.85) aus order-read.json.
// Kategorie 2 traegt im Kopf sentStatusId=37 (Status "Offen"); kein Status heisst dort
// «Versandt» oder «Gesendet» — beides aus der Fixture gelesen, nicht angenommen.
const salesCats = (JSON.parse(fixture('order-category-list-type-SALES')) as { data: { id: number; sentStatusId?: number; status: { id: number; name: string }[] }[] }).data;
const cat2 = salesCats.find((c) => c.id === 2)!;

function makeEnv(opts: { locationsBody?: string; salesCatsBody?: string } = {}) {
  const state = { mailBody: '' };
  const locationsBody = opts.locationsBody ?? fixture('location-list');
  const salesCatsBody = opts.salesCatsBody ?? fixture('order-category-list-type-SALES');
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('order/category/list')) {
      const type = new URL(u).searchParams.get('type');
      return json(type === 'PURCHASE' ? fixture('order-category-list-type-PURCHASE') : salesCatsBody);
    }
    if (u.includes('location/list')) return json(locationsBody);
    if (u.includes('order/document/mail')) {
      state.mailBody = String(init?.body ?? '');
      return json(JSON.stringify({ success: true }));
    }
    if (u.includes('person/read')) return json(fixture('person-read'));
    if (u.includes('order/read')) return json(fixture('order-read'));
    return json('{}');
  }) as unknown as typeof fetch;
  return { fetchImpl, state };
}

describe('prepare_send_order / commit_send_order (Stufe full)', () => {
  it('Vorschau nennt Kategorie, Belegnummer, Total, Empfaenger, Absender, Betreff, Zielstatus und Org; keine Warnung', async () => {
    expect(cat2.sentStatusId).toBe(37); // Praemisse der Fixture, gemessen — nicht angenommen
    const { fetchImpl } = makeEnv();
    const t = createToolset(cfg('full'), { fetchImpl, modules: [sendModule] });
    const r = await t.call('prepare_send_order', { orderId: 55, subject: 'Offerte AN-00012', message: 'Anbei die Offerte.' });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as { summary: string; warnings: string[]; token: string };
    expect(s.summary).toContain('Offerte');
    expect(s.summary).toContain('AN-00012');
    expect(s.summary).toContain('213875.85');
    expect(s.summary).toContain('geschwaerzt@example.com'); // Empfaenger (person-read.json)
    expect(s.summary).toContain('geschwaerzt@example.com'); // Absender (location-list.json)
    expect(s.summary).toContain('Offerte AN-00012');
    expect(s.summary).toContain('Offen');   // Zielstatus (sentStatusId 37 in Kategorie 2)
    expect(s.summary).toContain('nt');      // Organisationsname
    // R7: der Text ist das, was beim Empfaenger ankommt — die Vorschau muss ihn zeigen (Spec §6.3).
    expect(s.summary).toContain('Text: Anbei die Offerte.');
    expect(s.warnings).toEqual([]);
  });

  it('Vorschau zeigt den Mailtext einzeilig und auf 200 Zeichen gekuerzt (R7)', async () => {
    const { fetchImpl } = makeEnv();
    const t = createToolset(cfg('full'), { fetchImpl, modules: [sendModule] });
    const lang = `Sehr geehrte Damen und Herren\n\n${'x'.repeat(250)}\nFreundliche Gruesse`;
    const r = await t.call('prepare_send_order', { orderId: 55, subject: 'S', message: lang });
    expect(r.isError).toBeFalsy();
    const { summary } = r.structuredContent as { summary: string };
    const zeile = summary.split('\n').find((z) => z.startsWith('Text: '))!;
    expect(zeile).toBeTruthy();
    expect(zeile).toContain('Sehr geehrte Damen und Herren⏎⏎');
    expect(zeile.endsWith('…')).toBe(true);
    expect(zeile.length).toBe('Text: '.length + 200 + 1);   // 200 Zeichen plus Auslassungszeichen
  });

  it('commit sendet ueber den Client, Body ohne id/subject/message-Schluessel; liefert sentTo', async () => {
    const { fetchImpl, state } = makeEnv();
    const t = createToolset(cfg('full'), { fetchImpl, modules: [sendModule] });
    const prep = await t.call('prepare_send_order', { orderId: 55, subject: 'Offerte AN-00012', message: 'Anbei die Offerte.' });
    expect(prep.isError).toBeFalsy();
    const { token } = prep.structuredContent as { token: string };

    const commit = await t.call('commit_send_order', { token });
    expect(commit.isError).toBeFalsy();

    const bp = new URLSearchParams(state.mailBody);
    expect(bp.get('orderIds')).toBe('55');
    expect(bp.get('mailFrom')).toBe('geschwaerzt@example.com');
    expect(bp.get('mailSubject')).toBe('Offerte AN-00012');
    expect(bp.get('mailText')).toBe('Anbei die Offerte.');
    expect(bp.get('mailTo')).toBe('geschwaerzt@example.com');
    expect(bp.get('id')).toBeNull();
    expect(bp.get('subject')).toBeNull();
    expect(bp.get('message')).toBeNull();
    expect(bp.get('sentStatusId')).toBe(String(cat2.sentStatusId));

    const out = commit.structuredContent as { orderId: number; nr: string; sentTo: string; from: string; message: string };
    expect(out.sentTo).toBe('geschwaerzt@example.com');
    expect(out.from).toBe('geschwaerzt@example.com');
    expect(out.nr).toBe('AN-00012');

    const again = await t.call('commit_send_order', { token });
    expect(again.isError).toBe(true);
  });

  it('from in der Eingabe gewinnt gegenueber dem Standort', async () => {
    const { fetchImpl, state } = makeEnv();
    const t = createToolset(cfg('full'), { fetchImpl, modules: [sendModule] });
    const prep = await t.call('prepare_send_order', { orderId: 55, subject: 'S', message: 'M', from: 'chef@example.ch' });
    expect(prep.isError).toBeFalsy();
    const { token } = prep.structuredContent as { token: string };
    const commit = await t.call('commit_send_order', { token });
    expect(commit.isError).toBeFalsy();
    const bp = new URLSearchParams(state.mailBody);
    expect(bp.get('mailFrom')).toBe('chef@example.ch');
  });

  it('recipientEmail in der Eingabe gewinnt gegenueber dem Kontakt', async () => {
    const { fetchImpl, state } = makeEnv();
    const t = createToolset(cfg('full'), { fetchImpl, modules: [sendModule] });
    const prep = await t.call('prepare_send_order', { orderId: 55, subject: 'S', message: 'M', recipientEmail: 'andere@y.ch' });
    expect(prep.isError).toBeFalsy();
    const { token } = prep.structuredContent as { token: string };
    const commit = await t.call('commit_send_order', { token });
    expect(commit.isError).toBeFalsy();
    const bp = new URLSearchParams(state.mailBody);
    expect(bp.get('mailTo')).toBe('andere@y.ch');
  });

  it('resolveMailFrom bevorzugt den Standort vom Typ MAIN vor dem ersten Eintrag', async () => {
    const base = JSON.parse(fixture('location-list')) as { total: number; data: Record<string, unknown>[] };
    const mainLoc = base.data[0]; // type MAIN, aus der Fixture — geschwaerzt@example.com
    expect(mainLoc.type).toBe('MAIN'); // Praemisse der Fixture, gemessen — nicht angenommen
    const branch = { id: 2, type: 'BRANCH', email: 'filiale@example.ch' };
    const twoLocations = { ...base, total: 2, data: [branch, mainLoc] };
    const { fetchImpl, state } = makeEnv({ locationsBody: JSON.stringify(twoLocations) });
    const t = createToolset(cfg('full'), { fetchImpl, modules: [sendModule] });
    const prep = await t.call('prepare_send_order', { orderId: 55, subject: 'S', message: 'M' });
    expect(prep.isError).toBeFalsy();
    const { token } = prep.structuredContent as { token: string };
    const commit = await t.call('commit_send_order', { token });
    expect(commit.isError).toBeFalsy();
    const bp = new URLSearchParams(state.mailBody);
    expect(bp.get('mailFrom')).toBe(mainLoc.email);
  });

  it('Kategorie ohne sentStatusId und ohne Status Versandt/Gesendet: Warnung, kein sentStatusId im Body', async () => {
    const cats = JSON.parse(fixture('order-category-list-type-SALES')) as { total: number; data: Record<string, unknown>[] };
    const row = cats.data.find((c) => c.id === 2)!;
    delete row.sentStatusId;
    const { fetchImpl, state } = makeEnv({ salesCatsBody: JSON.stringify(cats) });
    const t = createToolset(cfg('full'), { fetchImpl, modules: [sendModule] });
    const prep = await t.call('prepare_send_order', { orderId: 55, subject: 'S', message: 'M' });
    expect(prep.isError).toBeFalsy();
    const s = prep.structuredContent as { warnings: string[]; token: string };
    expect(s.warnings.join(' ')).toContain('Versandstatus');
    const commit = await t.call('commit_send_order', { token: s.token });
    expect(commit.isError).toBeFalsy();
    const bp = new URLSearchParams(state.mailBody);
    expect(bp.get('sentStatusId')).toBeNull();
  });

  it('Standort ohne email und kein from: isError „Absenderadresse“', async () => {
    const locWithoutEmail = JSON.parse(fixture('location-list')) as { total: number; data: Record<string, unknown>[] };
    locWithoutEmail.data = locWithoutEmail.data.map((l) => { const { email: _email, ...rest } = l; return rest; });
    const { fetchImpl } = makeEnv({ locationsBody: JSON.stringify(locWithoutEmail) });
    const t = createToolset(cfg('full'), { fetchImpl, modules: [sendModule] });
    const r = await t.call('prepare_send_order', { orderId: 55, subject: 'S', message: 'M' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Absenderadresse');
  });

  it('fehlendes subject: isError (zod)', async () => {
    const { fetchImpl } = makeEnv();
    const t = createToolset(cfg('full'), { fetchImpl, modules: [sendModule] });
    const r = await t.call('prepare_send_order', { orderId: 55, message: 'M' });
    expect(r.isError).toBe(true);
  });

  it('Modus draft: prepare_send_order/commit_send_order gibt es nicht', () => {
    expect(createToolset(cfg('draft'), { modules: [sendModule] }).names()).toEqual([]);
  });

  it('Modus full: beide Werkzeuge sind da', () => {
    expect(createToolset(cfg('full'), { modules: [sendModule] }).names()).toEqual(['prepare_send_order', 'commit_send_order']);
  });
});

describe('sendMail-Schalter (Opt-in je Organisation, Standard aus)', () => {
  const ohneSendMail: Config = { mode: 'full', pdfDir: '/tmp/x', usageFile, source: 'env', orgs: [{ name: 'nt', subdomain: 'd', 'apiKey': 'k' }] };

  it('Modus full ohne sendMail: die Werkzeuge fehlen im vollen Werkzeugsatz (33 statt 35; 0.2.4: get_article, 0.3.0: list_currencies, 0.4.0: vier allgemeine)', () => {
    const t = createToolset(ohneSendMail);
    expect(t.names()).not.toContain('prepare_send_order');
    expect(t.names()).not.toContain('commit_send_order');
    expect(t.names()).toHaveLength(33);
  });

  it('Modus full mit sendMail: beide Werkzeuge da (35 im vollen Werkzeugsatz; 0.2.4: get_article, 0.3.0: list_currencies, 0.4.0: vier allgemeine)', () => {
    const t = createToolset(cfg('full'));
    expect(t.names()).toContain('prepare_send_order');
    expect(t.names()).toContain('commit_send_order');
    expect(t.names()).toHaveLength(35);
  });

  it('Negativkontrolle: commit_send_order ohne Schalter existiert im Modus full nicht', async () => {
    const t = createToolset(ohneSendMail);
    const r = await t.call('commit_send_order', { org: 'nt', token: 'x' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('gibt es im Modus');
  });

  it('zwei Organisationen, nur eine mit sendMail: Werkzeuge registriert; prepare_send_order fuer die andere -> validation-Fehler', async () => {
    const cfgZwei: Config = { mode: 'full', pdfDir: '/tmp/x', usageFile, source: 'env', orgs: [
      { name: 'nt', subdomain: 'd', 'apiKey': 'k', sendMail: true },
      { name: 'andere', subdomain: 'd2', 'apiKey': 'k2', sendMail: false },
    ] };
    const t = createToolset(cfgZwei);
    expect(t.names()).toContain('prepare_send_order');
    const r = await t.call('prepare_send_order', { org: 'andere', orderId: 55, subject: 'S', message: 'M' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('nicht freigeschaltet');
  });
});
