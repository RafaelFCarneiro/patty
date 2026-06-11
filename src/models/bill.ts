import { z } from 'zod'
import { Id, IsoDate } from './common.js'

export const BillStatus = z.enum(['open', 'closed', 'paid'])
export type BillStatus = z.infer<typeof BillStatus>

/** A credit card fatura: groups the card's transactions for one cycle. */
export const Bill = z.object({
  id: Id,
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2100),
  closeDate: IsoDate,
  dueDate: IsoDate,
  status: BillStatus,
})
export type Bill = z.infer<typeof Bill>
