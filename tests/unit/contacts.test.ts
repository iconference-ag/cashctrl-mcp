import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext } from '../../src/tools/context.js';
import { searchContacts, getContact } from '../../src/tools/read/contacts.js';
import { de } from '../../src/tools/result.js';
import type { Config } from '../../src/config/config.js';

const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8');
const f = (async (url: string | URL) => {
  const u = String(url);
  const body = u.includes('person/read') ? fixture('person-read') : fixture('person-list-limit-5');
  return new Response(body, { status: 200 });
}) as unknown as typeof fetch;
const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-c.json`);
const cfg: Config = { mode: 'read', pdfDir: '/tmp/x', usageFile, source: 'env', orgs: [{ name: 'nt', subdomain: 'd', 'apiKey': 'k' }] };

afterAll(async () => { await rm(usageFile, { force: true }); });

describe('search_contacts / get_contact', () => {
  it('gibt kompakte Eintraege mit id, nr, name, Rollen und Seiteninfo', async () => {
    const r = await searchContacts(buildContext(cfg, { fetchImpl: f }), { query: 'a', limit: 5 });
    const s = r.structuredContent as { items: Record<string, unknown>[]; total: number; hasMore: boolean };
    expect(s.items.length).toBeGreaterThan(0);
    expect(Object.keys(s.items[0])).toEqual(expect.arrayContaining(['id', 'nr', 'name', 'isCustomer', 'isVendor']));
    expect(typeof s.total).toBe('number');
    expect(typeof s.hasMore).toBe('boolean');
    expect(JSON.stringify(s.items[0]).length).toBeLessThan(600);   // kompakt, keine Rohantwort
  });
  it('get_contact liefert Adressen und Kontaktkanaele', async () => {
    const r = await getContact(buildContext(cfg, { fetchImpl: f }), { id: 1 });
    const s = r.structuredContent as Record<string, unknown>;
    expect(s).toHaveProperty('id');
    expect(s).toHaveProperty('addresses');
    expect(s).toHaveProperty('contacts');
  });
});

describe('notes an Kontakten (0.3.0, B9; M-5, 17.10.2026)', () => {
  // M-5 (Demo-Mandant): person/create nimmt notes an, person/read liefert sie (Feld `notes`; in der Aufnahme vom 28.08. ist es
  // null und fehlt im Objekt), person/list findet den Kontakt ueber `query` und ueber einen Filter `like` auf `notes`.
  const mitNotes = (() => { const r = JSON.parse(fixture('person-read')) as { data: Record<string, unknown> }; r.data.notes = 'desk-kontakt-m5a-202610162255'; return JSON.stringify(r); })();
  it('get_contact liefert notes', async () => {
    const g = (async () => new Response(mitNotes, { status: 200 })) as unknown as typeof fetch;
    const s = (await getContact(buildContext(cfg, { fetchImpl: g }), { id: 1 })).structuredContent as Record<string, unknown>;
    expect(s.notes).toBe('desk-kontakt-m5a-202610162255');
  });
  it('get_contact ohne notes im Datensatz: notes ist null, nicht undefined', async () => {
    const s = (await getContact(buildContext(cfg, { fetchImpl: f }), { id: 1 })).structuredContent as Record<string, unknown>;
    expect(s).toHaveProperty('notes', null);
  });
  it('search_contacts mit notes sendet einen Filter like auf notes; ohne notes keinen Filter', async () => {
    const urls: string[] = [];
    const g = (async (url: string | URL) => { urls.push(String(url)); return new Response(fixture('person-list-limit-5'), { status: 200 }); }) as unknown as typeof fetch;
    const ctx = buildContext(cfg, { fetchImpl: g });
    await searchContacts(ctx, { notes: 'desk-kontakt-m5a-202610162255' });
    const filter = JSON.parse(new URL(urls[0]).searchParams.get('filter') ?? 'null');
    expect(filter).toEqual([{ field: 'notes', comparison: 'like', value: 'desk-kontakt-m5a-202610162255' }]);
    await searchContacts(ctx, { query: 'a' });
    expect(new URL(urls[1]).searchParams.has('filter')).toBe(false);
  });
  it('compactPerson bleibt ohne notes (feste Schluesselliste)', async () => {
    const r = await searchContacts(buildContext(cfg, { fetchImpl: f }), { query: 'a', limit: 5 });
    expect(Object.keys((r.structuredContent as { items: Record<string, unknown>[] }).items[0])).not.toContain('notes');
  });
});

describe('de() — mehrsprachige Werte aufloesen (tests/fixtures/README.md, Abschnitt "Mehrsprachige Werte")', () => {
  it('ersetzt das Fragment durch den de-Text, Praefix-Text bleibt erhalten', () => {
    expect(de('1020 <values><de>Bank</de><en>Bank</en></values>')).toBe('1020 Bank');
  });
  it('reines Fragment ohne Praefix', () => {
    expect(de('<values><de>Stk.</de><en>pcs.</en><fr>pcs.</fr><it>pz.</it></values>')).toBe('Stk.');
  });
  it('ohne Fragment oder ohne <de>: Eingabe unveraendert als String', () => {
    expect(de('m²')).toBe('m²');
  });
  it('null/undefined ergibt leeren String', () => {
    expect(de(null)).toBe('');
    expect(de(undefined)).toBe('');
  });
});
