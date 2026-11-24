import { expandCompactOffset, HOURS_PER_DAY, MS_PER_HOUR } from '../models/timestamp.js';

/** Parses any timestamp `IsoTimestamp` accepts, compact offsets (`-03`, `-0300`) included. */
export const parse = (text: string): Date => new Date(expandCompactOffset(text));

/** The UTC ISO form (`YYYY-MM-DDTHH:mm:ss.sssZ`) of any accepted timestamp. */
export const canonical = (text: string): string => parse(text).toISOString();

const MS_PER_DAY = HOURS_PER_DAY * MS_PER_HOUR;
const DAYS_PER_WEEK = 7;
const WEEKEND_DAYS = 2;
const MS_PER_WEEK = DAYS_PER_WEEK * MS_PER_DAY;
const MS_PER_WEEKEND = WEEKEND_DAYS * MS_PER_DAY;
const WEEKEND_START_IN_WEEK = MS_PER_WEEK - MS_PER_WEEKEND;
/** The epoch is a Thursday; this shifts an instant so that 0 is a Monday 00:00 UTC. */
const EPOCH_TO_MONDAY = 3 * MS_PER_DAY;

/** Saturday/Sunday (UTC) milliseconds between the Monday that precedes the epoch and the instant. */
const weekendMsUntil = (instant: number): number => {
  const sinceMonday = instant + EPOCH_TO_MONDAY;
  const weeks = Math.floor(sinceMonday / MS_PER_WEEK);
  const intoWeek = sinceMonday - weeks * MS_PER_WEEK;
  return weeks * MS_PER_WEEKEND + Math.max(0, intoWeek - WEEKEND_START_IN_WEEK);
};

/** Hours elapsed from `from` to `to`. */
export const elapsedHours = (from: Date, to: Date): number => (to.getTime() - from.getTime()) / MS_PER_HOUR;

/** Elapsed hours minus the Saturday and Sunday (UTC) hours in between: how a weekday-only quote ages. */
export const hoursExcludingWeekends = (from: Date, to: Date): number =>
  (to.getTime() - from.getTime() - (weekendMsUntil(to.getTime()) - weekendMsUntil(from.getTime()))) / MS_PER_HOUR;
