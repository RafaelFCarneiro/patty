import { z } from 'zod';
/** `entities` is stored as a JSON array of tags; a value that is not one fails here, at the boundary. */
const EntityTagsSchema = z
  .string()
  .transform((text, context) => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      context.issues.push({ code: 'custom', message: 'entities is not valid JSON', input: text });
      return z.NEVER;
    }
  })
  .pipe(z.array(z.string()));

export const ChangeEventRowSchema = z.object({
  id: z.number().int(),
  userId: z.string().nullable(),
  entities: EntityTagsSchema,
  origin: z.string(),
  createdAt: z.string(),
});

/** What can be read of a row that failed to decode: its id, to report it and move past it. */
export const RowIdSchema = z.object({ id: z.number().int() });

export const DataVersionRowSchema = z.object({ data_version: z.number().int() });
export const LatestIdRowSchema = z.object({ latest: z.number().int().nullable() });
