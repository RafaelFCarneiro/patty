import { err, ok, type Result } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { toIsoDate } from '../logic/period.js'
import { resolveByName } from '../logic/resolve.js'
import type { Account } from '../models/account.js'
import type { CreateTransferInput, Transaction } from '../models/transaction.js'
import type { Deps } from './deps.js'

const resolveAccount = (accounts: Account[], name: string): Result<Account, AppError> => {
  const res = resolveByName(accounts, name)
  if (res.kind === 'none') return err({ code: 'unknown_account', query: res.query, candidates: res.candidates })
  if (res.kind === 'ambiguous')
    return err({ code: 'ambiguous_account', query: res.query, candidates: res.candidates })
  return ok(res.entity)
}

/**
 * A transfer is a Transaction {type: 'transfer'} with FROM and TO account edges (ADR-002).
 * Never classified, never in spending summaries; debits FROM and credits TO balances.
 */
export const createTransfer = async (
  deps: Deps,
  input: CreateTransferInput,
): Promise<Result<{ transaction: Transaction; created: boolean }, AppError>> => {
  const accounts = await deps.accounts.list()
  const from = resolveAccount(accounts, input.from)
  if (from.isErr()) return err(from.error)
  const to = resolveAccount(accounts, input.to)
  if (to.isErr()) return err(to.error)

  if (from.value.id === to.value.id)
    return err({ code: 'validation', issues: ['from and to must be different accounts'] })

  // Cross-currency transfers need an FX rate — not supported yet (see PLAN open questions)
  if (from.value.currency !== to.value.currency)
    return err({
      code: 'validation',
      issues: [
        `cross-currency transfer not supported yet: ${from.value.name} is ${from.value.currency}, ` +
          `${to.value.name} is ${to.value.currency}`,
      ],
    })

  const { transaction, created } = await deps.transactions.create(
    {
      id: deps.newId(),
      description: input.description ?? `Transferência: ${from.value.name} → ${to.value.name}`,
      amount: input.amount,
      type: 'transfer',
      date: input.date ?? toIsoDate(deps.clock()),
      currency: from.value.currency,
      source: 'mcp',
      idempotencyKey: input.idempotencyKey,
      classificationMethod: 'none',
      confidence: 0,
      rawInput: null,
    },
    {
      accountId: from.value.id,
      toAccountId: to.value.id,
      cardId: null,
      categoryId: null,
      merchantKey: null,
    },
  )
  return ok({ transaction, created })
}
