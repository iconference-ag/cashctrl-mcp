import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolset } from '../../src/toolset.js';
import { paymentPlan, paymentModule } from '../../src/tools/full/payment.js';
import type { Config } from '../../src/config/config.js';

const fixture = (n: string) => readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url), 'utf8');

describe('paymentPlan', () => {
  it('nimmt den offenen Betrag als Standard und erkennt Teilzahlungen', () => {
    expect(paymentPlan({ open: 100, total: 100 }, undefined)).toEqual({ amount: 100, remaining: 0, partial: false });
    expect(paymentPlan({ open: 100, total: 100 }, 40)).toEqual({ amount: 40, remaining: 60, partial: true });
  });
  it('lehnt Zahlung ueber den offenen Betrag und auf bezahlte Belege ab', () => {
    expect(() => paymentPlan({ open: 100, total: 100 }, 120)).toThrow(/offenen Betrag/);
    expect(() => paymentPlan({ open: 0, total: 100 }, undefined)).toThrow(/nichts offen/);
  });
});

const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-payment.json`);
const cfg = (mode: Config['mode']): Config => ({ mode, pdfDir: '/tmp/x', usageFile, source: 'env', orgs: [{ name: 'nt', subdomain: 'd', 'apiKey': 'k' }] });

afterAll(async () => { await rm(usageFile, { force: true }); });

// Einkaufsrechnung ER-2026-011 (id 82), Kategorie 15 (PURCHASE Rechnung), Status «Offen» (78),
// open 2659.25 == total: aus der Fixture gelesen, nicht verdrahtet.
const order82 = (JSON.parse(fixture('order-list-type-PURCHASE-limit-5')) as { data: Record<string, unknown>[] }).data.find((r) => r.id === 82)!;

// Status-ID von «Bezahlt» in Kategorie 15 (PURCHASE) aus der Fixture lesen, nicht verdrahten.
const purchaseCats = (JSON.parse(fixture('order-category-list-type-PURCHASE')) as { data: { id: number; status: { id: number; name: string }[] }[] }).data;
const bezahltId = purchaseCats.find((c) => c.id === 15)!.status.find((s) => s.name.includes('<de>Bezahlt</de>'))!.id;

const json = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
const text = (r: { content?: unknown[] }) => {
  const c = r.content?.[0];
  return c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '';
};

/**
 * Eigene fetch-Attrappe je Test: `order/read` liefert vor dem Buchen den Beleg 82 aus der
 * Fixture, nach `order/bookentry/create` denselben Beleg mit `open: afterOpen` — der offene
 * Betrag nach dem Buchen ist die einzige Groesse, die sich je Test unterscheidet (Voll- vs.
 * Teilzahlung). Beleg 55 (ungebucht, `open: null`) kommt unveraendert aus `order-read.json`.
 */
function makeEnv(afterOpen: number) {
  const state = { bookentryBody: '', updateStatusBody: '', updateStatusCalled: false, booked: false };
  const after = { ...order82, open: afterOpen, statusName: afterOpen <= 0 ? '<values><de>Bezahlt</de></values>' : order82.statusName };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('order/category/list')) {
      const type = new URL(u).searchParams.get('type');
      return json(fixture(type === 'PURCHASE' ? 'order-category-list-type-PURCHASE' : 'order-category-list-type-SALES'));
    }
    if (u.includes('account/bank/list')) return json(fixture('account-bank-list'));
    if (u.includes('order/bookentry/create')) { state.bookentryBody = String(init?.body ?? ''); state.booked = true; return json(JSON.stringify({ success: true, insertId: 500 })); }
    if (u.includes('order/update_status')) { state.updateStatusBody = String(init?.body ?? ''); state.updateStatusCalled = true; return json(JSON.stringify({ success: true })); }
    if (u.includes('order/read')) {
      const id = new URL(u).searchParams.get('id');
      if (id === '55') return json(fixture('order-read'));
      return json(JSON.stringify({ success: true, data: state.booked ? after : order82 }));
    }
    return json('{}');
  }) as unknown as typeof fetch;
  return { fetchImpl, state };
}

describe('prepare_payment / commit_payment (Stufe full)', () => {
  it('Vorschau nennt Betrag, Belegnummer, Datum und Bankkonto; keine Warnung', async () => {
    const { fetchImpl } = makeEnv(0);
    const t = createToolset(cfg('full'), { fetchImpl, modules: [paymentModule] });
    const r = await t.call('prepare_payment', { orderId: 82, date: '2026-08-27' });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as { summary: string; warnings: string[] };
    expect(s.summary).toContain('2659.25');
    expect(s.summary).toContain('ER-2026-011');
    expect(s.summary).toContain('2026-08-27');
    expect(s.summary).toContain('Zuger Seeblick Privatbank');
    expect(s.warnings).toEqual([]);
  });

  it('commit bucht die Zahlung und setzt den Status Bezahlt, wenn nichts mehr offen ist; zweiter Aufruf mit demselben Token schlaegt fehl', async () => {
    const { fetchImpl, state } = makeEnv(0);
    const t = createToolset(cfg('full'), { fetchImpl, modules: [paymentModule] });
    const prep = await t.call('prepare_payment', { orderId: 82, date: '2026-08-27' });
    expect(prep.isError).toBeFalsy();
    const { token } = prep.structuredContent as { token: string };

    const commit = await t.call('commit_payment', { token });
    expect(commit.isError).toBeFalsy();

    const bp = new URLSearchParams(state.bookentryBody);
    expect(bp.get('orderIds')).toBe('82');
    expect(bp.get('accountId')).toBe('3');
    expect(bp.get('amount')).toBe('2659.25');
    expect(bp.get('date')).toBe('2026-08-27');

    const up = new URLSearchParams(state.updateStatusBody);
    expect(up.get('ids')).toBe('82');
    expect(up.get('statusId')).toBe(String(bezahltId));

    const out = commit.structuredContent as { open: number; status: string; message: string };
    expect(out.open).toBe(0);
    expect(out.status).toBe('Bezahlt');
    expect(out.message).toBe('Zahlung gebucht, Beleg bezahlt.');

    const again = await t.call('commit_payment', { token });
    expect(again.isError).toBe(true);
  });

  it('Teilzahlung: Warnung vor dem Buchen, danach kein update_status-Aufruf', async () => {
    const { fetchImpl, state } = makeEnv(1659.25);
    const t = createToolset(cfg('full'), { fetchImpl, modules: [paymentModule] });
    const prep = await t.call('prepare_payment', { orderId: 82, amount: 1000, date: '2026-08-27' });
    expect(prep.isError).toBeFalsy();
    const p = prep.structuredContent as { warnings: string[]; token: string };
    expect(p.warnings.join(' ')).toContain('Teilzahlung: danach bleiben 1659.25 offen');

    const commit = await t.call('commit_payment', { token: p.token });
    expect(commit.isError).toBeFalsy();
    expect(state.updateStatusCalled).toBe(false);
    const out = commit.structuredContent as { open: number; message: string };
    expect(out.open).toBe(1659.25);
    expect(out.message).toContain('noch 1659.25 offen');
  });

  it('Beleg ohne offenen Betrag: isError „nichts offen“', async () => {
    const { fetchImpl } = makeEnv(0);
    const t = createToolset(cfg('full'), { fetchImpl, modules: [paymentModule] });
    const r = await t.call('prepare_payment', { orderId: 55, date: '2026-08-27' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('nichts offen');
  });

  it('Betrag ueber dem offenen Betrag: isError', async () => {
    const { fetchImpl } = makeEnv(0);
    const t = createToolset(cfg('full'), { fetchImpl, modules: [paymentModule] });
    const r = await t.call('prepare_payment', { orderId: 82, amount: 3000, date: '2026-08-27' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('offenen Betrag');
  });

  it('unbekanntes Bankkonto: isError mit der Liste der vorhandenen Bankkonten', async () => {
    const { fetchImpl } = makeEnv(0);
    const t = createToolset(cfg('full'), { fetchImpl, modules: [paymentModule] });
    const r = await t.call('prepare_payment', { orderId: 82, bankAccountId: 9, date: '2026-08-27' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Zuger Seeblick Privatbank');
  });

  it('Modus draft: prepare_payment/commit_payment gibt es nicht', () => {
    expect(createToolset(cfg('draft'), { modules: [paymentModule] }).names()).toEqual([]);
  });

  it('Modus full: beide Werkzeuge sind da', () => {
    expect(createToolset(cfg('full'), { modules: [paymentModule] }).names()).toEqual(['prepare_payment', 'commit_payment']);
  });
});
