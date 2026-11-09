import type { Rec } from '../../core/client.js';
import { CashCtrlError } from '../../core/errors.js';
import type { ToolContext } from '../context.js';
import { de } from '../result.js';

// `de()` lebt in ../result.js (Task 10) und wird hier weitergereicht: die Werkzeuge, die mit
// Kategorien und Status arbeiten, holen beides aus einer Datei.
export { de } from '../result.js';

export type CategoryKey = 'offer' | 'order_confirmation' | 'invoice' | 'purchase_invoice';
export interface StatusInfo { id: number; name: string; raw: Rec }
export interface CategoryInfo { id: number; key?: CategoryKey; name: string; type: 'SALES' | 'PURCHASE'; sentStatusId?: number; statuses: StatusInfo[] }

/**
 * Zuordnung ueber den deutschen Kategorienamen, nie ueber feste IDs — die IDs sind je Mandant
 * anders. Gemessen an tests/fixtures/order-category-list-type-{SALES,PURCHASE}.json:
 * SALES Offerte/Auftragsbestaetigung/Lieferschein/Rechnung/Zahlungserinnerung/Gutschrift,
 * PURCHASE Anfrage/Bestellung/Wareneingang/Rechnung/Gutschrift/Retourschein.
 */
function keyFor(name: string, type: 'SALES' | 'PURCHASE'): CategoryKey | undefined {
  const n = name.toLowerCase();
  if (type === 'SALES') {
    if (n.startsWith('offert')) return 'offer';
    if (n.startsWith('auftragsbest')) return 'order_confirmation';
    if (n.startsWith('rechnung')) return 'invoice';
  } else if (n.includes('rechnung')) return 'purchase_invoice';
  return undefined;
}

/**
 * Der Zwischenspeicher haengt am `ToolContext`, nicht am Modul: zwei Toolsets koennen denselben
 * Organisationsnamen auf verschiedene Subdomains zeigen lassen. Ein Modul-Singleton wuerde dann
 * fuenf Minuten lang Kategorie- und Status-IDs des einen Mandanten fuer den anderen ausgeben —
 * und die Tasks 15–19 schreiben aus genau diesen IDs. Die WeakMap gibt den Eintrag frei, sobald
 * der Kontext weg ist.
 */
const caches = new WeakMap<ToolContext, Map<string, { at: number; cats: CategoryInfo[] }>>();
const TTL_MS = 5 * 60 * 1000;

/**
 * Kategorien samt Statusliste, je Organisation und Typ fuenf Minuten im Speicher.
 * `order/category/list` traegt `status[]` bereits vollstaendig (tests/fixtures/README.md,
 * Abschnitt «order/category/read und order/category/list»); `order/category/read` wird nur
 * als Rueckfall gerufen, wenn die Liste ausnahmsweise kein `status[]` mitliefert. Das spart
 * je Kategorie einen Aufruf vom Monatskontingent.
 */
export async function loadCategories(ctx: ToolContext, org: string | undefined, type: 'SALES' | 'PURCHASE'): Promise<CategoryInfo[]> {
  const name = ctx.orgName(org);
  const k = `${name}:${type}`;
  let cache = caches.get(ctx);
  if (!cache) { cache = new Map(); caches.set(ctx, cache); }
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.cats;
  const c = ctx.client(name);
  const cats: CategoryInfo[] = [];
  for (const row of await c.listOrderCategories(type)) {
    const roh = (row.status as Rec[] | undefined) ?? ((await c.readOrderCategory(Number(row.id))).status as Rec[] | undefined) ?? [];
    const statuses = roh.map((s) => ({ id: Number(s.id), name: de(s.name), raw: s }));
    // Kategoriename ist `nameSingular` — ein Feld `name` traegt bei Kategorien etwas anderes.
    const n = de(row.nameSingular);
    // `sentStatusId` steht im Kategorie-Kopf (order/category/list und /read), nicht in status[] —
    // die von CashCtrl vorgesehene ID des Versandstatus dieser Kategorie (Vertrag: Fixture-Messung,
    // Offerte 2 -> 37 "Offen", Zahlungserinnerung 9 -> 30 "Versandt").
    const sentStatusId = typeof row.sentStatusId === 'number' ? row.sentStatusId : undefined;
    cats.push({ id: Number(row.id), key: keyFor(n, type), name: n, type, sentStatusId, statuses });
  }
  cache.set(k, { at: Date.now(), cats });
  return cats;
}

export function findCategory(cats: CategoryInfo[], key: CategoryKey): CategoryInfo {
  const c = cats.find((x) => x.key === key);
  if (!c) throw new CashCtrlError('validation', `Belegkategorie ${key} nicht gefunden. Vorhanden: ${cats.map((x) => x.name).join(', ')}`);
  return c;
}

/**
 * Status ueber den Namen: exakter Treffer zuerst, sonst der Praefix — aber nur, wenn der
 * Praefix genau einen trifft. «Erinnert» passt in der Rechnung auf «Erinnert 1» UND
 * «Erinnert 2»; still den ersten zu nehmen hiesse, einen Beleg auf einen Status zu setzen
 * (oder danach zu filtern), den niemand genannt hat. Der exakte Treffer sticht auch dann,
 * wenn er zugleich Praefix eines laengeren Namens ist.
 */
export function findStatus(cat: CategoryInfo, wanted: string): StatusInfo {
  const w = wanted.toLowerCase();
  const genau = cat.statuses.find((x) => x.name.toLowerCase() === w);
  if (genau) return genau;
  const praefix = cat.statuses.filter((x) => x.name.toLowerCase().startsWith(w));
  if (praefix.length > 1) throw new CashCtrlError('validation', `Status «${wanted}» ist in ${cat.name} mehrdeutig: ${praefix.map((x) => x.name).join(', ')} — vollen Namen angeben.`);
  if (praefix.length === 1) return praefix[0];
  throw new CashCtrlError('validation', `Status «${wanted}» gibt es in ${cat.name} nicht. Vorhanden: ${cat.statuses.map((x) => x.name).join(', ')}`);
}
