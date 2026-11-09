import { describe, it, expect } from 'vitest';
import { netToGross, round2 } from '../../src/core/money.js';

describe('money', () => {
  it('rechnet netto zu brutto mit 4 Dezimalen (gemessene Falle: unitPrice ist brutto)', () => {
    expect(netToGross(480, 8.1)).toBe(518.88);
    expect(netToGross(444.03, 8.1)).toBe(479.9964);
    expect(netToGross(100, 0)).toBe(100);
  });
  it('rundet kaufmaennisch auf 2 Dezimalen', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(13955.7)).toBe(13955.7);
  });
  it('rundet halbe Rappen vom Nullpunkt weg wie CashCtrl (gemessen 12.10.2026: -16.215 -> -16.22)', () => {
    expect(round2(-16.215)).toBe(-16.22);
    expect(round2(16.215)).toBe(16.22);
    expect(round2(-1.005)).toBe(-1.01);
    expect(netToGross(-15, 8.1)).toBe(-16.215);
    expect(Object.is(round2(-0.001), 0)).toBe(true);   // kein -0 in Vorschau und Vergleich
  });
  it('Spiegelprobe: f(-p) = -f(p) fuer alle Netto-Preise 0.01 bis 200.00 bei 2.6, 3.8 und 8.1 %', () => {
    const fehler: string[] = [];
    for (const satz of [2.6, 3.8, 8.1]) {
      for (let r = 1; r <= 20000; r++) {
        const p = r / 100;
        const g = netToGross(p, satz);
        if (netToGross(-p, satz) !== -g) fehler.push(`netToGross ${p} @ ${satz}`);
        if (round2(-g) !== -round2(g)) fehler.push(`round2 ${g}`);
        if (round2(-p * 3) !== -round2(p * 3)) fehler.push(`round2 3 x ${p}`);
      }
    }
    expect(fehler).toEqual([]);
  });
  // Trennlauf am Demo-Mandanten 12.10.2026 (Belege 249-253): CashCtrl rechnet exakt dezimal, halbe Rappen vom Nullpunkt weg.
  // 5.405/48.645/27.025 schliessen «halbe auf gerade» aus, 275.655 schliesst Float-Rundung aus (0.2.1 gab 275.65).
  it('trifft die am Mandanten gemessenen Zeilen und Totale (exakt dezimal, halbe weg vom Nullpunkt)', () => {
    const zeile = (netto: number, menge = 1) => round2(menge * netToGross(netto, 8.1));
    expect(zeile(5)).toBe(5.41);
    expect(zeile(45)).toBe(48.65);
    expect(zeile(25)).toBe(27.03);
    expect(zeile(255)).toBe(275.66);
    expect(round2(zeile(100) + zeile(-45))).toBe(59.45);
    expect(zeile(-15)).toBe(-16.22);
  });
  it('BigInt-Probe: Zeilentotal = exakte Dezimalrechnung fuer 200000 Zufallszeilen (fester Seed)', () => {
    // Exakt in ganzen Zahlen: Netto in Rappen x (1000 + Satz in Promille) = Brutto in 1e-5, halb weg auf 1e-4 (Stueckpreis),
    // Menge in Zehnteln x Stueckpreis = 1e-5, halb weg auf Rappen.
    const halbWeg = (x: bigint, d: bigint) => { const s = x < 0n ? -1n : 1n; return s * ((x * s + d / 2n) / d); };
    // mulberry32: 32-Bit-Arithmetik mit Math.imul, kein Ueberlauf ueber 2^53 (ein Float-LCG lief nach 12'195 Schritten im Kreis).
    let seed = 20261012;
    const zufall = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const verschieden = new Set<string>();
    const saetze = [[0, 0], [26, 2.6], [38, 3.8], [81, 8.1]] as const;
    const mengen = [1, 2, 3, 10, 2.5, 0.5, 12, 100];
    const fehler: string[] = [];
    for (let i = 0; i < 200000; i++) {
      const rappen = Math.floor(zufall() * 600001) - 300000;
      const [promille, satz] = saetze[Math.floor(zufall() * saetze.length)];
      const menge = mengen[Math.floor(zufall() * mengen.length)];
      verschieden.add(`${rappen}|${promille}|${menge}`);
      const stueck = halbWeg(BigInt(rappen) * BigInt(1000 + promille), 10n);
      const exakt = Number(halbWeg(stueck * BigInt(menge * 10), 1000n)) / 100;
      const ist = round2(menge * netToGross(rappen / 100, satz));
      if (ist !== exakt && fehler.length < 5) fehler.push(`${menge} x ${rappen / 100} @ ${satz}: ${ist} statt ${exakt}`);
    }
    expect(verschieden.size).toBeGreaterThanOrEqual(190000);   // die Probe deckt wirklich so viele Zeilen ab
    expect(fehler).toEqual([]);
  });
});
