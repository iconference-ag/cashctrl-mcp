import { z } from 'zod';
import type { ToolContext } from '../context.js';
import type { ToolModule } from '../def.js';
import { CashCtrlError } from '../../core/errors.js';
import { round2 } from '../../core/money.js';
import { OrgParam, IsoDatum } from '../result.js';
import { resolveAccount } from '../accounts.js';
import { twoPhaseTools } from '../twophase.js';

/**
 * Prueft, dass ein Datum in ein offenes Geschaeftsjahr faellt. Feldnamen laut
 * tests/fixtures/README.md, Abschnitt fiscalperiod/list: `start`/`end` kommen als
 * "2026-01-01 00:00:00.0" — auf die ersten 10 Zeichen (das reine Datum) normiert.
 * Exportiert, weil es unabhaengig von Kontoaufloesung/Steuer pruefbar ist (Vertragstest).
 */
export function checkPeriod(periods: { id: unknown; start: unknown; end: unknown; isClosed: unknown }[], date: string): { id: number } {
  const p = periods.find((x) => String(x.start).slice(0, 10) <= date && date <= String(x.end).slice(0, 10));
  if (!p) throw new CashCtrlError('validation', `Für ${date} gibt es kein Geschäftsjahr.`);
  if (p.isClosed) throw new CashCtrlError('validation', `Das Geschäftsjahr für ${date} ist abgeschlossen.`);
  return { id: Number(p.id) };
}

const Input = z.object({
  org: OrgParam,
  date: IsoDatum,
  title: z.string().min(1).max(250),
  debitAccount: z.string().describe('Kontonummer Soll, z.B. 1020'),
  creditAccount: z.string().describe('Kontonummer Haben, z.B. 3000'),
  amount: z.number().positive(),
  taxCode: z.string().optional(),
  reference: z.string().max(100).optional(),
});
interface Payload { dateAdded: string; title: string; debitId: number; creditId: number; amount: number; taxId?: number; reference?: string }

export const journalModule: ToolModule = {
  tools(ctx: ToolContext) {
    return twoPhaseTools<typeof Input, Payload>(ctx, 'full', {
      kind: 'journal_entry', title: 'Buchung anlegen', destructive: true, input: Input,
      description: 'Bereitet eine manuelle Buchung vor: Soll- und Habenkonto per Kontonummer, Betrag, Datum im offenen Geschäftsjahr, optional Steuercode und Beleg-Referenz.',
      async prepare(c, a) {
        const client = c.client(a.org);
        if (a.debitAccount === a.creditAccount) throw new CashCtrlError('validation', 'Soll- und Habenkonto müssen verschieden sein.');
        checkPeriod(await client.listFiscalPeriods() as { id: unknown; start: unknown; end: unknown; isClosed: unknown }[], a.date);
        const accounts = await client.listAccounts({}) as { id: unknown; number: unknown; name: unknown }[];
        const debit = resolveAccount(accounts, a.debitAccount);
        const credit = resolveAccount(accounts, a.creditAccount);
        let taxId: number | undefined;
        if (a.taxCode) {
          const taxes = await client.listTaxes();
          const t = taxes.find((x) => String(x.code).toLowerCase() === a.taxCode!.toLowerCase());
          if (!t) throw new CashCtrlError('validation', `Steuercode ${a.taxCode} unbekannt. Vorhanden: ${taxes.map((x) => String(x.code)).join(', ')}`);
          taxId = Number(t.id);
        }
        const amount = round2(a.amount);
        return {
          summary: `Buchung ${a.date} in ${c.orgName(a.org)}: ${debit.number} ${debit.name} an ${credit.number} ${credit.name}, ${amount.toFixed(2)}${a.taxCode ? ' ' + a.taxCode : ''} — «${a.title}»${a.reference ? ' (Beleg ' + a.reference + ')' : ''}`,
          warnings: [],
          payload: { dateAdded: a.date, title: a.title, debitId: debit.id, creditId: credit.id, amount, taxId, reference: a.reference },
        };
      },
      async commit(c, org, p) {
        const r = await c.client(org).createJournalEntry(p);
        return { id: r.insertId, message: `Buchung angelegt (ID ${r.insertId}).` };
      },
    });
  },
};
