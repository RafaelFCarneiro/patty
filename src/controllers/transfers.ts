import { ok, safeTry, type ResultAsync } from 'neverthrow'
import { toTransferCreateProps } from '../adapters/transactions.js'
import type { AppError } from '../common/errors.js'
import { guard } from '../common/result.js'
import { toIsoDate } from '../logic/period.js'
import type { Account } from '../models/account.js'
import type { CreateTransferInput, Transaction, TransactionSource } from '../models/transaction.js'
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
): ResultAsync<{ transaction: Transaction; created: boolean }, AppError> =>
  safeTry(async function* () {
    const from = yield* resolveAccountRef(deps, input.from)
    const to = yield* resolveAccountRef(deps, input.to)

    yield* validateTransferAccounts(from, to)

    const txProps = toTransferCreateProps({
      id: deps.newId(),
      date: input.date ?? toIsoDate(deps.clock()),
      input,
      from,
      to,
      source,
    })

    const { transaction, created } = await deps.transactions.create(
      txProps,
      { accountId: from.id, toAccountId: to.id, cardId: null, categoryId: null, merchantKey: null },
    )
    return ok({ transaction, created })
  })
