import type { AccountsRepo } from '../diplomat/db/repos/accounts.js'
import type { CategoriesRepo } from '../diplomat/db/repos/categories.js'
import type { MerchantsRepo } from '../diplomat/db/repos/merchants.js'
import type { TransactionsRepo } from '../diplomat/db/repos/transactions.js'

/** Side-effect dependencies, injected so controllers stay testable. */
export type Deps = {
  accounts: AccountsRepo
  categories: CategoriesRepo
  merchants: MerchantsRepo
  transactions: TransactionsRepo
  clock: () => Date
  newId: () => string
}
