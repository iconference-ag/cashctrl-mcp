import { describe, it, expect } from 'vitest';
import { mkdtempSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { UsageCounter } from '../../src/core/usage.js';
import type { CashCtrlError } from '../../src/core/errors.js';

/** Gibt den geworfenen Fehler zurueck — und scheitert, wenn keiner kommt. */
async function fehler(p: Promise<unknown>): Promise<CashCtrlError> {
  try { await p; } catch (e) { return e as CashCtrlError; }
  throw new Error('Erwarteter Fehler blieb aus');
}

describe('UsageCounter', () => {
  const file = () => join(mkdtempSync(join(tmpdir(), 'usage-')), 'usage.json');
  it('zaehlt je Organisation und Monat, warnt ab 80 %, sperrt bei 100 %', async () => {
    let d = new Date('2026-08-27T10:00:00Z');
    const u = new UsageCounter(file(), 10, () => d);
    for (let i = 0; i < 8; i++) await u.record('a');
    const s = await u.state('a');
    expect(s).toMatchObject({ month: '2026-08', calls: 8, limit: 10, percent: 80 });
    expect(s.warning).toMatch(/80 %/);
    await u.record('a'); await u.record('a');
    await expect(u.record('a')).rejects.toMatchObject({ kind: 'quota' });
    expect((await u.state('b')).calls).toBe(0);
    d = new Date('2026-09-01T00:00:01Z');       // Monatswechsel setzt zurueck
    expect((await u.state('a')).calls).toBe(0);
  });
  it('serialisiert 20 parallele record()-Aufrufe ohne Fehler oder Datenverlust', async () => {
    const u = new UsageCounter(file(), 1000);
    await Promise.all(Array.from({ length: 20 }, () => u.record('a')));
    expect((await u.state('a')).calls).toBe(20);
  });
  it('zwei Instanzen auf derselben Datei verlieren keine Aufrufe (I3)', async () => {
    const f = file();
    const a = new UsageCounter(f, 1000);
    const b = new UsageCounter(f, 1000);
    await Promise.all([
      ...Array.from({ length: 20 }, () => a.record('a')),
      ...Array.from({ length: 20 }, () => b.record('a')),
    ]);
    expect((await new UsageCounter(f, 1000).state('a')).calls).toBe(40);
  }, 30000);
  it('respektiert eine fremde Lockdatei und raeumt eine verwaiste weg (I3, Positivkontrolle)', async () => {
    const f = file();
    const lock = `${f}.lock`;
    const u = new UsageCounter(f, 1000);
    await fsp.writeFile(lock, '');                         // fremder Halter, frisch
    let fertig = false;
    const p = u.record('a').then(() => { fertig = true; });
    await new Promise((r) => setTimeout(r, 150));
    expect(fertig).toBe(false);                            // blockiert, solange der Lock steht
    await fsp.rm(lock);
    await p;
    expect(fertig).toBe(true);
    const alt = new Date(Date.now() - 30000);
    await fsp.writeFile(lock, '');
    await fsp.utimes(lock, alt, alt);                      // verwaist (aelter als 10 s)
    await u.record('a');                                   // muss ohne Warten durchlaufen
    expect((await u.state('a')).calls).toBe(2);
  }, 30000);
  it('raeumt einen verwaisten Lock auch als Wartender weg (N2)', async () => {
    const f = file();
    const lock = `${f}.lock`;
    await fsp.mkdir(dirname(f), { recursive: true });
    await fsp.writeFile(lock, '');                 // liegengeblieben, niemand raeumt ihn auf
    const u = new UsageCounter(f, 1000, undefined, { lockStaleMs: 150, lockWaitMs: 2000 });
    expect((await u.record('a')).calls).toBe(1);   // Wartefrist muss die Stale-Grenze erreichen
  }, 30000);
  it('meldet einen dauerhaft gehaltenen Lock mit Pfad (N2)', async () => {
    const f = file();
    const lock = `${f}.lock`;
    await fsp.mkdir(dirname(f), { recursive: true });
    await fsp.writeFile(lock, '');
    const halter = setInterval(() => {            // lebender Halter: frischt die Lockdatei auf
      const t = new Date();
      void fsp.utimes(lock, t, t).catch(() => undefined);
    }, 30);
    const u = new UsageCounter(f, 1000, undefined, { lockStaleMs: 150, lockWaitMs: 300 });
    const err = await fehler(u.record('a'));
    clearInterval(halter);
    await fsp.rm(lock, { force: true });
    expect(err.kind).toBe('unknown');
    expect(err.message).toContain(lock);
    expect(err.message).toContain('zweiter Server');
  }, 30000);
  it('ueberlebt einen Neustart (Datei)', async () => {
    const f = file();
    await new UsageCounter(f, 100).record('a');
    expect((await new UsageCounter(f, 100).state('a')).calls).toBe(1);
  });
});
