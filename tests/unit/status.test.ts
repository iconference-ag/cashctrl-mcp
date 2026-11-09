import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolset } from '../../src/toolset.js';
import { statusModule } from '../../src/tools/full/status.js';
import { findStatus, type CategoryInfo } from '../../src/tools/read/categories.js';
import type { Config } from '../../src/config/config.js';

const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8');

const cat: CategoryInfo = { id: 2, key: 'offer', name: 'Offerte', type: 'SALES', statuses: [{ id: 1, name: 'Entwurf', raw: {} }, { id: 2, name: 'Gesendet', raw: {} }, { id: 3, name: 'Akzeptiert', raw: {} }, { id: 4, name: 'Abgelehnt', raw: {} }] };
describe('Statusauflösung fuer update_status', () => {
  it('findet Status ohne Gross/Klein und als Praefix, sonst Fehler mit Liste', () => {
    expect(findStatus(cat, 'akzeptiert').id).toBe(3);
    expect(findStatus(cat, 'Abgel').id).toBe(4);
    expect(() => findStatus(cat, 'Bezahlt')).toThrow(/Entwurf, Gesendet, Akzeptiert, Abgelehnt/);
  });
});

const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-status.json`);
const cfg = (mode: Config['mode']): Config => ({ mode, pdfDir: '/tmp/x', usageFile, source: 'env', orgs: [{ name: 'nt', subdomain: 'd', 'apiKey': 'k' }] });

afterAll(async () => { await rm(usageFile, { force: true }); });

// Status-ID von «Akzeptiert» in Kategorie 2 (Offerte) aus der Fixture lesen, nicht verdrahten.
const salesCats = (JSON.parse(fixture('order-category-list-type-SALES')) as { data: { id: number; status: { id: number; name: string }[] }[] }).data;
const akzeptiertId = salesCats.find((c) => c.id === 2)!.status.find((s) => s.name.includes('<de>Akzeptiert</de>'))!.id;

let updateStatusBody = '';
let statusGesetzt = false;
// Beleg nach dem Statuswechsel: derselbe Beleg 55, aber mit dem neuen Status — simuliert das
// Nachlesen in commit(), das den Endzustand zeigen soll statt dem Payload zu vertrauen.
const orderReadAkzeptiert = (() => {
  const d = JSON.parse(fixture('order-read')) as { data: Record<string, unknown> };
  d.data.statusId = akzeptiertId;
  d.data.statusName = '<values><de>Akzeptiert</de><en>Accepted</en><fr>Accepté</fr><it>Accettato</it></values>';
  return JSON.stringify(d);
})();

const json = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.includes('order/category/list')) {
    const type = new URL(u).searchParams.get('type');
    return json(fixture(type === 'PURCHASE' ? 'order-category-list-type-PURCHASE' : 'order-category-list-type-SALES'));
  }
  if (u.includes('order/update_status')) {
    updateStatusBody = String(init?.body ?? '');
    statusGesetzt = true;
    return json(JSON.stringify({ success: true }));
  }
  if (u.includes('order/read')) return json(statusGesetzt ? orderReadAkzeptiert : fixture('order-read'));
  return json('{}');
}) as unknown as typeof fetch;

const text = (r: { content?: unknown[] }) => {
  const c = r.content?.[0];
  return c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '';
};

describe('prepare_order_status / commit_order_status (Stufe full)', () => {
  it('Vorschau nennt Kategorie, Belegnummer, alten und neuen Status', async () => {
    const t = createToolset(cfg('full'), { fetchImpl, modules: [statusModule] });
    const r = await t.call('prepare_order_status', { orderId: 55, status: 'Akzeptiert' });
    expect(r.isError).toBeFalsy();
    const s = (r.structuredContent as { summary: string }).summary;
    expect(s).toContain('Offerte');
    expect(s).toContain('AN-00012');
    expect(s).toContain('Offen');
    expect(s).toContain('Akzeptiert');
  });

  it('unbekannter Status: isError mit der Liste der vorhandenen Status', async () => {
    const t = createToolset(cfg('full'), { fetchImpl, modules: [statusModule] });
    const r = await t.call('prepare_order_status', { orderId: 55, status: 'Bezahlt' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Bezahlt');
    expect(text(r)).toContain('Entwurf');
    expect(text(r)).toContain('Offen');
    expect(text(r)).toContain('Akzeptiert');
    expect(text(r)).toContain('Abgelehnt');
  });

  it('commit sendet ids und statusId, liest den Endzustand nach; zweiter Aufruf mit demselben Token schlaegt fehl', async () => {
    updateStatusBody = ''; statusGesetzt = false;
    const t = createToolset(cfg('full'), { fetchImpl, modules: [statusModule] });
    const prep = await t.call('prepare_order_status', { orderId: 55, status: 'Akzeptiert' });
    expect(prep.isError).toBeFalsy();
    const { token } = prep.structuredContent as { token: string };

    const commit = await t.call('commit_order_status', { token });
    expect(commit.isError).toBeFalsy();

    const p = new URLSearchParams(updateStatusBody);
    expect(p.get('ids')).toBe('55');
    expect(p.get('statusId')).toBe(String(akzeptiertId));

    // status kommt aus dem NACH dem Update nachgelesenen Beleg, nicht aus dem payload.
    const out = commit.structuredContent as { status: string; orderId: number };
    expect(out.status).toBe('Akzeptiert');
    expect(out.orderId).toBe(55);

    const again = await t.call('commit_order_status', { token });
    expect(again.isError).toBe(true);
  });

  it('Modus draft: prepare_order_status/commit_order_status gibt es nicht', () => {
    expect(createToolset(cfg('draft'), { modules: [statusModule] }).names()).toEqual([]);
  });

  it('Modus full: beide Werkzeuge sind da', () => {
    expect(createToolset(cfg('full'), { modules: [statusModule] }).names()).toEqual(['prepare_order_status', 'commit_order_status']);
  });
});
