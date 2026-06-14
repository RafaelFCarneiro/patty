import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Result } from 'neverthrow'
import { z } from 'zod'
import { httpStatus, type AppError } from '../../common/errors.js'
import * as accountAdapters from '../../adapters/accounts.js'
import * as categoryAdapters from '../../adapters/categories.js'
import * as creditCardAdapters from '../../adapters/creditCards.js'
import * as recurringAdapters from '../../adapters/recurring.js'
import * as transactionAdapters from '../../adapters/transactions.js'
import { createAccount, getAccountBalances, listAccounts } from '../../controllers/accounts.js'
import { getBill, payBill } from '../../controllers/bills.js'
import { createCategory, createSubCategory, listCategories, listSubCategories } from '../../controllers/categories.js'
import { createCreditCard, listCreditCards } from '../../controllers/creditCards.js'
import type { Deps } from '../../controllers/deps.js'
import { applyDueRecurring, createRecurring, listRecurring } from '../../controllers/recurring.js'
import { createTag, deleteTag, listTags } from '../../controllers/tags.js'
import { getSpendingSummary } from '../../controllers/summary.js'
import {
  createTransaction,
  createTransactionsBulk,
  deleteTransaction,
  searchTransactions,
  updateTransaction,
} from '../../controllers/transactions.js'
import { createTransfer } from '../../controllers/transfers.js'
import { AccountType } from '../../models/account.js'
import { TransactionSource } from '../../models/transaction.js'
import { Period } from '../../models/common.js'
import { BillQuery, type BillQuery as BillQueryInput } from '../../wire/in/bills.js'
import * as wireInAccounts from '../../wire/in/accounts.js'
import * as wireInCategories from '../../wire/in/categories.js'
import * as wireInCreditCards from '../../wire/in/creditCards.js'
import * as wireInRecurring from '../../wire/in/recurring.js'
import * as wireInTransactions from '../../wire/in/transactions.js'

/** Thin diplomat: zod-parse (wire/in) → wireInToModel → controller → map Result to HTTP. */

const send = <T>(reply: FastifyReply, result: Result<T, AppError>, okStatus = 200) =>
  result.match(
    (value) => reply.status(okStatus).send(value),
    (e) => reply.status(httpStatus(e)).send({ error: e }),
  )

const parse = <S extends z.ZodTypeAny>(schema: S, body: unknown, reply: FastifyReply): z.output<S> | null => {
  const r = schema.safeParse(body)
  if (!r.success) {
    reply.status(422).send({ error: { code: 'validation', issues: r.error.issues.map((i) => i.message) } })
    return null
  }
  return r.data as z.output<S>
}

