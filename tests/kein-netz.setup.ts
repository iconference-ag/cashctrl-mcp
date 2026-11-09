import { afterAll, expect } from 'vitest';

/**
 * Die Unit-Suite laeuft ohne Netz (README, «Entwicklung»). Diese Sperre macht daraus eine Messung:
 * wer ohne `fetchImpl` bis zum Netz kommt, wirft hier, und die Testdatei faellt am Ende durch.
 * Die Vertragstests gegen den Mandanten (CASHCTRL_LIVE=1) brauchen das echte fetch.
 */
if (process.env.CASHCTRL_LIVE !== '1') {
  const rufe: string[] = [];
  globalThis.fetch = (async (ziel: string | URL | Request) => {
    rufe.push(String(ziel instanceof Request ? ziel.url : ziel).split('?')[0]!);
    throw new Error('Netzzugriff in der Unit-Suite');
  }) as typeof fetch;
  afterAll(() => { expect(rufe, 'ein Unit-Test ohne fetchImpl hat das Netz erreicht').toEqual([]); });
}
