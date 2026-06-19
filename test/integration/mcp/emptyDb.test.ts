import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../../../src/diplomat/db/driver.js'
import { accountsRepo } from '../../../src/diplomat/db/repos/accounts.js'
import { billsRepo } from '../../../src/diplomat/db/repos/bills.js'
import { categoriesRepo } from '../../../src/diplomat/db/repos/categories.js'
import { subCategoriesRepo } from '../../../src/diplomat/db/repos/subCategories.js'
import { creditCardsRepo } from '../../../src/diplomat/db/repos/creditCards.js'
import { merchantsRepo } from '../../../src/diplomat/db/repos/merchants.js'
import { recurringRepo } from '../../../src/diplomat/db/repos/recurring.js'
import { settingsRepo } from '../../../src/diplomat/db/repos/settings.js'
import { tagsRepo } from '../../../src/diplomat/db/repos/tags.js'
import { transactionsRepo } from '../../../src/diplomat/db/repos/transactions.js'
import { McpTransport } from '../../../src/config.js'
import { Locale } from '../../../src/models/locale.js'
import { listCategories } from '../../../src/controllers/categories.js'
import type { Deps } from '../../../src/controllers/deps.js'

const TEST_KEY = 'b'.repeat(64)
const MIGRATIONS = fileURLToPath(new URL('../../../drizzle', import.meta.url))

let tmpDir: string
let deps: Deps

describe('empty DB (ADR-008)', () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fintrack-empty-'))
    const db = openDatabase({
      DB_PATH: join(tmpDir, 'empty.db'),
      FINTRACK_DB_KEY: TEST_KEY,
      PORT: 0,
      MCP_TRANSPORT: McpTransport.enum.stdio,
    })
    await migrate(db, { migrationsFolder: MIGRATIONS })

    const settingsR = settingsRepo(db)
    deps = {
      accounts: accountsRepo(db),
      bills: billsRepo(db),
      categories: categoriesRepo(db),
      subCategories: subCategoriesRepo(db),
      creditCards: creditCardsRepo(db),
      merchants: merchantsRepo(db),
      recurring: recurringRepo(db),
      settings: settingsR,
      tags: tagsRepo(db),
      transactions: transactionsRepo(db),
      clock: () => new Date(),
      newId: () => randomUUID(),
      locale: async () => {
        const row = await settingsR.getLocale()
        return row?.locale ?? Locale.enum.en
      },
    }
  })

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('list_categories returns empty array on unseeded DB', async () => {
    const categories = await listCategories(deps)
    expect(categories).toEqual([])
  })
})
