import { describe, it, expect } from 'vitest';
import { IsoDatum, shiftDay, clampLimit, isoTag, fail } from '../../src/tools/result.js';
import { CashCtrlError } from '../../src/core/errors.js';
import { compactPerson } from '../../src/tools/read/contacts.js';
import { compactArticle } from '../../src/tools/read/articles.js';
import { compactOrder } from '../../src/tools/read/orders.js';
import { compactEntry, compactAccount } from '../../src/tools/read/ledger.js';

describe('IsoDatum — kalendarische Pruefung (B1)', () => {
  it('nimmt echte Tage an', () => {
    for (const gut of ['2026-01-01', '2026-12-31', '2024-02-29', '2000-02-29']) {
      expect(IsoDatum.safeParse(gut).success, gut).toBe(true);
    }
  });
  it('lehnt Tage ab, die es im Kalender nicht gibt', () => {
    // Alle drei bestehen die reine Regex ^\d{4}-\d{2}-\d{2}$ und liefen bisher still durch.
    for (const boese of ['2026-02-30', '2026-13-45', '2025-02-29', '1900-02-29', '2026-04-31', '2026-00-10', '2026-01-00']) {
      expect(IsoDatum.safeParse(boese).success, boese).toBe(false);
    }
  });
  it('lehnt auch die Form ab und nennt das Muster', () => {
    const r = IsoDatum.safeParse('10.07.2026');
    expect(r.success).toBe(false);
    expect(r.success === false && r.error.issues[0].message).toContain('YYYY-MM-DD');
  });
});

describe('shiftDay (B1)', () => {
  it('rechnet ueber Monats- und Jahresgrenzen', () => {
    expect(shiftDay('2026-07-01', -1)).toBe('2026-06-30');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDay('2024-03-01', -1)).toBe('2024-02-29');
  });
  it('wirft bei einem Datum, das es nicht gibt, statt still zu verschieben', () => {
    // Bisher: shiftDay('2026-02-30', 1) ergab '2026-03-03' — ein Filter auf einen Tag,
    // den niemand angefragt hat.
    expect(() => shiftDay('2026-02-30', 1)).toThrow(/YYYY-MM-DD/);
    expect(() => shiftDay('2026-13-45', -1)).toThrow(/YYYY-MM-DD/);
    expect(() => shiftDay('nicht-ein-datum', 1)).toThrow(/YYYY-MM-DD/);
  });
});

describe('clampLimit (Minor)', () => {
  it('haelt das Limit zwischen 1 und 200, Standard 50', () => {
    expect(clampLimit(1)).toBe(1);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit(500)).toBe(200);
    expect(clampLimit(200)).toBe(200);
    expect(clampLimit(-7)).toBe(1);
  });
});

describe('isoTag (B3)', () => {
  it('schneidet CashCtrls Zeitstempel auf den reinen Tag', () => {
    expect(isoTag('2026-07-10 00:00:00.0')).toBe('2026-07-10');
    expect(isoTag('2026-12-31 23:59:59.0')).toBe('2026-12-31');
    expect(isoTag('2026-07-10')).toBe('2026-07-10');
  });
  it('gibt fuer alles, was kein String ist, null', () => {
    expect(isoTag(null)).toBeNull();
    expect(isoTag(undefined)).toBeNull();
    expect(isoTag(20260710)).toBeNull();
  });
});

describe('Kompakte Ausgaben — genau diese Felder, kein weiteres (Minor)', () => {
  it('compactPerson', () => {
    expect(Object.keys(compactPerson({ id: 1 }))).toEqual(['id', 'nr', 'name', 'company', 'firstName', 'lastName', 'city', 'email', 'isCustomer', 'isVendor', 'isEmployee']);
  });
  it('compactArticle', () => {
    expect(Object.keys(compactArticle({ id: 1 }))).toEqual(['id', 'nr', 'name', 'unit', 'salesPriceNet', 'purchasePriceNet', 'stock', 'categoryId', 'salesPriceIsGross', 'salesAccountId', 'currencyId', 'currency']);
  });
  it('compactOrder', () => {
    expect(Object.keys(compactOrder({ id: 1 }))).toEqual(['id', 'nr', 'date', 'category', 'status', 'contactName', 'total', 'open', 'currency', 'currencyId', 'dueDate', 'previousId']);
  });
  it('compactEntry', () => {
    expect(Object.keys(compactEntry({ id: 1 }))).toEqual(['id', 'date', 'title', 'debitAccount', 'creditAccount', 'amount', 'reference']);
  });
  it('compactAccount', () => {
    expect(Object.keys(compactAccount({ id: 1 }))).toEqual(['id', 'number', 'name', 'category', 'endAmount', 'currency']);
  });
});

// Claude Desktop gibt dem Modell nur structuredContent weiter, wenn es vorhanden ist (Meldung aus Claude Desktop, 25.10.2026).
// Die Fehlermeldung muss darum auch dort stehen, sonst sieht das Modell nur die Fehlerart.
describe('fail: Meldung auch in structuredContent', () => {
  it('CashCtrlError: message neben kind', () => {
    const r = fail(new CashCtrlError('validation', 'Lohn-Endpunkte sind nicht freigeschaltet.'));
    expect(r.structuredContent).toMatchObject({ kind: 'validation', message: 'Lohn-Endpunkte sind nicht freigeschaltet.' });
    expect((r.content[0] as { text: string }).text).toBe('Lohn-Endpunkte sind nicht freigeschaltet.');
  });
  it('anderer Fehler: dieselbe Meldung wie im Text', () => {
    const r = fail(new Error('kaputt'));
    expect(r.structuredContent).toMatchObject({ kind: 'unknown', message: 'Fehler: kaputt' });
  });
});
