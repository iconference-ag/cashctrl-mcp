import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext } from '../../src/tools/context.js';
import { listOrgs, usageTool } from '../../src/tools/read/orgs.js';
import { createToolset } from '../../src/toolset.js';
import type { Config } from '../../src/config/config.js';

const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8');
/** Beantwortet location/list und fiscalperiod/list aus den Fixtures, alles andere leer. */
const f = (async (url: string | URL) => {
  const u = String(url);
  const body = u.includes('location/list') ? fixture('location-list') : u.includes('fiscalperiod/list') ? fixture('fiscalperiod-list') : '{}';
  return new Response(body, { status: 200 });
}) as unknown as typeof fetch;
const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-orgs.json`);
const cfg: Config = { mode: 'read', pdfDir: '/tmp/x', usageFile, source: 'file', orgs: [{ name: 'nt', subdomain: 'demo', 'apiKey': 'abcdX' }] };

afterAll(async () => { await rm(usageFile, { force: true }); });

describe('list_orgs / usage', () => {
  it('nennt Name, Subdomain, orgName, Modus und sendMail — nie den Schluessel', async () => {
    const r = await listOrgs(buildContext(cfg, { fetchImpl: f }));
    expect(JSON.stringify(r)).not.toContain('abcdX');
    const orgs = (r.structuredContent as { orgs: { name: string; subdomain: string; orgName: string; mode: string; sendMail: boolean; deleteOrders: boolean }[] }).orgs;
    expect(orgs[0]).toMatchObject({ name: 'nt', subdomain: 'demo', mode: 'read', sendMail: false, deleteOrders: false });
    // Firmenname aus location/list, Feld `orgName` — nicht der Standortname «Hauptsitz Zug».
    expect(orgs[0].orgName).toBe('Nothing-Toulouse AG');
  });
  it('reachable: true, wenn location/list antwortet; sonst false, der Grund bleibt in orgName (B-MCP-1)', async () => {
    const da = await listOrgs(buildContext(cfg, { fetchImpl: f }));
    expect((da.structuredContent as { orgs: { reachable: boolean }[] }).orgs[0].reachable).toBe(true);
    const tot = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const weg = await listOrgs(buildContext(cfg, { fetchImpl: tot }));
    expect(weg.isError).toBeFalsy();
    const o = (weg.structuredContent as { orgs: { reachable: boolean; orgName: string }[] }).orgs[0];
    expect(o.reachable).toBe(false);
    expect(o.orgName).toContain('nicht erreichbar');
  });
  it('usage zeigt Modus, Monat, Aufrufe, 4 Zeichen des Schluessels und sendMail', async () => {
    const r = await usageTool(buildContext(cfg, { fetchImpl: f }), 'nt');
    expect(r.structuredContent).toMatchObject({ mode: 'read', keyPrefix: 'abcd', limit: 30000, sendMail: false, deleteOrders: false });
    expect(JSON.stringify(r)).not.toContain('abcdX');
  });
});

describe('ToolContext.config — schluesselfreie Sicht (R8)', () => {
  it('traegt den Schluessel nicht, nur sein Praefix', () => {
    const ctx = buildContext(cfg, { fetchImpl: f });
    // Positivkontrolle: an der rohen Konfiguration beisst dieselbe Pruefung.
    expect(JSON.stringify(cfg)).toContain('abcdX');
    expect(JSON.stringify(ctx.config)).not.toContain('abcdX');
    expect(JSON.stringify(ctx)).not.toContain('abcdX');
    expect(ctx.config.orgs).toEqual([{ name: 'nt', subdomain: 'demo', keyPrefix: 'abcd', sendMail: false, deleteOrders: false, salary: false, deleteRecords: false }]);
    expect(ctx.config).toMatchObject({ mode: 'read', pdfDir: '/tmp/x', usageFile, source: 'file' });
    expect(Object.keys(ctx.config)).toEqual(['mode', 'pdfDir', 'usageFile', 'source', 'orgs']);
  });
});

describe('list_fiscal_periods', () => {
  it('gibt genau die sechs Felder aus der Fixture zurueck, kein weiteres; Datumsfelder als ISO-Tag (B3)', async () => {
    const r = await createToolset(cfg, { fetchImpl: f }).call('list_fiscal_periods', {});
    expect(r.isError).toBeUndefined();
    const items = (r.structuredContent as { items: Record<string, unknown>[] }).items;
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0])).toEqual(['id', 'name', 'start', 'end', 'isCurrent', 'isClosed']);
    // Roh liefert die Fixture "2026-01-01 00:00:00.0" / "2026-12-31 23:59:59.0" — Spec §4 verlangt ISO.
    expect(items[0]).toEqual({ id: 1, name: '2026', start: '2026-01-01', end: '2026-12-31', isCurrent: true, isClosed: false });
  });
  it('liefert den vollstaendigen Bestand mit total, ohne Paginierung (B4)', async () => {
    const r = await createToolset(cfg, { fetchImpl: f }).call('list_fiscal_periods', {});
    const s = r.structuredContent as { items: unknown[]; total: number; hasMore?: unknown };
    expect(s.total).toBe(s.items.length);
    expect(s.total).toBe(1);
    expect(Object.keys(s)).toEqual(['items', 'total']);   // Spec §9, benannte Ausnahme: kein hasMore
  });
});

describe('list_taxes: inactive (0.2.4, MWST-Konfiguration Desk)', () => {
  it('list_taxes nennt inactive je Steuer (isInactive der Aufnahme)', async () => {
    const g = (async (url: string | URL) => new Response(String(url).includes('tax/list') ? fixture('tax-list') : '{}', { status: 200 })) as unknown as typeof fetch;
    const r = await createToolset(cfg, { fetchImpl: g }).call('list_taxes', { org: 'nt' });
    const items = (r.structuredContent as { items: { code: string; inactive: boolean }[] }).items;
    expect(items).toHaveLength(20);
    expect(items.every((t) => t.inactive === false)).toBe(true);
  });
  it('list_taxes: isInactive true wird inactive true (Gegenprobe; in der Aufnahme ist keine Steuer inaktiv)', async () => {
    const roh = JSON.parse(fixture('tax-list')) as { data: Record<string, unknown>[] };
    roh.data[0]!.isInactive = true;
    const g = (async (url: string | URL) => new Response(String(url).includes('tax/list') ? JSON.stringify(roh) : '{}', { status: 200 })) as unknown as typeof fetch;
    const r = await createToolset(cfg, { fetchImpl: g }).call('list_taxes', { org: 'nt' });
    const items = (r.structuredContent as { items: { code: string; inactive: boolean }[] }).items;
    expect(items.filter((t) => t.inactive).map((t) => t.code)).toEqual(['BN1']);
  });
});

describe('list_taxes: sales (0.3.1, Verkaufssteuer aus components)', () => {
  // Gelesen am Demo-Mandanten 17.10.2026 (tax/list, components[].applyRule/isInputTax): Verkauf = alle Komponenten REVENUE und isInputTax false.
  const steuern = async (roh?: { data: Record<string, unknown>[] }) => {
    const text = roh === undefined ? fixture('tax-list') : JSON.stringify(roh);
    const g = (async (url: string | URL) => new Response(String(url).includes('tax/list') ? text : '{}', { status: 200 })) as unknown as typeof fetch;
    const r = await createToolset(cfg, { fetchImpl: g }).call('list_taxes', { org: 'nt' });
    return (r.structuredContent as { items: { code: string; sales: boolean }[] }).items;
  };
  it('sales true genau fuer Umsatzsteuer, befreite und Saldosaetze; false fuer Bezugsteuer, Vorsteuer und Zoll', async () => {
    const items = await steuern();
    expect(items.filter((t) => t.sales).map((t) => t.code).sort()).toEqual(['SS1', 'SS2', 'U0A', 'U0E', 'UN1', 'UR1', 'US1']);
    expect(items.find((t) => t.code === 'BN1')!.sales).toBe(false);
    expect(items.find((t) => t.code === 'VN1')!.sales).toBe(false);
  });
  it('fehlen components oder ist eine Komponente nicht REVENUE oder isInputTax, ist sales false (nicht geraten)', async () => {
    const roh = JSON.parse(fixture('tax-list')) as { data: Record<string, unknown>[] };
    const un1 = roh.data.find((x) => x.code === 'UN1')!; const ur1 = roh.data.find((x) => x.code === 'UR1')!; const us1 = roh.data.find((x) => x.code === 'US1')!;
    delete un1.components;
    ur1.components = [...(ur1.components as Record<string, unknown>[]), { applyRule: 'EXPENSE', isInputTax: true }];
    us1.components = [];
    const items = await steuern(roh);
    for (const c of ['UN1', 'UR1', 'US1']) expect(items.find((t) => t.code === c)!.sales).toBe(false);
  });
});

describe('list_currencies (0.3.0, B2)', () => {
  // currency/list am Demo-Mandanten gemessen 16.10.2026 (Messbericht M-K, A5): CHF 1 (Standard), EUR 2, USD 3.
  it('liefert id, code, isDefault je Waehrung, kein weiteres Feld', async () => {
    const g = (async (url: string | URL) => new Response(String(url).includes('currency/list') ? fixture('currency-list') : '{}', { status: 200 })) as unknown as typeof fetch;
    const r = await createToolset(cfg, { fetchImpl: g }).call('list_currencies', { org: 'nt' });
    expect(r.isError).toBeUndefined();
    const s = r.structuredContent as { items: Record<string, unknown>[]; total: number };
    expect(s.total).toBe(3);
    expect(s.items).toEqual([{ id: 1, code: 'CHF', isDefault: true }, { id: 2, code: 'EUR', isDefault: false }, { id: 3, code: 'USD', isDefault: false }]);
  });
  it('steht in der Stufe read', () => {
    expect(createToolset(cfg, { fetchImpl: f }).names()).toContain('list_currencies');
  });
});
