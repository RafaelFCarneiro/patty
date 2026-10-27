import { z } from 'zod';
import { DemoProbe } from '../../models/demo.js';

export const DatabaseLook = z.object({ probe: DemoProbe, holdsData: z.boolean() });
export type DatabaseLook = z.infer<typeof DatabaseLook>;
