import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/config.js';

function home(cfg?: unknown, mode = 0o600) {
  const h = mkdtempSync(join(tmpdir(), 'home-'));
  if (cfg !== undefined) {
    mkdirSync(join(h, '.config/cashctrl-mcp'), { recursive: true });
    const f = join(h, '.config/cashctrl-mcp/config.json');
    writeFileSync(f, JSON.stringify(cfg)); chmodSync(f, mode);
  }
  return h;
}

/** Gibt den geworfenen Fehler zurueck — und scheitert, wenn keiner kommt. */
async function fehler(p: Promise<unknown>): Promise<Error> {
  try { await p; } catch (e) { return e as Error; }
  throw new Error('Erwarteter Fehler blieb aus');
}

/** Legt eine Konfigurationsdatei mit rohem, ggf. ungueltigem Inhalt an. */
function homeRoh(text: string, mode = 0o600) {
  const h = mkdtempSync(join(tmpdir(), 'home-'));
  mkdirSync(join(h, '.config/cashctrl-mcp'), { recursive: true });
  const f = join(h, '.config/cashctrl-mcp/config.json');
  writeFileSync(f, text); chmodSync(f, mode);
  return { h, f };
}

describe('loadConfig', () => {
  it('liest die Datei, Standard-Modus read, Standardpfade unter home', async () => {
    const h = home({ orgs: [{ name: 'nt', subdomain: 'demo', apiKey: 'k' }] });
    const c = await loadConfig({ home: h, env: {} });
    expect(c.mode).toBe('read');
    expect(c.source).toBe('file');
    expect(c.pdfDir).toBe(join(h, 'Downloads/cashctrl-mcp'));
    expect(c.usageFile).toBe(join(h, '.config/cashctrl-mcp/usage.json'));
    expect(c.orgs[0].name).toBe('nt');
  });
  it('nimmt Umgebungsvariablen fuer Ein-Org-Setups', async () => {
    const c = await loadConfig({ home: home(), env: { CASHCTRL_SUBDOMAIN: 'demo', CASHCTRL_API_KEY: 'k', CASHCTRL_MODE: 'draft' } });
    expect(c).toMatchObject({ mode: 'draft', source: 'env', orgs: [{ name: 'demo', subdomain: 'demo', apiKey: 'k' }] });
  });
  it('sendMail (Datei): fehlt das Feld, ist es false; "sendMail": true kommt durch', async () => {
    const ohne = await loadConfig({ home: home({ orgs: [{ name: 'nt', subdomain: 'a', apiKey: 'k' }] }), env: {} });
    expect(ohne.orgs[0].sendMail).toBeFalsy();
    const mit = await loadConfig({ home: home({ orgs: [{ name: 'nt', subdomain: 'a', apiKey: 'k', sendMail: true }] }), env: {} });
    expect(mit.orgs[0].sendMail).toBe(true);
  });
  it('sendMail (Umgebung): CASHCTRL_SEND_MAIL=1 -> true, fehlend -> false', async () => {
    const mit = await loadConfig({ home: home(), env: { CASHCTRL_SUBDOMAIN: 'demo', CASHCTRL_API_KEY: 'k', CASHCTRL_SEND_MAIL: '1' } });
    expect(mit.orgs[0].sendMail).toBe(true);
    const ohne = await loadConfig({ home: home(), env: { CASHCTRL_SUBDOMAIN: 'demo', CASHCTRL_API_KEY: 'k' } });
    expect(ohne.orgs[0].sendMail).toBe(false);
  });
  it('deleteOrders (Datei): fehlt das Feld, ist es false; "deleteOrders": true kommt durch; kein String', async () => {
    const ohne = await loadConfig({ home: home({ orgs: [{ name: 'nt', subdomain: 'a', apiKey: 'k' }] }), env: {} });
    expect(ohne.orgs[0].deleteOrders).toBeFalsy();
    const mit = await loadConfig({ home: home({ orgs: [{ name: 'nt', subdomain: 'a', apiKey: 'k', deleteOrders: true }] }), env: {} });
    expect(mit.orgs[0].deleteOrders).toBe(true);
    await expect(loadConfig({ home: home({ orgs: [{ name: 'nt', subdomain: 'a', apiKey: 'k', deleteOrders: 'true' }] }), env: {} })).rejects.toThrow(/deleteOrders/);
  });
  it('deleteOrders (Umgebung): nur CASHCTRL_DELETE_ORDERS=1 -> true, sonst false', async () => {
    const mit = await loadConfig({ home: home(), env: { CASHCTRL_SUBDOMAIN: 'demo', CASHCTRL_API_KEY: 'k', CASHCTRL_DELETE_ORDERS: '1' } });
    expect(mit.orgs[0].deleteOrders).toBe(true);
    const ja = await loadConfig({ home: home(), env: { CASHCTRL_SUBDOMAIN: 'demo', CASHCTRL_API_KEY: 'k', CASHCTRL_DELETE_ORDERS: 'true' } });
    expect(ja.orgs[0].deleteOrders).toBe(false);
    const ohne = await loadConfig({ home: home(), env: { CASHCTRL_SUBDOMAIN: 'demo', CASHCTRL_API_KEY: 'k' } });
    expect(ohne.orgs[0].deleteOrders).toBe(false);
  });
  it('lehnt Datei plus Umgebung, unbekannten Modus und leere Konfiguration ab', async () => {
    const h = home({ orgs: [{ name: 'a', subdomain: 'a', apiKey: 'k' }] });
    await expect(loadConfig({ home: h, env: { CASHCTRL_API_KEY: 'k', CASHCTRL_SUBDOMAIN: 'a' } })).rejects.toThrow(/entweder/);
    await expect(loadConfig({ home: home({ mode: 'write', orgs: [{ name: 'a', subdomain: 'a', apiKey: 'k' }] }), env: {} })).rejects.toThrow(/Modus/);
    await expect(loadConfig({ home: home(), env: {} })).rejects.toThrow(/config\.json/);
  });
  it('lehnt einen Organisationsnamen ab, der als Verzeichnisname gefaehrlich waere', async () => {
    // Der Name wird in get_order_pdf zum Verzeichnis unter pdfDir: '..' zeigt eine Ebene hoeher,
    // '.' auf pdfDir selbst, '../x' aus dem Verzeichnis heraus.
    for (const name of ['..', '.', '../x', 'nt/../..']) {
      await expect(loadConfig({ home: home({ orgs: [{ name, subdomain: 'a', apiKey: 'k' }] }), env: {} }))
        .rejects.toThrow(/Organisationsname/);
    }
    // Positivkontrolle: gewoehnliche Namen kommen weiterhin durch, Punkt im Namen bleibt erlaubt.
    const ok = await loadConfig({ home: home({ orgs: [{ name: 'nt', subdomain: 'a', apiKey: 'k' }, { name: 'iconf.ag', subdomain: 'b', apiKey: 'k' }] }), env: {} });
    expect(ok.orgs.map((o) => o.name)).toEqual(['nt', 'iconf.ag']);
  });
  it('prueft die Subdomain auch im Umgebungspfad (C0)', async () => {
    await expect(loadConfig({ home: home(), env: { CASHCTRL_SUBDOMAIN: 'Evil/Path', CASHCTRL_API_KEY: 'k' } }))
      .rejects.toThrow(/subdomain/);
    // Positivkontrolle: eine gueltige Subdomain kommt weiterhin durch.
    const ok = await loadConfig({ home: home(), env: { CASHCTRL_SUBDOMAIN: 'demo', CASHCTRL_API_KEY: 'k' } });
    expect(ok.orgs[0].subdomain).toBe('demo');
  });
  it('meldet eine unlesbare Datei statt sie als fehlend zu behandeln (M6)', async () => {
    if (process.getuid?.() === 0) return;                 // als root ist alles lesbar
    const { h, f } = homeRoh(JSON.stringify({ orgs: [{ name: 'a', subdomain: 'a', apiKey: 'k' }] }), 0o000);
    const err = await fehler(loadConfig({ home: h, env: {} }));
    expect(err.message).toContain('nicht lesbar');
    expect(err.message).toContain(f);
  });
  it('meldet kaputtes JSON mit Pfad statt eines Absturzes (M7)', async () => {
    const { h, f } = homeRoh('{');
    const err = await fehler(loadConfig({ home: h, env: {} }));
    expect(err.message).toContain('kein gültiges JSON');
    expect(err.message).toContain(f);
  });
  it('erkennt Datei plus CASHCTRL_MODE als Doppelkonfiguration (M8)', async () => {
    const h = home({ orgs: [{ name: 'a', subdomain: 'a', apiKey: 'k' }] });
    await expect(loadConfig({ home: h, env: { CASHCTRL_MODE: 'draft' } })).rejects.toThrow(/entweder/);
    await expect(loadConfig({ home: h, env: { CASHCTRL_PDF_DIR: '/tmp/x' } })).rejects.toThrow(/entweder/);
  });
  it('haengt den Modus-Hinweis nur an, wenn der Modus schuld ist (M13)', async () => {
    const h = home({ orgs: [{ name: 'a', subdomain: 'a', apiKey: '' }] });
    const err = await fehler(loadConfig({ home: h, env: {} }));
    expect(err.message).toContain('apiKey');
    expect(err.message).not.toContain('Modus');
  });
  it('zitiert bei kaputtem JSON nie den Dateiinhalt (N1)', async () => {
    const { h } = homeRoh('{"orgs":[{"name":"a","subdomain":"a","apiKey":SECRT}]}');
    const err = await fehler(loadConfig({ home: h, env: {} }));
    expect(err.message).toContain('kein g\u00fcltiges JSON');
    expect(err.message).not.toContain('SECRT');
    // Positivkontrolle: die rohe Meldung von JSON.parse zitiert den Inhalt sehr wohl.
    let roh = '';
    try { JSON.parse('{"orgs":[{"apiKey":SECRT}]}'); } catch (e) { roh = (e as Error).message; }
    expect(roh).toContain('SECRT');
  });
  it('zitiert auch im Schema-Fehler keinen Wert (N1, Regressionsnetz)', async () => {
    const { h } = homeRoh('{"orgs":[{"name":"a","subdomain":"a","apiKey":12345}]}');
    const err = await fehler(loadConfig({ home: h, env: {} }));
    expect(err.message).toContain('apiKey');
    expect(err.message).not.toContain('12345');
  });
  it('nennt den Feldnamen im Fehler nur einmal (Minor)', async () => {
    const h = home({ orgs: [{ name: 'a', subdomain: 'Gross/Falsch', apiKey: 'k' }] });
    const err = await fehler(loadConfig({ home: h, env: {} }));
    expect(err.message).toContain('subdomain:');
    expect(err.message).not.toContain('subdomain: subdomain:');
  });
  it('meldet ohne Datei und ohne Kernvariablen weiterhin den Anlege-Hinweis (Minor)', async () => {
    await expect(loadConfig({ home: home(), env: { CASHCTRL_MODE: 'draft' } })).rejects.toThrow(/config\.json/);
    await expect(loadConfig({ home: home(), env: { CASHCTRL_PDF_DIR: '/tmp/x' } })).rejects.toThrow(/config\.json/);
  });
  it('warnt bei zu offenen Dateirechten', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    await loadConfig({ home: home({ orgs: [{ name: 'a', subdomain: 'a', apiKey: 'k' }] }, 0o644), env: {} });
    expect(warn.mock.calls.flat().join(' ')).toMatch(/0600/);
    warn.mockRestore();
  });
});
