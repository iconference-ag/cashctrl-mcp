import { describe, it, expect, afterAll } from 'vitest';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolset } from '../../src/toolset.js';
import type { Config } from '../../src/config/config.js';

/**
 * B6: die MCP-Annotationen sind der Teil des Sicherheitsmodells, den der Client sieht
 * (Spec §6, §7). Bis hierher gab es keinen Test darauf: `destructiveHint` liess sich
 * entfernen, ohne dass etwas rot wurde. Geprueft wird das ganze Werkzeugset im Modus `full`.
 */
const usageFile = join(tmpdir(), `cashctrl-usage-${process.pid}-annotations.json`);
// sendMail und deleteOrders: true, damit der volle Werkzeugsatz (37, inkl. send_order und
// delete_order) geprueft wird — der Fall ohne Schalter (33) hat einen eigenen Test unten.
// 0.4.0: api_catalog, api_read, prepare_api_write, commit_api_write sind ohne Schalter da.
const cfg: Config = { mode: 'full', pdfDir: '/tmp/x', usageFile, source: 'env', orgs: [{ name: 'nt', subdomain: 'd', 'apiKey': 'k', sendMail: true, deleteOrders: true }] };
afterAll(async () => { await rm(usageFile, { force: true }); });

const alle = createToolset(cfg).tools;
const A = (name: string) => {
  const t = alle.find((x) => x.name === name);
  if (!t) throw new Error(`Werkzeug ${name} fehlt im Modus full`);
  return t.annotations;
};

const LESEND = ['list_orgs', 'usage', 'list_fiscal_periods', 'search_contacts', 'get_contact', 'search_articles', 'get_article', 'search_orders', 'get_order', 'get_order_pdf', 'search_journal', 'list_accounts', 'financial_summary', 'list_taxes', 'list_currencies', 'api_catalog', 'api_read'];
const ARTEN = ['contact', 'article', 'order_draft', 'order_status', 'order_create', 'payment', 'journal_entry', 'send_order', 'delete_order', 'api_write'];
/** Aktionen, die Geld bewegen, Zustand am Beleg aendern, den Rechner verlassen oder loeschen (Spec §6; 0.4.0: der allgemeine Schreibweg kann alles davon). */
const ZERSTOEREND = ['commit_order_status', 'commit_order_create', 'commit_payment', 'commit_journal_entry', 'commit_send_order', 'commit_delete_order', 'commit_api_write'];
const HARMLOS = ['commit_contact', 'commit_article', 'commit_order_draft'];

describe('MCP-Annotationen (B6)', () => {
  it('genau 37 Werkzeuge im Modus full mit beiden Schaltern: 17 lesend (0.2.4: get_article, 0.3.0: list_currencies, 0.4.0: api_catalog, api_read), 10 prepare_, 10 commit_', () => {
    expect(alle).toHaveLength(37);
    const namen = alle.map((t) => t.name);
    expect(namen.filter((n) => LESEND.includes(n)).sort()).toEqual([...LESEND].sort());
    expect(namen.filter((n) => n.startsWith('prepare_')).sort()).toEqual(ARTEN.map((k) => `prepare_${k}`).sort());
    expect(namen.filter((n) => n.startsWith('commit_')).sort()).toEqual(ARTEN.map((k) => `commit_${k}`).sort());
  });

  it('Lesewerkzeuge und alle prepare_ tragen readOnlyHint: true', () => {
    for (const n of LESEND) expect(A(n).readOnlyHint, n).toBe(true);
    for (const k of ARTEN) expect(A(`prepare_${k}`).readOnlyHint, k).toBe(true);
  });

  it('alle commit_ tragen readOnlyHint false, idempotentHint false, openWorldHint true', () => {
    for (const k of ARTEN) {
      const a = A(`commit_${k}`);
      expect(a.readOnlyHint, k).toBe(false);
      expect(a.idempotentHint, k).toBe(false);
      expect(a.openWorldHint, k).toBe(true);
    }
  });

  it('destructiveHint steht genau bei den sieben Aktionen aus Spec §6 (0.4.0: dazu commit_api_write)', () => {
    for (const n of ZERSTOEREND) expect(A(n).destructiveHint, n).toBe(true);
    for (const n of HARMLOS) expect(A(n).destructiveHint, n).toBe(false);
    // Und nirgends sonst: kein lesendes und kein prepare_-Werkzeug traegt die Marke.
    for (const t of alle.filter((x) => !ZERSTOEREND.includes(x.name))) {
      expect(t.annotations.destructiveHint, t.name).not.toBe(true);
    }
  });

  it('openWorldHint: true ueberall ausser bei usage und api_catalog, die nur lokal lesen (0.4.0: der Katalog liegt im Paket)', () => {
    for (const t of alle) {
      expect(t.annotations.openWorldHint, t.name).toBe(t.name !== 'usage' && t.name !== 'api_catalog');
    }
  });

  it('ohne Schalter: 33 Werkzeuge, weder send_order noch delete_order, aber die vier allgemeinen', () => {
    const ohne: Config = { mode: 'full', pdfDir: '/tmp/x', usageFile, source: 'env', orgs: [{ name: 'nt', subdomain: 'd', 'apiKey': 'k' }] };
    const t = createToolset(ohne).tools;
    expect(t).toHaveLength(33);
    expect(t.map((x) => x.name)).toEqual(expect.arrayContaining(['api_catalog', 'api_read', 'prepare_api_write', 'commit_api_write']));
    const namen = t.map((x) => x.name);
    expect(namen).not.toContain('prepare_send_order');
    expect(namen).not.toContain('commit_send_order');
    expect(namen).not.toContain('commit_delete_order');
    expect(t.some((x) => x.name === 'commit_send_order' && x.annotations.destructiveHint === true)).toBe(false);
  });
});
