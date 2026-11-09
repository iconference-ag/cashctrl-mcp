import { z } from 'zod';
import type { ToolContext } from '../context.js';
import type { ToolModule } from '../def.js';
import { CashCtrlError } from '../../core/errors.js';
import { round2 } from '../../core/money.js';
import { de, OrgParam, IsoDatum } from '../result.js';
import { twoPhaseTools } from '../twophase.js';
import { findStatus } from '../read/categories.js';
import { categoryOfOrder } from './status.js';

/**
 * Reine Rechnung ueber Vorgabewert und Teilzahlung. `open`/`amount` kaufmaennisch auf zwei
 * Dezimalen gerundet, damit ein Rappen-Rest aus dem Beleg keine falsche Teilzahlung meldet.
 */
export function paymentPlan(order: { open: unknown; total: unknown }, amount?: number) {
  const open = round2(Number(order.open ?? 0));
  if (open <= 0) throw new CashCtrlError('validation', 'Auf diesem Beleg ist nichts offen.');
  const a = round2(amount ?? open);
  if (a <= 0) throw new CashCtrlError('validation', 'Betrag muss grösser als 0 sein.');
  if (a > open + 0.005) throw new CashCtrlError('validation', `Betrag ${a.toFixed(2)} liegt über dem offenen Betrag ${open.toFixed(2)}.`);
  const remaining = round2(open - a);
  return { amount: a, remaining, partial: remaining > 0 };
}

const Input = z.object({
  org: OrgParam,
  orderId: z.number().int(),
  amount: z.number().positive().optional().describe('Standard: offener Betrag'),
  date: IsoDatum,
  bankAccountId: z.number().int().optional().describe('Standard: erstes Bankkonto'),
});
interface Payload { orderId: number; amount: number; date: string; accountId: number; paidStatusId?: number; partial: boolean; nr: unknown }

export const paymentModule: ToolModule = {
  tools(ctx: ToolContext) {
    return twoPhaseTools<typeof Input, Payload>(ctx, 'full', {
      kind: 'payment', title: 'Zahlung erfassen', destructive: true, input: Input,
      description: 'Bereitet eine Zahlung auf einen Beleg vor: Betrag (Standard offener Betrag), Datum, Bankkonto; setzt nach dem Buchen den Status Bezahlt, wenn nichts mehr offen ist.',
      async prepare(c, a) {
        const client = c.client(a.org);
        const o = await client.readOrder(a.orderId);
        const plan = paymentPlan(o as { open: unknown; total: unknown }, a.amount);
        const banks = await client.listBankAccounts();
        const bank = a.bankAccountId ? banks.find((b) => Number(b.id) === a.bankAccountId) : banks[0];
        if (!bank) throw new CashCtrlError('validation', `Bankkonto nicht gefunden. Vorhanden: ${banks.map((b) => `${b.id} ${de(b.name)}`).join(', ')}`);
        // `bank.id` ist die ID des Bankkonto-Datensatzes, `bank.accountId` die Buchungskonto-ID
        // (order/bookentry/create erwartet Letztere — Vertrag: tests/fixtures/README.md, account/bank/list).
        if (bank.accountId === null || bank.accountId === undefined) throw new CashCtrlError('validation', `Bankkonto ${de(bank.name)} ist mit keinem Konto verknüpft.`);
        const accountId = Number(bank.accountId);
        const cat = await categoryOfOrder(c, a.org, Number(o.categoryId));
        let paidStatusId: number | undefined;
        const warnings: string[] = [];
        try { paidStatusId = findStatus(cat, 'Bezahlt').id; } catch { warnings.push(`Kategorie ${cat.name} kennt keinen Status «Bezahlt» — Status bleibt unverändert.`); }
        if (plan.partial) warnings.push(`Teilzahlung: danach bleiben ${plan.remaining.toFixed(2)} offen, Status bleibt.`);
        return {
          summary: `Zahlung ${plan.amount.toFixed(2)} auf ${cat.name} ${o.nr ?? a.orderId} am ${a.date} über ${de(bank.name)} erfassen in ${c.orgName(a.org)}`,
          warnings,
          payload: { orderId: a.orderId, amount: plan.amount, date: a.date, accountId, paidStatusId, partial: plan.partial, nr: o.nr },
        };
      },
      async commit(c, org, p) {
        const client = c.client(org);
        // Gemessene Falle: bookentry/create setzt den Status nicht — erst danach nachlesen und
        // nur bei open <= 0 den Status «Bezahlt» setzen; Teilzahlung laesst den Status stehen.
        await client.createOrderBookEntry({ orderIds: [p.orderId], accountId: p.accountId, amount: p.amount, date: p.date });
        const after = await client.readOrder(p.orderId);
        const open = round2(Number(after.open ?? 0));
        if (open <= 0 && p.paidStatusId) await client.updateOrderStatus({ ids: [p.orderId], statusId: p.paidStatusId });
        const final = await client.readOrder(p.orderId);      // Endzustand nachlesen, nicht dem Rueckgabewert glauben
        return {
          orderId: p.orderId, nr: p.nr, paid: p.amount, open, status: de(final.statusName),
          message: open <= 0 ? 'Zahlung gebucht, Beleg bezahlt.' : `Zahlung gebucht, noch ${open.toFixed(2)} offen.`,
        };
      },
    });
  },
};
