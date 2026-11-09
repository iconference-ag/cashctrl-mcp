// scripts/record-fixtures.ts — Aufruf: CASHCTRL_LIVE=1 npx tsx scripts/record-fixtures.ts
//
// Nimmt lesend einen Mandanten auf (bei uns der Demo-Mandant Nothing Toulouse) und legt geschwaerzte Fixtures
// unter tests/fixtures/ ab. Nur lesende Endpunkte (list / read / tree), nie schreibend.
// Die Fixtures sind der Feldnamen-Vertrag fuer die spaeteren Tasks: Feldnamen werden
// dort abgelesen, nicht geraten.
//
// Konsolenausgabe geht nach stderr — stdout gehoert dem Protokoll.
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { CashCtrlHttp } from '../src/core/http.js';
import { schwaerzen } from './schwaerzen.js';

if (process.env.CASHCTRL_LIVE !== '1') {
  console.error('Nur mit CASHCTRL_LIVE=1 — liest den Mandanten aus CASHCTRL_LIVE_SUBDOMAIN.');
  process.exit(1);
}

// Der Schluessel wird nur hier gelesen und nie ausgegeben, weder in Log noch in Fixture.
// Quelle wie in tests/live/mandant.ts: CASHCTRL_LIVE_SUBDOMAIN, dazu CASHCTRL_LIVE_API_KEY oder CASHCTRL_LIVE_KEYCHAIN
// (Dienstname in der macOS-Keychain, Account `api`).
const subdomain = process.env.CASHCTRL_LIVE_SUBDOMAIN;
const dienst = process.env.CASHCTRL_LIVE_KEYCHAIN;
const schluessel = process.env.CASHCTRL_LIVE_API_KEY
  ?? (dienst ? execFileSync('security', ['find-generic-password', '-s', dienst, '-a', 'api', '-w'], { encoding: 'utf8' }).trim() : undefined);
if (!subdomain || !schluessel) {
  console.error('CASHCTRL_LIVE_SUBDOMAIN und CASHCTRL_LIVE_API_KEY (oder CASHCTRL_LIVE_KEYCHAIN) setzen.');
  process.exit(1);
}

const http = new CashCtrlHttp({ subdomain, 'apiKey': schluessel, org: 'fixtures' });

const calls: [string, Record<string, unknown>][] = [
  ['person/list', { limit: 5 }], ['person/list', { query: 'Muster', limit: 5 }],
  ['inventory/article/list', { limit: 5 }], ['inventory/unit/list', {}],
  ['order/category/list', { type: 'SALES' }], ['order/category/list', { type: 'PURCHASE' }],
  ['order/list', { type: 'SALES', limit: 5 }], ['order/list', { type: 'SALES', onlyOpen: true, limit: 5 }], ['order/list', { type: 'PURCHASE', limit: 5 }],
  ['journal/list', { limit: 5 }], ['account/list', {}], ['account/category/tree', {}], ['fiscalperiod/list', {}], ['location/list', {}], ['account/bank/list', {}], ['tax/list', {}],
];

// Die Schwaerzung (IBAN/apiKey/password/ssn, API-Benutzer, Mailadressen) steht in
// scripts/schwaerzen.ts — dort auch direkt aufrufbar, um bestehende Fixtures neu zu schwaerzen.
const schreibe = async (name: string, body: unknown): Promise<void> => {
  await fs.writeFile(`tests/fixtures/${name}.json`, JSON.stringify(schwaerzen(body), null, 2) + '\n');
  console.error('aufgenommen:', name);
};

await fs.mkdir('tests/fixtures', { recursive: true });
for (const [ep, params] of calls) {
  const name = ep.replace(/\//g, '-') + (Object.keys(params).length ? '-' + Object.entries(params).map(([k, v]) => `${k}-${v}`).join('-') : '');
  await schreibe(name, await http.get(ep, params));
}

// Detailobjekte: erste ID je Liste
const firstId = async (ep: string, params: Record<string, unknown>): Promise<number | undefined> =>
  (await http.get<{ data: { id: number }[] }>(ep, params)).data[0]?.id;

const pid = await firstId('person/list', { limit: 1 });
if (pid) await schreibe('person-read', await http.get('person/read', { id: pid }));

const oid = await firstId('order/list', { type: 'SALES', limit: 1 });
if (oid) {
  await schreibe('order-read', await http.get('order/read', { id: oid }));
  await schreibe('order-document-read', await http.get('order/document/read', { id: oid }));
  // Der Binaerabruf ist der einzige Schritt, der scheitern darf, ohne die Aufnahme zu stoppen:
  // sein Ergebnis ist ein Befund (Spec 12, Annahme 2), keine Fixture-Datei.
  try {
    const pdf = await http.getBinary('order/document/read.pdf', { id: oid });
    console.error('PDF-Bytes:', pdf.length, 'Kopf:', Buffer.from(pdf.slice(0, 5)).toString());
  } catch (e) {
    console.error('PDF-Abruf gescheitert:', e instanceof Error ? e.message : String(e));
  }
}

const cats = await http.get<{ data: { id: number }[] }>('order/category/list', { type: 'SALES' });
if (cats.data[0]) await schreibe('order-category-read', await http.get('order/category/read', { id: cats.data[0].id }));