export const registerRoutes = (app: FastifyInstance, deps: Deps): void => {
  app.get('/api/health', async () => ({ status: 'ok' }))

  app.get('/api/accounts', async (req, reply) => {
    const q = z.object({ type: AccountType.optional() }).safeParse(req.query)
    if (!q.success) return reply.status(422).send({ error: { code: 'validation', issues: ['invalid type'] } })
    return reply.send(await listAccounts(deps, q.data.type))
  })
  app.get('/api/accounts/balances', async (req, reply) => {
    const q = z
      .object({ account: z.string().optional(), type: AccountType.optional() })
      .safeParse(req.query)
    if (!q.success) return reply.status(422).send({ error: { code: 'validation', issues: ['invalid query'] } })
    return send(reply, await getAccountBalances(deps, q.data))
  })
  app.post('/api/accounts', async (req, reply) => {
    const wireIn = parse(wireInAccounts.CreateAccount, req.body, reply)
    if (!wireIn) return reply
    return send(reply, await createAccount(deps, accountAdapters.wireInToModel(wireIn)), 201)
  })

  app.get('/api/categories', async () => listCategories(deps))
  app.post('/api/categories', async (req, reply) => {
    const wireIn = parse(wireInCategories.CreateCategory, req.body, reply)
    if (!wireIn) return reply
    return send(reply, await createCategory(deps, categoryAdapters.wireInToModel(wireIn)), 201)
  })
  app.get('/api/sub-categories', async (req, reply) => {
    const q = z.object({ parentId: z.string().optional() }).safeParse(req.query)
    if (!q.success) return reply.status(422).send({ error: { code: 'validation', issues: ['invalid query'] } })
    return reply.send(await listSubCategories(deps, q.data.parentId))
  })
  app.post('/api/sub-categories', async (req, reply) => {
    const wireIn = parse(wireInCategories.CreateSubCategory, req.body, reply)
    if (!wireIn) return reply
    return send(reply, await createSubCategory(deps, wireIn), 201)
  })

  app.post('/api/transactions', async (req, reply) => {
    const wireIn = parse(wireInTransactions.CreateTransactionInput, req.body, reply)
    if (!wireIn) return reply
    const result = await createTransaction(deps, transactionAdapters.createWireInToModel(wireIn), TransactionSource.enum.rest)
    return result.match(
      (value) => {
        const out = transactionAdapters.createResultToWireOut(value)
        return reply.status(out.created ? 201 : 200).send(out)
      },
      (e) => reply.status(httpStatus(e)).send({ error: e }),
    )
  })

  app.post('/api/transactions/bulk', async (req, reply) => {
    const wireIn = parse(wireInTransactions.CreateTransactionsBulkInput, req.body, reply)
    if (!wireIn) return reply
    return send(reply, (await createTransactionsBulk(deps, transactionAdapters.bulkWireInToModel(wireIn), TransactionSource.enum.import)).map(transactionAdapters.bulkResultToWireOut), 201)
  })

  app.get('/api/credit-cards', async () => listCreditCards(deps))
  app.post('/api/credit-cards', async (req, reply) => {
    const wireIn = parse(wireInCreditCards.CreateCreditCard, req.body, reply)
    if (!wireIn) return reply
    return send(reply, await createCreditCard(deps, creditCardAdapters.wireInToModel(wireIn)), 201)
  })

  app.get('/api/bills', async (req, reply) => {
    const input = parse(BillQuery, req.query, reply) as BillQueryInput
    if (!input) return reply
    return send(reply, await getBill(deps, input))
  })
  app.post('/api/bills/pay', async (req, reply) => {
    const input = parse(BillQuery, req.body, reply) as BillQueryInput
    if (!input) return reply
    return send(reply, await payBill(deps, input))
  })

  app.post('/api/transfers', async (req, reply) => {
    const wireIn = parse(wireInTransactions.CreateTransferInput, req.body, reply)
    if (!wireIn) return reply
    const result = await createTransfer(deps, transactionAdapters.transferWireInToModel(wireIn), TransactionSource.enum.rest)
    return result.match(
      (value) => reply.status(value.created ? 201 : 200).send(value),
      (e) => reply.status(httpStatus(e)).send({ error: e }),
    )
  })

  app.get('/api/recurring', async () => listRecurring(deps))
  app.post('/api/recurring', async (req, reply) => {
    const wireIn = parse(wireInRecurring.CreateRecurringInput, req.body, reply)
    if (!wireIn) return reply
    return send(reply, await createRecurring(deps, recurringAdapters.wireInToModel(wireIn)), 201)
  })
  app.post('/api/recurring/apply-due', async (_req, reply) => reply.send(await applyDueRecurring(deps)))

  app.patch('/api/transactions/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const wireIn = parse(wireInTransactions.UpdateTransactionInput, { ...(req.body as object), id }, reply)
    if (!wireIn) return reply
    return send(reply, await updateTransaction(deps, transactionAdapters.updateWireInToModel(wireIn)))
  })

  app.delete('/api/transactions/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const confirm = (req.query as { confirm?: string }).confirm === 'true'
    return send(reply, (await deleteTransaction(deps, { id, confirm })).map(transactionAdapters.deleteResultToWireOut))
  })

  app.get('/api/transactions', async (req, reply) => {
    const wireIn = parse(wireInTransactions.SearchTransactionsInput, req.query, reply)
    if (!wireIn) return reply
    return send(reply, await searchTransactions(deps, transactionAdapters.searchWireInToModel(wireIn)))
  })

  app.get('/api/tags', async () => listTags(deps))
  app.post('/api/tags', async (req, reply) => {
    const input = parse(z.object({ name: z.string().min(1) }), req.body, reply)
    if (!input) return reply
    return send(reply, await createTag(deps, input.name), 201)
  })
  app.delete('/api/tags/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    return send(reply, await deleteTag(deps, id))
  })

  app.get('/api/summary', async (req, reply) => {
    const input = parse(Period.extend({ month: z.coerce.number(), year: z.coerce.number() }), req.query, reply)
    if (!input) return reply
    return reply.send(await getSpendingSummary(deps, input))
  })
}
