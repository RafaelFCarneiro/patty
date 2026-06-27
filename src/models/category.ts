import { z } from 'zod'
import { Id } from './common.js'
import type { Ambiguous, DuplicateName, InUse, NotFound, ValidationError } from './error.js'
import type { LabelMap } from './locale.js'

export const CategoryKind = z.enum(['expense', 'income', 'both'])
export type CategoryKind = z.infer<typeof CategoryKind>

export const categoryKindLabels: LabelMap<CategoryKind> = {
  expense: { en: 'Expense', pt: 'Despesa', es: 'Gasto' },
  income:  { en: 'Income',  pt: 'Receita', es: 'Ingreso' },
  both:    { en: 'Both',    pt: 'Ambos',   es: 'Ambos' },
}

export const LocalizedNames = z.record(z.string().min(1), z.string().min(1)).nullable()
export type LocalizedNames = z.infer<typeof LocalizedNames>

export const Category = z.object({
  id: Id,
  name: z.string().min(1),
  kind: CategoryKind,
  kindLabel: z.string().optional(),
  names: LocalizedNames,
})
export type Category = z.infer<typeof Category>

export type CreateCategory = {
  name: string
  kind: CategoryKind
}

/** Sub-category read projection — includes parent info joined from [:BELONGS_TO]->(:Category). */
export const SubCategory = z.object({
  id: Id,
  name: z.string().min(1),
  parentId: Id,
  parentName: z.string().min(1),
  kind: CategoryKind,
  kindLabel: z.string().optional(),
})
export type SubCategory = z.infer<typeof SubCategory>

export type CreateSubCategory = {
  id: string
  name: string
  parentId: string
}

export type CategoryReferences = { transactions: number; recurring: number; subCategories: number }

export type CategoryError =
  | NotFound<'category'>
  | Ambiguous<'category'>
  | NotFound<'sub_category'>
  | Ambiguous<'sub_category'>
  | DuplicateName<'category'>
  | DuplicateName<'sub_category'>
  | InUse<'category', CategoryReferences>
  | InUse<'sub_category', CategoryReferences>
  | { code: 'category_kind_mismatch'; transactionType: 'expense' | 'income'; categoryName: string; categoryKind: CategoryKind; hint: string }
  | ValidationError

export const categoryErrors = {
  duplicateName: (entity: 'category' | 'sub_category', name: string): CategoryError => ({
    code: 'duplicate_name', entity, name,
  }),
  inUse: (entity: 'category' | 'sub_category', name: string, references: CategoryReferences): CategoryError => ({
    code: 'in_use', entity, name, references,
  }),
  kindMismatch: (transactionType: 'expense' | 'income', categoryName: string, categoryKind: CategoryKind): CategoryError => ({
    code: 'category_kind_mismatch',
    transactionType,
    categoryName,
    categoryKind,
    hint: `Category "${categoryName}" is ${categoryKind}-only; to use it, set type: "${categoryKind}"`,
  }),
}
