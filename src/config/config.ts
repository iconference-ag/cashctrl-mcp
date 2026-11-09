import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

export type Mode = 'read' | 'draft' | 'full';
/** `sendMail` optional statt Pflichtfeld: rund zwanzig Testdateien bauen `Config`-Literale ohne
 * Belegversand-Bezug — ein Pflichtfeld haette dort ueberall eine wirkungslose Ergaenzung erzwungen. */
export interface OrgConfig { name: string; subdomain: string; apiKey: string; sendMail?: boolean; deleteOrders?: boolean; salary?: boolean; deleteRecords?: boolean }
export interface Config { mode: Mode; pdfDir: string; usageFile: string; orgs: OrgConfig[]; source: 'file' | 'env' }

const ModeSchema = z.enum(['read', 'draft', 'full']);
/** Gilt fuer beide Pfade — Datei und Umgebung. Die Subdomain landet in der URL, sie muss eng geprueft sein. */
/**
 * Der Organisationsname wird als Verzeichnisname unter `pdfDir` verwendet (get_order_pdf) und muss
 * deshalb ein harmloses Pfadsegment sein. `.` und `..` bestehen den Zeichenfilter, bezeichnen aber
 * Verzeichnisse — sie sind hier ausgeschlossen. Der Filter in `orders.ts` bleibt als zweite Schicht.
 */
const NAME_REGEL = 'Organisationsname: nur Buchstaben, Ziffern, Punkt, Unterstrich, Bindestrich; nicht . oder ..';
const OrgSchema = z.object({
  name: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/, NAME_REGEL).refine((n) => n !== '.' && n !== '..', NAME_REGEL),
  subdomain: z.string().regex(/^[a-z0-9-]+$/, 'nur a-z, 0-9 und -'),
  'apiKey': z.string().min(1),
  // Opt-in Belegversand je Organisation (Entscheid 28.08.2026): fehlt das Feld, ist es false.
  sendMail: z.boolean().optional(),
  // Opt-in Loeschen ungebuchter Belege je Organisation (Entscheid 12.10.2026): fehlt das Feld, ist es false.
  deleteOrders: z.boolean().optional(),
  // Allgemeine Werkzeuge (0.4.0, Entscheid 24.10.2026), beide Standard aus: Lohn-Endpunkte
  // lesen und schreiben (`salary`, Personendaten der Mitarbeitenden); Loeschen jeder Art ueber
  // `api_write` (`deleteRecords`). Mail-Endpunkte brauchen den bestehenden Schalter `sendMail`.
  salary: z.boolean().optional(),
  deleteRecords: z.boolean().optional(),
});
const FileSchema = z.object({
  mode: ModeSchema.optional(),
  pdfDir: z.string().optional(),
  orgs: z.array(OrgSchema).min(1),
});
/**
 * Nimmt aus einer JSON.parse-Meldung hoechstens die Fundstelle mit — nie den zitierten Inhalt.
 * Gemessen an Node 24: genau die zitierende Variante ("Unexpected token 'S', ...\"apiKey\":X\"...")
 * nennt KEINE Position, die nicht-zitierende ("... at position 7 (line 1 column 8)") schon.
 */
function jsonStelle(e: unknown): string {
  const treffer = /position \d+(?: \(line \d+ column \d+\))?/i.exec((e as Error).message);
  return treffer ? ` an ${treffer[0].replace(/^position/i, 'Position')}` : ' — Inhalt wird nicht zitiert, Position meldet Node hier nicht';
}
const issueText = (e: z.ZodError) => e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');

export async function loadConfig(opts: { file?: string; env?: NodeJS.ProcessEnv; home?: string } = {}): Promise<Config> {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const file = opts.file ?? join(home, '.config/cashctrl-mcp/config.json');
  const usageFile = join(home, '.config/cashctrl-mcp/usage.json');
  const expand = (p: string) => (p.startsWith('~') ? join(home, p.slice(1)) : p);

  let fileText: string | undefined;
  try {
    fileText = await fs.readFile(file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw new Error(`Konfiguration nicht lesbar (${file}): ${code ?? (e as Error).message}`);
    fileText = undefined;
  }
  // Fuer den "beides"-Fehler zaehlt jede CASHCTRL_*-Variable, fuer "gar nichts" nur die beiden Pflichtvariablen.
  const envIrgendetwas = Boolean(env.CASHCTRL_API_KEY || env.CASHCTRL_SUBDOMAIN || env.CASHCTRL_MODE || env.CASHCTRL_PDF_DIR);
  const envKern = Boolean(env.CASHCTRL_API_KEY || env.CASHCTRL_SUBDOMAIN);

  if (fileText !== undefined && envIrgendetwas) throw new Error(`Konfiguration doppelt: entweder ${file} oder CASHCTRL_*-Umgebungsvariablen, nicht beides.`);
  if (fileText === undefined && !envKern) throw new Error(`Keine Konfiguration: ${file} anlegen (siehe README) oder CASHCTRL_SUBDOMAIN und CASHCTRL_API_KEY setzen.`);

  if (fileText !== undefined) {
    const st = await fs.stat(file);
    if ((st.mode & 0o077) !== 0) console.error(`[cashctrl-mcp] Warnung: ${file} ist für andere lesbar — bitte chmod 0600.`);
    let roh: unknown;
    try { roh = JSON.parse(fileText); } catch (e) { throw new Error(`Konfiguration ist kein gültiges JSON (${file})${jsonStelle(e)}.`); }
    const parsed = FileSchema.safeParse(roh);
    if (!parsed.success) {
      const modusSchuld = parsed.error.issues.some((i) => i.path[0] === 'mode');
      throw new Error(`Konfiguration ungültig (${file}): ${issueText(parsed.error)}${modusSchuld ? ' — Modus muss read, draft oder full sein.' : ''}`);
    }
    const names = new Set<string>();
    for (const o of parsed.data.orgs) { if (names.has(o.name)) throw new Error(`Organisation doppelt: ${o.name}`); names.add(o.name); }
    return { mode: parsed.data.mode ?? 'read', pdfDir: expand(parsed.data.pdfDir ?? '~/Downloads/cashctrl-mcp'), usageFile, orgs: parsed.data.orgs, source: 'file' };
  }
  const mode = ModeSchema.safeParse(env.CASHCTRL_MODE ?? 'read');
  if (!mode.success) throw new Error(`CASHCTRL_MODE ungültig — Modus muss read, draft oder full sein.`);
  if (!env.CASHCTRL_SUBDOMAIN || !env.CASHCTRL_API_KEY) throw new Error('CASHCTRL_SUBDOMAIN und CASHCTRL_API_KEY müssen beide gesetzt sein.');
  const org = OrgSchema.safeParse({
    name: env.CASHCTRL_SUBDOMAIN, subdomain: env.CASHCTRL_SUBDOMAIN, 'apiKey': env.CASHCTRL_API_KEY,
    sendMail: env.CASHCTRL_SEND_MAIL === '1',
    deleteOrders: env.CASHCTRL_DELETE_ORDERS === '1',
    salary: env.CASHCTRL_SALARY === '1',
    deleteRecords: env.CASHCTRL_DELETE_RECORDS === '1',
  });
  if (!org.success) throw new Error(`CASHCTRL_*-Umgebungsvariablen ungültig: ${issueText(org.error)}`);
  return {
    mode: mode.data, pdfDir: expand(env.CASHCTRL_PDF_DIR ?? '~/Downloads/cashctrl-mcp'), usageFile,
    orgs: [org.data], source: 'env',
  };
}
