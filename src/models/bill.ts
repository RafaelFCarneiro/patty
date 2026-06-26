import { z } from 'zod'
import { Id, IsoDate } from './common.js'
import type { ValidationError } from './error.js'
import type { LabelMap } from './locale.js'

export const BillStatus = z.enum(['open', 'closed', 'paid'])
export type BillStatus = z.infer<typeof BillStatus>

export const billStatusLabels: LabelMap<BillStatus> = {
  open:   { en: 'Open',   pt: 'Aberta',  es: 'Abierta' },
  closed: { en: 'Closed', pt: 'Fechada', es: 'Cerrada' },
  paid:   { en: 'Paid',   pt: 'Paga',    es: 'Pagada' },
}

/** A credit card fatura: groups the card's transactions for one cycle. */
export const Bill = z.object({
  id: Id,
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2100),
  closeDate: IsoDate,
  dueDate: IsoDate,
  status: BillStatus,
  statusLabel: z.string().optional(),
})
export type Bill = z.infer<typeof Bill>

export type BillError =
  | { code: 'unknown_bill'; card: string; month: number; year: number }
  | ValidationError

export const billErrors = {
  notFound: (card: string, month: number, year: number): BillError => ({
    code: 'unknown_bill', card, month, year,
  }),
  noPayingAccount: {
    code: 'validation',
    issues: ['no paying account: pass `account` or set `paymentAccount` on the card'],
  } satisfies BillError,
}
