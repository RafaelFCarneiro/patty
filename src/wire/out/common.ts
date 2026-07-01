import { z } from 'zod';

// Shared across several domains' delete responses (accounts, categories, sub-categories, tags) —
// not owned by any single entity, so it doesn't belong in one domain's wire/out file.
export const DeletedOut = z.object({ deleted: z.boolean() });
export type DeletedOut = z.infer<typeof DeletedOut>;
