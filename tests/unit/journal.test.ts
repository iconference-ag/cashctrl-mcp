import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolset } from '../../src/toolset.js';
import { checkPeriod, journalModule } from '../../src/tools/full/journal.js';
import type { Config } from '../../src/config/config.js';

const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8');

/**
 * Vertragstest (aus dem Brief uebernommen): synthetische Perioden, nicht die Fixture — prueft
 * die Grenzfaelle offen/abgeschlossen/ausserhalb unabhaengig vom realen Datensatz.
 */
describe('checkPeriod', () => {
  const periods = [
    { id: 1, start: '2025-01-01', end: '2025-12-31', isClosed: true },
    { id: 2, start: '2026-01-01', end: '2026-12-31', isClosed: false },
  ];
  it('findet das offene Geschaeftsjahr fuer ein Datum darin', () => {
    expect(checkPeriod(periods, '2026-08-27').id).toBe(2);
  });
  it('lehnt ein Datum in einem abgeschlossenen Geschaeftsjahr ab', () => {
    expect(() => checkPeriod(periods, '2025-03-01')).toThrow(/abgeschlossen/);
  });
  it('lehnt ein Datum ausserhalb aller Geschaeftsjahre ab', () => {
    expect(() => checkPeriod(periods, '2027-01-01')).toThrow(/kein Geschäftsjahr/);
  });
});

