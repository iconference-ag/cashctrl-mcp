import { describe, it, expect } from 'vitest';
import { KATALOG, einordnen, endpunktFinden, ohneJson, paramsPruefen } from '../../src/catalog/katalog.js';
import { parseKatalog } from '../../scripts/katalog.js';

/**
 * Katalog der CashCtrl-API (0.4.0). Die Zahlen sind am Original (API-Doku vom 24.10.2026) gezaehlt
 * (Auftrag, Abschnitt 1) und hier am erzeugten `src/catalog/endpoints.json` nachgemessen.
 */
const e = KATALOG.endpunkte;
const endung = (p: string) => /\.([a-z]+)$/.exec(p.split('/').pop() ?? '')?.[1] ?? '';

describe('Katalog: Zahlen aus der Doku', () => {
  it('376 Endpunkte, alle Pfade eindeutig, Stand und Quelle gesetzt', () => {
    expect(e).toHaveLength(376);
    expect(new Set(e.map((x) => x.path)).size).toBe(376);
    expect(KATALOG.stand).toBe('2026-10-24');
    expect(KATALOG.quelle).toBe('https://app.cashctrl.com/static/help/en/api/index.html');
  });
  it('184 GET, 192 POST; alle POST enden auf .json', () => {
    expect(e.filter((x) => x.method === 'GET')).toHaveLength(184);
    expect(e.filter((x) => x.method === 'POST')).toHaveLength(192);
    expect(e.filter((x) => x.method === 'POST' && !x.path.endsWith('.json'))).toEqual([]);
  });
  it('GET: 119 mit .json, 65 mit anderem Format oder ohne Endung (pdf 19, xlsx 15, csv 15, zip 3, vcf/html/xml je 1, ohne Endung 10)', () => {
    const get = e.filter((x) => x.method === 'GET');
    expect(get.filter((x) => endung(x.path) === 'json')).toHaveLength(119);
    const andere = get.filter((x) => endung(x.path) !== 'json');
    expect(andere).toHaveLength(65);
    const je: Record<string, number> = {};
    for (const x of andere) je[endung(x.path) || '(ohne)'] = (je[endung(x.path) || '(ohne)'] ?? 0) + 1;
    expect(je).toEqual({ pdf: 19, xlsx: 15, csv: 15, zip: 3, vcf: 1, html: 1, xml: 1, '(ohne)': 10 });
  });
  it('44 POST auf /delete.json, 90 Pfade mit salary/, 3 Pfade auf /mail.json', () => {
    expect(e.filter((x) => x.method === 'POST' && x.path.endsWith('/delete.json'))).toHaveLength(44);
    expect(e.filter((x) => x.path.startsWith('salary/'))).toHaveLength(90);
    expect(e.filter((x) => x.path.endsWith('/mail.json')).map((x) => x.path).sort()).toEqual(['order/document/mail.json', 'salary/certificate/document/mail.json', 'salary/document/mail.json']);
  });
  it('jeder Eintrag hat Titel, Bereich = erstes Pfadsegment und gueltige Parameter; keine Beschreibungstexte', () => {
    for (const x of e) {
      expect(x.title, x.path).not.toBe('');
      expect(x.area, x.path).toBe(x.path.split('/')[0]);
      expect(Object.keys(x).sort(), x.path).toEqual(['area', 'method', 'params', 'path', 'title']);
      for (const p of x.params) {
        expect(typeof p.name, x.path).toBe('string');
        expect(typeof p.required, x.path).toBe('boolean');
        expect(p.max === null || Number.isInteger(p.max), `${x.path}:${p.name}`).toBe(true);
      }
    }
  });
  it('Parameter am Beispiel order/create.json: Pflicht, Typ, MAX und die Felder der JSON-Liste items (nicht nur die ersten fuenf)', () => {
    const o = endpunktFinden('order/create.json')!;
    expect(o.params.filter((p) => p.required).map((p) => p.name)).toEqual(['associateId', 'categoryId', 'date']);
    expect(o.params.find((p) => p.name === 'description')).toMatchObject({ type: 'TEXT', max: 200, required: false });
    expect(o.params.find((p) => p.name === 'associateId')).toMatchObject({ type: 'CSV', required: true });
    const items = o.params.find((p) => p.name === 'items')!;
    expect(items.type).toBe('JSON');
    expect(items.fields!.filter((f) => f.required).map((f) => f.name)).toEqual(['accountId', 'name', 'unitPrice']);
    expect(o.params.map((p) => p.name)).toEqual(expect.arrayContaining(['statusId', 'startDate', 'sequenceNumberId']));
  });
});

