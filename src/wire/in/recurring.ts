import { z } from 'zod';
import * as modelRecurring from '../../models/recurring.js';
import { IsoDateQuerySchema } from './coerce.js';

// No QoL defaults needed for recurring — currency is resolved by resolveCurrency in the controller.
export const CreateRecurringSchema = modelRecurring.CreateRecurringSchema;
export type CreateRecurring = z.infer<typeof CreateRecurringSchema>;

export const ApplyDueBodySchema = z.object({ through: IsoDateQuerySchema.optional() });
export type ApplyDueBody = z.infer<typeof ApplyDueBodySchema>;
