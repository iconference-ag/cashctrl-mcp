import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createToolset, type ToolModule } from '../../src/toolset.js';
import { twoPhaseTools } from '../../src/tools/twophase.js';
import type { Config } from '../../src/config/config.js';
import type { TokenStore, UsageStore, PdfStore } from '../../src/core/stores.js';
import { zustandAus, type UsageState } from '../../src/core/usage.js';

const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8');
/** Eine Zaehlerdatei, die es nie geben darf: der fremde Speicher muss sie ueberfluessig machen. */
const NIRGENDS = '/nirgends/cashctrl-usage-stores-test.json';
const cfg: Config = { mode: 'draft', pdfDir: '/tmp/x', usageFile: NIRGENDS, source: 'env', orgs: [{ name: 'nt', subdomain: 'd', 'apiKey': 'k' }] };

/** Ein Token-Speicher, der jede Bewegung mitschreibt — steht fuer eine Datenbank hinter dem Vertrag. */
function tokenSpeicher() {
  const eintraege = new Map<string, { kind: string; org: string; payload: unknown }>();
  const log: string[] = [];
  const s: TokenStore = {
    async issue(kind, org, payload) {
      const token = 't' + eintraege.size; eintraege.set(token, { kind, org, payload }); log.push('issue ' + token);
      return { token, expiresAt: '2026-12-31T00:00:00.000Z' };
    },
    async redeem<T>(kind: string, org: string, token: string) {
      const e = eintraege.get(token);
      if (!e || e.kind !== kind || e.org !== org) throw new Error('Token unbekannt');
      eintraege.delete(token); log.push('redeem ' + token);
      return e.payload as T;
    },
  };
  return { s, log };
}
/** Ein Zaehler ohne Datei. */
function zaehler() {
  const calls: Record<string, number> = {};
  const s: UsageStore = {
    async state(org) { return zustandAus(calls[org] ?? 0, '2026-08'); },
    async record(org) { calls[org] = (calls[org] ?? 0) + 1; return zustandAus(calls[org], '2026-08'); },
  };
  return { s, calls };
}
const thing: ToolModule = { tools: (ctx) => twoPhaseTools(ctx, 'draft', {
  kind: 'thing', title: 'Ding', description: 'x', destructive: false,
  input: z.object({ org: z.string().optional(), name: z.string() }),
  prepare: async (_c, a) => ({ summary: 'Ding ' + a.name, warnings: [], payload: { name: a.name } }),
  commit: async (_c, _o, p) => ({ done: p }),
}) };

describe('deps.stores (Desk-Spec O125)', () => {
  it('prepare/commit laufen ueber den fremden Token-Speicher, nicht ueber den eingebauten', async () => {
    const { s, log } = tokenSpeicher();
    const t = createToolset(cfg, { modules: [thing], stores: { tokens: s } });
    const prep = await t.call('prepare_thing', { name: 'A' });
    const { token } = prep.structuredContent as { token: string };
    expect(token).toBe('t0');
    expect((await t.call('commit_thing', { token })).structuredContent).toEqual({ done: { name: 'A' } });
    expect((await t.call('commit_thing', { token })).isError).toBe(true);
    expect(log).toEqual(['issue t0', 'redeem t0']);
  });
  it('der fremde Zaehler zaehlt jeden CashCtrl-Aufruf, usage liest ihn, die Datei entsteht nie', async () => {
    const { s, calls } = zaehler();
    const f = (async () => new Response(fixture('location-list'), { status: 200 })) as unknown as typeof fetch;
    const t = createToolset({ ...cfg, mode: 'read' }, { fetchImpl: f, stores: { usage: s } });
    await t.call('list_orgs', {});
    expect(calls.nt).toBe(1);
    const u = await t.call('usage', {});
    expect(u.structuredContent).toMatchObject({ org: 'nt', calls: 1, month: '2026-08' });
    expect(existsSync(NIRGENDS)).toBe(false);
  });
  it('zustandAus rechnet Prozent, Hinweis ab 80 % und Sperre bei 100 %', () => {
    expect(zustandAus(0, '2026-08', 10)).toMatchObject({ calls: 0, percent: 0, blocked: false });
    expect(zustandAus(8, '2026-08', 10).warning).toMatch(/80 %/);
    const voll: UsageState = zustandAus(10, '2026-08', 10);
    expect(voll.blocked).toBe(true);
    expect(voll.warning).toMatch(/erreicht/);
  });
  it('get_order_pdf legt ueber den fremden PdfStore ab; pdfDir bleibt leer; path ist die Ref', async () => {
    const abgelegt: { org: string; name: string; bytes: number }[] = [];
    const pdf: PdfStore = { async put(org, name, bytes) { abgelegt.push({ org, name, bytes: bytes.length }); return 'ref:' + org + '/' + name; } };
    const pdfDir = mkdtempSync(join(tmpdir(), 'cashctrl-stores-'));
    const f = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes('order/document/read.pdf')) return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), { status: 200, headers: { 'content-type': 'application/pdf' } });
      return new Response(fixture('order-read'), { status: 200 });
    }) as unknown as typeof fetch;
    const t = createToolset({ ...cfg, mode: 'read', pdfDir }, { fetchImpl: f, stores: { pdf, usage: zaehler().s } });
    const r = await t.call('get_order_pdf', { id: 12 });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as { path: string; bytes: number };
    expect(s.path).toMatch(/^ref:nt\//);
    expect(s.bytes).toBe(6);
    expect(abgelegt).toHaveLength(1);
    expect(abgelegt[0].name).toMatch(/\.pdf$/);
    expect(readdirSync(pdfDir)).toEqual([]);          // Positivkontrolle G6: nichts auf der Platte
  });
});
