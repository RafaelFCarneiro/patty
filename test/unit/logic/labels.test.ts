import { describe, expect, it } from 'vitest'
import { AccountType } from '../../../src/models/account.js'
import { BillStatus } from '../../../src/models/bill.js'
import { CategoryKind } from '../../../src/models/category.js'
import { Locale } from '../../../src/models/locale.js'
import { RecurringPeriod } from '../../../src/models/recurring.js'
import { ClassificationMethod, TransactionSource, TransactionStatus, TransactionType } from '../../../src/models/transaction.js'
import { CurrencyCode } from '../../../src/models/common.js'
import {
  localizeAccountType,
  localizeBillStatus,
  localizeCategoryKind,
  localizeRecurringPeriod,
  localizeTransactionStatus,
  localizeTransactionType,
  withTransactionLabels,
} from '../../../src/logic/labels.js'
import type { TransactionView } from '../../../src/models/transaction.js'

const locales = Locale.options

const exhaustive = <E extends string>(
  enumSchema: { options: readonly E[] },
  resolver: (v: E, l: (typeof locales)[number]) => string,
  label: string,
) => {
  describe(label, () => {
    for (const value of enumSchema.options) {
      for (const locale of locales) {
        it(`${value} → ${locale}`, () => {
          const result = resolver(value, locale)
          expect(result).toBeTypeOf('string')
          expect(result.length).toBeGreaterThan(0)
        })
      }
    }

    it('non-English locales differ from English for at least one member', () => {
      const hasNonEnglish = enumSchema.options.some((value) =>
        locales
          .filter((l) => l !== Locale.enum.en)
          .some((l) => resolver(value, l) !== resolver(value, Locale.enum.en)),
      )
      expect(hasNonEnglish).toBe(true)
    })
  })
}

exhaustive(AccountType, localizeAccountType, 'localizeAccountType')
exhaustive(CategoryKind, localizeCategoryKind, 'localizeCategoryKind')
exhaustive(RecurringPeriod, localizeRecurringPeriod, 'localizeRecurringPeriod')
exhaustive(BillStatus, localizeBillStatus, 'localizeBillStatus')
exhaustive(TransactionType, localizeTransactionType, 'localizeTransactionType')
exhaustive(TransactionStatus, localizeTransactionStatus, 'localizeTransactionStatus')

describe('specific translations', () => {
  it('AccountType checking → pt', () => {
    expect(localizeAccountType(AccountType.enum.checking, Locale.enum.pt)).toBe('Conta corrente')
  })

  it('TransactionType transfer → es', () => {
    expect(localizeTransactionType(TransactionType.enum.transfer, Locale.enum.es)).toBe('Transferencia')
  })

  it('BillStatus paid → pt', () => {
    expect(localizeBillStatus(BillStatus.enum.paid, Locale.enum.pt)).toBe('Paga')
  })

  it('RecurringPeriod monthly → en', () => {
    expect(localizeRecurringPeriod(RecurringPeriod.enum.monthly, Locale.enum.en)).toBe('Monthly')
  })
})

describe('withTransactionLabels', () => {
  const baseTx: TransactionView = {
    id: 'tx-1',
    description: 'Test',
    amount: 100,
    type: TransactionType.enum.expense,
    status: TransactionStatus.enum.effective,
    date: '2026-01-01',
    currency: CurrencyCode.enum.BRL,
    source: TransactionSource.enum.mcp,
    idempotencyKey: 'test-1',
    classification: { method: ClassificationMethod.enum.none, confidence: 0 },
    tags: [],
  }

  it('adds typeLabel and statusLabel for the given locale', () => {
    const labeled = withTransactionLabels(baseTx, Locale.enum.pt)
    expect(labeled.typeLabel).toBe('Despesa')
    expect(labeled.statusLabel).toBe('Efetivada')
  })

  it('preserves original enum values', () => {
    const labeled = withTransactionLabels(baseTx, Locale.enum.es)
    expect(labeled.type).toBe(TransactionType.enum.expense)
    expect(labeled.status).toBe(TransactionStatus.enum.effective)
  })

  it('resolves categoryName from categoryNames map for active locale', () => {
    const tx: TransactionView = {
      ...baseTx,
      categoryName: 'Food',
      categoryNames: { pt: 'Alimentação', es: 'Alimentación' },
    }
    const labeled = withTransactionLabels(tx, Locale.enum.pt)
    expect(labeled.categoryName).toBe('Alimentação')
  })

  it('resolves subCategoryName from subCategoryNames map', () => {
    const tx: TransactionView = {
      ...baseTx,
      subCategoryName: 'Groceries',
      subCategoryNames: { pt: 'Supermercado', es: 'Supermercado' },
    }
    const labeled = withTransactionLabels(tx, Locale.enum.pt)
    expect(labeled.subCategoryName).toBe('Supermercado')
  })

  it('falls back to canonical name when locale has no translation', () => {
    const tx: TransactionView = {
      ...baseTx,
      categoryName: 'Food',
      categoryNames: { pt: 'Alimentação' },
    }
    const labeled = withTransactionLabels(tx, Locale.enum.es)
    expect(labeled.categoryName).toBe('Food')
  })

  it('keeps literal name for user-created categories (names null)', () => {
    const tx: TransactionView = {
      ...baseTx,
      categoryName: 'My Custom',
      categoryNames: null,
    }
    const labeled = withTransactionLabels(tx, Locale.enum.pt)
    expect(labeled.categoryName).toBe('My Custom')
  })

  it('strips categoryNames and subCategoryNames from output', () => {
    const tx: TransactionView = {
      ...baseTx,
      categoryName: 'Food',
      categoryNames: { pt: 'Alimentação' },
      subCategoryName: 'Groceries',
      subCategoryNames: { pt: 'Supermercado' },
    }
    const labeled = withTransactionLabels(tx, Locale.enum.pt)
    expect(labeled.categoryNames).toBeUndefined()
    expect(labeled.subCategoryNames).toBeUndefined()
  })

  it('leaves categoryName undefined when no category assigned', () => {
    const labeled = withTransactionLabels(baseTx, Locale.enum.pt)
    expect(labeled.categoryName).toBeUndefined()
  })

  it('categoryId is unchanged by locale resolution', () => {
    const tx: TransactionView = {
      ...baseTx,
      categoryId: 'cat-food',
      categoryName: 'Food',
      categoryNames: { pt: 'Alimentação' },
    }
    const labeled = withTransactionLabels(tx, Locale.enum.pt)
    expect(labeled.categoryId).toBe('cat-food')
  })

  it('works as a curried mapper (purry data-last)', () => {
    const tx: TransactionView = {
      ...baseTx,
      categoryName: 'Food',
      categoryNames: { pt: 'Alimentação' },
    }
    const mapper = withTransactionLabels(Locale.enum.pt)
    const labeled = mapper(tx)
    expect(labeled.categoryName).toBe('Alimentação')
    expect(labeled.categoryNames).toBeUndefined()
  })
})
