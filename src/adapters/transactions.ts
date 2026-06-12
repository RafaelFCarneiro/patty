import type { Account } from '../models/account.js'
import type { CreateTransferInput, TransactionSource } from '../models/transaction.js'

type TransferCreateProps = {
  id: string
  description: string
  amount: number
  type: 'transfer'
  date: string
  currency: string
  source: TransactionSource
  idempotencyKey: string
  classificationMethod: 'none'
  confidence: number
  rawInput: null
}

type TransferWireIn = {
  id: string
  date: string
  input: CreateTransferInput
  from: Account
  to: Account
  source: TransactionSource
}

/** Wire-in adapter: transfer input + resolved refs => Transaction create props. Pure. */
export const toTransferCreateProps = ({
  id,
  date,
  input,
  from,
  to,
  source,
}: TransferWireIn): TransferCreateProps => ({
  id,
  description: input.description ?? `Transferência: ${from.name} → ${to.name}`,
  amount: input.amount,
  type: 'transfer',
  date,
  currency: from.currency,
  source,
  idempotencyKey: input.idempotencyKey,
  classificationMethod: 'none',
  confidence: 0,
  rawInput: null,
})
