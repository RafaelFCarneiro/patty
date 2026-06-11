import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Result } from 'neverthrow'
import { z } from 'zod'
import { httpStatus, type AppError } from '../../common/errors.js'
import { createAccount, listAccounts } from '../../controllers/accounts.js'
import { createCategory, listCategories } from '../../controllers/categories.js'
import type { Deps } from '../../controllers/deps.js'
import { getSpendingSummary } from '../../controllers/summary.js'
import { createTransaction, searchTransactions } from '../../controllers/transactions.js'
import { CreateAccount } from '../../models/account.js'
import { CreateCategory } from '../../models/category.js'
import { Period } from '../../models/common.js'
import { CreateTransactionInput, SearchTransactionsInput } from '../../models/transaction.js'

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

  app.get('/api/accounts', async () => listAccounts(deps))
  app.post('/api/accounts', async (req, reply) => {
    const input = parse(CreateAccount, req.body, reply)
    if (!input) return
    return send(reply, await createAccount(deps, input), 201)
  })

  app.get('/api/categories', async () => listCategories(deps))
  app.post('/api/categories', async (req, reply) => {
    const input = parse(CreateCategory, req.body, reply)
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

  app.get('/api/transactions', async (req, reply) => {
    const input = parse(SearchTransactionsInput, req.query, reply)
    if (!input) return
    return send(reply, await searchTransactions(deps, input))
  })

  app.get('/api/summary', async (req, reply) => {
    const input = parse(Period.extend({ month: z.coerce.number(), year: z.coerce.number() }), req.query, reply)
    if (!input) return
    return reply.send(await getSpendingSummary(deps, input))
  })
}
