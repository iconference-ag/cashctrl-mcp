import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CashCtrlError } from './errors.js';
import type { UsageStore } from './stores.js';

/**
 * Wartezeit zwischen zwei Lock-Versuchen, Gesamtfrist, und ab wann eine Lockdatei als verwaist gilt.
 * Die Wartefrist MUSS ueber der Stale-Grenze liegen: sonst gibt ein Wartender auf, bevor er eine
 * nach `kill -9` liegengebliebene Lockdatei ueberhaupt wegraeumen darf.
 */
const LOCK_POLL_MS = 25;
const LOCK_STALE_MS = 10000;
const LOCK_WAIT_MS = 12000;

/**
 * AGB Ziffer 6: 30'000 Anfragen pro Monat. Eine Zahl, eine Stelle — der Zaehler, der
 * Kontext und die Beschreibung des Werkzeugs `usage` lesen sie hier ab, damit keine
 * Kopie stehen bleibt, wenn CashCtrl das Kontingent aendert.
 */
export const MONATSLIMIT = 30000;

export interface UsageOptions { lockWaitMs?: number; lockStaleMs?: number }

export interface UsageState { month: string; calls: number; limit: number; percent: number; blocked: boolean; warning?: string }
type Store = Record<string, { month: string; calls: number }>;

/** Der Zustand aus Aufrufen und Monat, ohne Datei — auch fuer fremde Speicher (Desk, O125). */
export function zustandAus(calls: number, month: string, limit: number = MONATSLIMIT): UsageState {
  const percent = Math.round((calls / limit) * 100);
  const s: UsageState = { month, calls, limit, percent, blocked: calls >= limit };
  if (s.blocked) s.warning = `Monatskontingent von ${limit} Anfragen erreicht — Aufrufe bis zum Monatswechsel gesperrt.`;
  else if (percent >= 80) s.warning = `Achtung: ${percent} % des Monatskontingents (${calls}/${limit}) verbraucht.`;
  return s;
}

/** AGB Ziffer 6: 30'000 Anfragen pro Monat. Ab 80 % Hinweis, bei 100 % Stopp — lieber als ein gesperrtes Konto. */
export class UsageCounter implements UsageStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly lockWaitMs: number;
  private readonly lockStaleMs: number;
  constructor(private readonly file: string, private readonly limit = MONATSLIMIT, private readonly now: () => Date = () => new Date(), opts: UsageOptions = {}) {
    this.lockStaleMs = opts.lockStaleMs ?? LOCK_STALE_MS;
    this.lockWaitMs = opts.lockWaitMs ?? LOCK_WAIT_MS;
  }
  /** Monatsgrenze nach UTC — nicht nach lokaler Zeit; steht so in README «Grenzen» und Spec §9. */
  private month(): string { const d = this.now(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }
  /** Serialisiert alle load()/save()-Zugriffe dieser Instanz — record() und state() ueberlappen nie. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
  /**
   * Serialisiert load()+save() ueber Prozessgrenzen hinweg mit einer Lockdatei `<file>.lock`.
   * Ohne sie zaehlen zwei Server-Prozesse auf derselben usage.json ihre Aufrufe gegenseitig weg.
   * Zeitmessung bewusst mit der echten Uhr, nicht mit `this.now` — das ist die Testuhr fuer den Monat.
   */
  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = `${this.file}.lock`;
    await fs.mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.lockWaitMs;
    let handle: FileHandle | undefined;
    while (handle === undefined) {
      try {
        handle = await fs.open(lock, 'wx');
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const stale = await fs.stat(lock).then((st) => Date.now() - st.mtimeMs > this.lockStaleMs, () => false);
      if (stale) { await fs.rm(lock, { force: true }); continue; }
      if (Date.now() > deadline) throw new CashCtrlError('unknown', `Zähler gesperrt: ${lock} — läuft ein zweiter Server?`);
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
    try {
      return await fn();
    } finally {
      await handle.close().catch(() => undefined);
      await fs.rm(lock, { force: true }).catch(() => undefined);
    }
  }
  private async load(): Promise<Store> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch {
      return {};
    }
    try {
      return JSON.parse(raw) as Store;
    } catch (err) {
      console.error(`[cashctrl-mcp] usage.json unlesbar, Zähler beginnt neu: ${(err as Error).message}`);
      return {};
    }
  }
  private async save(s: Store): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }
  private toState(calls: number): UsageState { return zustandAus(calls, this.month(), this.limit); }
  async state(org: string): Promise<UsageState> {
    return this.locked(() => this.withFileLock(async () => {
      const s = await this.load(); const e = s[org];
      return this.toState(e && e.month === this.month() ? e.calls : 0);
    }));
  }
  async record(org: string): Promise<UsageState> {
    return this.locked(() => this.withFileLock(async () => {
      const s = await this.load(); const m = this.month();
      const e = s[org] && s[org].month === m ? s[org] : { month: m, calls: 0 };
      if (e.calls >= this.limit) throw new CashCtrlError('quota', this.toState(e.calls).warning!);
      e.calls += 1; s[org] = e; await this.save(s);
      return this.toState(e.calls);
    }));
  }
}
