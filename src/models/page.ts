import { z } from 'zod';
import { Id } from './id.js';

/**
 * ADR-014: cursor pagination + whitelisted ordering, shared by every collection endpoint that
 * adopts keyset paging. A named home (the `date.ts`/`money.ts`/`id.ts` convention), not a
 * catch-all — per-entity sort enums (e.g. `TransactionSortField`) stay on their own entity model.
 */

export const SortDirection = z.enum(['asc', 'desc']);
export type SortDirection = z.infer<typeof SortDirection>;

export const INCLUDE_TOTAL_DESCRIPTION =
  'When true, include `total` — the count of all items matching the filters (costs an extra COUNT query). Default false';

/** Request fields shared by every cursor-paginated endpoint. QoL defaults (limit → 50, and
 *  each entity's sort/dir defaults) are applied at the wire boundary, per the
 *  defaults-by-intent rule — this schema only states the bounds/shape. */
export const PageRequestSchema = z.object({
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe('Opaque continuation token returned as `nextCursor` by a previous page'),
  limit: z.number().int().min(1).max(200).describe('Maximum results per page'),
  includeTotal: z.boolean().optional().describe(INCLUDE_TOTAL_DESCRIPTION),
});
export type PageRequest = z.infer<typeof PageRequestSchema>;

/** `{ items, nextCursor?, total? }` — the paginated envelope. `nextCursor` is absent on the
 *  last page; `total` is present only when the request opted in via `includeTotal`. */
export const pageSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().optional().describe('Opaque cursor for the next page; absent on the last page'),
    total: z
      .number()
      .int()
      .optional()
      .describe('Count of all items matching the filters; present only when includeTotal was requested'),
  });
export type Page<T> = { items: T[]; nextCursor?: string; total?: number };

/** The keyset tiebreaker pair a cursor carries: the sort field's value on the last row of a
 *  page, plus the entity id as tiebreaker (same direction as `dir` — ADR-014 Decision 1). */
export const CursorKeySchema = z.object({ value: z.union([z.string(), z.number()]), id: Id });
export type CursorKey = z.infer<typeof CursorKeySchema>;

export const CURSOR_VERSION = 1;

/** Per-entity cursor payload: version + the sort binding it was produced under + the keyset.
 *  Opaque to clients — no encryption (local single-user app); opacity is a contract convention,
 *  not a security boundary. `sort` is the caller's own whitelisted sort-field enum. */
export const cursorSchema = <Sort extends z.ZodTypeAny>(sort: Sort) =>
  z.object({ v: z.literal(CURSOR_VERSION), sort, dir: SortDirection, key: CursorKeySchema });

const CURSOR_TEXT_ENCODING: BufferEncoding = 'utf8';
const CURSOR_TOKEN_ENCODING: BufferEncoding = 'base64url';

export const encodeCursor = (payload: unknown): string =>
  Buffer.from(JSON.stringify(payload), CURSOR_TEXT_ENCODING).toString(CURSOR_TOKEN_ENCODING);

/** Decodes + zod-validates an opaque cursor string against its entity-specific schema. Returns
 *  null for anything malformed or stale — callers turn that into a `validation` AppError. */
export const decodeCursor = <T>(schema: z.ZodType<T>, raw: string): T | null => {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, CURSOR_TOKEN_ENCODING).toString(CURSOR_TEXT_ENCODING));
  } catch {
    return null;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
};
