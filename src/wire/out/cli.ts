import { z } from 'zod';
import { DemoCountry, DemoSeedStatus } from '../../models/demo.js';

export const DemoPrepared = z.object({
  status: DemoSeedStatus,
  databasePath: z.string(),
  country: DemoCountry,
});
export type DemoPrepared = z.infer<typeof DemoPrepared>;
