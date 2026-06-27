import type { CreateRecurring } from '../models/recurring.js'
import type * as wireIn from '../wire/in/recurring.js'

export const wireInToModel = (input: wireIn.CreateRecurring): CreateRecurring => input