describe('Katalog: Einordnung aus Methode und Pfad (deterministisch)', () => {
  it('lesend = GET, schreibend = POST, Loeschen = POST auf /delete.json', () => {
    expect(einordnen({ method: 'GET', path: 'person/list.json' })).toEqual({ art: 'read', gates: [] });
    expect(einordnen({ method: 'POST', path: 'person/create.json' })).toEqual({ art: 'write', gates: [] });
    expect(einordnen({ method: 'POST', path: 'person/title/delete.json' })).toEqual({ art: 'delete', gates: ['deleteRecords'] });
  });
  it('Lohn = salary/ (lesend wie schreibend), Mail = /mail.json; Ueberlagerungen brauchen beide Schalter', () => {
    expect(einordnen({ method: 'GET', path: 'salary/payment/download' })).toEqual({ art: 'read', gates: ['salary'] });
    expect(einordnen({ method: 'POST', path: 'salary/status/create.json' })).toEqual({ art: 'write', gates: ['salary'] });
    expect(einordnen({ method: 'POST', path: 'order/document/mail.json' })).toEqual({ art: 'write', gates: ['sendMail'] });
    expect(einordnen({ method: 'POST', path: 'salary/status/delete.json' })).toEqual({ art: 'delete', gates: ['salary', 'deleteRecords'] });
    expect(einordnen({ method: 'POST', path: 'salary/document/mail.json' })).toEqual({ art: 'write', gates: ['salary', 'sendMail'] });
  });
  it('am ganzen Katalog: jeder Lohn-Pfad traegt salary, jeder /delete.json-POST deleteRecords, jeder /mail.json sendMail; kein GET traegt deleteRecords oder sendMail', () => {
    for (const x of e) {
      const { art, gates } = einordnen(x);
      expect(gates.includes('salary'), x.path).toBe(x.path.startsWith('salary/'));
      const loescht = x.method === 'POST' && (x.path.endsWith('/delete.json') || x.path === 'file/empty_archive.json');
      expect(gates.includes('deleteRecords'), x.path).toBe(loescht);
      expect(gates.includes('sendMail'), x.path).toBe(x.path.endsWith('/mail.json'));
      expect(art, x.path).toBe(x.method === 'GET' ? 'read' : loescht ? 'delete' : 'write');
    }
    expect(e.filter((x) => einordnen(x).art === 'delete')).toHaveLength(45);
    // Leert das Dateiarchiv endgueltig, heisst aber nicht /delete.json (24.10.2026).
    expect(einordnen({ path: 'file/empty_archive.json', method: 'POST' })).toEqual({ art: 'delete', gates: ['deleteRecords'] });
    expect(e.filter((x) => einordnen(x).gates.length > 1).map((x) => x.path)).toHaveLength(13);
  });
});

describe('Katalog: Suche und Parameterpruefung', () => {
  it('endpunktFinden: genauer Pfad, sonst mit .json, fuehrender Schraegstrich egal; Unbekanntes bleibt unbekannt', () => {
    expect(endpunktFinden('person/list.json')?.path).toBe('person/list.json');
    expect(endpunktFinden('person/list')?.path).toBe('person/list.json');
    expect(endpunktFinden('/person/list.json')?.path).toBe('person/list.json');
    expect(endpunktFinden('account/balance')?.path).toBe('account/balance');
    expect(endpunktFinden('order/document/read.pdf')?.path).toBe('order/document/read.pdf');
    expect(endpunktFinden('person/gibtsnicht.json')).toBeUndefined();
    expect(endpunktFinden('../etc/passwd')).toBeUndefined();
    expect(endpunktFinden('')).toBeUndefined();
  });
  it('ohneJson entfernt nur die Endung .json', () => {
    expect(ohneJson('person/list.json')).toBe('person/list');
    expect(ohneJson('order/document/read.pdf')).toBe('order/document/read.pdf');
    expect(ohneJson('account/balance')).toBe('account/balance');
  });
  it('paramsPruefen: unbekannte Namen und fehlende Pflichtparameter werden abgewiesen; null und leerer Text gelten als fehlend, false und 0 nicht', () => {
    const lesen = endpunktFinden('person/read.json')!;
    expect(() => paramsPruefen(lesen, { id: 1, zusatz: 'x' })).toThrow(/Unbekannte Parameter.*zusatz/);
    expect(() => paramsPruefen(lesen, {})).toThrow(/Pflichtparameter fehlen.*id/);
    expect(() => paramsPruefen(lesen, undefined)).toThrow(/Pflichtparameter fehlen.*id/);
    expect(() => paramsPruefen(lesen, { id: '' })).toThrow(/Pflichtparameter/);
    expect(() => paramsPruefen(lesen, { id: null })).toThrow(/Pflichtparameter/);
    expect(paramsPruefen(lesen, { id: 0 })).toEqual({ id: 0 });
    expect(paramsPruefen(endpunktFinden('person/list.json')!, { onlyCustomers: false })).toEqual({ onlyCustomers: false });
    expect(() => paramsPruefen(lesen, JSON.parse('{"id":1,"__proto__":{"x":1},"constructor":2}'))).toThrow(/Unbekannte Parameter/);
  });
  it('paramsPruefen: eine Liste bei einem CSV-Parameter wird mit Komma verbunden (nicht als [7,8] kodiert); Objekte in der Liste werden abgewiesen', () => {
    const del = endpunktFinden('person/title/delete.json')!;
    expect(paramsPruefen(del, { ids: [7, 8, '9'] })).toEqual({ ids: '7,8,9' });
    expect(paramsPruefen(del, { ids: '7,8' })).toEqual({ ids: '7,8' });
    expect(() => paramsPruefen(del, { ids: [{ a: 1 }] })).toThrow(/CSV/);
    // JSON-Parameter bleiben Objekte/Listen und werden unveraendert weitergereicht (die HTTP-Schicht kodiert sie).
    const liste = [{ comparison: 'like', field: 'name', value: 'x' }];
    expect(paramsPruefen(endpunktFinden('person/list.json')!, { filter: liste })).toEqual({ filter: liste });
  });
});

