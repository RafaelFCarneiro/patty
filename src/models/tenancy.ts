import { CURRENCY_RATE_ENTITY_TAG } from './currency-rate.js';
import { validation, type ValidationError } from './error.js';

/** The one message every attempt to change a shared default answers with. */
export const SHARED_DEFAULT_READ_ONLY_MESSAGE =
  "Default categories and dashboards are shared by every user and can't be changed or deleted. " +
  'Create your own instead (a dashboard saved under a default’s name replaces it for you alone).';

export const sharedDefaultErrors = {
  readOnly: validation([SHARED_DEFAULT_READ_ONLY_MESSAGE]) satisfies ValidationError,
};

/** A committed change: the entity tags touched and whose they are (`null` = instance bookkeeping, heard by no one). */
export type ChangeEvent = { userId: string | null; entities: readonly string[] };

/** Entities every user sees (rates move everyone's valuations): any user's change to them is heard by all. */
export const SHARED_ENTITY_TAGS: readonly string[] = [CURRENCY_RATE_ENTITY_TAG];
