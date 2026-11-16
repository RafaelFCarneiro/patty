import type { ChangeLogEntry } from '@rfc0/effect-runner';
import type { ChangeEvent } from '../models/tenancy.js';
import { ChangeEventRowSchema, RowIdSchema } from '../wire/db/change-events.js';

const NO_ID = 0;

const idOf = (row: unknown): number => RowIdSchema.safeParse(row).data?.id ?? NO_ID;

/** A stored row as the relay's entry: the decoded event, or the reason it could not be decoded (never thrown). */
export const dbToModel = (row: unknown): ChangeLogEntry<ChangeEvent> => {
  const decoded = ChangeEventRowSchema.safeParse(row);
  return decoded.success
    ? {
        id: decoded.data.id,
        origin: decoded.data.origin,
        event: { userId: decoded.data.userId, entities: decoded.data.entities },
      }
    : { id: idOf(row), skipped: decoded.error.issues.map(({ message }) => message).join('; ') };
};
