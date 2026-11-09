// scripts/katalog.ts: erzeugt src/catalog/endpoints.json aus der HTML-Fassung der CashCtrl-API-Doku.
//
// Aufruf (Pfad der HTML-Datei als Argument, optional der Zielpfad als zweites):
//   node_modules/.bin/tsx scripts/katalog.ts <api-doku.html> [ziel.json]
// Quelle: https://app.cashctrl.com/static/help/en/api/index.html (Fassung vom 24.10.2026).
//
// Uebernommen werden nur Pfad, Methode, Titel und die Parameter (Name, Pflicht, Datentyp, MAX).
// Beschreibungstexte der Doku werden bewusst NICHT uebernommen (Urheberrecht). Das Ergebnis
// liegt im Paket: zur Laufzeit braucht der Katalog kein Netz.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const QUELLE = 'https://app.cashctrl.com/static/help/en/api/index.html';
export const STAND = '2026-10-24';

// Nur der Typ: ein Laufzeit-Import wuerde endpoints.json laden, das dieses Skript erst erzeugt.
import type { Katalog, KatalogEndpunkt, KatalogParam } from '../src/catalog/katalog.js';

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
const entities = (s: string): string => s.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (m) => ENTITIES[m] ?? m);
const text = (s: string): string => entities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/**
 * Loest die obersten `<table>` aus einem Fragment heraus (Tiefenzaehlung, weil Parametertabellen
 * Untertabellen `parameters sub` tragen). Rueckgabe: das Fragment mit Marken `\u0000<n>\u0000` an
 * Stelle jeder Tabelle, dazu Tabellen (Oeffnungs-Tag und Inhalt).
 */
function tabellenLoesen(html: string): { rest: string; tabellen: { tag: string; inner: string }[] } {
  const tabellen: { tag: string; inner: string }[] = [];
  let rest = '';
  let letzte = 0; let tiefe = 0; let start = 0; let tagEnde = 0; let tag = '';
  for (const m of html.matchAll(/<table\b[^>]*>|<\/table>/g)) {
    if (m[0].startsWith('</')) {
      tiefe--;
      if (tiefe === 0) {
        tabellen.push({ tag, inner: html.slice(tagEnde, m.index) });
        rest += html.slice(letzte, start) + `\u0000${tabellen.length - 1}\u0000`;
        letzte = m.index + m[0].length;
      }
    } else {
      if (tiefe === 0) { start = m.index; tag = m[0]; tagEnde = m.index + m[0].length; }
      tiefe++;
    }
  }
  if (tiefe !== 0) throw new Error('Tabellen nicht ausgeglichen');
  return { rest: rest + html.slice(letzte), tabellen };
}

function parseParams(inner: string): KatalogParam[] {
  const { rest, tabellen } = tabellenLoesen(inner);
  const params: KatalogParam[] = [];
  for (const zeile of rest.split('</tr>')) {
    const name = /<code class="name mobile">([^<]*)<\/code>/.exec(zeile)?.[1];
    if (name === undefined) continue;
    const labels = /<div class="labels">((?:<div class="label[^"]*">[^<]*<\/div>)*)<\/div>/.exec(zeile)?.[1] ?? '';
    const werte = [...labels.matchAll(/<div class="label([^"]*)">([^<]*)<\/div>/g)].map((m) => ({ klasse: m[1].trim(), wert: m[2].trim() }));
    const max = werte.map((w) => /^MAX:(\d+)$/.exec(w.wert)).find(Boolean);
    const p: KatalogParam = {
      name: entities(name).trim(),
      required: werte.some((w) => w.klasse === 'mandatory'),
      type: werte.find((w) => w.klasse === 'datatype')?.wert ?? null,
      max: max ? Number(max[1]) : null,
    };
    // Untertabelle (JSON-Parameter wie `items`): die Felder der Elemente, ohne Beschreibungen.
    const marke = /\u0000(\d+)\u0000/.exec(zeile);
    if (marke) p.fields = parseParams(tabellen[Number(marke[1])].inner);
    params.push(p);
  }
  return params;
}

/** Parst die Doku. Wirft, wenn ein Abschnitt in sich nicht stimmig ist (Anker ≠ Endpunkt, doppelter Pfad). */
export function parseKatalog(html: string): Katalog {
  const endpunkte: KatalogEndpunkt[] = [];
  const gesehen = new Set<string>();
  // Jeder Abschnitt `<section class="action">` ... bis zum naechsten `<section`. Abschnitte ohne
  // `<div class="endpoint"> GET|POST /api/v1/...` sind Erlaeuterungen und fallen weg.
  const teile = html.split('<section class="action">').slice(1);
  for (const roh of teile) {
    const teil = roh.split(/<section\b/)[0];
    const ep = /<div class="endpoint">\s*(GET|POST)\s+\/api\/v1\/(\S+?)\s*<\/div>/.exec(teil);
    if (!ep) continue;
    const method = ep[1] as 'GET' | 'POST';
    const pfad = ep[2];
    const anker = /<a id="\/([^"]+)"><\/a>/.exec(teil)?.[1];
    if (anker !== pfad) throw new Error(`Anker ${anker ?? '(fehlt)'} passt nicht zum Endpunkt ${pfad}`);
    if (gesehen.has(pfad)) throw new Error(`Pfad doppelt: ${pfad}`);
    gesehen.add(pfad);
    const titel = /<h3>([\s\S]*?)<\/h3>/.exec(teil)?.[1];
    if (!titel) throw new Error(`Ueberschrift fehlt bei ${pfad}`);
    // Die oberste Parametertabelle des Abschnitts (nicht `parameters sub`).
    const oben = tabellenLoesen(teil).tabellen.find((t) => /class="parameters"/.test(t.tag));
    const params = oben ? parseParams(oben.inner) : [];
    endpunkte.push({ path: pfad, method, title: text(titel), area: pfad.split('/')[0], params });
  }
  return { stand: STAND, quelle: QUELLE, endpunkte };
}

// Direktaufruf (nicht beim Import als Modul).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const quelle = process.argv[2];
  if (!quelle) { console.error('Aufruf: tsx scripts/katalog.ts <api-doku.html> [ziel.json]'); process.exit(2); }
  const ziel = process.argv[3] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/catalog/endpoints.json');
  const katalog = parseKatalog(await fs.readFile(quelle, 'utf8'));
  await fs.mkdir(path.dirname(ziel), { recursive: true });
  await fs.writeFile(ziel, JSON.stringify(katalog, null, 1) + '\n');
  console.error(`katalog: ${katalog.endpunkte.length} Endpunkte nach ${ziel}`);
}
