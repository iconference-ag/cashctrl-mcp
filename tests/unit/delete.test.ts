import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolset } from '../../src/toolset.js';
import { deleteModule } from '../../src/tools/full/delete.js';
import type { Config, OrgConfig } from '../../src/config/config.js';

/**
 * delete_order (v0.2.0, Entscheid 12.10.2026): Opt-in `deleteOrders` je Organisation,
 * Standard aus; nur ungebuchte Belege. Die Antworten von `order/delete` und von `order/read` nach
 * dem Loeschen sind aus der Doku nachgebaut, am Mandanten nicht gemessen (12.10.2026).
 */
const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8');
const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-delete.json`);
afterAll(async () => { await rm(usageFile, { force: true }); });
const cfg = (orgs: OrgConfig[], mode: Config['mode'] = 'full'): Config => ({ mode, pdfDir: '/tmp/x', usageFile, source: 'env', orgs });
const MIT: OrgConfig = { name: 'nt', subdomain: 'd', 'apiKey': 'k', deleteOrders: true };
const OHNE: OrgConfig = { name: 'andere', subdomain: 'd2', 'apiKey': 'k2' };
const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
const text = (r: { content?: unknown[] }) => {
  const c = r.content?.[0];
  return c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '';
};

// Beleg 55 (AN-00012) aus order-read.json; Kategorie und Status ueberschreibbar. In der Fixture der
// SALES-Kategorien bucht Offerte 37 nicht (isBook false), Rechnung 16 bucht (isBook true), 12 nicht.
const beleg55 = (JSON.parse(fixture('order-read')) as { data: Record<string, unknown> }).data;

function makeEnv(beleg: Record<string, unknown> = {}) {
  const posts: { url: string; body: string }[] = [];
  const state = { geloescht: false, wirkungslos: false };
  const aktuell = { ...beleg55, ...beleg };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if ((init?.method ?? 'GET') === 'POST') {
      posts.push({ url: u, body: String(init?.body ?? '') });
      if (u.includes('order/delete')) { state.geloescht = !state.wirkungslos; return json({ success: true, message: 'Gelöscht' }); }
      return json({ success: true });
    }
    if (u.includes('order/category/list')) {
      return new URL(u).searchParams.get('type') === 'PURCHASE' ? json(JSON.parse(fixture('order-category-list-type-PURCHASE'))) : json(JSON.parse(fixture('order-category-list-type-SALES')));
    }
    if (u.includes('order/read')) return state.geloescht ? json({ success: false, message: 'Eintrag nicht gefunden.' }) : json({ data: aktuell });
    return json({});
  }) as unknown as typeof fetch;
  return { fetchImpl, posts, state, aktuell };
}
const deletes = (p: { url: string; body: string }[]) => p.filter((x) => x.url.includes('order/delete'));

describe('deleteOrders-Schalter (Opt-in je Organisation, Standard aus)', () => {
  it('Modus full ohne Schalter: prepare_/commit_delete_order fehlen', () => {
    const t = createToolset(cfg([{ name: 'nt', subdomain: 'd', 'apiKey': 'k' }]));
    expect(t.names()).not.toContain('prepare_delete_order');
    expect(t.names()).not.toContain('commit_delete_order');
  });

  it('Modus draft mit Schalter: fehlen ebenfalls (Stufe full)', () => {
    const t = createToolset(cfg([MIT], 'draft'));
    expect(t.names()).not.toContain('prepare_delete_order');
  });

  it('Modus full mit Schalter: beide Werkzeuge da', () => {
    const t = createToolset(cfg([MIT]));
    expect(t.names()).toContain('prepare_delete_order');
    expect(t.names()).toContain('commit_delete_order');
  });

  it('sendMail schaltet das Loeschen nicht frei und umgekehrt', () => {
    const nurMail = createToolset(cfg([{ name: 'nt', subdomain: 'd', 'apiKey': 'k', sendMail: true }]));
    expect(nurMail.names()).not.toContain('prepare_delete_order');
    const nurLoeschen = createToolset(cfg([MIT]));
    expect(nurLoeschen.names()).not.toContain('prepare_send_order');
  });

  it('zwei Organisationen, nur eine mit Schalter: registriert, aber prepare fuer die andere weist ab, ohne CashCtrl zu fragen', async () => {
    const { fetchImpl, posts } = makeEnv();
    let aufrufe = 0;
    const zaehlend = (async (u: string | URL, i?: RequestInit) => { aufrufe++; return fetchImpl(u, i); }) as typeof fetch;
    const t = createToolset(cfg([MIT, OHNE]), { fetchImpl: zaehlend, modules: [deleteModule] });
    expect(t.names()).toContain('prepare_delete_order');
    const r = await t.call('prepare_delete_order', { org: 'andere', orderId: 55 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('nicht freigeschaltet');
    expect(aufrufe).toBe(0);
    expect(deletes(posts)).toHaveLength(0);
  });

  it('zwei Organisationen: commit prueft den Schalter selbst, auch wenn der Token-Speicher fuer die andere einloest', async () => {
    // Der Token-Speicher ist austauschbar (deps.stores, O125). Ein Speicher, der fuer jede
    // Organisation einloest, darf das Loeschen unter einer Organisation ohne Schalter nicht oeffnen.
    const { fetchImpl, posts } = makeEnv();
    const tokens = { issue: async () => ({ token: 't', expiresAt: '' }), redeem: async <T>() => ({ orderId: 55, nr: 'AN-00012', total: 213875.85 }) as T };
    const t = createToolset(cfg([MIT, OHNE]), { fetchImpl, modules: [deleteModule], stores: { tokens } });
    const r = await t.call('commit_delete_order', { org: 'andere', token: 't' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('nicht freigeschaltet');
    expect(deletes(posts)).toHaveLength(0);
    // Gegenstueck: dieselbe Lage unter der freigeschalteten Organisation loescht.
    expect((await t.call('commit_delete_order', { org: 'nt', token: 't' })).isError).toBeFalsy();
    expect(deletes(posts)).toHaveLength(1);
  });
});

describe('prepare_delete_order / commit_delete_order', () => {
  it('Vorschau nennt Kategorie, Nummer, Status, Total, Organisation und warnt; prepare schreibt nichts', async () => {
    const { fetchImpl, posts } = makeEnv();
    const t = createToolset(cfg([MIT]), { fetchImpl, modules: [deleteModule] });
    const r = await t.call('prepare_delete_order', { orderId: 55 });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as { summary: string; warnings: string[]; token: string };
    for (const teil of ['Offerte', 'AN-00012', 'Offen', '213875.85', 'nt', 'löschen']) expect(s.summary).toContain(teil);
    expect(s.warnings.join(' ')).toContain('unumkehrbar');
    expect(s.token).toBeTruthy();
    expect(posts).toHaveLength(0);
  });

  it('commit loescht genau diesen Beleg (ids=55) und meldet deleted', async () => {
    const { fetchImpl, posts } = makeEnv();
    const t = createToolset(cfg([MIT]), { fetchImpl, modules: [deleteModule] });
    const { token } = (await t.call('prepare_delete_order', { orderId: 55 })).structuredContent as { token: string };
    const r = await t.call('commit_delete_order', { token });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ orderId: 55, nr: 'AN-00012', deleted: true });
    expect(deletes(posts)).toHaveLength(1);
    expect(new URLSearchParams(deletes(posts)[0].body).get('ids')).toBe('55');
  });

  it('gebuchter Beleg (Rechnung Status 16, isBook true): prepare weist ab', async () => {
    const { fetchImpl, posts } = makeEnv({ categoryId: 4, statusId: 16, isBook: true, nr: 'RE-00001' });
    const t = createToolset(cfg([MIT]), { fetchImpl, modules: [deleteModule] });
    const r = await t.call('prepare_delete_order', { orderId: 55 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('gebucht');
    expect(posts).toHaveLength(0);
  });

  it('Status bucht laut Kategorie, auch wenn order/read isBook false meldet: abgewiesen (beide Quellen muessen ungebucht sagen)', async () => {
    const { fetchImpl } = makeEnv({ categoryId: 4, statusId: 16, isBook: false });
    const t = createToolset(cfg([MIT]), { fetchImpl, modules: [deleteModule] });
    const r = await t.call('prepare_delete_order', { orderId: 55 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('gebucht');
  });

  it('Buchungsstand nicht feststellbar (isBook fehlt im Beleg): abgewiesen', async () => {
    const { fetchImpl } = makeEnv({ isBook: undefined });
    const t = createToolset(cfg([MIT]), { fetchImpl, modules: [deleteModule] });
    const r = await t.call('prepare_delete_order', { orderId: 55 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('nicht feststellbar');
  });

  it('Rechnungsentwurf (Status 12, ungebucht) laesst sich loeschen', async () => {
    const { fetchImpl, posts } = makeEnv({ categoryId: 4, statusId: 12, isBook: false, nr: 'RE-00002' });
    const t = createToolset(cfg([MIT]), { fetchImpl, modules: [deleteModule] });
    const { token } = (await t.call('prepare_delete_order', { orderId: 55 })).structuredContent as { token: string };
    const r = await t.call('commit_delete_order', { token });
    expect(r.isError).toBeFalsy();
    expect(deletes(posts)).toHaveLength(1);
  });

  it('zwischen prepare und commit gebucht: commit liest neu und weist ab, ohne zu loeschen', async () => {
    const env = makeEnv({ categoryId: 4, statusId: 12, isBook: false });
    const t = createToolset(cfg([MIT]), { fetchImpl: env.fetchImpl, modules: [deleteModule] });
    const { token } = (await t.call('prepare_delete_order', { orderId: 55 })).structuredContent as { token: string };
    Object.assign(env.aktuell, { statusId: 16, isBook: true });
    const r = await t.call('commit_delete_order', { token });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('gebucht');
    expect(deletes(env.posts)).toHaveLength(0);
  });

  it('Beleg nach dem Loeschen noch lesbar: Fehler mit sent true, kein deleted', async () => {
    const env = makeEnv();
    env.state.wirkungslos = true;
    const t = createToolset(cfg([MIT]), { fetchImpl: env.fetchImpl, modules: [deleteModule] });
    const { token } = (await t.call('prepare_delete_order', { orderId: 55 })).structuredContent as { token: string };
    const r = await t.call('commit_delete_order', { token });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('noch lesbar');
    expect(r.structuredContent).toMatchObject({ kind: 'unknown', sent: true });
  });

  it('Token ist einmalig: zweiter commit loescht nicht noch einmal', async () => {
    const { fetchImpl, posts } = makeEnv();
    const t = createToolset(cfg([MIT]), { fetchImpl, modules: [deleteModule] });
    const { token } = (await t.call('prepare_delete_order', { orderId: 55 })).structuredContent as { token: string };
    await t.call('commit_delete_order', { token });
    const r2 = await t.call('commit_delete_order', { token });
    expect(r2.isError).toBe(true);
    expect(deletes(posts)).toHaveLength(1);
  });

  it('commit_delete_order traegt destructiveHint true, prepare readOnlyHint true', () => {
    const t = createToolset(cfg([MIT]));
    expect(t.tools.find((x) => x.name === 'commit_delete_order')!.annotations.destructiveHint).toBe(true);
    expect(t.tools.find((x) => x.name === 'prepare_delete_order')!.annotations.readOnlyHint).toBe(true);
  });
});
