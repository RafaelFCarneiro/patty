import type { z } from 'zod';
import { ListAssetsSchema, STALE_ONLY_DESCRIPTION, type ListAssetsInput } from '../../models/investment/asset.js';
import { BooleanQuerySchema } from './common.js';

export const ListAssetsQuerySchema = ListAssetsSchema.extend({
  staleOnly: BooleanQuerySchema.optional().describe(STALE_ONLY_DESCRIPTION),
});

export const ListAssetsInputSchema = ListAssetsQuerySchema.transform((query): ListAssetsInput => ({
  ...query,
  staleOnly: query.staleOnly === 'true',
}));
export type ListAssetsQueryInput = z.output<typeof ListAssetsInputSchema>;
