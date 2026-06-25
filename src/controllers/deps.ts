import type { Locale } from '../models/locale.js'
import type { AccountsRepo } from '../diplomat/db/repos/accounts.js'
import type { BillsRepo } from '../diplomat/db/repos/bills.js'
import type { CategoriesRepo } from '../diplomat/db/repos/categories.js'
import type { SubCategoriesRepo } from '../diplomat/db/repos/subCategories.js'
import type { CreditCardsRepo } from '../diplomat/db/repos/creditCards.js'
import type { HealthRepo } from '../diplomat/db/repos/health.js'
import type { MerchantsRepo } from '../diplomat/db/repos/merchants.js'
import type { RecurringRepo } from '../diplomat/db/repos/recurring.js'
import type { SettingsRepo } from '../diplomat/db/repos/settings.js'
import type { TagsRepo } from '../diplomat/db/repos/tags.js'
import type { TransactionsRepo } from '../diplomat/db/repos/transactions.js'

/** Side-effect dependencies, injected so controllers stay testable. */
export type Deps = {
  accounts: AccountsRepo
  bills: BillsRepo
  categories: CategoriesRepo
  subCategories: SubCategoriesRepo
  creditCards: CreditCardsRepo
  health: HealthRepo
  merchants: MerchantsRepo
  recurring: RecurringRepo
  settings: SettingsRepo
  tags: TagsRepo
  transactions: TransactionsRepo
  clock: () => Date
  newId: () => string
  locale: () => Promise<Locale>
  resetLocale: () => void
}
