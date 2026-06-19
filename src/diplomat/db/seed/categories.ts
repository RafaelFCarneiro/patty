import { z } from 'zod'
import { CategoryKind } from '../../../models/category.js'

export const DefaultCategoryId = z.enum([
  'cat-food',
  'cat-transport',
  'cat-housing',
  'cat-utilities',
  'cat-health',
  'cat-education',
  'cat-leisure',
  'cat-shopping',
  'cat-subscriptions',
  'cat-travel',
  'cat-taxes',
  'cat-salary',
  'cat-extra-income',
  'cat-investments',
  'cat-other',
])
export type DefaultCategoryId = z.infer<typeof DefaultCategoryId>

export const CATEGORIES = [
  { id: 'cat-food',          name: 'Food',          kind: CategoryKind.enum.expense, names: JSON.stringify({ pt: 'Alimentação',       es: 'Alimentación' }) },
  { id: 'cat-transport',     name: 'Transport',     kind: CategoryKind.enum.expense, names: JSON.stringify({ pt: 'Transporte',         es: 'Transporte' }) },
  { id: 'cat-housing',       name: 'Housing',       kind: CategoryKind.enum.expense, names: JSON.stringify({ pt: 'Moradia',             es: 'Vivienda' }) },
  { id: 'cat-utilities',     name: 'Utilities',     kind: CategoryKind.enum.expense, names: JSON.stringify({ pt: 'Contas & Serviços',   es: 'Servicios' }) },
  { id: 'cat-health',        name: 'Health',        kind: CategoryKind.enum.expense, names: JSON.stringify({ pt: 'Saúde',               es: 'Salud' }) },
  { id: 'cat-education',     name: 'Education',     kind: CategoryKind.enum.expense, names: JSON.stringify({ pt: 'Educação',            es: 'Educación' }) },
  { id: 'cat-leisure',       name: 'Leisure',       kind: CategoryKind.enum.expense, names: JSON.stringify({ pt: 'Lazer',               es: 'Ocio' }) },
  { id: 'cat-shopping',      name: 'Shopping',      kind: CategoryKind.enum.expense, names: JSON.stringify({ pt: 'Compras',             es: 'Compras' }) },
  { id: 'cat-subscriptions', name: 'Subscriptions', kind: CategoryKind.enum.expense, names: JSON.stringify({ pt: 'Assinaturas',         es: 'Suscripciones' }) },
  { id: 'cat-travel',        name: 'Travel',        kind: CategoryKind.enum.expense, names: JSON.stringify({ pt: 'Viagem',              es: 'Viajes' }) },
  { id: 'cat-taxes',         name: 'Taxes',         kind: CategoryKind.enum.expense, names: JSON.stringify({ pt: 'Impostos & Taxas',    es: 'Impuestos & Tasas' }) },
  { id: 'cat-salary',        name: 'Salary',        kind: CategoryKind.enum.income,  names: JSON.stringify({ pt: 'Salário',             es: 'Salario' }) },
  { id: 'cat-extra-income',  name: 'Extra Income',  kind: CategoryKind.enum.income,  names: JSON.stringify({ pt: 'Renda Extra',         es: 'Ingresos Extra' }) },
  { id: 'cat-investments',   name: 'Investments',   kind: CategoryKind.enum.both,    names: JSON.stringify({ pt: 'Investimentos',       es: 'Inversiones' }) },
  { id: 'cat-other',         name: 'Other',         kind: CategoryKind.enum.both,    names: JSON.stringify({ pt: 'Outros',              es: 'Otros' }) },
] as const satisfies ReadonlyArray<{
  id: DefaultCategoryId
  name: string
  kind: CategoryKind
  names: string
}>
