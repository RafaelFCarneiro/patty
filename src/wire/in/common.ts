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

export const ConfirmQuerySchema = z.object({
  confirm: z
    .enum(['true', 'false'])
    .optional()
    .describe('Pass "true" to actually perform the action (dry-run otherwise)'),
});
export type ConfirmQuery = z.infer<typeof ConfirmQuerySchema>;
