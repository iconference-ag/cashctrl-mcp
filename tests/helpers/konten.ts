import { readFileSync } from 'node:fs';

/**
 * `account/list` der Aufnahme (tests/fixtures/account-list.json) mit der Steuer an einzelnen Konten.
 * Die Aufnahme vom 28.08.2026 hat an allen Konten `taxId: null` und bleibt unveraendert (Feldnamen-Vertrag).
 * Dass ein Konto eine Steuer fuehrt, ist am Demo-Mandanten gemessen (M-1, 17.10.2026: `account/update`
 * mit `taxId` 9, danach `account/read` -> `taxId` 9); die Variante hier ist daraus abgeleitet.
 * `taxCode` an einem Konto mit Steuer ist ungemessen und bleibt `null`; der Server liest nur `taxId`.
 *
 * Vorgabe: Konto 3000 (id 15) fuehrt UN1 (id 9, 8.1 %), damit die Tests, die frueher die feste Vorgabe UN1
 * verwendeten, dieselbe Steuer ueber das Konto bekommen. Konto 3400 (id 43) bleibt ohne Steuer.
 */
export function kontenListe(steuer: Record<string, number | null> = { '3000': 9 }): string {
  const l = JSON.parse(readFileSync(new URL('../fixtures/account-list.json', import.meta.url), 'utf8')) as { data: Record<string, unknown>[] };
  for (const a of l.data) if (Object.hasOwn(steuer, String(a.number))) a.taxId = steuer[String(a.number)];
  return JSON.stringify(l);
}
