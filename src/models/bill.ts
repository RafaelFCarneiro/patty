import { z } from 'zod';
import { IsoDate } from './date.js';
import { Id } from './id.js';
import type { ValidationError } from './error.js';
import type { LabelMap } from './locale.js';

export const BillStatus = z.enum(['open', 'closed', 'paid']);
export type BillStatus = z.infer<typeof BillStatus>;

export const billStatusLabels: LabelMap<BillStatus> = {
  open: { en: 'Open', pt: 'Aberta', es: 'Abierta' },
  closed: { en: 'Closed', pt: 'Fechada', es: 'Cerrada' },
  paid: { en: 'Paid', pt: 'Paga', es: 'Pagada' },
};

// `.describe()` is domain information — it states what each field is and represents.
export const BillSchema = z.object({
  id: Id,
  month: z.number().int().min(1).max(12).describe('Billing cycle month (1–12)'),
  year: z.number().int().min(2000).max(2100).describe('Billing cycle year'),
  closeDate: IsoDate.describe('Date the billing cycle closes'),
  dueDate: IsoDate.describe('Payment due date'),
  status: BillStatus.describe('open | closed | paid'),
  statusLabel: z.string().optional().describe('Localized status label'),
  paymentTransactionId: Id.optional().describe(
    'Id of the transfer transaction that paid this bill. Absent for open/closed bills, and for paid bills ' +
      'settled with a non-positive total (no transfer was created)',
  ),
});
export type Bill = z.infer<typeof BillSchema>;

// Internal persistence-side entity: `Bill` plus `version` and the credit-card FK (neither on the
// wire — mirrors `models/account.ts`'s `AccountEntitySchema` split).
export const RawBillSchema = BillSchema.extend({
  creditCardId: Id.describe('Owning credit card id; internal, never on wire/out'),
  version: z.number().int().nonnegative().describe('Optimistic-concurrency token; internal, never on wire/out'),
});
export type RawBill = z.infer<typeof RawBillSchema>;

// Mirrors `models/account.ts`'s `ACCOUNT_ENTITY_TAG`.
export const BILL_ENTITY_TAG = 'bill';

/** The bill entity's `Persistable` model — field names already match the `bills` table's drizzle
 *  column properties one-for-one, so only `INITIAL_VERSION` injection is needed on insert
 *  (`adapters/bills.ts`), no renaming. */
export type BillEntity = {
  id: string;
  creditCardId: string;
  month: number;
  year: number;
  closeDate: string;
  dueDate: string;
  status: BillStatus;
  paymentTransactionId?: string;
};

export const BillQuerySchema = z.object({
  card: z.string().min(1).describe('Credit card name'),
  month: BillSchema.shape.month,
  year: BillSchema.shape.year,
});
export type BillQuery = z.infer<typeof BillQuerySchema>;

export const PayBillSchema = BillQuerySchema.extend({
  account: z.string().min(1).optional().describe('Paying account name (overrides card default)'),
});
export type PayBill = z.infer<typeof PayBillSchema>;

export type BillError = { code: 'unknown_bill'; card: string; month: number; year: number } | ValidationError;

export const billErrors = {
  notFound: (card: string, month: number, year: number): BillError => ({
    code: 'unknown_bill',
    card,
    month,
    year,
  }),
  noPayingAccount: {
    code: 'validation',
    issues: ['no paying account: pass `account` or set `paymentAccount` on the card'],
  } satisfies BillError,
};
