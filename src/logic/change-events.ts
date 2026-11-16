import type { ChangeEvent } from '../models/tenancy.js';

/** An event no stream can receive is neither appended nor relayed: one with no user (instance bookkeeping, `userId`
 *  null, reaches no one — `/ui/events` forwards only a user's own events) and one naming no entity. */
export const isWorthAnnouncing = ({ userId, entities }: ChangeEvent): boolean => userId !== null && entities.length > 0;
