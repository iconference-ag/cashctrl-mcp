import { describe, it, expect, afterAll } from 'vitest';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createToolset, type ToolModule } from '../../src/toolset.js';
import { twoPhaseTools } from '../../src/tools/twophase.js';
import type { Config } from '../../src/config/config.js';

const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-twophase.json`);
const cfg: Config = { mode: 'draft', pdfDir: '/tmp/x', usageFile, source: 'env', orgs: [{ name: 'nt', subdomain: 'd', 'apiKey': 'k' }] };

afterAll(async () => { await rm(usageFile, { force: true }); });

/** Antwortet auf alles leer: die Vorschau liest seit B-MCP-3 den Firmennamen nach, ein Unit-Test geht nie ins Netz. */
const leer = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

const thingModule = (done: unknown[]): ToolModule => ({
  tools: (ctx) => twoPhaseTools(ctx, 'draft', {
    kind: 'thing', title: 'Ding', description: 'x', destructive: false,
    input: z.object({ org: z.string().optional(), name: z.string() }),
    prepare: async (_c, a) => ({ summary: `Ding ${a.name} anlegen`, warnings: [], payload: { name: a.name } }),
    commit: async (_c, _org, p) => { done.push(p); return { insertId: 1 }; },
  }),
});

describe('twoPhaseTools', () => {
  it('prepare gibt Vorschau und Token, commit fuehrt genau einmal aus, im Modus read fehlen beide', async () => {
    const done: unknown[] = [];
    const mod = thingModule(done);
    const t = createToolset(cfg, { fetchImpl: leer, modules: [mod] });
    expect(t.names()).toEqual(['prepare_thing', 'commit_thing']);
    const prep = await t.call('prepare_thing', { name: 'A' });
    expect(prep.structuredContent).toMatchObject({ summary: 'Ding A anlegen', warnings: [] });
    const { token } = prep.structuredContent as { token: string };
    expect((await t.call('commit_thing', { token })).structuredContent).toMatchObject({ insertId: 1 });
    expect((await t.call('commit_thing', { token })).isError).toBe(true);
    expect(done.length).toBe(1);
    expect(createToolset({ ...cfg, mode: 'read' }, { modules: [mod] }).names()).toEqual([]);
  });

  it('prepare_thing mit ungueltiger Eingabe (name fehlt): isError, keine Ausnahme', async () => {
    const t = createToolset(cfg, { modules: [thingModule([])] });
    const r = await t.call('prepare_thing', {});
    expect(r.isError).toBe(true);
  });

  it('commit_thing mit fremdem, nie ausgestelltem Token — isError, Handler wird nicht aufgerufen', async () => {
    const done: unknown[] = [];
    const t = createToolset(cfg, { modules: [thingModule(done)] });
    const r = await t.call('commit_thing', { 'token': 'xxxxx' });
    expect(r.isError).toBe(true);
    expect(done.length).toBe(0);
  });
});

describe('Vorschau nennt die Firma des Hauptstandorts (B-MCP-3)', () => {
  const ort = JSON.stringify({ data: [{ id: 1, orgName: 'Muster AG', name: 'Hauptsitz' }] });
  /** Beantwortet location/list mit der Firma und zaehlt die Aufrufe; `ausfall` laesst die ersten n Aufrufe scheitern. */
  const mitFirma = (ausfall = 0) => {
    const z = { n: 0 };
    const f = (async (url: string | URL) => {
      if (!String(url).includes('location/list')) return new Response('{}', { status: 200 });
      z.n++;
      if (z.n <= ausfall) throw new TypeError('fetch failed');
      return new Response(ort, { status: 200 });
    }) as unknown as typeof fetch;
    return { z, f };
  };
  type Vorschau = { summary: string; orgName?: string };

  it('summary endet mit «Organisation: Firma (Name)», orgName steht in der Antwort', async () => {
    const t = createToolset(cfg, { fetchImpl: mitFirma().f, modules: [thingModule([])] });
    const r = await t.call('prepare_thing', { name: 'A' });
    const s = r.structuredContent as Vorschau;
    expect(s.summary).toBe('Ding A anlegen\nOrganisation: Muster AG (nt)');
    expect(s.orgName).toBe('Muster AG');
    expect(JSON.stringify(r.content)).toContain('Organisation: Muster AG (nt)');
  });

  it('liest location/list je Organisation nur einmal', async () => {
    const { z, f } = mitFirma();
    const t = createToolset(cfg, { fetchImpl: f, modules: [thingModule([])] });
    await t.call('prepare_thing', { name: 'A' });
    await t.call('prepare_thing', { name: 'B' });
    expect(z.n).toBe(1);
  });

  it('ohne Antwort von CashCtrl bleibt die Vorschau ohne Firmenzeile und ohne Fehler; der naechste Aufruf versucht es wieder', async () => {
    const t = createToolset(cfg, { fetchImpl: mitFirma(1).f, modules: [thingModule([])] });
    const a = await t.call('prepare_thing', { name: 'A' });
    expect(a.isError).toBeFalsy();
    expect((a.structuredContent as Vorschau).summary).toBe('Ding A anlegen');
    expect((a.structuredContent as Vorschau).orgName).toBeUndefined();
    const b = await t.call('prepare_thing', { name: 'B' });
    expect((b.structuredContent as Vorschau).summary).toBe('Ding B anlegen\nOrganisation: Muster AG (nt)');
  });
});
