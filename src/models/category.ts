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

export const LocalizedNamesSchema = z.record(z.string().min(1), z.string().min(1)).nullable()
export type LocalizedNames = z.infer<typeof LocalizedNamesSchema>

// `.describe()` is domain information — it states what each field is and represents.
// Defaults split by intent: integrity defaults (a value that must exist for the entity to be
// valid) live here; quality-of-life convenience defaults live at the wire boundary
// (see wire/in/categories.ts), keeping the domain contract honest about what is required.
export const CategorySchema = z.object({
  id: Id,
  name: z.string().min(1).describe('Category display name'),
  kind: CategoryKind.describe('expense | income | both — controls which transaction types may use this category'),
  kindLabel: z.string().optional(),
  names: LocalizedNamesSchema.describe('Locale-keyed display names for default categories; null for user-created'),
})
export type Category = z.infer<typeof CategorySchema>

export const CreateCategorySchema = CategorySchema.omit({ id: true, kindLabel: true, names: true })
export type CreateCategory = z.infer<typeof CreateCategorySchema>

/** Sub-category read projection — includes parent info joined from [:BELONGS_TO]->(:Category). */
export const SubCategorySchema = z.object({
  id: Id,
  name: z.string().min(1).describe('Sub-category display name'),
  parentId: Id.describe('Parent category ID'),
  parentName: z.string().min(1).describe('Parent category name'),
  kind: CategoryKind.describe('Inherited from the parent category'),
  kindLabel: z.string().optional(),
})
export type SubCategory = z.infer<typeof SubCategorySchema>

export const CreateSubCategorySchema = z.object({
  id: Id,
  name: z.string().min(1).describe('Sub-category display name'),
  parentId: Id.describe('ID of the parent category'),
})
export type CreateSubCategory = z.infer<typeof CreateSubCategorySchema>

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