const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-journal.json`);
const cfg = (mode: Config['mode']): Config => ({ mode, pdfDir: '/tmp/x', usageFile, source: 'env', orgs: [{ name: 'nt', subdomain: 'd', 'apiKey': 'k' }] });

afterAll(async () => { await rm(usageFile, { force: true }); });

const json = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
const text = (r: { content?: unknown[] }) => {
  const c = r.content?.[0];
  return c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '';
};

/**
 * Fixture-Kanten: Konto 4000 = id 16 "Materialaufwand", Konto 1020 = id 3 "Bank" (account-list.json),
 * Steuercode VN1 = id 13 (tax-list.json), fiscalperiod-list.json traegt eine offene Periode 2026.
 */
function makeEnv() {
  const state = { createBody: '', createCalled: false };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('fiscalperiod/list')) return json(fixture('fiscalperiod-list'));
    if (u.includes('account/list')) return json(fixture('account-list'));
    if (u.includes('tax/list')) return json(fixture('tax-list'));
    if (u.includes('journal/create')) { state.createBody = String(init?.body ?? ''); state.createCalled = true; return json(JSON.stringify({ success: true, insertId: 321 })); }
    return json('{}');
  }) as unknown as typeof fetch;
  return { fetchImpl, state };
}

describe('prepare_journal_entry / commit_journal_entry (Stufe full)', () => {
  it('Vorschau nennt Konten, Betrag, Titel, Datum und die aufgeloesten Kontonamen', async () => {
    const { fetchImpl } = makeEnv();
    const t = createToolset(cfg('full'), { fetchImpl, modules: [journalModule] });
    const r = await t.call('prepare_journal_entry', { date: '2026-08-27', title: 'Miete August', debitAccount: '4000', creditAccount: '1020', amount: 4200 });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as { summary: string; warnings: string[] };
    expect(s.summary).toContain('4000');
    expect(s.summary).toContain('1020');
    expect(s.summary).toContain('4200.00');
    expect(s.summary).toContain('Miete August');
    expect(s.summary).toContain('2026-08-27');
    expect(s.summary).toContain('Materialaufwand');
    expect(s.summary).toContain('Bank');
    expect(s.warnings).toEqual([]);
  });

  it('commit bucht ohne Steuer und ohne sequenceNumberId; zweiter Aufruf mit demselben Token schlaegt fehl', async () => {
    const { fetchImpl, state } = makeEnv();
    const t = createToolset(cfg('full'), { fetchImpl, modules: [journalModule] });
    const prep = await t.call('prepare_journal_entry', { date: '2026-08-27', title: 'Miete August', debitAccount: '4000', creditAccount: '1020', amount: 4200 });
    expect(prep.isError).toBeFalsy();
    const { token } = prep.structuredContent as { token: string };

    const commit = await t.call('commit_journal_entry', { token });
    expect(commit.isError).toBeFalsy();
    expect(state.createCalled).toBe(true);

    const bp = new URLSearchParams(state.createBody);
    expect(bp.get('dateAdded')).toBe('2026-08-27');
    expect(bp.get('title')).toBe('Miete August');
    expect(bp.get('debitId')).toBe('16');
    expect(bp.get('creditId')).toBe('3');
    expect(bp.get('amount')).toBe('4200');
    expect(bp.get('taxId')).toBeNull();
    expect(bp.get('sequenceNumberId')).toBeNull();

    const out = commit.structuredContent as { id: number };
    expect(out.id).toBe(321);

    const again = await t.call('commit_journal_entry', { token });
    expect(again.isError).toBe(true);
  });

  it('mit taxCode VN1: Body traegt die aufgeloeste taxId', async () => {
    const { fetchImpl, state } = makeEnv();
    const t = createToolset(cfg('full'), { fetchImpl, modules: [journalModule] });
    const prep = await t.call('prepare_journal_entry', { date: '2026-08-27', title: 'Miete August', debitAccount: '4000', creditAccount: '1020', amount: 4200, taxCode: 'VN1' });
    expect(prep.isError).toBeFalsy();
    const { token } = prep.structuredContent as { token: string };
    const commit = await t.call('commit_journal_entry', { token });
    expect(commit.isError).toBeFalsy();
    const bp = new URLSearchParams(state.createBody);
    expect(bp.get('taxId')).toBe('13');
  });

  it('unbekannter Steuercode: isError mit der Liste der vorhandenen Codes', async () => {
    const { fetchImpl } = makeEnv();
    const t = createToolset(cfg('full'), { fetchImpl, modules: [journalModule] });
    const r = await t.call('prepare_journal_entry', { date: '2026-08-27', title: 'Miete August', debitAccount: '4000', creditAccount: '1020', amount: 4200, taxCode: 'XX9' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('XX9');
    expect(text(r)).toContain('VN1');
  });

  it('Datum ausserhalb des offenen Geschaeftsjahrs: isError', async () => {
    const { fetchImpl } = makeEnv();
    const t = createToolset(cfg('full'), { fetchImpl, modules: [journalModule] });
    const r = await t.call('prepare_journal_entry', { date: '2027-01-01', title: 'Miete August', debitAccount: '4000', creditAccount: '1020', amount: 4200 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('kein Geschäftsjahr');
  });

  it('Soll- und Habenkonto identisch: isError', async () => {
    const { fetchImpl } = makeEnv();
    const t = createToolset(cfg('full'), { fetchImpl, modules: [journalModule] });
    const r = await t.call('prepare_journal_entry', { date: '2026-08-27', title: 'Miete August', debitAccount: '4000', creditAccount: '4000', amount: 4200 });
    expect(r.isError).toBe(true);
  });

  it('unbekannte Kontonummer: isError „nicht gefunden“', async () => {
    const { fetchImpl } = makeEnv();
    const t = createToolset(cfg('full'), { fetchImpl, modules: [journalModule] });
    const r = await t.call('prepare_journal_entry', { date: '2026-08-27', title: 'Miete August', debitAccount: '9999', creditAccount: '1020', amount: 4200 });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('nicht gefunden');
  });

  it('Modus draft: prepare_journal_entry/commit_journal_entry gibt es nicht', () => {
    expect(createToolset(cfg('draft'), { modules: [journalModule] }).names()).toEqual([]);
  });

  it('Modus full: beide Werkzeuge sind da', () => {
    expect(createToolset(cfg('full'), { modules: [journalModule] }).names()).toEqual(['prepare_journal_entry', 'commit_journal_entry']);
  });
});
