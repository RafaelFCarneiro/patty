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
    const labeled = withTransactionLabels(Locale.enum.pt)(baseTx)
    expect(labeled.typeLabel).toBe('Despesa')
    expect(labeled.statusLabel).toBe('Efetivada')
  })

  it('preserves original enum values', () => {
    const labeled = withTransactionLabels(Locale.enum.es)(baseTx)
    expect(labeled.type).toBe(TransactionType.enum.expense)
    expect(labeled.status).toBe(TransactionStatus.enum.effective)
  })
})
