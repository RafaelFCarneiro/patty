import { Locale } from '../models/locale.js'
import type { StatusOut } from '../wire/out/status.js'
import type { Deps } from './deps.js'

export const getStatus = async (deps: Deps, version: string): Promise<StatusOut> => ({
  name: 'fintrack',
  version,
  db: (await deps.health.reachable()) ? 'ok' : 'error',
  locale: await deps.locale().catch(() => Locale.enum.en),
})
