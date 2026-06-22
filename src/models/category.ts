import { z } from 'zod'
import { Id } from './common.js'
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
