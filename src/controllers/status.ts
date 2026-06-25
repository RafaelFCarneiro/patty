import { Locale } from '../models/locale.js'
import type { HealthRepo } from '../diplomat/db/repos/health.js'

type StatusDeps = {
  health: HealthRepo
  locale: () => Promise<Locale>
}

export type Status = {
  name: 'fintrack'
  version: string
  db: 'ok' | 'error'
  locale: Locale
}

export const getStatus = async (deps: StatusDeps, version: string): Promise<Status> => {
  let db: 'ok' | 'error'
  try {
    await deps.health.reachable()
    db = 'ok'
  } catch {
    db = 'error'
  }

  let locale: Locale
  try {
    locale = await deps.locale()
  } catch {
    locale = Locale.enum.en
  }

  return { name: 'fintrack', version, db, locale }
}
