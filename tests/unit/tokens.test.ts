import { describe, it, expect } from 'vitest';
import { MemoryTokenStore } from '../../src/tools/tokens.js';

describe('MemoryTokenStore', () => {
  it('gibt ein Token, das genau einmal, nur fuer Art und Org und nur 10 Minuten gilt', async () => {
    let t = 0; const s = new MemoryTokenStore(10 * 60 * 1000, () => t);
    const { token, expiresAt } = await s.issue('contact', 'nt', { company: 'X' });
    expect(expiresAt).toBeTruthy();
    await expect(s.redeem('article', 'nt', token)).rejects.toThrow(/Token/);
    await expect(s.redeem('contact', 'andere', token)).rejects.toThrow(/Token/);
    expect(await s.redeem<{ company: string }>('contact', 'nt', token)).toEqual({ company: 'X' });
    await expect(s.redeem('contact', 'nt', token)).rejects.toThrow(/Token/);       // entwertet
    const t2 = (await s.issue('contact', 'nt', {})).token; t += 10 * 60 * 1000 + 1;
    await expect(s.redeem('contact', 'nt', t2)).rejects.toThrow(/abgelaufen/);
  });

  it('issue raeumt abgelaufene Eintraege weg — kein Wachstum ueber die Laufzeit (Minor)', async () => {
    let t = 0;
    const s = new MemoryTokenStore(1000, () => t);
    const eintraege = (s as unknown as { entries: Map<string, unknown> }).entries;
    const alt = (await s.issue('contact', 'nt', { a: 1 })).token;
    expect(eintraege.size).toBe(1);
    t += 1001;                                   // der erste ist abgelaufen, aber nie eingeloest worden
    const neu = (await s.issue('contact', 'nt', { a: 2 })).token;
    expect(eintraege.size).toBe(1);              // beim Ausstellen weggeraeumt, nicht angesammelt
    await expect(s.redeem('contact', 'nt', alt)).rejects.toThrow(/unbekannt/);
    await s.redeem('contact', 'nt', neu);
    expect(eintraege.size).toBe(0);
  });
});
