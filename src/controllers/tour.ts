import { demoTourContext, standardTourContext, tourCountryOf } from '../logic/tour.js';
import { toIsoDate } from '../logic/period.js';
import { isDemoInstance } from '../models/instance.js';
import type { TourContext } from '../models/tour.js';
import { getPreferences } from './settings.js';
import type { Deps } from './deps.js';

/** Gather what the database says it is, decide the tour's shape; a standard one never reads a demo's language. */
export const getTourContext = async (deps: Deps): Promise<TourContext> => {
  if (!isDemoInstance(await deps.instance.kind())) return standardTourContext(await deps.locale());
  const locale = await deps.instance.locale();
  const { baseCurrency } = await getPreferences(deps);
  return demoTourContext(locale, tourCountryOf(baseCurrency, locale), toIsoDate(deps.clock()));
};
