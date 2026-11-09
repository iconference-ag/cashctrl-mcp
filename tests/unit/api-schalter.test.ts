import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../../src/config/config.js';
import { createToolset } from '../../src/toolset.js';
import { paketVersion } from '../../src/server.js';

/**
 * Die zwei neuen Schalter je Organisation (0.4.0, Entscheid 24.10.2026): `salary` und
 * `deleteRecords`, Standard aus, per Datei und per Umgebung; `list_orgs` und `usage` nennen sie.
 */
function home(cfg: unknown) {
  const h = mkdtempSync(join(tmpdir(), 'home-'));
  mkdirSync(join(h, '.config/cashctrl-mcp'), { recursive: true });
  const f = join(h, '.config/cashctrl-mcp/config.json');
  writeFileSync(f, JSON.stringify(cfg)); chmodSync(f, 0o600);
  return h;
}
const leer = () => mkdtempSync(join(tmpdir(), 'home-'));
const ENV = { CASHCTRL_SUBDOMAIN: 'demo', CASHCTRL_API_KEY: 'k' };

describe('Schalter salary und deleteRecords: Konfiguration', () => {
  it('Datei: fehlt das Feld, ist es falsch; true kommt durch; ein String wird abgewiesen', async () => {
    const ohne = await loadConfig({ home: home({ orgs: [{ name: 'nt', subdomain: 'a', apiKey: 'k' }] }), env: {} });
    expect(ohne.orgs[0].salary).toBeFalsy();
    expect(ohne.orgs[0].deleteRecords).toBeFalsy();
    const mit = await loadConfig({ home: home({ orgs: [{ name: 'nt', subdomain: 'a', apiKey: 'k', salary: true, deleteRecords: true }] }), env: {} });
    expect(mit.orgs[0].salary).toBe(true);
    expect(mit.orgs[0].deleteRecords).toBe(true);
    const nurLohn = await loadConfig({ home: home({ orgs: [{ name: 'nt', subdomain: 'a', apiKey: 'k', salary: true }] }), env: {} });
    expect(nurLohn.orgs[0].salary).toBe(true);
    expect(nurLohn.orgs[0].deleteRecords).toBeFalsy();
    await expect(loadConfig({ home: home({ orgs: [{ name: 'nt', subdomain: 'a', apiKey: 'k', salary: 'true' }] }), env: {} })).rejects.toThrow(/salary/);
    await expect(loadConfig({ home: home({ orgs: [{ name: 'nt', subdomain: 'a', apiKey: 'k', deleteRecords: 'true' }] }), env: {} })).rejects.toThrow(/deleteRecords/);
  });
  it('Umgebung: nur CASHCTRL_SALARY=1 und CASHCTRL_DELETE_RECORDS=1 schalten frei, jeder andere Wert oder fehlend nicht; die Schalter sind getrennt', async () => {
    const beide = await loadConfig({ home: leer(), env: { ...ENV, CASHCTRL_SALARY: '1', CASHCTRL_DELETE_RECORDS: '1' } });
    expect(beide.orgs[0]).toMatchObject({ salary: true, deleteRecords: true });
    const lohn = await loadConfig({ home: leer(), env: { ...ENV, CASHCTRL_SALARY: '1' } });
    expect(lohn.orgs[0]).toMatchObject({ salary: true, deleteRecords: false });
    const loeschen = await loadConfig({ home: leer(), env: { ...ENV, CASHCTRL_DELETE_RECORDS: '1' } });
    expect(loeschen.orgs[0]).toMatchObject({ salary: false, deleteRecords: true });
    const ja = await loadConfig({ home: leer(), env: { ...ENV, CASHCTRL_SALARY: 'true', CASHCTRL_DELETE_RECORDS: 'true' } });
    expect(ja.orgs[0]).toMatchObject({ salary: false, deleteRecords: false });
    const ohne = await loadConfig({ home: leer(), env: ENV });
    expect(ohne.orgs[0]).toMatchObject({ salary: false, deleteRecords: false });
    // deleteOrders und sendMail bleiben davon unberuehrt.
    const alt = await loadConfig({ home: leer(), env: { ...ENV, CASHCTRL_DELETE_ORDERS: '1', CASHCTRL_SEND_MAIL: '1' } });
    expect(alt.orgs[0]).toMatchObject({ deleteOrders: true, sendMail: true, salary: false, deleteRecords: false });
  });
});

describe('list_orgs und usage nennen die neuen Schalter', () => {
  const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-api-schalter.json`);
  afterAll(async () => { await rm(usageFile, { force: true }); });
  const cfg: Config = { mode: 'read', pdfDir: '/tmp/x', usageFile, source: 'env', orgs: [
    { name: 'mit', subdomain: 'd', 'apiKey': 'abcdX', salary: true, deleteRecords: true, sendMail: true, deleteOrders: false },
    { name: 'ohne', subdomain: 'd2', 'apiKey': 'efghX' },
  ] };
  const fetchImpl = (async () => new Response(JSON.stringify({ data: [{ orgName: 'Test AG' }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  const t = createToolset(cfg, { fetchImpl });
  it('list_orgs: je Organisation salary und deleteRecords wie sendMail und deleteOrders', async () => {
    const r = await t.call('list_orgs', {});
    const orgs = (r.structuredContent as { orgs: Record<string, unknown>[] }).orgs;
    expect(orgs.find((o) => o.name === 'mit')).toMatchObject({ sendMail: true, deleteOrders: false, salary: true, deleteRecords: true });
    expect(orgs.find((o) => o.name === 'ohne')).toMatchObject({ sendMail: false, deleteOrders: false, salary: false, deleteRecords: false });
    expect(JSON.stringify(r)).not.toContain('abcdX');
  });
  it('usage: dieselben Felder', async () => {
    const r = await t.call('usage', { org: 'mit' });
    expect(r.structuredContent).toMatchObject({ org: 'mit', salary: true, deleteRecords: true, sendMail: true });
  });
});

describe('Version des Servers', () => {
  it('server.ts liest die Fassung aus package.json (nicht mehr fest 0.2.0)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(paketVersion()).toBe(pkg.version);
    // Kein fester Wert: der bricht bei jeder neuen Fassung (so geschehen beim Schritt auf 0.5.0).
    expect(paketVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(paketVersion()).not.toBe('0.2.0');
  });
});
