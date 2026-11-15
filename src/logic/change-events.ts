import type { ChangeEvent } from '../models/tenancy.js';

/** An event naming no entity tells no dashboard anything: it is neither appended nor relayed. */
export const isWorthAnnouncing = (event: ChangeEvent): boolean => event.entities.length > 0;
