import { z } from 'zod';

const strictTimestamp = z.iso.datetime({ offset: true });
const COMPACT_OFFSET = /([+-]\d{2})(\d{2})?$/;
const MINUTES_WHEN_ABSENT = '00';

/** `+02`/`+0200` → `+02:00`; any other text is returned as is. */
export const expandCompactOffset = (text: string): string =>
  text.replace(
    COMPACT_OFFSET,
    (_: string, hours: string, minutes?: string) => `${hours}:${minutes ?? MINUTES_WHEN_ABSENT}`,
  );

/** An ISO 8601 timestamp with an offset; also accepts +02 / +0200, which logic/timestamp normalizes. */
export const IsoTimestamp = z
  .string()
  .meta({ format: 'date-time' })
  .refine((text) => strictTimestamp.safeParse(expandCompactOffset(text)).success, {
    error: 'Invalid datetime',
  });
