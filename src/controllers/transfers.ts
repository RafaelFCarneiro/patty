import { err, ok, type Result } from 'neverthrow'
import type { AppError } from '../common/errors.js'
import { periodRange, toIsoDate } from '../logic/period.js'
import { resolveByName } from '../logic/resolve.js'
import type { Account } from '../models/account.js'
import type { CreateTransferInput, Transfer } from '../models/transfer.js'
import type { Deps } from './deps.js'

const resolveAccount = (
  accounts: Account[],
  name: string,
): Result<Account, AppError> => {
  const res = resolveByName(accounts, name)
  if (res.kind === 'none') return err({ code: 'unknown_account', query: res.query, candidates: res.candidates })
  if (res.kind === 'ambiguous')
    return err({ code: 'ambiguous_account', query: res.query, candidates: res.candidates })
  return ok(res.entity)
}

export const createTransfer = async (
  deps: Deps,
  input: CreateTransferInput,
): Promise<Result<{ transfer: Transfer; created: boolean }, AppError>> => {
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

  const result = await deps.transfers.create({
    id: deps.newId(),
    amount: input.amount,
    date: input.date ?? toIsoDate(deps.clock()),
    currency: from.value.currency,
    description: input.description ?? null,
    idempotencyKey: input.idempotencyKey,
    fromAccountId: from.value.id,
    toAccountId: to.value.id,
  })
  return ok(result)
}

export const listTransfers = async (
  deps: Deps,
  input: { month?: number; year?: number; account?: string },
): Promise<Result<Transfer[], AppError>> => {
  let from: string | null = null
  let to: string | null = null
  if (input.month && input.year) {
    const range = periodRange({ month: input.month, year: input.year })
    from = range.from
    to = range.to
  }

  let accountId: string | null = null
  if (input.account) {
    const res = resolveAccount(await deps.accounts.list(), input.account)
    if (res.isErr()) return err(res.error)
    accountId = res.value.id
  }

  return ok(await deps.transfers.list({ from, to, accountId }))
}
