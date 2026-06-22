import { z } from 'zod'

export const Locale = z.enum(['en', 'es', 'pt'])
export type Locale = z.infer<typeof Locale>

export const LocaleSource = z.enum(['default', 'inferred', 'explicit'])
export type LocaleSource = z.infer<typeof LocaleSource>

export type LabelMap<E extends string> = Record<E, Record<Locale, string>>
