import { filter, firstBy, identity, map, pipe } from 'remeda';
import { type ChangeEventEntry, type RelayBatchPlan, type StoredChangeEvent } from '../models/change-events.js';
import type { ChangeEvent } from '../models/tenancy.js';

/** Rows older than this instant are past retention. The clock comes from the caller. */
export const pruneCutoff = (now: Date, retentionMs: number): string =>
  new Date(now.getTime() - retentionMs).toISOString();

/** An event naming no entity tells no dashboard anything: it is neither appended nor relayed. */
export const isWorthAnnouncing = (event: ChangeEvent): boolean => event.entities.length > 0;

/** `data_version` moves when another connection committed; the first reading has nothing to compare with. */
export const shouldLook = (previous: number | null, current: number): boolean => previous !== current;

export const isSkippedEntry = (entry: ChangeEventEntry): entry is { id: number; skipped: string } => 'skipped' in entry;

const isEvent = (entry: ChangeEventEntry): entry is StoredChangeEvent => !isSkippedEntry(entry);

const eventOf = ({ event }: StoredChangeEvent): ChangeEvent => event;

const idOf = ({ id }: ChangeEventEntry): number => id;

/** The relay's decision for one batch, read in id order: publish the decoded events, report the rows that did not
 *  decode, and move the cursor past all of them (a skipped row must not be read again). */
export const planRelayBatch = (lastId: number, entries: readonly ChangeEventEntry[]): RelayBatchPlan => ({
  events: pipe(entries, filter(isEvent), map(eventOf), filter(isWorthAnnouncing)),
  skipped: entries.filter(isSkippedEntry),
  lastId: firstBy([lastId, ...entries.map(idOf)], [identity(), 'desc']) ?? lastId,
});
