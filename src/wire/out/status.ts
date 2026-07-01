import { z } from 'zod';
import { Locale } from '../../models/locale.js';

export const StatusOut = z.object({
  name: z.literal('fintrack'),
  version: z.string(),
  db: z.enum(['ok', 'error']),
  locale: Locale,
});
export type StatusOut = z.infer<typeof StatusOut>;
