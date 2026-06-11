import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Result } from 'neverthrow'
import { z } from 'zod'
import { httpStatus, type AppError } from '../../common/errors.js'
import { createAccount, listAccounts } from '../../controllers/accounts.js'
import { getBill, payBill } from '../../controllers/bills.js'
import { createCategory, listCategories } from '../../controllers/categories.js'
import { createCreditCard, listCreditCards } from '../../controllers/creditCards.js'
import type { Deps } from '../../controllers/deps.js'
import { applyDueRecurring, createRecurring, listRecurring } from '../../controllers/recurring.js'
import { getSpendingSummary } from '../../controllers/summary.js'
import {
  createTransaction,
  createTransactionsBulk,
  deleteTransaction,
  searchTransactions,
  updateTransaction,
} from '../../controllers/transactions.js'
import { createTransfer, listTransfers } from '../../controllers/transfers.js'
import { CreateTransferInput } from '../../models/transfer.js'
import { AccountType } from '../../models/account.js'
import { CreateAccount } from '../../models/account.js'
import { CreateCategory } from '../../models/category.js'
import { Period } from '../../models/common.js'
import { CreateCreditCard } from '../../models/creditCard.js'
import { CreateRecurringInput } from '../../models/recurring.js'
import {
  CreateTransactionInput,
  CreateTransactionsBulkInput,
  SearchTransactionsInput,
  UpdateTransactionInput,
} from '../../models/transaction.js'

/** Thin diplomat: zod-parse → controller → map Result to HTTP. */

const send = <T>(reply: FastifyReply, result: Result<T, AppError>, okStatus = 200) =>
  result.match(
    (value) => reply.status(okStatus).send(value),
    (e) => reply.status(httpStatus(e)).send({ error: e }),
  )

const parse = <T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | null => {
  const r = schema.safeParse(body)
  if (!r.success) {
    void reply.status(422).send({ error: { code: 'validation', issues: r.error.issues.map((i) => i.message) } })
    return null
  }
  return r.data
}

export const registerRoutes = (app: FastifyInstance, deps: Deps): void => {
  app.get('/api/health', async () => ({ status: 'ok' }))

  app.get('/api/accounts', async (req, reply) => {
    const q = z.object({ type: AccountType.optional() }).safeParse(req.query)
    if (!q.success) return reply.status(422).send({ error: { code: 'validation', issues: ['invalid type'] } })
    return listAccounts(deps, q.data.type)
  })
  app.post('/api/accounts', async (req, reply) => {
    const input = parse(CreateAccount, req.body, reply) as CreateAccount
    if (!input) return
    return send(reply, await createAccount(deps, input), 201)
  })

  app.get('/api/categories', async () => listCategories(deps))
  app.post('/api/categories', async (req, reply) => {
    const input = parse(CreateCategory, req.body, reply) as CreateCategory
    if (!input) return
    return send(reply, await createCategory(deps, input), 201)
  })

  app.post('/api/transactions', async (req, reply) => {
    const input = parse(CreateTransactionInput, req.body, reply)
    if (!input) return
    const result = await createTransaction(deps, input, 'rest')
    return result.match(
      (value) => reply.status(value.created ? 201 : 200).send(value),
      (e) => reply.status(httpStatus(e)).send({ error: e }),
    )
  })

  app.post('/api/transactions/bulk', async (req, reply) => {
    const input = parse(CreateTransactionsBulkInput, req.body, reply) as CreateTransactionsBulkInput
    if (!input) return
    return send(reply, await createTransactionsBulk(deps, input, 'import'), 201)
  })

  app.get('/api/credit-cards', async () => listCreditCards(deps))
  app.post('/api/credit-cards', async (req, reply) => {
    const input = parse(CreateCreditCard, req.body, reply) as CreateCreditCard
    if (!input) return
    return send(reply, await createCreditCard(deps, input), 201)
  })

  const BillQuery = z.object({
    card: z.string().min(1),
    month: z.coerce.number().int().min(1).max(12),
    year: z.coerce.number().int().min(2000).max(2100),
  })
  app.get('/api/bills', async (req, reply) => {
    const input = parse(BillQuery, req.query, reply) as z.infer<typeof BillQuery>
    if (!input) return
    return send(reply, await getBill(deps, input))
  })
  app.post('/api/bills/pay', async (req, reply) => {
    const input = parse(BillQuery, req.body, reply) as z.infer<typeof BillQuery>
    if (!input) return
    return send(reply, await payBill(deps, input))
  })

  app.post('/api/transfers', async (req, reply) => {
    const input = parse(CreateTransferInput, req.body, reply) as CreateTransferInput
    if (!input) return
    const result = await createTransfer(deps, input)
    return result.match(
      (value) => reply.status(value.created ? 201 : 200).send(value),
      (e) => reply.status(httpStatus(e)).send({ error: e }),
    )
  })
  const TransfersQuery = z.object({
    month: z.coerce.number().int().min(1).max(12).optional(),
    year: z.coerce.number().int().min(2000).max(2100).optional(),
    account: z.string().optional(),
  })
  app.get('/api/transfers', async (req, reply) => {
    const input = parse(TransfersQuery, req.query, reply) as z.infer<typeof TransfersQuery>
    if (!input) return
    return send(reply, await listTransfers(deps, input))
  })

  app.get('/api/recurring', async () => listRecurring(deps))
  app.post('/api/recurring', async (req, reply) => {
    const input = parse(CreateRecurringInput, req.body, reply) as CreateRecurringInput
    if (!input) return
    return send(reply, await createRecurring(deps, input), 201)
  })
  app.post('/api/recurring/apply-due', async (_req, reply) => reply.send(await applyDueRecurring(deps)))

  app.patch('/api/transactions/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const input = parse(UpdateTransactionInput, { ...(req.body as object), id }, reply) as UpdateTransactionInput
    if (!input) return
    return send(reply, await updateTransaction(deps, input))
  })

  app.delete('/api/transactions/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const confirm = (req.query as { confirm?: string }).confirm === 'true'
    return send(reply, await deleteTransaction(deps, { id, confirm }))
  })

  app.get('/api/transactions', async (req, reply) => {
    const input = parse(SearchTransactionsInput, req.query, reply) as SearchTransactionsInput
    if (!input) return
    return send(reply, await searchTransactions(deps, input))
  })

  app.get('/api/summary', async (req, reply) => {
    const input = parse(Period.extend({ month: z.coerce.number(), year: z.coerce.number() }), req.query, reply)
    if (!input) return
    return reply.send(await getSpendingSummary(deps, input))
  })
}
