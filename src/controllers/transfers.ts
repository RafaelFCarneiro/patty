import { ok, safeTry, type ResultAsync } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { guard } from '../common/result.js'
import { toIsoDate } from '../logic/period.js'
import type { Account } from '../models/account.js'
import type { CreateTransferInput, TransactionView, TransactionSource } from '../models/transaction.js'
import type { Deps } from './deps.js'
import { resolveAccountRef } from './resolve.js'

const validateTransferAccounts = (from: Account, to: Account) =>
  safeTry(function* () {
    yield* guard(from.id !== to.id, {
      code: 'validation',
      issues: ['from and to must be different accounts'],
    })
    // Cross-currency transfers need an FX rate — not supported yet (see PLAN open questions)
    yield* guard(from.currency === to.currency, {
      code: 'validation',
      issues: [
        `cross-currency transfer not supported yet: ${from.name} is ${from.currency}, ${to.name} is ${to.currency}`,
      ],
    })
    return ok(undefined)
  })

/**
 * A transfer is a Transaction {type: 'transfer'} with FROM and TO account edges (ADR-002).
 * Never classified, never in spending summaries; debits FROM and credits TO balances.
 */
export const createTransfer = (
  deps: Deps,
  input: CreateTransferInput,
  source: TransactionSource,
): ResultAsync<{ transaction: TransactionView; created: boolean }, AppError> =>
  safeTry(async function* () {
    const from = yield* resolveAccountRef(deps, input.from)
    const to = yield* resolveAccountRef(deps, input.to)

    yield* validateTransferAccounts(from, to)

    const { transaction, created } = await deps.transactions.create({
      id: deps.newId(),
      description: input.description ?? `Transferência: ${from.name} → ${to.name}`,
      amount: input.amount,
      type: 'transfer',
      date: input.date ?? toIsoDate(deps.clock()),
      currency: from.currency,
      source,
      idempotencyKey: input.idempotencyKey,
      classification: { method: 'none', confidence: 0 },
      refs: { accountId: from.id, toAccountId: to.id },
    }, [])
    return ok({ transaction, created })
  })
