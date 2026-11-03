import { toIsoDate } from '../../logic/period.js';
import { demoTourContext, standardTourContext, tourCountryOf } from '../../logic/demo/tour.js';
import { isDemoInstance } from '../../models/instance.js';
import type { TourContext } from '../../models/demo/tour.js';
import type { Deps } from '../deps.js';

/** Gather what the database says it is, decide the tour's shape; a standard one never reads a demo's language. */
export const getTourContext = async (deps: Deps): Promise<TourContext> => {
  if (!isDemoInstance(await deps.instance.kind())) return standardTourContext(await deps.locale());
  const locale = await deps.instance.locale();
  const stored = await deps.settings.getLocale();
  const country = tourCountryOf(await deps.instance.country(), stored?.baseCurrency ?? null, locale);
  return demoTourContext(locale, country, toIsoDate(deps.clock()));
};
