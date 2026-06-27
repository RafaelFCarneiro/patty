import { describe, expect, it } from 'vitest'
import { canAutoSwitchLocale } from '../../../src/logic/locale.js'
import { localeErrors, LocaleSource } from '../../../src/models/locale.js'

describe('canAutoSwitchLocale', () => {
  it('allows inferred change when current source is default', () => {
    expect(canAutoSwitchLocale('inferred', { localeSource: LocaleSource.enum.default }, true)).toBe(true)
  })

  it('allows inferred change when current source is inferred', () => {
    expect(canAutoSwitchLocale('inferred', { localeSource: LocaleSource.enum.inferred }, true)).toBe(true)
  })

  it('blocks inferred change when current source is explicit and locale would change', () => {
    expect(canAutoSwitchLocale('inferred', { localeSource: LocaleSource.enum.explicit }, true)).toBe(false)
  })

  it('allows inferred when explicit but locale would not change (no-op)', () => {
    expect(canAutoSwitchLocale('inferred', { localeSource: LocaleSource.enum.explicit }, false)).toBe(true)
  })

  it('allows explicit change regardless of current source', () => {
    expect(canAutoSwitchLocale('explicit', { localeSource: LocaleSource.enum.explicit }, true)).toBe(true)
  })

  it('allows when current is null (first-time set)', () => {
    expect(canAutoSwitchLocale('inferred', null, true)).toBe(true)
  })
})

describe('localeErrors', () => {
  it('explicitLocaleBlock is a validation error', () => {
    expect(localeErrors.explicitLocaleBlock.code).toBe('validation')
    expect(localeErrors.explicitLocaleBlock.issues[0]).toContain('explicit')
  })
})
