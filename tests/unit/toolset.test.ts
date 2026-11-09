import { describe, it, expect, afterAll } from 'vitest';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createToolset, tool, type ToolModule } from '../../src/toolset.js';
import type { Config } from '../../src/config/config.js';

const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-toolset.json`);
const cfg = (mode: Config['mode']): Config => ({ mode, pdfDir: '/tmp/x', usageFile, source: 'env', orgs: [{ name: 'nt', subdomain: 'd', 'apiKey': 'k' }] });
const mods: ToolModule[] = [{ tools: () => [
  tool('a', 'read', { title: 'a', description: 'a', inputSchema: z.object({ x: z.number() }), annotations: { readOnlyHint: true } }, async ({ x }) => ({ content: [{ type: 'text', text: String(x * 2) }] })),
  tool('b', 'draft', { title: 'b', description: 'b', inputSchema: z.object({}), annotations: {} }, async () => ({ content: [{ type: 'text', text: 'b' }] })),
  tool('c', 'full', { title: 'c', description: 'c', inputSchema: z.object({}), annotations: {} }, async () => ({ content: [{ type: 'text', text: 'c' }] })),
] }];
// Ein Modul ohne eigenes try/catch — der Desk-Pfad muss das abfangen, nicht durchlassen.
const wirftMods: ToolModule[] = [{ tools: () => [
  tool('wirft', 'read', { title: 'wirft', description: 'wirft', inputSchema: z.object({}), annotations: {} }, async () => { throw new Error('Handler kaputt'); }),
] }];

afterAll(async () => { await rm(usageFile, { force: true }); });

describe('createToolset (Modus-Gate ohne Transport)', () => {
  it('filtert nach Modus', () => {
    expect(createToolset(cfg('read'), { modules: mods }).names()).toEqual(['a']);
    expect(createToolset(cfg('draft'), { modules: mods }).names()).toEqual(['a', 'b']);
    expect(createToolset(cfg('full'), { modules: mods }).names()).toEqual(['a', 'b', 'c']);
  });
  it('call validiert die Eingabe und ruft den Handler', async () => {
    const t = createToolset(cfg('read'), { modules: mods });
    expect((await t.call('a', { x: 21 })).content[0]).toMatchObject({ text: '42' });
    expect((await t.call('a', { x: 'nein' })).isError).toBe(true);
    expect((await t.call('c', {})).isError).toBe(true);          // nicht im Modus: existiert nicht
  });
  it('call faengt eine Ausnahme des Handlers, statt sie durchzulassen', async () => {
    const t = createToolset(cfg('read'), { modules: wirftMods });
    const r = await t.call('wirft', {});
    expect(r.isError).toBe(true);
    expect(r.content[0]).toMatchObject({ text: 'Fehler: Handler kaputt' });
  });
});
