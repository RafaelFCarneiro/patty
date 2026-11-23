import { expandCompactOffset } from '../models/currency-rate.js';

/** Parses any timestamp `IsoTimestamp` accepts, compact offsets (`-03`, `-0300`) included. */
export const parseTimestamp = (text: string): Date => new Date(expandCompactOffset(text));

/** The UTC ISO form (`YYYY-MM-DDTHH:mm:ss.sssZ`) of any accepted timestamp. */
export const canonical = (text: string): string => parseTimestamp(text).toISOString();
