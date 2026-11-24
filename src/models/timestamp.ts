import { z } from 'zod';

const strictTimestamp = z.iso.datetime({ offset: true });

export const MS_PER_HOUR = 60 * 60 * 1000;
const COMPACT_OFFSET = /([+-]\d{2})(\d{2})?$/;
const MINUTES_WHEN_ABSENT = '00';
const EARLIEST_INSTANT = Date.parse('0000-01-01T00:00:00.000Z');
const LATEST_INSTANT = Date.parse('9999-12-31T23:59:59.999Z');

/** `+02`/`+0200` → `+02:00`; any other text is returned as is. */
export const expandCompactOffset = (text: string): string =>
  text.replace(
    COMPACT_OFFSET,
    (_: string, hours: string, minutes?: string) => `${hours}:${minutes ?? MINUTES_WHEN_ABSENT}`,
  );

const isCanonicalizable = (text: string): boolean => {
  const instant = Date.parse(expandCompactOffset(text));
  return instant >= EARLIEST_INSTANT && instant <= LATEST_INSTANT;
};

/** An ISO 8601 timestamp with an offset; also accepts +02 / +0200, which logic/timestamp normalizes. Its UTC instant
 *  stays within years 0000–9999, so the canonical form is always a four-digit year. */
export const IsoTimestamp = z
  .string()
  .meta({ format: 'date-time' })
  .refine((text) => strictTimestamp.safeParse(expandCompactOffset(text)).success && isCanonicalizable(text), {
    error: 'Invalid datetime',
  });

/** The strict canonical form PATTY serves: a full ISO 8601 timestamp with an offset (what `logic/timestamp.canonical`
 *  produces). Every stored or returned `asOf` uses it; `IsoTimestamp` stays for inputs. */
export const UtcTimestamp = strictTimestamp;

/** What a quote's age is measured in: weekday hours for what only trades on weekdays, elapsed hours otherwise. */
export const StalenessClass = z.enum(['fiat_rate', 'crypto_rate', 'market_price', 'manual_price']);
export type StalenessClass = z.infer<typeof StalenessClass>;