describe('scripts/katalog.ts: Generator', () => {
  const html = (inner: string) => `<section class="controller"><section class="action">${inner}</section></section>`;
  const abschnitt = (pfad: string, methode: string, titel: string, tabelle: string) => `
    <a id="/${pfad}"></a><h3>${titel}</h3>${tabelle}<div class="endpoint">
      ${methode} /api/v1/${pfad}
    </div>`;
  const zeile = (name: string, labels: string, sub = '') => `<tr><th><code>${name}</code></th><td><code class="name mobile">${name}</code><div class="labels">${labels}</div><p>Beschreibung, die nicht in den Katalog gehoert.</p>${sub}</td></tr>`;
  const tabelle = (zeilen: string, klasse = 'parameters') => `<table class="${klasse}">${zeilen}</table>`;
  const PFLICHT = '<div class="label mandatory">mandatory</div><div class="label datatype">NUMBER</div>';
  const OPT = '<div class="label">optional</div><div class="label datatype">TEXT</div><div class="label">MAX:50</div>';

  it('liest Pfad, Methode, Titel (Entities aufgeloest), Pflicht, Typ, MAX; ueberspringt Abschnitte ohne Endpunkt; Beschreibungen fehlen im Ergebnis', () => {
    const k = parseKatalog(html(abschnitt('a/read.json', 'GET', 'Read &amp; more', tabelle(zeile('id', PFLICHT) + zeile('name', OPT)))) + '<section class="action"><h3>Nur Text</h3></section>');
    expect(k.endpunkte).toEqual([{ path: 'a/read.json', method: 'GET', title: 'Read & more', area: 'a', params: [
      { name: 'id', required: true, type: 'NUMBER', max: null },
      { name: 'name', required: false, type: 'TEXT', max: 50 },
    ] }]);
    expect(JSON.stringify(k)).not.toContain('Beschreibung');
  });
  it('Untertabellen (parameters sub) bleiben dem JSON-Parameter zugeordnet und verdecken die folgenden obersten Parameter nicht', () => {
    const sub = tabelle(zeile('accountId', PFLICHT) + zeile('tief', OPT, tabelle(zeile('x', PFLICHT), 'parameters sub')), 'parameters sub');
    const k = parseKatalog(html(abschnitt('o/create.json', 'POST', 'Create', tabelle(
      zeile('first', PFLICHT) + zeile('items', '<div class="label">optional</div><div class="label datatype">JSON</div>', sub) + zeile('last', OPT),
    ))));
    const p = k.endpunkte[0].params;
    expect(p.map((x) => x.name)).toEqual(['first', 'items', 'last']);
    expect(p[1].fields!.map((x) => x.name)).toEqual(['accountId', 'tief']);
    expect(p[1].fields![1].fields!.map((x) => x.name)).toEqual(['x']);
  });
  it('wirft bei doppeltem Pfad und bei einem Anker, der nicht zum Endpunkt passt', () => {
    const a = abschnitt('a/read.json', 'GET', 'A', '');
    expect(() => parseKatalog(html(a) + html(a))).toThrow(/doppelt/);
    expect(() => parseKatalog(html(a.replace('<a id="/a/read.json">', '<a id="/b/read.json">')))).toThrow(/Anker/);
  });
});
