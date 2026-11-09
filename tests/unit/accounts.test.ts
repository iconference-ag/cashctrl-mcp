import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveAccount } from '../../src/tools/accounts.js';

// Echte Kontenliste des Mandanten (140 Konten) — Feldname `number`, nicht `nr`
// (tests/fixtures/README.md, Abschnitt account/list).
const accounts = (JSON.parse(readFileSync(new URL('../fixtures/account-list.json', import.meta.url), 'utf8')) as { data: { id: unknown; number: unknown; name: unknown }[] }).data;

describe('resolveAccount', () => {
  it('loest die Kontonummer exakt auf und gibt den deutschen Namen', () => {
    expect(resolveAccount(accounts, '3000')).toEqual({ id: 15, number: '3000', name: 'Produktionsertrag' });
    expect(resolveAccount(accounts, '1100')).toEqual({ id: 4, number: '1100', name: 'Debitoren' });
  });

  it('kein Praefix-Treffer: 300 findet nicht 3000', () => {
    expect(() => resolveAccount(accounts, '300')).toThrow(/Konto 300 nicht gefunden/);
  });

  it('unbekannte Nummer: Fehler nennt die Nummer', () => {
    expect(() => resolveAccount(accounts, '9999')).toThrow(/Konto 9999 nicht gefunden/);
  });
});
