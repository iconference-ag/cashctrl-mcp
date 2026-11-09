import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolset } from '../../src/toolset.js';
import { CashCtrlHttp } from '../../src/core/http.js';
import type { Config } from '../../src/config/config.js';

/**
 * R9: `netzfehler()` reichte die Meldung eines fremden `fetchImpl` woertlich nach aussen.
 * `fetchImpl` kommt von aussen — aus dem Desk, aus Tests, aus kuenftigen Adaptern —, und
 * eine solche Meldung kann den Authorization-Header tragen. Gemessen wird am Endergebnis:
 * am Text der Werkzeugantwort, nicht nur an der Ausnahme.
 */
const SCHLUESSEL = 'SECRT';
const b64 = Buffer.from(`${SCHLUESSEL}:`).toString('base64');
const boeseMeldung = `Header: Authorization: Basic ${b64}`;
const wirft = (async () => { throw new Error(boeseMeldung); }) as unknown as typeof fetch;
const wegwerf = () => join(mkdtempSync(join(tmpdir(), 'netzfehler-')), 'usage.json');
const cfg = (): Config => ({ mode: 'read', pdfDir: '/tmp/x', usageFile: wegwerf(), source: 'env', orgs: [{ name: 'nt', subdomain: 'd', 'apiKey': SCHLUESSEL }] });
const text = (r: { content?: unknown[] }) => {
  const c = r.content?.[0];
  return c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '';
};

describe('Netzfehler einer fremden fetch-Umsetzung (R9)', () => {
  it('traegt weder «Basic» noch das Base64 des Schluessels in die Werkzeugantwort', async () => {
    // Positivkontrolle: die Meldung, die der Aufruf wirft, enthaelt beides wirklich.
    expect(boeseMeldung).toContain('Basic');
    expect(boeseMeldung).toContain(b64);

    const r = await createToolset(cfg(), { fetchImpl: wirft }).call('search_contacts', {});
    expect(r.isError).toBe(true);
    const t = text(r);
    expect(t).not.toContain('Basic');
    expect(t).not.toContain(b64);
    expect(t).not.toContain(SCHLUESSEL);
    expect(JSON.stringify(r)).not.toContain(b64);
    // Der Endpunkt und der Wiederholungshinweis bleiben — die Meldung muss brauchbar bleiben.
    expect(t).toContain('person/list');
    expect(t).toContain('erneut versuchen');
  });

  it('nennt statt der fremden Meldung die symbolische Kennung des Fehlers', async () => {
    const mitCode = (async () => { const e = new Error(boeseMeldung) as Error & { code?: string }; e.code = 'ECONNRESET'; throw e; }) as unknown as typeof fetch;
    const h = new CashCtrlHttp({ subdomain: 'd', 'apiKey': SCHLUESSEL, org: 'nt', fetchImpl: mitCode, usageFile: wegwerf() });
    await expect(h.get('person/list')).rejects.toMatchObject({ kind: 'network', message: expect.stringContaining('ECONNRESET') });
  });
});
