import { z } from 'zod';

// Wire shape of `{ error: AppError }` responses. `common/errors.ts` owns the AppError union
// and its httpStatus mapping (every code resolves to exactly one of 404 / 409 / 422); these
// document what actually goes over the wire for each status, for OpenAPI purposes.
export const ValidationErrorOut = z.object({
  error: z.object({ code: z.literal('validation'), issues: z.array(z.string()) }),
});
export type ValidationErrorOut = z.infer<typeof ValidationErrorOut>;

export const NotFoundErrorOut = z.object({
  error: z.object({ code: z.string(), query: z.string(), candidates: z.array(z.string()) }).catchall(z.unknown()),
});
export type NotFoundErrorOut = z.infer<typeof NotFoundErrorOut>;

export const ConflictErrorOut = z.object({
  error: z.object({ code: z.string(), entity: z.string(), name: z.string() }).catchall(z.unknown()),
});
export type ConflictErrorOut = z.infer<typeof ConflictErrorOut>;
