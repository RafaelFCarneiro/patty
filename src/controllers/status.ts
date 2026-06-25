import { Locale } from '../models/locale.js'
import type { StatusOut } from '../wire/out/status.js'
import type { Deps } from './deps.js'

export const getStatus = async (deps: Deps, version: string): Promise<StatusOut> => {
  const [reachable, locale] = await Promise.all([
    deps.health.reachable(),
    deps.locale().catch(() => Locale.enum.en),
  ])

  return { name: 'fintrack', version, db: reachable ? 'ok' : 'error', locale }
}
