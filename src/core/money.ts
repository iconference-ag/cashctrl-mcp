/**
 * Kaufmaennisch runden wie CashCtrl: exakt dezimal, halbe Einheiten vom Nullpunkt weg; 1.005 -> 1.01, -1.005 -> -1.01.
 * Gemessen am Demo-Mandanten 12.10.2026 (Trennlauf, Belege 249-253): 5.405 -> 5.41, 48.645 -> 48.65, 275.655 -> 275.66.
 * Die Normierung auf 15 signifikante Stellen entfernt das Binaerrauschen vor dem Runden (275.655 * 100 ist in Float
 * 27565.499999999996; ohne Normierung gab 0.2.1 hier 275.65). Gibt nie -0 zurueck.
 * Grenze: gilt, solange |n| x faktor unter 1e15 bleibt (15 Stellen), bei netToGross (faktor 10000) also fuer Betraege
 * unter rund 1e11.
 */
function rundeSymmetrisch(n: number, faktor: number): number {
  const r = Math.sign(n) * (Math.round(Number((Math.abs(n) * faktor).toPrecision(15))) / faktor);
  return r === 0 ? 0 : r;
}
export function round2(n: number): number {
  return rundeSymmetrisch(n, 100);
}
/** CashCtrl erwartet in order/create den BRUTTO-Stueckpreis (gemessen 27.08.2026). */
export function netToGross(net: number, ratePercent: number): number {
  return rundeSymmetrisch(net * (1 + ratePercent / 100), 10000);
}
