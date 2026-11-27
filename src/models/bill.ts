import { z } from 'zod';
import { IsoDate } from './date.js';
import { Id } from './id.js';
import { withPersistenceMeta } from '@rfc0/effect-runner';
import { validationWithRemedy, type ValidationError } from './error.js';
import { Remedy } from './remedy.js';
import type { LabelMap } from './locale.js';
import { Money, type CurrencyCode } from './money.js';
import type { CreditCard } from './credit-card.js';
import type { RawTransactionView, TransactionEntity, TransactionSource, TransactionView } from './transaction.js';

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
});
export type Bill = z.infer<typeof BillSchema>;

export const BillPaymentSchema = z.object({
  id: Id.describe('Id of the payment transfer; the `paymentId` that undoes this payment'),
  date: IsoDate.describe('Date the payment occurred'),
  amount: Money.describe('Amount paid, in the card currency'),
  account: z.string().optional().describe('Name of the account the payment left'),
});
export type BillPayment = z.infer<typeof BillPaymentSchema>;

export const SettlementSchema = z.object({
  paidAmount: z.number().describe('Sum of the bill payments'),
  remaining: z.number().describe('Bill total minus paidAmount; what is still owed on this bill'),
  partiallyPaid: z.boolean().describe('True when part of the bill is paid and part remains'),
});
export type Settlement = z.infer<typeof SettlementSchema>;

export const SettledBillSchema = BillSchema.extend({
  ...SettlementSchema.shape,
  payments: z.array(BillPaymentSchema).describe('The bill payments, oldest first'),
  paymentTransactionId: Id.optional().describe(
    'Id of the latest payment transfer; absent without a payment. `payments` is the field to read',
  ),
});
export type SettledBill = z.infer<typeof SettledBillSchema>;

export type BillView = { bill: SettledBill; cardName: string; transactions: TransactionView[]; total: number };

// Internal persistence-side entity: `Bill` plus `version` and the credit-card FK (neither on the
// wire — mirrors `models/account.ts`'s `AccountEntitySchema` split).
export const RawBillSchema = withPersistenceMeta(BillSchema).extend({
  creditCardId: Id.describe('Owning credit card id; internal, never on wire/out'),
});
export type RawBill = z.infer<typeof RawBillSchema>;

// Mirrors `models/account.ts`'s `ACCOUNT_ENTITY_TAG`.
export const BILL_ENTITY_TAG = 'bill';

export type BillEntity = {
  id: string;
  creditCardId: string;
  month: number;
  year: number;
  closeDate: string;
  dueDate: string;
  status: BillStatus;
};

export const BillQuerySchema = z.object({
  card: z.string().min(1).describe('Credit card name'),
  month: BillSchema.shape.month,
  year: BillSchema.shape.year,
});
export type BillQuery = z.infer<typeof BillQuerySchema>;

export const RevertBillPaymentSchema = BillQuerySchema.extend({
  paymentId: Id.optional().describe(
    'The payment to undo (see `payments` on the bill); required when the bill has several. One that is not, or no longer, a payment of the bill changes nothing',
  ),
});
export type RevertBillPayment = z.infer<typeof RevertBillPaymentSchema>;

export const PayBillSchema = BillQuerySchema.extend({
  amount: Money.optional().describe('Amount to pay now (defaults to what remains on the bill)'),
  account: z.string().min(1).optional().describe('Paying account name (overrides card default)'),
  paymentDate: IsoDate.optional().describe('Date the payment occurred (defaults to today); must not be in the future'),
  discriminator: z
    .string()
    .min(1)
    .optional()
    .describe('Tells two genuinely distinct payments apart when bill, date and amount are the same'),
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
  futurePaymentDate: (date: string): BillError => ({
    code: 'validation',
    issues: [`payment date ${date} is in the future: a bill payment records a payment that already occurred`],
  }),
  amountBelowPrecision: {
    code: 'validation',
    issues: ["amount is below the card currency's smallest unit"],
  } satisfies BillError,
  amountExceedsRemaining: (remaining: number): BillError => ({
    code: 'validation',
    issues: [`amount exceeds what remains on the bill (${remaining})`],
  }),
  paymentIdRequired: (ids: readonly string[]): BillError => ({
    code: 'validation',
    issues: [`the bill has several payments: pass \`paymentId\` — one of ${ids.join(', ')}`],
  }),
  totalBelowPaid: (paidAmount: number): BillError =>
    validationWithRemedy(
      `the change would bring the bill total below what is already paid (${paidAmount})`,
      Remedy.enum.revert_bill_payment,
    ),
};

export type BillPeriod = { month: number; year: number; closeDate: string; dueDate: string };

export type BillPaymentFacts = {
  id: string;
  card: { name: string; currency: CurrencyCode; accountId: string };
  payer: { id: string };
  bill: Pick<RawBill, 'id' | 'month' | 'year'>;
  amount: number;
  decimals: number;
  discriminator?: string;
  date: string;
  today: string;
  source: TransactionSource;
};

export type BillPaymentPlan = { transferEntity: TransactionEntity; idempotencyKey: string };

export type PayBillInput = PayBill & { source: TransactionSource };

export type BillTotalChange = {
  removedId?: string;
  added?: Pick<TransactionView, 'type' | 'amount'>;
  addedKey?: string;
};

export type BillContext = {
  card: CreditCard;
  existing: { bill: Bill; transactions: RawTransactionView[] };
  decimals: number;
  current: SettledBill;
  total: number;
  rawBill: RawBill;
};
