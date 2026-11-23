import { expandCompactOffset } from '../models/timestamp.js';

/** Parses any timestamp `IsoTimestamp` accepts, compact offsets (`-03`, `-0300`) included. */
export const parse = (text: string): Date => new Date(expandCompactOffset(text));

/** The UTC ISO form (`YYYY-MM-DDTHH:mm:ss.sssZ`) of any accepted timestamp. */
export const canonical = (text: string): string => parse(text).toISOString();
