import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolset } from '../../src/toolset.js';
import { articleDraftModule, resolveUnit } from '../../src/tools/draft/article.js';
import type { Config } from '../../src/config/config.js';

const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8');

describe('resolveUnit', () => {
  const units = [{ id: 4, name: 'Stk.' }, { id: 5, name: 'Std.' }, { id: 6, name: 'm' }];
  it('findet Stk. auch als stk oder Stück, sonst Fehler mit Liste', () => {
    expect(resolveUnit(units, 'stk')).toBe(4);
    expect(resolveUnit(units, 'Stk.')).toBe(4);
    expect(resolveUnit(units, 'Std')).toBe(5);
    expect(() => resolveUnit(units, 'Palette')).toThrow(/Stk\., Std\., m/);
  });

  it('loest einen mehrsprachigen Einheitennamen (Fixture-Form) ueber Stück auf', () => {
    const multi = [{ id: 4, name: '<values><de>Stk.</de><en>pcs.</en></values>' }];
    expect(resolveUnit(multi, 'Stück')).toBe(4);
  });
});

const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-article-draft.json`);
const cfg = (mode: Config['mode']): Config => ({ mode, pdfDir: '/tmp/x', usageFile, source: 'env', orgs: [{ name: 'nt', subdomain: 'd', 'apiKey': 'k' }] });

afterAll(async () => { await rm(usageFile, { force: true }); });

let sentBody = '';
const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.includes('inventory/unit/list')) return new Response(fixture('inventory-unit-list'), { status: 200 });
  if (u.includes('inventory/article/list')) return new Response(fixture('inventory-article-list-limit-5'), { status: 200 });
  if (u.includes('inventory/article/create')) { sentBody = String(init?.body ?? ''); return new Response(JSON.stringify({ success: true, insertId: 77 }), { status: 200 }); }
  return new Response('{}', { status: 200 });
}) as unknown as typeof fetch;

describe('prepare_article / commit_article (Stufe draft)', () => {
  it('Nummer A-01 ist in der Fixture vorhanden: Dubletten-Warnung', async () => {
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [articleDraftModule] });
    const r = await t.call('prepare_article', { nr: 'A-01', name: 'Test', salesPriceNet: 10 });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as { warnings: string[] };
    expect(s.warnings[0]).toBe('Artikelnummer A-01 existiert schon.');
  });

  it('ohne nr: isError, die Meldung nennt nr (CashCtrl vergibt ueber die API keine Nummer, gemessen 09.11.2026)', async () => {
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [articleDraftModule] });
    const r = await t.call('prepare_article', { name: 'Neu', salesPriceNet: 1 });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('nr');
  });

  it('unbekannte Einheit: isError mit Liste der vorhandenen Einheiten', async () => {
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [articleDraftModule] });
    const r = await t.call('prepare_article', { nr: 'A-90', name: 'Neu', unit: 'Palette', salesPriceNet: 1 });
    expect(r.isError).toBe(true);
    const text = r.content?.[0] && 'text' in r.content[0] ? r.content[0].text : '';
    expect(text).toContain('Stk.');
  });

  it('Vorschau nennt Name, aufgeloeste Einheit und beide Preise netto', async () => {
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [articleDraftModule] });
    const r = await t.call('prepare_article', { nr: 'A-90', name: 'Neu', salesPriceNet: 12.5, purchasePriceNet: 7 });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as { summary: string };
    expect(s.summary).toContain('Neu');
    expect(s.summary).toContain('Stk.');
    expect(s.summary).toContain('12.50');
    expect(s.summary).toContain('7.00');
  });

  it('commit_article loest das Token ein, legt an (insertId 77), sendet unitId/salesPrice/lastPurchasePrice/name; zweiter Aufruf mit demselben Token schlaegt fehl', async () => {
    const t = createToolset(cfg('draft'), { fetchImpl, modules: [articleDraftModule] });
    const prep = await t.call('prepare_article', { nr: 'A-90', name: 'Neu', salesPriceNet: 12.5, purchasePriceNet: 7 });
    const { token } = prep.structuredContent as { token: string };

    const commit = await t.call('commit_article', { token });
    expect(commit.isError).toBeFalsy();
    expect((commit.structuredContent as { id: number }).id).toBe(77);

    const params = new URLSearchParams(sentBody);
    expect(params.get('unitId')).toBe('4');
    expect(params.get('salesPrice')).toBe('12.5');
    expect(params.get('lastPurchasePrice')).toBe('7');
    expect(params.get('name')).toBe('Neu');
    expect(params.get('nr')).toBe('A-90');

    const again = await t.call('commit_article', { token });
    expect(again.isError).toBe(true);
  });

  it('Modus read: prepare_article/commit_article gibt es nicht', () => {
    expect(createToolset(cfg('read'), { modules: [articleDraftModule] }).names()).toEqual([]);
  });
});
