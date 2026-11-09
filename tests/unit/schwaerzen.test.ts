import { describe, it, expect } from 'vitest';
import { schwaerzen } from '../../scripts/schwaerzen.js';

describe('schwaerzen', () => {
  it('schwaerzt eine Mailadresse als ganzen Feldwert, unabhaengig vom Feldnamen', () => {
    const r = schwaerzen({ emailWork: 'info@musterfirma.ch' }) as Record<string, unknown>;
    expect(r.emailWork).toBe('geschwaerzt@example.com');
  });

  it('schwaerzt eine Mailadresse in contacts[].address', () => {
    const r = schwaerzen({
      contacts: [
        { type: 'PHONE_WORK', address: '+41 79 000 00 00' },
        { type: 'EMAIL_WORK', address: 'kontakt@beispiel-firma.ch' },
      ],
    }) as { contacts: { type: string; address: string }[] };
    expect(r.contacts[0].address).toBe('+41 00 000 00 00');   // seit 0.5.0 auch Telefonnummern
    expect(r.contacts[1].address).toBe('geschwaerzt@example.com');
  });

  it('schwaerzt jede Adresse einzeln in einem mailTo mit zwei kommagetrennten Adressen', () => {
    const r = schwaerzen({ mailTo: 'a@firma-eins.ch, b@firma-zwei.ch' }) as Record<string, unknown>;
    expect(r.mailTo).toBe('geschwaerzt@example.com, geschwaerzt@example.com');
  });

  it('schwaerzt eine Mailadresse innerhalb eines laengeren Fliesstexts (kein Komma als Trenner)', () => {
    const r = schwaerzen({ footer: 'Firma AG · Weg 1 · 6300 Zug · kontakt@firma.ch · +41 41 000 00 00' }) as Record<string, unknown>;
    expect(r.footer).toBe('Firma AG · Weg 1 · 6300 Zug · geschwaerzt@example.com · +41 00 000 00 00');
  });

  it('schwaerzt weiter IBAN-Felder (Bestandsregel bleibt)', () => {
    const r = schwaerzen({ iban: 'CH00 0000 0000 0000 0000 0', orgQrIban: 'CH11 1111 1111 1111 1111 1' }) as Record<string, unknown>;
    expect(r.iban).toBe('GESCHWAERZT');
    expect(r.orgQrIban).toBe('GESCHWAERZT');
  });

  it('schwaerzt weiter apiKey/password/ssn (Bestandsregel bleibt)', () => {
    const r = schwaerzen({ apiKey: 'geh1', password: 'geh1', ssn: '756.1234.5678.90' }) as Record<string, unknown>;
    expect(r.apiKey).toBe('GESCHWAERZT');
    expect(r.password).toBe('GESCHWAERZT');
    expect(r.ssn).toBe('GESCHWAERZT');
  });

  it('schwaerzt weiter createdBy/lastUpdatedBy mit API:-Praefix (Bestandsregel bleibt)', () => {
    const r = schwaerzen({ createdBy: 'API:abcd', lastUpdatedBy: 'Max Muster' }) as Record<string, unknown>;
    expect(r.createdBy).toBe('API:GESCHWAERZT');
    expect(r.lastUpdatedBy).toBe('Max Muster'); // kein API:-Praefix, bleibt unveraendert
  });

  it('laesst ein Feld ohne Mailadresse unveraendert', () => {
    const r = schwaerzen({ name: 'Aare Energie GmbH', city: 'Bern', total: 213875.85 }) as Record<string, unknown>;
    expect(r.name).toBe('Aare Energie GmbH');
    expect(r.city).toBe('Bern');
    expect(r.total).toBe(213875.85);
  });

  it('schwaerzt eine Telefonnummer als Feldwert und innerhalb eines Texts; Betraege und Daten bleiben', () => {
    const r = schwaerzen({ phoneMain: '+41 41 728 30 30', footer: 'Muster AG · Demoweg 12 · +41 41 728 30 30', mobil: '+41791234567', total: 4141.3, date: '2026-08-28' }) as Record<string, unknown>;
    expect(r.phoneMain).toBe('+41 00 000 00 00');
    expect(r.footer).toBe('Muster AG · Demoweg 12 · +41 00 000 00 00');
    expect(r.mobil).toBe('+41 00 000 00 00');
    expect(r.total).toBe(4141.3);
    expect(r.date).toBe('2026-08-28');
  });

  it('ist idempotent: ein zweiter Lauf aendert nichts mehr', () => {
    const einmal = schwaerzen({ emailWork: 'info@musterfirma.ch', mailTo: 'a@b.ch, c@d.ch', phoneMain: '+41 41 728 30 30' });
    const zweimal = schwaerzen(einmal);
    expect(zweimal).toEqual(einmal);
  });
});
