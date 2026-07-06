import { z } from 'zod';

// Generic path-param / query shapes shared across many routes' `req.params`/`req.query` reads
// (diplomat/http/routes.ts) — not owned by any single domain, so they don't belong in one
// domain's wire/in file. routes.ts casts these directly rather than parsing them today
// (tracked as tech debt: github.com/RafaelFCarneiro/fintrack/issues/76), so these schemas
// back the OpenAPI documentation only, not runtime validation.
export const NameParamSchema = z.object({ name: z.string().min(1) });
export type NameParam = z.infer<typeof NameParamSchema>;

export const IdParamSchema = z.object({ id: z.string().min(1) });
export type IdParam = z.infer<typeof IdParamSchema>;

// A query string never carries a real boolean — every boolean query flag parses as this literal
// "true"/"false" pair; how it becomes a real boolean differs per consumer. includeTotal
// (SearchTransactionsQuerySchema) converts via a `.transform()` on the schema itself; confirm
// below is converted ad hoc in the route handler (`req.query.confirm === 'true'`), the same
// direct-cast pattern NameParamSchema/IdParamSchema's comment above notes as tech debt (issue #76).
export const BooleanQuerySchema = z.enum(['true', 'false']);

export const ConfirmQuerySchema = z.object({
  confirm: BooleanQuerySchema.optional().describe('Pass "true" to actually perform the action (dry-run otherwise)'),
});
export type ConfirmQuery = z.infer<typeof ConfirmQuerySchema>;
