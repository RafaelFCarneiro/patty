import type { z } from 'zod';
import * as modelRecurring from '../../models/recurring.js';

// No QoL defaults needed for recurring — currency is resolved by resolveCurrency in the controller.
export const CreateRecurringSchema = modelRecurring.CreateRecurringSchema;
export type CreateRecurring = z.infer<typeof CreateRecurringSchema>;
