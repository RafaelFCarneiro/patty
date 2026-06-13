import type { CreateRecurringInput } from '../models/recurring.js'
import type * as wireIn from '../wire/in/recurring.js'

export const wireInToModel = (input: wireIn.CreateRecurringInput): CreateRecurringInput => input
