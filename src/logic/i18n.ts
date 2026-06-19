import { Locale, type Locale as LocaleType } from '../models/locale.js'

type Translations = Record<LocaleType, string>

const categoryNames: Record<string, Translations> = {
  'cat-food':          { [Locale.enum.en]: 'Food',              [Locale.enum.es]: 'Alimentación',       [Locale.enum.pt]: 'Alimentação' },
  'cat-transport':     { [Locale.enum.en]: 'Transport',         [Locale.enum.es]: 'Transporte',         [Locale.enum.pt]: 'Transporte' },
  'cat-housing':       { [Locale.enum.en]: 'Housing',           [Locale.enum.es]: 'Vivienda',           [Locale.enum.pt]: 'Moradia' },
  'cat-utilities':     { [Locale.enum.en]: 'Utilities',         [Locale.enum.es]: 'Servicios',          [Locale.enum.pt]: 'Contas & Serviços' },
  'cat-health':        { [Locale.enum.en]: 'Health',            [Locale.enum.es]: 'Salud',              [Locale.enum.pt]: 'Saúde' },
  'cat-education':     { [Locale.enum.en]: 'Education',         [Locale.enum.es]: 'Educación',          [Locale.enum.pt]: 'Educação' },
  'cat-leisure':       { [Locale.enum.en]: 'Leisure',           [Locale.enum.es]: 'Ocio',               [Locale.enum.pt]: 'Lazer' },
  'cat-shopping':      { [Locale.enum.en]: 'Shopping',          [Locale.enum.es]: 'Compras',            [Locale.enum.pt]: 'Compras' },
  'cat-subscriptions': { [Locale.enum.en]: 'Subscriptions',     [Locale.enum.es]: 'Suscripciones',      [Locale.enum.pt]: 'Assinaturas' },
  'cat-travel':        { [Locale.enum.en]: 'Travel',            [Locale.enum.es]: 'Viajes',             [Locale.enum.pt]: 'Viagem' },
  'cat-taxes':         { [Locale.enum.en]: 'Taxes',             [Locale.enum.es]: 'Impuestos & Tasas',  [Locale.enum.pt]: 'Impostos & Taxas' },
  'cat-salary':        { [Locale.enum.en]: 'Salary',            [Locale.enum.es]: 'Salario',            [Locale.enum.pt]: 'Salário' },
  'cat-extra-income':  { [Locale.enum.en]: 'Extra Income',      [Locale.enum.es]: 'Ingresos Extra',     [Locale.enum.pt]: 'Renda Extra' },
  'cat-investments':   { [Locale.enum.en]: 'Investments',       [Locale.enum.es]: 'Inversiones',        [Locale.enum.pt]: 'Investimentos' },
  'cat-other':         { [Locale.enum.en]: 'Other',             [Locale.enum.es]: 'Otros',              [Locale.enum.pt]: 'Outros' },
}

export const translate = (key: string, locale: LocaleType): string | undefined =>
  categoryNames[key]?.[locale]

export const translateWithFallback = (key: string, locale: LocaleType, fallback: string): string =>
  translate(key, locale) ?? fallback

export const allNamesForKey = (key: string): string[] => {
  const entry = categoryNames[key]
  if (!entry) return []
  return [...new Set(Object.values(entry))]
}

export const defaultCategoryKeys = Object.keys(categoryNames)
