import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolset } from '../../src/toolset.js';
import { MONATSLIMIT } from '../../src/core/usage.js';
import type { Config } from '../../src/config/config.js';

/**
 * Spec §9 und README: ab 80 % des Monatskontingents haengt JEDE Antwort einen Hinweis an.
 * Gemessen wird am Endergebnis — dem Text der Werkzeugantwort —, nicht am Rueckgabewert
 * von `UsageCounter.record()`; genau dazwischen ging der Hinweis bisher verloren.
 */
const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8');
const f = (async () => new Response(fixture('person-list-limit-5'), { status: 200 })) as unknown as typeof fetch;
const jetzt = () => new Date('2026-08-15T12:00:00Z');   // Monat 2026-08, UTC
const text = (r: { content?: unknown[] }) => {
  const c = r.content?.[0];
  return c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '';
};

/** Zaehlerdatei mit einem Startstand je Organisation — der Pfad kommt in die Konfiguration. */
function zaehlerMit(stand: Record<string, number>): string {
  const file = join(mkdtempSync(join(tmpdir(), 'kontingent-')), 'usage.json');
  const s: Record<string, { month: string; calls: number }> = {};
  for (const [org, calls] of Object.entries(stand)) s[org] = { month: '2026-08', calls };
  writeFileSync(file, JSON.stringify(s));
  return file;
}
const cfg = (usageFile: string, orgs: string[]): Config => ({
  mode: 'read', pdfDir: '/tmp/x', usageFile, source: 'env',
  orgs: orgs.map((name) => ({ name, subdomain: 'd', 'apiKey': 'k' })),
});

// 80 % von 30'000 sind 24'000: ein Aufruf mehr als dieser Stand loest den Hinweis aus.
const achtzig = Math.ceil(MONATSLIMIT * 0.8);
const haelfte = Math.floor(MONATSLIMIT * 0.5);

describe('Kontingent-Hinweis in der Werkzeugantwort (B2)', () => {
  it('haengt den Hinweis ab 80 % an die Antwort von search_contacts', async () => {
    const t = createToolset(cfg(zaehlerMit({ nt: achtzig }), ['nt']), { fetchImpl: f, now: jetzt });
    const r = await t.call('search_contacts', { limit: 5 });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain(`Achtung: 80 % des Monatskontingents (${achtzig + 1}/${MONATSLIMIT}) verbraucht.`);
    // Claude Desktop gibt dem Modell nur structuredContent weiter (Meldung 25.10.2026): der Hinweis muss auch dort stehen.
    expect((r.structuredContent as { hinweisKontingent?: string }).hinweisKontingent).toContain('80 % des Monatskontingents');
  });

  it('unter 80 % steht kein Hinweis in der Antwort', async () => {
    const t = createToolset(cfg(zaehlerMit({ nt: haelfte }), ['nt']), { fetchImpl: f, now: jetzt });
    const r = await t.call('search_contacts', { limit: 5 });
    expect(r.isError).toBeFalsy();
    expect(text(r)).not.toContain('Monatskontingent');
    expect((r.structuredContent as { hinweisKontingent?: string }).hinweisKontingent).toBeUndefined();
  });

  it('der Hinweis gehoert der Organisation, die aufgerufen wurde', async () => {
    // Zwei Organisationen auf derselben Zaehlerdatei: der volle Zaehler von «a» darf nicht
    // an einer Antwort fuer «b» haengen.
    const t = createToolset(cfg(zaehlerMit({ a: achtzig, b: haelfte }), ['a', 'b']), { fetchImpl: f, now: jetzt });
    expect(text(await t.call('search_contacts', { org: 'b', limit: 5 }))).not.toContain('Monatskontingent');
    expect(text(await t.call('search_contacts', { org: 'a', limit: 5 }))).toContain('des Monatskontingents');
  });
});
