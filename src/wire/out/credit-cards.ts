import { z } from 'zod';

export const DeleteCreditCardResultOut = z.union([
  z.object({ deleted: z.literal(true), card: z.string() }),
  z.object({
    deleted: z.literal(false),
    dryRun: z.literal(true),
    wouldDelete: z.object({
      card: z.string(),
      account: z.string(),
      transactions: z.number().int(),
      bills: z.number().int(),
    }),
    hint: z.string(),
  }),
]);
export type DeleteCreditCardResultOut = z.infer<typeof DeleteCreditCardResultOut>;
