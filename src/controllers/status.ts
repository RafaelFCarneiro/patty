import { Locale } from '../models/locale.js'
import type { Deps } from './deps.js'

export type Status = {
  name: 'fintrack'
  version: string
  db: 'ok' | 'error'
  locale: Locale
}

export const getStatus = async (deps: Deps, version: string): Promise<Status> => ({
  name: 'fintrack',
  version,
  db: (await deps.health.reachable()) ? 'ok' : 'error',
  locale: await deps.locale().catch(() => Locale.enum.en),
})
