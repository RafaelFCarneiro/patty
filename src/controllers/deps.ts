import type { AccountsRepo } from '../diplomat/db/repos/accounts.js'
import type { BillsRepo } from '../diplomat/db/repos/bills.js'
import type { CategoriesRepo } from '../diplomat/db/repos/categories.js'
import type { CreditCardsRepo } from '../diplomat/db/repos/creditCards.js'
import type { MerchantsRepo } from '../diplomat/db/repos/merchants.js'
import type { RecurringRepo } from '../diplomat/db/repos/recurring.js'
import type { TransactionsRepo } from '../diplomat/db/repos/transactions.js'

/** Side-effect dependencies, injected so controllers stay testable. */
export type Deps = {
  accounts: AccountsRepo
  bills: BillsRepo
  categories: CategoriesRepo
  creditCards: CreditCardsRepo
  merchants: MerchantsRepo
  recurring: RecurringRepo
  transactions: TransactionsRepo
  clock: () => Date
  newId: () => string
}
