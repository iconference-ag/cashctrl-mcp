// scripts/schwaerzen.ts — Schwaerzung fuer Fixtures, wiederverwendbar und direkt aufrufbar.
//
// Export schwaerzen(v) fuer scripts/record-fixtures.ts.
// Direktaufruf: npx tsx scripts/schwaerzen.ts
//   Liest alle tests/fixtures/*.json, wendet schwaerzen() erneut an und schreibt sie
//   zurueck. Idempotent — ein zweiter Lauf aendert nichts mehr an bereits geschwaerzten Werten.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Geschwaerzt wird ueber die kompakte JSON-Form (dort steht "feld":"wert" ohne Leerzeichen).
// CashCtrl nennt Kontonummern je nach Endpunkt iban, qrIban, orgIban, orgQrIban, recipientIban —
// darum jeder Feldname, der auf «iban» endet, nicht eine feste Liste.
const GEHEIME_FELDER = /"([A-Za-z0-9_]*[Ii]ban|apiKey|password|ssn)":"[^"]*"/g;
// Der Name des API-Benutzers ist in CashCtrl gleich den ersten vier Zeichen des Schluessels
// (gemessen 27.08.2026). Er steht in createdBy/lastUpdatedBy und gehoert nicht ins Repo.
const API_BENUTZER = /"(createdBy|lastUpdatedBy)":"API:[^"]*"/g;

// Mailadresse als ganzer Feldwert (z.B. emailWork, contacts[].address, location.email).
const MAIL_GANZ = /^[^\s@"]+@[^\s@"]+\.[^\s@"]+$/;
// Mailadresse innerhalb eines laengeren Strings (z.B. mailTo mit mehreren, kommagetrennten
// Adressen, oder ein Footer-Text mit Adresse) — je Fundstelle geschwaerzt, Trenner bleiben stehen.
const MAIL_TEIL = /[^\s@,;"]+@[^\s@,;"]+\.[^\s@,;"]+/g;
const MAIL_ERSATZ = 'geschwaerzt@example.com';
// Telefonnummer in internationaler Schreibweise (+41 41 000 00 00 oder +41791234567), als Feldwert oder
// innerhalb eines Texts. Auch in einem Demo-Mandanten kann eine Nummer einem echten Anschluss gehoeren.
const TELEFON = /\+\d{2}(?: ?\d){9,11}/g;
const TELEFON_ERSATZ = '+41 00 000 00 00';

const schwaerzeText = (s: string): string => {
  if (MAIL_GANZ.test(s)) return MAIL_ERSATZ;
  const ohneMail = s.includes('@') ? s.replace(MAIL_TEIL, MAIL_ERSATZ) : s;
  return ohneMail.includes('+') ? ohneMail.replace(TELEFON, TELEFON_ERSATZ) : ohneMail;
};

// Rekursiv durch die geparste Struktur: jeder String-Wert, der wie eine Mailadresse oder eine
// Telefonnummer aussieht, wird geschwaerzt — unabhaengig vom Feldnamen (emailWork, contacts[].address, mailTo, ...).
const schwaerzeMails = (v: unknown): unknown => {
  if (typeof v === 'string') return schwaerzeText(v);
  if (Array.isArray(v)) return v.map(schwaerzeMails);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, schwaerzeMails(val)]),
    );
  }
  return v;
};

export function schwaerzen(v: unknown): unknown {
  const ohneGeheimfelder = JSON.parse(
    JSON.stringify(v)
      .replace(GEHEIME_FELDER, '"$1":"GESCHWAERZT"')
      .replace(API_BENUTZER, '"$1":"API:GESCHWAERZT"'),
  );
  return schwaerzeMails(ohneGeheimfelder);
}

// Direktaufruf (nicht beim Import als Modul): liest alle tests/fixtures/*.json, wendet
// schwaerzen() an und schreibt jede Datei zurueck.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const verzeichnis = 'tests/fixtures';
  const dateien = (await fs.readdir(verzeichnis)).filter((d) => d.endsWith('.json'));
  for (const datei of dateien) {
    const pfad = path.join(verzeichnis, datei);
    const inhalt = JSON.parse(await fs.readFile(pfad, 'utf8'));
    await fs.writeFile(pfad, JSON.stringify(schwaerzen(inhalt), null, 2) + '\n');
    console.error('geschwaerzt:', datei);
  }
}
