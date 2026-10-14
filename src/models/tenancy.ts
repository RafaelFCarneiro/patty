import { validation, type ValidationError } from './error.js';

/**
 * What a change to a shared default says (ADR-033 §5). The rows FinTrack ships — the seeded categories, the bundled
 * dashboards — belong to no one and are the same for everyone, so none of them can be renamed or deleted. Every
 * attempt, through any tool or route, answers with this one message.
 */
export const SHARED_DEFAULT_READ_ONLY_MESSAGE =
  "Default categories and dashboards are shared by every user and can't be changed or deleted. " +
  'Create your own instead (a dashboard saved under a default’s name replaces it for you alone).';

export const sharedDefaultErrors = {
  readOnly: validation([SHARED_DEFAULT_READ_ONLY_MESSAGE]) satisfies ValidationError,
};

/** A committed change, as the change bus carries it (ADR-033 §5): the entity tags it touched and the user it
 *  belongs to, so a subscriber hears only about its own user's data. `userId` is null for an instance-level change
 *  (identity bookkeeping), which no dashboard subscriber is ever told about. */
export type ChangeEvent = { userId: string | null; entities: readonly string[] };
