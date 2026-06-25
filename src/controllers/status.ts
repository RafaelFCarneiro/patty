import * as R from 'remeda'
import { Locale } from '../models/locale.js'
import type { StatusOut } from '../wire/out/status.js'
import type { Deps } from './deps.js'

export const getStatus = async (deps: Deps, version: string): Promise<StatusOut> =>
  R.pipe(
    await Promise.all([deps.health.reachable(), deps.locale().catch(() => Locale.enum.en)]),
    ([reachable, locale]) => ({ name: 'fintrack', version, db: reachable ? 'ok' : 'error' as const, locale }),
  )
