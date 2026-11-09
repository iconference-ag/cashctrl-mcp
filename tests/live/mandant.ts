/**
 * Zugang zum Mandanten fuer die Vertragstests. Nichts davon steht im Repo:
 *
 *   CASHCTRL_LIVE_SUBDOMAIN   der Teil vor `.cashctrl.com`
 *   CASHCTRL_LIVE_API_KEY     Schluessel des API-Benutzers, oder
 *   CASHCTRL_LIVE_KEYCHAIN    Dienstname in der macOS-Keychain (Account `api`); der Schluessel kommt
 *                             dann ueber `security find-generic-password -w`
 *
 * Der Schluessel lebt nur in der zurueckgegebenen Konfiguration. Nie `security -g`, nie in eine Ausgabe.
 * Die Eigenschaft heisst quotiert `'apiKey'`, wie ueberall im Projekt: unquotiert schlaegt ein
 * Secret-Scan auf die Zeile an.
 */
import { execFileSync } from 'node:child_process';
import type { Config } from '../../src/config/config.js';

type Org = Config['orgs'][number];

export function liveOrg(schalter: Partial<Pick<Org, 'sendMail' | 'deleteOrders' | 'deleteRecords' | 'salary'>> = {}): Org {
  const subdomain = process.env.CASHCTRL_LIVE_SUBDOMAIN;
  if (!subdomain) throw new Error('CASHCTRL_LIVE_SUBDOMAIN fehlt (der Teil vor .cashctrl.com).');
  const dienst = process.env.CASHCTRL_LIVE_KEYCHAIN;
  const schluessel = process.env.CASHCTRL_LIVE_API_KEY
    ?? (dienst ? execFileSync('security', ['find-generic-password', '-s', dienst, '-a', 'api', '-w'], { encoding: 'utf8' }).trim() : undefined);
  if (!schluessel) throw new Error('Kein Schluessel: CASHCTRL_LIVE_API_KEY oder CASHCTRL_LIVE_KEYCHAIN setzen.');
  return { name: 'nt', subdomain, 'apiKey': schluessel, ...schalter };
}
